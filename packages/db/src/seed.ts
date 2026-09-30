import { sql } from 'drizzle-orm';
import type { PrimaryDb } from './client';
import { featureFlags } from './schema';

/**
 * Feature flags that back the degradation ladder (Section 8A.6), in the order they are applied
 * under load. All are OFF by default: the ladder is engaged by operators or automatic triggers,
 * and every rung is reversible without a deploy.
 */
export const degradationLadderFlags = [
  {
    key: 'degrade.disable-social-and-reviews',
    description: 'Rung 1: disable social feeds, UGC and reviews widgets',
  },
  {
    key: 'degrade.simplify-recommendations-facets',
    description: 'Rung 2: simplify recommendations and facets',
  },
  { key: 'degrade.serve-stale-search', description: 'Rung 3: serve stale search results' },
  {
    key: 'degrade.pause-non-essential-jobs',
    description: 'Rung 4: pause non-essential background jobs',
  },
  { key: 'degrade.waiting-room', description: 'Rung 5: enable the virtual waiting room' },
] as const;

/** Idempotent: safe to run repeatedly and never overwrites operator changes to `enabled`. */
export async function seedBase(db: PrimaryDb): Promise<{ flags: number }> {
  await db
    .insert(featureFlags)
    .values(
      degradationLadderFlags.map((f) => ({
        key: f.key,
        description: f.description,
        enabled: false,
      })),
    )
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: { description: sql`excluded.description` },
    });
  return { flags: degradationLadderFlags.length };
}
