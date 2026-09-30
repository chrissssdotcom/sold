import { sql } from 'drizzle-orm';
import type { PrimaryDb } from './client';

/** Months of outbox history to keep (published events). */
export const OUTBOX_RETENTION_MONTHS = 3;
export const PARTITION_MONTHS_AHEAD = 3;

export interface PartitionMaintenanceResult {
  created: number;
  dropped: number;
  /** True when retention was skipped because unpublished events exist beyond the window. */
  blocked: boolean;
  unpublishedBeyondRetention: number;
}

/**
 * Create upcoming monthly partitions and drop expired ones. A partition is only dropped when it
 * holds no unpublished events, so retention can never destroy an event that has not been delivered:
 * correctness beats tidiness, and the caller is expected to alert when `blocked` is true.
 */
export async function maintainOutboxPartitions(db: PrimaryDb): Promise<PartitionMaintenanceResult> {
  const created = await db.execute<{ n: number }>(
    sql`SELECT sold_ensure_monthly_partitions('outbox_events', ${PARTITION_MONTHS_AHEAD}) AS n`,
  );
  const stuck = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM outbox_events
    WHERE published_at IS NULL
      AND created_at < date_trunc('month', now()) - make_interval(months => ${OUTBOX_RETENTION_MONTHS})`);
  const unpublished = Number(stuck.rows[0]?.n ?? 0);
  const createdCount = Number(created.rows[0]?.n ?? 0);
  if (unpublished > 0)
    return {
      created: createdCount,
      dropped: 0,
      blocked: true,
      unpublishedBeyondRetention: unpublished,
    };
  const dropped = await db.execute<{ n: number }>(
    sql`SELECT sold_drop_old_partitions('outbox_events', ${OUTBOX_RETENTION_MONTHS}) AS n`,
  );
  return {
    created: createdCount,
    dropped: Number(dropped.rows[0]?.n ?? 0),
    blocked: false,
    unpublishedBeyondRetention: 0,
  };
}
