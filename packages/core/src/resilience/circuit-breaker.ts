/** Circuit breaker + timeout for every outbound dependency (Section 8A.8). */

export class CircuitOpenError extends Error {
  constructor(public readonly breaker: string) {
    super(`Circuit "${breaker}" is open`);
    this.name = 'CircuitOpenError';
  }
}

export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly ms: number,
  ) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is allowed. */
  cooldownMs?: number;
  now?: () => number;
  onStateChange?: (name: string, state: BreakerState) => void;
  /**
   * Errors that say nothing about the health of the protected dependency (for example "our own pool is full").
   * They are neither a failure nor a success: they never move the breaker.
   */
  ignoreError?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  readonly name: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange: ((name: string, state: BreakerState) => void) | undefined;
  private readonly ignoreError: ((error: unknown) => boolean) | undefined;
  private failures = 0;
  /** Bumped every time the circuit opens, so a call that started before that can be recognised as stale. */
  private epoch = 0;
  private openedAt = 0;
  private current: BreakerState = 'closed';
  private trialInFlight = false;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.onStateChange = opts.onStateChange;
    this.ignoreError = opts.ignoreError;
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.cooldownMs)
      return 'half-open';
    return this.current;
  }

  /** Open the circuit now (for example when a call proved it blocks the event loop). Idempotent while open. */
  trip(): void {
    if (this.current === 'open' && this.state === 'open') return;
    this.open();
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open') throw new CircuitOpenError(this.name);
    if (state === 'half-open') {
      // Exactly one trial call while half-open; everyone else keeps failing fast.
      if (this.trialInFlight) throw new CircuitOpenError(this.name);
      this.trialInFlight = true;
      this.transition('half-open');
    }
    const epoch = this.epoch;
    const isTrial = state === 'half-open';
    // A call that started while the circuit was closed and finishes after it opened is stale: what it saw
    // says nothing about the dependency now. Only the half-open trial may close an open circuit.
    const stale = () => !isTrial && (this.epoch !== epoch || this.current !== 'closed');
    try {
      const result = await fn();
      if (isTrial) {
        this.failures = 0;
        this.transition('closed');
      } else if (!stale()) {
        this.failures = 0;
      }
      return result;
    } catch (error) {
      if (this.ignoreError?.(error)) throw error;
      if (isTrial) {
        this.open();
      } else if (!stale()) {
        this.failures++;
        if (this.failures >= this.threshold) this.open();
      }
      throw error;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }

  private open(): void {
    this.epoch++;
    this.openedAt = this.now();
    this.transition('open');
  }

  private transition(next: BreakerState): void {
    if (this.current !== next) {
      this.current = next;
      this.onStateChange?.(this.name, next);
    }
  }
}

/** Reject if `work` does not settle within `ms`. The timer is always cleared. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
