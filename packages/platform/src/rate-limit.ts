/**
 * Fixed-window rate limiting per key. Backed by anything that can `incr` with an expiry (Redis in production); with no store it
 * falls back to a per-process window, which is correct for one instance and merely generous across many (documented in docs/api.md).
 */
export interface CounterStore {
  /** Increment `key`, setting a TTL on first use; return the new count. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export interface Limit {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

export class MemoryCounters implements CounterStore {
  private readonly m = new Map<string, { n: number; until: number }>();
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const cur = this.m.get(key);
    if (!cur || cur.until <= now) {
      if (this.m.size > 10_000) for (const [k, v] of this.m) if (v.until <= now) this.m.delete(k);
      this.m.set(key, { n: 1, until: now + ttlSeconds * 1000 });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }
}

export async function checkRate(
  store: CounterStore,
  keyId: string,
  limit: number,
  windowSeconds = 60,
  now = Date.now(),
): Promise<Limit> {
  const window = Math.floor(now / 1000 / windowSeconds);
  let n: number;
  try {
    n = await store.incr(`rl:${keyId}:${window}`, windowSeconds + 1);
  } catch {
    // The limiter being down must not take the API down: fail open (and the platform-wide shedding still applies).
    return { allowed: true, remaining: limit, limit, retryAfterSeconds: 0 };
  }
  const resetIn = windowSeconds - (Math.floor(now / 1000) % windowSeconds);
  return {
    allowed: n <= limit,
    remaining: Math.max(0, limit - n),
    limit,
    retryAfterSeconds: n <= limit ? 0 : resetIn,
  };
}
