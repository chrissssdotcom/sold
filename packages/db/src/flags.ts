import { eq } from 'drizzle-orm';
import type { ReplicaDb } from './client';
import { featureFlags } from './schema';

/**
 * Read-side feature flags with a short in-process TTL cache, served from the replica handle.
 * The cache is an optimisation only: flags live in Postgres and every instance converges within
 * `ttlMs` (default 5s), so flipping a degradation-ladder rung needs no deploy and no cache purge.
 * On a read error the last known value is kept (fail static), never flipped to a guess.
 */
export class FeatureFlags {
  private readonly cache = new Map<string, { enabled: boolean; expiresAt: number }>();

  constructor(
    private readonly db: ReplicaDb,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async isEnabled(key: string, fallback = false): Promise<boolean> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.enabled;
    try {
      const [row] = await this.db
        .select({ enabled: featureFlags.enabled })
        .from(featureFlags)
        .where(eq(featureFlags.key, key))
        .limit(1);
      const enabled = row?.enabled ?? fallback;
      this.cache.set(key, { enabled, expiresAt: this.now() + this.ttlMs });
      return enabled;
    } catch {
      // Fail static AND negative-cache: while the database is down, do not hammer it once per call. Keep the last
      // known value (or the fallback) for a short window, then try again.
      const value = cached?.enabled ?? fallback;
      this.cache.set(key, { enabled: value, expiresAt: this.now() + Math.min(this.ttlMs, 2_000) });
      return value;
    }
  }
}
