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
}

export class CircuitBreaker {
  readonly name: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange: ((name: string, state: BreakerState) => void) | undefined;
  private failures = 0;
  private openedAt = 0;
  private current: BreakerState = 'closed';
  private trialInFlight = false;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.onStateChange = opts.onStateChange;
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.cooldownMs)
      return 'half-open';
    return this.current;
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
    try {
      const result = await fn();
      this.failures = 0;
      this.transition('closed');
      return result;
    } catch (error) {
      this.failures++;
      if (state === 'half-open' || this.failures >= this.threshold) {
        this.openedAt = this.now();
        this.transition('open');
      }
      throw error;
    } finally {
      if (state === 'half-open') this.trialInFlight = false;
    }
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
