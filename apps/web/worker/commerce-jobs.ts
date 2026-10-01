import { createCommerce, relayOutbox, type RelayEvent } from '@sold/commerce';
import type { Env } from '@sold/core/env';
import type { EventName } from '@sold/extension-sdk';
import type { JobQueue } from '@sold/core/jobs';
import type { PrimaryDb } from '@sold/db';
import { SamlClient, SessionService } from '@sold/identity';
import { notifyOnEvent } from '@sold/notify';
import { buildWebhooks } from '../src/server/platform';
import instanceConfig from '../../../sold.config';
import { buildNotifications, buildTransport, orderLink, productLink } from '../src/server/notify';
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
  const notify = buildNotifications(opts.env);
  const transport = buildTransport(opts.env);
  const orderUrl = orderLink(opts.env);
  const productUrl = productLink(opts.env);
  const webhooks = buildWebhooks(opts.env);
  if (!transport)
    log.warn(
      {},
      'no email transport configured (set POSTMARK_SERVER_TOKEN or SMTP_URL): emails will queue but not send',
    );

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

  // Identity housekeeping: expired sessions and the SAML replay ledger. Both are ignored by readers once expired, so this
  // only bounds table growth; hourly is plenty.
  await queue.ensureQueue({ name: 'identity.sweep', class: 'default' });
  await queue.work('identity.sweep', async () => {
    const sessions = await new SessionService().sweepExpired(db);
    const replays = await SamlClient.sweep(db);
    log.info({ sessions, replays }, 'identity sweep');
  });
  await queue.schedule('identity.sweep', '17 * * * *');

  const publish = async (e: RelayEvent): Promise<void> => {
    // Outbound webhooks: one idempotent delivery row per subscribed endpoint.
    await webhooks.enqueue(db, {
      eventId: e.eventId,
      eventType: e.eventType,
      payload: e.payload,
      createdAt: new Date(),
    });
    // Internal consumers first (idempotent by event id), then extensions. A failure here retries the whole event.
    await notifyOnEvent(
      {
        db,
        notify,
        orders: commerce.orders,
        orderUrl,
        productUrl,
        reviewRequestDays: instanceConfig.notifications.reviewRequestDays,
      },
      e,
    );
    // Events no extension can subscribe to are still "published" (nothing to deliver).
    if (!KNOWN_EVENTS.has(e.eventType)) return;
    await opts.publish(e.eventType as EventName, e.payload as never, { eventId: e.eventId });
  };

  // Webhook delivery loop (same shape as email delivery): sends due deliveries, backs off when idle.
  void (async () => {
    let idle = 0;
    while (!signal.aborted) {
      try {
        const r = await webhooks.deliverDue(db, { batch: 20 });
        idle = r.delivered + r.retried + r.failed === 0 ? Math.min(idle + 1, 10) : 0;
        if (r.failed > 0) log.warn(r, 'webhook deliveries failed permanently');
      } catch (error) {
        idle = 10;
        log.error({ err: error }, 'webhook delivery pass failed');
      }
      if (idle > 0) await new Promise((res) => setTimeout(res, 300 * idle + Math.random() * 300));
    }
  })();

  // Email delivery: a tight loop like the outbox relay (an order confirmation should arrive in seconds), backing off when idle.
  if (transport) {
    void (async () => {
      let idle = 0;
      while (!signal.aborted) {
        try {
          const r = await notify.deliverDue(db, transport, { batch: 20 });
          idle = r.sent + r.retried + r.failed + r.suppressed === 0 ? Math.min(idle + 1, 10) : 0;
          if (r.failed > 0) log.error(r, 'emails failed permanently');
        } catch (error) {
          idle = 10;
          log.error({ err: error }, 'email delivery pass failed');
        }
        if (idle > 0) await new Promise((r) => setTimeout(r, 200 * idle + Math.random() * 200));
      }
    })();
  }

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
