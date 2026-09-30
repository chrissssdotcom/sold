import { fromJsonSafe, type JsonSafe } from '@sold/core';
import { sql } from '@sold/db';
import type { DbOrTx } from './types';

export interface RelayEvent {
  /** Stable across retries (the outbox row id): observers dedupe on it. */
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  createdAt: Date;
}

export interface RelayResult {
  published: number;
  failed: number;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  created_at: Date;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: JsonSafe;
  attempts: number;
}

/** Retry delay for the nth failed attempt: 2^n seconds with a cap, so a dead subscriber cannot spin the relay. */
export function relayBackoffSeconds(attempts: number, capSeconds = 300): number {
  return Math.min(2 ** Math.min(attempts, 20), capSeconds);
}

/**
 * Publishes committed outbox events, at least once. Safe to run from many workers at once: rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so two relays never publish the same row concurrently, and a crash mid-batch releases
 * the locks so another relay picks the rows up. Delivery is at-least-once (a crash after publish, before commit,
 * republishes), which is why every event carries a stable `eventId` and every consumer must be idempotent.
 * Ordering across rows is best effort (by availability time); consumers must not depend on cross-aggregate order.
 *
 * `publish` should only enqueue (the EventBus does), so the transaction that holds the row locks stays short.
 */
export async function relayOutbox(
  db: DbOrTx,
  publish: (event: RelayEvent) => Promise<void>,
  opts: { batch?: number } = {},
): Promise<RelayResult> {
  const batch = opts.batch ?? 100;
  return db.transaction(async (tx) => {
    // Uses outbox_events_unpublished_idx (available_at) WHERE published_at IS NULL.
    const rows = (
      await tx.execute<OutboxRow>(sql`
        SELECT id, created_at, aggregate_type, aggregate_id, event_type, payload, attempts
        FROM outbox_events
        WHERE published_at IS NULL AND available_at <= now()
        ORDER BY available_at, id
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED`)
    ).rows;
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await publish({
          eventId: row.id,
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: fromJsonSafe(row.payload),
          attempts: row.attempts,
          createdAt: row.created_at,
        });
        await tx.execute(sql`
          UPDATE outbox_events SET published_at = now(), attempts = attempts + 1
          WHERE id = ${row.id} AND created_at = ${row.created_at}`);
        published++;
      } catch {
        await tx.execute(sql`
          UPDATE outbox_events
          SET attempts = attempts + 1,
              available_at = now() + make_interval(secs => ${relayBackoffSeconds(row.attempts + 1)})
          WHERE id = ${row.id} AND created_at = ${row.created_at}`);
        failed++;
      }
    }
    return { published, failed };
  });
}

/** Drain until a pass publishes nothing (or `maxPasses`), for the worker loop and tests. */
export async function drainOutbox(
  db: DbOrTx,
  publish: (event: RelayEvent) => Promise<void>,
  opts: { batch?: number; maxPasses?: number } = {},
): Promise<RelayResult> {
  const total = { published: 0, failed: 0 };
  for (let i = 0; i < (opts.maxPasses ?? 50); i++) {
    const r = await relayOutbox(db, publish, opts.batch === undefined ? {} : { batch: opts.batch });
    total.published += r.published;
    total.failed += r.failed;
    if (r.published + r.failed === 0) break;
    // A pass that only failed rows would spin: those rows are now delayed, so the next pass sees none.
  }
  return total;
}
