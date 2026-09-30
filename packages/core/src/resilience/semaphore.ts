export class SaturatedError extends Error {
  constructor(public readonly name_: string) {
    super(`"${name_}" is saturated`);
    this.name = 'SaturatedError';
  }
}

/**
 * Bounded concurrency with a bounded wait queue. When both are full it rejects immediately: under
 * overload a fast, explicit failure beats an unbounded queue (Section 8A.8 "bounded pool").
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly name: string,
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiters.length >= this.maxQueue) throw new SaturatedError(this.name);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
