import { sql } from 'drizzle-orm';
import type { PrimaryDb } from './client';

/** Months of outbox history to keep (published events). */
export const OUTBOX_RETENTION_MONTHS = 3;
export const PARTITION_MONTHS_AHEAD = 3;

export interface PartitionMaintenanceResult {
  created: number;
  dropped: number;
  /** Retention skipped because unpublished events exist in an expired partition. */
  blocked: boolean;
  unpublishedBeyondRetention: number;
  /** Rows that landed in the DEFAULT partition (maintenance fell behind). Non-zero needs an operator. */
  defaultPartitionRows: number;
  /** Expired, fully published partitions that could not be dropped this run because the parent stayed busy. */
  deferred: number;
  /** Creating a partition failed (typically because default-partition rows overlap its range). */
  createError: string | null;
}

/**
 * Create upcoming monthly partitions and retire expired ones.
 *
 * - Retention never drops a partition that holds an unpublished event: correctness beats tidiness, and the
 *   caller is expected to alert when `blocked` is true.
 * - Dropping a partition needs an ACCESS EXCLUSIVE lock on the hot parent, and every checkout insert queues behind a
 *   waiting request for it. `DETACH ... CONCURRENTLY` would avoid that but PostgreSQL forbids it while a DEFAULT
 *   partition exists, and the default partition is what keeps a lagging job from failing checkout writes. So the
 *   drop runs with a very short `lock_timeout` and is retried: writers stall for at most that timeout, and a busy
 *   moment just defers retirement to the next run (`deferred`).
 * - Rows in the DEFAULT partition are a fault, not a normal state: they prevent creating a partition for their
 *   range. They are counted and reported, never silently moved. See docs/runbooks/database.md.
 */
export async function maintainOutboxPartitions(db: PrimaryDb): Promise<PartitionMaintenanceResult> {
  const result: PartitionMaintenanceResult = {
    created: 0,
    dropped: 0,
    blocked: false,
    unpublishedBeyondRetention: 0,
    defaultPartitionRows: 0,
    deferred: 0,
    createError: null,
  };

  try {
    const created = await db.execute<{ n: number }>(
      sql`SELECT sold_ensure_monthly_partitions('outbox_events', ${PARTITION_MONTHS_AHEAD}) AS n`,
    );
    result.created = Number(created.rows[0]?.n ?? 0);
  } catch (error) {
    result.createError = error instanceof Error ? error.message : String(error);
  }

  const inDefault = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM outbox_events_default`,
  );
  result.defaultPartitionRows = Number(inDefault.rows[0]?.n ?? 0);

  const expired = await db.execute<{ relname: string }>(sql`
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'outbox_events'::regclass
       AND c.relname ~ '_[0-9]{6}$'
       AND to_date(right(c.relname, 6), 'YYYYMM') < (date_trunc('month', now()) - make_interval(months => ${OUTBOX_RETENTION_MONTHS}))::date
     ORDER BY c.relname`);

  for (const { relname } of expired.rows) {
    // relname comes from pg_class and matches a strict pattern; still quote it as an identifier.
    const ident = sql.raw(`"${relname.replaceAll('"', '""')}"`);
    const pending = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${ident} WHERE published_at IS NULL`,
    );
    const unpublished = Number(pending.rows[0]?.n ?? 0);
    if (unpublished > 0) {
      result.blocked = true;
      result.unpublishedBeyondRetention += unpublished;
      continue;
    }
    if (await dropWithShortLockWait(db, ident)) result.dropped++;
    else result.deferred++;
  }
  return result;
}

const DROP_LOCK_TIMEOUT_MS = 150;
const DROP_ATTEMPTS = 5;

/** True if dropped. False if the parent stayed too busy to lock within the attempts (retry next run). */
async function dropWithShortLockWait(
  db: PrimaryDb,
  ident: ReturnType<typeof sql.raw>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= DROP_ATTEMPTS; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${DROP_LOCK_TIMEOUT_MS}ms'`));
        await tx.execute(sql`DROP TABLE ${ident}`);
      });
      return true;
    } catch (error) {
      const code =
        (error as { cause?: { code?: string }; code?: string }).cause?.code ??
        (error as { code?: string }).code;
      if (code !== '55P03') throw error; // anything other than "lock not available" is a real failure
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
    }
  }
  return false;
}
