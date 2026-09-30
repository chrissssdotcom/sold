import { Money } from '@sold/core';
import { createCommerce, type Commerce } from '@sold/commerce';
import { openMigrated, seedVariant } from '@sold/commerce/testing';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayError } from './gateway';
import { ManualGateway } from './gateways/manual';
import { PaymentService } from './service';
import { MockGateway } from './testing';

let testDb: TestDatabase;
let db: Db;
let commerce: Commerce;
let mock: MockGateway;
let payments: PaymentService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 20);
  commerce = createCommerce();
  mock = new MockGateway();
  payments = new PaymentService({ gateways: [mock, new ManualGateway()], orders: commerce.orders });
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const au = {
  line1: '1 George St',
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
};
let n = 0;

/** A real order placed through checkout: pending_payment, stock held. */
async function order(onHand = 5, qty = 1, price = 4000n) {
  const { variantId } = await seedVariant(db, { onHand, price });
  const cart = await commerce.carts.create(db.primary, { currency: 'AUD' });
  await commerce.carts.addItem(db.primary, cart.id, variantId, qty);
  const { order: placed } = await commerce.checkout.place(
    db.primary,
    { cartId: cart.id, email: 'p@example.com', shippingAddress: au, shippingMethodId: 'standard' },
    `pay-test-${Date.now()}-${++n}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return { orderId: placed.orderId, variantId, total: placed.total };
}
const one = async <T>(q: ReturnType<typeof sql>) =>
  (await db.primary.execute<T & Record<string, unknown>>(q)).rows[0]!;
const orderStatus = async (id: string) => (await commerce.orders.get(db.primary, id)).status;
let evSeq = 0;
const ev = (over: Record<string, unknown>) => ({ id: `evt_${++evSeq}`, ...over }) as never;

async function paid() {
  const o = await order();
  const started = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
  const ref = `mock_pi_${started.paymentId}`;
  const d = mock.delivery([
    ev({ type: 'payment.captured', ref, amount: o.total.amount.toString(), currency: 'AUD' }),
  ]);
  await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
  return { ...o, paymentId: started.paymentId, ref };
}

describe('starting a payment', () => {
  it('creates one payment per order, idempotently, and never stores the client secret', async () => {
    const o = await order();
    const a = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    const b = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    expect(b.paymentId).toBe(a.paymentId);
    expect(a.clientSecret).toBe(`secret_${a.paymentId}`);
    expect(b.clientSecret).toBe(a.clientSecret); // the gateway is idempotent by payment id
    const row = await one<{ n: string; amount: string; status: string }>(
      sql`SELECT count(*) AS n, max(amount)::text AS amount, max(status) AS status FROM payments WHERE order_id = ${o.orderId}`,
    );
    expect(Number(row.n)).toBe(1);
    expect(BigInt(row.amount)).toBe(o.total.amount);
    expect(row.status).toBe('requires_action');
    const dump = await one<{ j: string }>(
      sql`SELECT row_to_json(p)::text AS j FROM payments p WHERE id = ${a.paymentId}`,
    );
    expect(dump.j).not.toContain('secret_');
  });

  it('refuses a second gateway while one payment is open, unknown gateways, and non-payable orders', async () => {
    const o = await order();
    await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    await expect(
      payments.start(db.primary, { orderId: o.orderId, gatewayId: 'manual' }),
    ).rejects.toMatchObject({
      code: 'payment_in_progress',
    });
    await expect(
      payments.start(db.primary, { orderId: o.orderId, gatewayId: 'nope' }),
    ).rejects.toMatchObject({
      code: 'gateway_unavailable',
    });
    const cancelled = await order();
    await commerce.orders.transition(db.primary, cancelled.orderId, 'cancelled', { actor: 't' });
    await expect(
      payments.start(db.primary, { orderId: cancelled.orderId, gatewayId: 'mock' }),
    ).rejects.toMatchObject({
      code: 'order_not_payable',
    });
  });

  it('marks the payment failed on a final gateway error, and can retry after a retryable one', async () => {
    const o = await order();
    mock.failNextCall(new GatewayError('card declined', false, 'card_declined'));
    await expect(
      payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' }),
    ).rejects.toThrow('declined');
    const failed = await one<{ status: string; failure_code: string }>(
      sql`SELECT status, failure_code FROM payments WHERE order_id = ${o.orderId}`,
    );
    expect(failed).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    const retry = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    expect(retry.status).toBe('requires_action');

    const o2 = await order();
    mock.failNextCall(new GatewayError('timeout', true, 'network_error'));
    await expect(
      payments.start(db.primary, { orderId: o2.orderId, gatewayId: 'mock' }),
    ).rejects.toThrow('timeout');
    const still = await one<{ status: string }>(
      sql`SELECT status FROM payments WHERE order_id = ${o2.orderId}`,
    );
    expect(still.status).toBe('pending'); // unknown outcome: not failed, retry with the same key
    await payments.start(db.primary, { orderId: o2.orderId, gatewayId: 'mock' });
  });

  it('respects gateway currency support', async () => {
    const o = await order();
    mock.currencies = ['USD'];
    await expect(
      payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    mock.currencies = null;
  });
});

describe('webhooks', () => {
  it('a captured webhook pays the order, commits stock and emits payment.captured; a duplicate does nothing', async () => {
    const o = await order(5, 2);
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    const d = mock.delivery([
      ev({
        type: 'payment.captured',
        ref: `mock_pi_${s.paymentId}`,
        amount: o.total.amount.toString(),
        currency: 'AUD',
      }),
    ]);
    const first = await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
    expect(first).toMatchObject({ received: 1, applied: 1, duplicates: 0 });
    expect(await orderStatus(o.orderId)).toBe('paid');
    expect(
      await one(
        sql`SELECT reserved, on_hand FROM inventory_levels WHERE variant_id = ${o.variantId}`,
      ),
    ).toMatchObject({
      reserved: 0,
      on_hand: 3,
    });
    const pay = await one<{ status: string; captured: string }>(
      sql`SELECT status, captured::text FROM payments WHERE id = ${s.paymentId}`,
    );
    expect(pay).toMatchObject({ status: 'captured', captured: o.total.amount.toString() });

    const again = await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
    expect(again).toMatchObject({ applied: 0, duplicates: 1 });
    const events = await db.primary.execute<{ event_type: string }>(
      sql`SELECT event_type FROM outbox_events WHERE aggregate_id IN (${s.paymentId}, ${o.orderId}) ORDER BY created_at, id`,
    );
    expect(
      events.rows.map((r) => r.event_type).filter((t) => t === 'payment.captured'),
    ).toHaveLength(1);
    expect(
      await one<{ n: string }>(
        sql`SELECT count(*) AS n FROM payment_events WHERE event_id = ${JSON.parse(d.rawBody)[0].id}`,
      ),
    ).toMatchObject({
      n: '1',
    });
  });

  it('rejects unsigned and tampered deliveries without touching state', async () => {
    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    const d = mock.delivery([
      ev({ type: 'payment.captured', ref: `mock_pi_${s.paymentId}`, amount: '1', currency: 'AUD' }),
    ]);
    await expect(
      payments.handleWebhook(db.primary, 'mock', d.rawBody, new Headers()),
    ).rejects.toThrow(/signature/);
    await expect(
      payments.handleWebhook(db.primary, 'mock', d.rawBody.replace('"1"', '"9"'), d.headers),
    ).rejects.toThrow(/signature/);
    expect(await orderStatus(o.orderId)).toBe('pending_payment');
  });

  it('20 concurrent identical deliveries apply exactly once', async () => {
    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    const d = mock.delivery([
      ev({
        type: 'payment.captured',
        ref: `mock_pi_${s.paymentId}`,
        amount: o.total.amount.toString(),
        currency: 'AUD',
      }),
    ]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers),
      ),
    );
    expect(results.reduce((a, r) => a + r.applied, 0)).toBe(1);
    expect(await orderStatus(o.orderId)).toBe('paid');
    expect(
      await one(sql`SELECT on_hand FROM inventory_levels WHERE variant_id = ${o.variantId}`),
    ).toMatchObject({ on_hand: 4 });
  });

  it('a webhook that beats the recorded gateway reference is deferred, then applied by the sweep', async () => {
    const o = await order();
    // Simulate the race: the payment row exists but the reference is not recorded yet.
    const p = await one<{ id: string }>(sql`
      INSERT INTO payments (order_id, gateway, currency, amount) VALUES (${o.orderId}, 'mock', 'AUD', ${o.total.amount}::bigint) RETURNING id`);
    const ref = `mock_pi_${p.id}`;
    const d = mock.delivery([
      ev({ type: 'payment.captured', ref, amount: o.total.amount.toString(), currency: 'AUD' }),
    ]);
    const first = await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
    expect(first).toMatchObject({ deferred: 1, applied: 0 });
    expect(await orderStatus(o.orderId)).toBe('pending_payment');
    await db.primary.execute(sql`UPDATE payments SET gateway_ref = ${ref} WHERE id = ${p.id}`);
    const swept = await payments.reprocessPending(db.primary, { olderThanSeconds: 0 });
    expect(swept.applied).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(o.orderId)).toBe('paid');
    // and the redelivery is now a duplicate
    expect(await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers)).toMatchObject({
      duplicates: 1,
    });
  });

  it('flags an amount mismatch instead of marking the order paid', async () => {
    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    const d = mock.delivery([
      ev({
        type: 'payment.captured',
        ref: `mock_pi_${s.paymentId}`,
        amount: (o.total.amount - 1n).toString(),
        currency: 'AUD',
      }),
    ]);
    expect(await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers)).toMatchObject({
      needsAttention: 1,
    });
    expect(await orderStatus(o.orderId)).toBe('pending_payment');
    const evt = await one<{ error: string; processed_at: Date | null }>(
      sql`SELECT error, processed_at FROM payment_events WHERE event_id = ${JSON.parse(d.rawBody)[0].id}`,
    );
    expect(evt.error).toBe('needs_attention');
    const flagged = await db.primary.execute(
      sql`SELECT 1 FROM outbox_events WHERE event_type = 'payment.amount_mismatch' AND aggregate_id = ${s.paymentId}`,
    );
    expect(flagged.rows).toHaveLength(1);
  });

  it('failure then late success: gateway truth wins', async () => {
    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    const ref = `mock_pi_${s.paymentId}`;
    const fail = mock.delivery([ev({ type: 'payment.failed', ref, code: 'card_declined' })]);
    await payments.handleWebhook(db.primary, 'mock', fail.rawBody, fail.headers);
    expect(await one(sql`SELECT status FROM payments WHERE id = ${s.paymentId}`)).toMatchObject({
      status: 'failed',
    });
    expect(await orderStatus(o.orderId)).toBe('pending_payment');
    const ok = mock.delivery([
      ev({ type: 'payment.captured', ref, amount: o.total.amount.toString(), currency: 'AUD' }),
    ]);
    await payments.handleWebhook(db.primary, 'mock', ok.rawBody, ok.headers);
    expect(await orderStatus(o.orderId)).toBe('paid');
  });

  it('money for an order that was cancelled is refunded automatically, exactly once', async () => {
    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    await commerce.orders.transition(db.primary, o.orderId, 'cancelled', { actor: 'sweeper' });
    const d = mock.delivery([
      ev({
        type: 'payment.captured',
        ref: `mock_pi_${s.paymentId}`,
        amount: o.total.amount.toString(),
        currency: 'AUD',
      }),
    ]);
    await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
    expect(await orderStatus(o.orderId)).toBe('cancelled');
    expect(
      (
        await db.primary.execute(
          sql`SELECT 1 FROM outbox_events WHERE event_type = 'payment.orphaned_capture' AND aggregate_id = ${s.paymentId}`,
        )
      ).rows,
    ).toHaveLength(1);
    expect(await payments.reconcileOrphans(db.primary)).toBeGreaterThanOrEqual(1);
    expect(await payments.reconcileOrphans(db.primary)).toBe(0);
    expect(
      await one(sql`SELECT status, refunded::text FROM payments WHERE id = ${s.paymentId}`),
    ).toMatchObject({
      status: 'refunded',
      refunded: o.total.amount.toString(),
    });
    // still cancelled, and stock was not double-restocked
    expect(await orderStatus(o.orderId)).toBe('cancelled');
    expect(
      await one(
        sql`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = ${o.variantId}`,
      ),
    ).toMatchObject({ on_hand: 5, reserved: 0 });
  });
});

describe('refunds', () => {
  it('partial then full refund; the order becomes refunded only when fully refunded', async () => {
    const p = await paid();
    const half = Money.of(p.total.amount / 2n, 'AUD');
    const r1 = await payments.refund(db.primary, {
      paymentId: p.paymentId,
      amount: half,
      reason: 'damaged',
      actor: 'admin',
      idempotencyKey: `r-${p.paymentId}-1`,
    });
    expect(r1.status).toBe('succeeded');
    expect(
      await one(sql`SELECT status, refunded::text FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({ status: 'partially_refunded' });
    expect(await orderStatus(p.orderId)).toBe('paid');
    const rest = Money.of(p.total.amount - half.amount, 'AUD');
    await payments.refund(db.primary, {
      paymentId: p.paymentId,
      amount: rest,
      reason: 'rest',
      actor: 'admin',
      idempotencyKey: `r-${p.paymentId}-2`,
    });
    expect(
      await one(sql`SELECT status, refunded::text FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({
      status: 'refunded',
      refunded: p.total.amount.toString(),
    });
    expect(await orderStatus(p.orderId)).toBe('refunded');
    // paid → refunded restocks the goods that never shipped
    expect(
      await one(sql`SELECT on_hand FROM inventory_levels WHERE variant_id = ${p.variantId}`),
    ).toMatchObject({ on_hand: 5 });
  });

  it('refuses over-refunds, wrong currency, non-captured payments and key reuse; is idempotent per key', async () => {
    const p = await paid();
    const key = `r-${p.paymentId}`;
    await expect(
      payments.refund(db.primary, {
        paymentId: p.paymentId,
        amount: Money.of(p.total.amount + 1n, 'AUD'),
        reason: '',
        actor: 'a',
        idempotencyKey: `${key}-over`,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      payments.refund(db.primary, {
        paymentId: p.paymentId,
        amount: Money.of(100n, 'USD'),
        reason: '',
        actor: 'a',
        idempotencyKey: `${key}-cur`,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const a = await payments.refund(db.primary, {
      paymentId: p.paymentId,
      amount: Money.of(100n, 'AUD'),
      reason: 'x',
      actor: 'a',
      idempotencyKey: key,
    });
    const before = mock.calls.refund;
    const b = await payments.refund(db.primary, {
      paymentId: p.paymentId,
      amount: Money.of(100n, 'AUD'),
      reason: 'x',
      actor: 'a',
      idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
    expect(mock.calls.refund).toBe(before); // a replay never calls the gateway again
    await expect(
      payments.refund(db.primary, {
        paymentId: p.paymentId,
        amount: Money.of(200n, 'AUD'),
        reason: 'x',
        actor: 'a',
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });

    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'mock' });
    await expect(
      payments.refund(db.primary, {
        paymentId: s.paymentId,
        amount: Money.of(1n, 'AUD'),
        reason: '',
        actor: 'a',
        idempotencyKey: `${key}-np`,
      }),
    ).rejects.toMatchObject({ code: 'payment_not_refundable' });
  });

  it('concurrent refund attempts can never refund more than was captured', async () => {
    const p = await paid();
    const each = Money.of(p.total.amount / 3n + 1n, 'AUD'); // three of them exceed the total
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) =>
        payments.refund(db.primary, {
          paymentId: p.paymentId,
          amount: each,
          reason: 'race',
          actor: 'a',
          idempotencyKey: `race-${p.paymentId}-${i}`,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);
    const row = await one<{ refunded: string }>(
      sql`SELECT refunded::text FROM payments WHERE id = ${p.paymentId}`,
    );
    expect(BigInt(row.refunded)).toBe(each.amount * 2n);
    expect(BigInt(row.refunded)).toBeLessThanOrEqual(p.total.amount);
  });

  it('a pending refund is settled by the gateway webhook; a dashboard refund is recorded too', async () => {
    const p = await paid();
    mock.refundStatus = 'pending';
    const r = await payments.refund(db.primary, {
      paymentId: p.paymentId,
      amount: Money.of(500n, 'AUD'),
      reason: 'p',
      actor: 'a',
      idempotencyKey: `pend-${p.paymentId}`,
    });
    mock.refundStatus = 'succeeded';
    expect(r.status).toBe('pending');
    expect(
      await one(sql`SELECT refunded::text FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({ refunded: '0' });
    const d = mock.delivery([
      ev({
        type: 'refund.succeeded',
        ref: p.ref,
        refundRef: `mock_re_pend-${p.paymentId}`,
        amount: '500',
        currency: 'AUD',
      }),
    ]);
    await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
    expect(
      await one(sql`SELECT refunded::text, status FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({ refunded: '500', status: 'partially_refunded' });
    // redelivery does not double count
    await payments.handleWebhook(db.primary, 'mock', d.rawBody, d.headers);
    expect(
      await one(sql`SELECT refunded::text FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({ refunded: '500' });

    const dash = mock.delivery([
      ev({
        type: 'refund.succeeded',
        ref: p.ref,
        refundRef: 're_dashboard',
        amount: '300',
        currency: 'AUD',
      }),
    ]);
    await payments.handleWebhook(db.primary, 'mock', dash.rawBody, dash.headers);
    expect(
      await one(sql`SELECT refunded::text FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({ refunded: '800' });
    expect(
      await one(sql`SELECT actor FROM refunds WHERE gateway_ref = 're_dashboard'`),
    ).toMatchObject({ actor: 'gateway' });
  });

  it('a failed gateway refund leaves money untouched', async () => {
    const p = await paid();
    mock.failNextCall(new GatewayError('refused', false, 'refund_refused'));
    await expect(
      payments.refund(db.primary, {
        paymentId: p.paymentId,
        amount: Money.of(100n, 'AUD'),
        reason: '',
        actor: 'a',
        idempotencyKey: `fail-${p.paymentId}`,
      }),
    ).rejects.toThrow('refused');
    expect(
      await one(sql`SELECT refunded::text FROM payments WHERE id = ${p.paymentId}`),
    ).toMatchObject({ refunded: '0' });
    expect(
      await one(sql`SELECT status FROM refunds WHERE idempotency_key = ${`fail-${p.paymentId}`}`),
    ).toMatchObject({ status: 'failed' });
  });
});

describe('manual gateway', () => {
  it('waits for an admin to confirm, then pays the order (idempotently)', async () => {
    const o = await order();
    const s = await payments.start(db.primary, { orderId: o.orderId, gatewayId: 'manual' });
    expect(s.instructions).toBeTruthy();
    expect(await orderStatus(o.orderId)).toBe('pending_payment');
    expect(await payments.confirmManually(db.primary, s.paymentId, 'admin:1')).toBe('applied');
    expect(await payments.confirmManually(db.primary, s.paymentId, 'admin:1')).toBe('ignored');
    expect(await orderStatus(o.orderId)).toBe('paid');
  });
});

describe('database guarantees', () => {
  it('refuses captured > amount and refunded > captured even if application code is wrong', async () => {
    const p = await paid();
    const msg = async (q: ReturnType<typeof sql>) =>
      db.primary.execute(q).then(
        () => '',
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(
      await msg(sql`UPDATE payments SET captured = amount + 1 WHERE id = ${p.paymentId}`),
    ).toMatch(/payments_captured_check/);
    expect(
      await msg(sql`UPDATE payments SET refunded = captured + 1 WHERE id = ${p.paymentId}`),
    ).toMatch(/payments_refunded_check/);
  });
});
