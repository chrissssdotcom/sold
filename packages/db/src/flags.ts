import { createHash } from 'node:crypto';
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
  private readonly rules = new Map<
    string,
    { enabled: boolean; rules: FlagRules; expiresAt: number }
  >();

  constructor(
    private readonly db: ReplicaDb,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Rules-aware check for one visitor. Uses the same cached read as `isEnabled` (rules refresh with the TTL). */
  async assignmentFor(key: string, visitorId: string): Promise<Assignment> {
    const cached = this.rules.get(key);
    let row = cached && cached.expiresAt > this.now() ? cached : undefined;
    if (!row) {
      try {
        const [r] = await this.db
          .select({ enabled: featureFlags.enabled, rules: featureFlags.rules })
          .from(featureFlags)
          .where(eq(featureFlags.key, key))
          .limit(1);
        row = {
          enabled: r?.enabled ?? false,
          rules: (r?.rules ?? {}) as FlagRules,
          expiresAt: this.now() + this.ttlMs,
        };
      } catch {
        row = cached ?? { enabled: false, rules: {}, expiresAt: 0 };
        row = { ...row, expiresAt: this.now() + Math.min(this.ttlMs, 2_000) };
      }
      this.rules.set(key, row);
    }
    return assign(key, row.enabled, row.rules, visitorId);
  }

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

/**
 * Rollout rules stored in `feature_flags.rules` (jsonb). All optional:
 *  - `allowList`: visitor/customer ids that always get the flag (staff, testers);
 *  - `rolloutPercent`: 0-100, the share of visitors that get it (stable per visitor);
 *  - `variants`: named arms for an experiment, weighted (weights need not sum to 100; relative).
 */
export interface FlagRules {
  allowList?: string[];
  rolloutPercent?: number;
  variants?: { name: string; weight: number }[];
}

/** Stable bucket in [0, 10000) for (flag, visitor). Changing the flag key reshuffles; the same pair never moves. */
export function bucketOf(flagKey: string, visitorId: string): number {
  const h = createHash('sha256').update(`${flagKey}\0${visitorId}`).digest();
  return h.readUInt32BE(0) % 10_000;
}

export interface Assignment {
  /** Whether this visitor is exposed to the flag at all. */
  enabled: boolean;
  /** The experiment arm, when the flag defines variants and the visitor is exposed. */
  variant: string | null;
}

/**
 * Pure assignment: same inputs, same answer, on every instance and every request, with no storage. A disabled flag exposes
 * nobody. The rollout bucket and the variant bucket are independent (different salts), so a 10 % rollout is not skewed to one arm.
 */
export function assign(
  flagKey: string,
  enabled: boolean,
  rules: FlagRules,
  visitorId: string,
): Assignment {
  if (!enabled) return { enabled: false, variant: null };
  const listed = rules.allowList?.includes(visitorId) === true;
  const pct = rules.rolloutPercent;
  const exposed =
    listed ||
    pct === undefined ||
    (pct > 0 && bucketOf(`${flagKey}:rollout`, visitorId) < Math.min(100, pct) * 100);
  if (!exposed) return { enabled: false, variant: null };
  const arms = (rules.variants ?? []).filter((v) => v.weight > 0);
  if (arms.length === 0) return { enabled: true, variant: null };
  const total = arms.reduce((n, v) => n + v.weight, 0);
  let point = (bucketOf(`${flagKey}:variant`, visitorId) / 10_000) * total;
  for (const arm of arms) {
    if (point < arm.weight) return { enabled: true, variant: arm.name };
    point -= arm.weight;
  }
  return { enabled: true, variant: arms[arms.length - 1]!.name };
}
