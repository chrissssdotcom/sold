import {
  sql,
  type EventMap,
  type ExtensionContext,
  type ObserverDefinition,
} from '@sold/extension-sdk';
import { buildPayload, type ConversionInput } from './events';
import type { Settings } from './settings';

type Ctx = ExtensionContext<Settings>;

/**
 * Send one conversion to the Events API, once.
 *  - Consent: only orders whose customer accepted advertising cookies *at checkout* (recorded on the order) are sent.
 *  - Idempotent: `ext_tiktok_social_sent` plus TikTok's own `event_id` de-duplication.
 *  - Errors: network/5xx/429 throw (the observer is retried with backoff); other 4xx are logged and dropped, because
 *    retrying a request TikTok has rejected can never succeed.
 */
async function sendConversion(
  ctx: Ctx,
  orderId: string,
  input: Omit<ConversionInput, 'email' | 'pageUrl'>,
): Promise<void> {
  const cfg = await ctx.settings.get();
  if (!cfg.serverEvents || !cfg.pixelCode || !cfg.accessToken) return;

  const rows = await ctx.db.primary.execute(
    sql`SELECT email, consent FROM orders WHERE id = ${orderId}::uuid`,
  );
  const order = rows.rows[0] as { email: string; consent: { marketing?: boolean } } | undefined;
  if (!order) {
    ctx.log.warn({ orderId }, 'order not found for conversion event');
    return;
  }
  if (order.consent?.marketing !== true) return; // no advertising consent at checkout: send nothing, store nothing

  const already = await ctx.db.primary.execute(
    sql`SELECT 1 FROM ext_tiktok_social_sent WHERE event_id = ${input.eventId}`,
  );
  if (already.rows.length > 0) return;

  const body = buildPayload(
    cfg.pixelCode,
    { ...input, email: order.email, ...(cfg.publicUrl ? { pageUrl: cfg.publicUrl } : {}) },
    cfg.testEventCode,
  );
  const res = await fetch(`${cfg.apiBase.replace(/\/$/, '')}/open_api/v1.3/event/track/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'access-token': cfg.accessToken },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  const out = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
  const accepted = res.ok && (out.code === 0 || out.code === undefined);
  if (!accepted) {
    const transient = res.status === 429 || res.status >= 500;
    ctx.log.warn(
      { status: res.status, code: out.code, message: out.message, event: input.event, transient },
      'TikTok Events API rejected a conversion',
    );
    if (transient) throw new Error(`TikTok Events API ${res.status}`);
    return; // permanent: do not retry, do not record as sent
  }
  await ctx.db.primary.execute(
    sql`INSERT INTO ext_tiktok_social_sent (event_id, event) VALUES (${input.eventId}, ${input.event}) ON CONFLICT DO NOTHING`,
  );
}

export const placeOrderEvent: ObserverDefinition<'order.placed', Ctx> = {
  event: 'order.placed',
  name: 'place-an-order',
  async handler(order: EventMap['order.placed'], ctx) {
    await sendConversion(ctx, order.orderId, {
      event: 'PlaceAnOrder',
      eventId: `order-${order.orderId}`, // the browser pixel uses the same id, so TikTok counts the pair once
      occurredAt: new Date(order.placedAt),
      currency: order.total.currency,
      amountMinor: order.total.amount,
    });
  },
};

export const paymentEvent: ObserverDefinition<'payment.captured', Ctx> = {
  event: 'payment.captured',
  name: 'complete-payment',
  async handler(p: EventMap['payment.captured'], ctx) {
    await sendConversion(ctx, p.orderId, {
      event: 'CompletePayment',
      eventId: `payment-${p.paymentId}`,
      occurredAt: new Date(),
      currency: p.amount.currency,
      amountMinor: p.amount.amount,
    });
  },
};
