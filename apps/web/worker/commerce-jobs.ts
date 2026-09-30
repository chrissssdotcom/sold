import { createCommerce, relayOutbox, type RelayEvent } from '@sold/commerce';
import type { Env } from '@sold/core/env';
import type { EventName } from '@sold/extension-sdk';
import type { JobQueue } from '@sold/core/jobs';
import type { PrimaryDb } from '@sold/db';
import { buildPayments } from '../src/server/payments';

interface Log {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

const KNOWN_EVENTS = new Set<string>([
  'cart.updated',
  'order.placed',
  'payment.captured',
  'order.status_changed',
]);

/**
 * Commerce background work.
 *  - The outbox relay is a tight in-process loop (an order's observers should run within a second, and cron cannot
 *    schedule below a minute). Many workers may run it at once: rows are claimed with SKIP LOCKED.
 *  - Sweeps (expired stock holds, unpaid orders, deferred payment webhooks, orphaned captures) run every minute
 *    through the job queue; they are idempotent and bounded.
 */
export async function startCommerceJobs(opts: {
  env: Env;
  db: PrimaryDb;
  queue: JobQueue;
  log: Log;
  publish: (event: EventName, payload: never, opts: { eventId: string }) => Promise<unknown>;
  signal: AbortSignal;
}): Promise<void> {
  const { db, queue, log, signal } = opts;
  const commerce = createCommerce();
  const payments = buildPayments(opts.env, commerce);

  await queue.ensureQueue({ name: 'commerce.sweep', class: 'critical' });
  await queue.work('commerce.sweep', async () => {
    const holds = await commerce.inventory.sweepExpired(db);
    const cancelled = await commerce.orders.cancelUnpaid(
      db,
      commerce.config.paymentWindowMinutes + 5,
    );
    const webhooks = await payments.reprocessPending(db);
    const orphans = await payments.reconcileOrphans(db);
    log.info({ holds, cancelled, webhooks: webhooks.applied, orphans }, 'commerce sweep');
  });
  await queue.schedule('commerce.sweep', '* * * * *');

  const publish = async (e: RelayEvent): Promise<void> => {
    // Events no extension can subscribe to are still "published" (nothing to deliver).
    if (!KNOWN_EVENTS.has(e.eventType)) return;
    await opts.publish(e.eventType as EventName, e.payload as never, { eventId: e.eventId });
  };

  void (async () => {
    let idle = 0;
    while (!signal.aborted) {
      try {
        const r = await relayOutbox(db, publish, { batch: 100 });
        idle = r.published + r.failed === 0 ? Math.min(idle + 1, 10) : 0;
        if (r.failed > 0) log.warn(r, 'outbox relay: some events failed and will be retried');
      } catch (error) {
        idle = 10;
        log.error({ err: error }, 'outbox relay pass failed');
      }
      // Busy: loop immediately. Idle: back off to ~1s with jitter so N workers do not poll in lockstep.
      if (idle > 0) await new Promise((r) => setTimeout(r, 100 * idle + Math.random() * 100));
    }
  })();
}
