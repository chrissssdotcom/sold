export class SaturatedError extends Error {
  constructor(public readonly name_: string) {
    super(`"${name_}" is saturated`);
    this.name = 'SaturatedError';
  }
}

interface Waiter {
  grant(): void;
  cancel(): void;
}

/**
 * Bounded concurrency with a bounded wait queue. When both are full it rejects immediately: under
 * overload a fast, explicit failure beats an unbounded queue (Section 8A.8 "bounded pool").
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly name: string,
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get capacity(): number {
    return this.max;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a slot and return its (idempotent) release function. Rejects with `SaturatedError` when the queue is
   * full, or when a slot did not free up within `maxWaitMs`: a caller with a latency budget must not wait
   * longer than it can afford, and the wait must never be charged to the work it is waiting to run.
   */
  async acquire(maxWaitMs = Number.POSITIVE_INFINITY): Promise<() => void> {
    if (this.active >= this.max) {
      if (this.waiters.length >= this.maxQueue) throw new SaturatedError(this.name);
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter: Waiter = {
          grant: () => {
            clearTimeout(timer);
            resolve();
          },
          cancel: () => reject(new SaturatedError(this.name)),
        };
        if (Number.isFinite(maxWaitMs))
          timer = setTimeout(() => {
            const i = this.waiters.indexOf(waiter);
            if (i >= 0) {
              this.waiters.splice(i, 1);
              waiter.cancel();
            }
          }, maxWaitMs);
        this.waiters.push(waiter);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next)
        next.grant(); // the slot is handed over, `active` is unchanged
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
