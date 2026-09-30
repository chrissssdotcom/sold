import { Semaphore } from '@sold/core';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommerce, type Commerce } from '../commerce';
import type { HookRunner } from '../hooks';
import { relayOutbox } from '../outbox-relay';
import { openMigrated, seedVariant } from '../test-support';

let testDb: TestDatabase;
let db: Db;
let commerce: Commerce;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 20);
  commerce = createCommerce();
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const au = {
  name: 'Sam Shopper',
  line1: '1 George St',
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
};
let keySeq = 0;
const key = () => `test-key-${Date.now()}-${++keySeq}-${Math.random().toString(36).slice(2, 8)}`;

async function cartWith(variantId: string, quantity: number, coupon?: string) {
  const cart = await commerce.carts.create(db.primary, { currency: 'AUD' });
  await commerce.carts.addItem(db.primary, cart.id, variantId, quantity);
  if (coupon) await commerce.carts.applyCoupon(db.primary, cart.id, coupon);
  return cart.id;
}
const request = (cartId: string, extra: Record<string, unknown> = {}) => ({
  cartId,
  email: 'Sam@Example.com',
  shippingAddress: au,
  shippingMethodId: 'standard',
  ...extra,
});
const one = async <T>(q: ReturnType<typeof sql>) =>
  (await db.primary.execute<T & Record<string, unknown>>(q)).rows[0]!;

describe('quote', () => {
  it('prices a cart: inclusive GST extracted, shipping added, exact to the cent', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10, price: 1099n });
    const cartId = await cartWith(variantId, 2);
    const q = await commerce.quotes.quote(db.primary, {
      cartId,
      destination: au,
      shippingMethodId: 'standard',
    });
    expect(q.subtotal.amount).toBe(2198n);
    expect(q.shippingTotal.amount).toBe(995n); // below the A$150 free-shipping threshold
    expect(q.total.amount).toBe(3193n); // GST-inclusive prices: tax is inside, not added
    expect(q.taxTotal.amount).toBe(290n); // 200 (goods) + 90 (shipping), rounded per line
    expect(q.shippingOptions.map((o) => o.methodId)).toContain('standard');
  });

  it('refuses an empty cart and an unavailable shipping method', async () => {
    const cart = await commerce.carts.create(db.primary, { currency: 'AUD' });
    await expect(
      commerce.quotes.quote(db.primary, { cartId: cart.id, destination: au }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const { variantId } = await seedVariant(db, { onHand: 1 });
    const cartId = await cartWith(variantId, 1);
    await expect(
      commerce.quotes.quote(db.primary, { cartId, destination: au, shippingMethodId: 'teleport' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('placing an order', () => {
  it('creates a pending order, holds stock, closes the cart and writes the outbox event atomically', async () => {
    const { variantId } = await seedVariant(db, { onHand: 5, price: 2500n, title: 'Mug' });
    const cartId = await cartWith(variantId, 2);
    const { order, replayed } = await commerce.checkout.place(db.primary, request(cartId), key());
    expect(replayed).toBe(false);
    expect(order.status).toBe('pending_payment');
    expect(order.total.amount).toBe(5995n); // 5000 + 995 shipping

    const view = await commerce.orders.get(db.primary, order.orderId);
    expect(view.email).toBe('sam@example.com');
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({ sku: expect.any(String), quantity: 2 });
    expect(view.lines[0]!.unitPrice.amount).toBe(2500n);
    expect(view.subtotal.amount + view.shippingTotal.amount).toBe(view.total.amount);
    expect(view.number).toMatch(/^\d+$/);

    expect(
      await one<{ reserved: number; on_hand: number }>(
        sql`SELECT reserved, on_hand FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 2, on_hand: 5 });
    expect((await commerce.carts.get(db.primary, cartId)).status).toBe('converted');

    const events = await db.primary.execute<{ event_type: string }>(
      sql`SELECT event_type FROM outbox_events WHERE aggregate_id = ${order.orderId}`,
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(['order.placed']);
    const published: unknown[] = [];
    await relayOutbox(db.primary, async (e) => void published.push(e));
    expect(published).toContainEqual(
      expect.objectContaining({
        eventType: 'order.placed',
        payload: expect.objectContaining({ total: { amount: 5995n, currency: 'AUD' } }),
      }),
    );
  });

  it('is idempotent: same key returns the same order; reuse with another body is refused', async () => {
    const { variantId } = await seedVariant(db, { onHand: 5 });
    const cartId = await cartWith(variantId, 1);
    const k = key();
    const a = await commerce.checkout.place(db.primary, request(cartId), k);
    const b = await commerce.checkout.place(db.primary, request(cartId), k);
    expect(b.replayed).toBe(true);
    expect(b.order.orderId).toBe(a.order.orderId);
    expect(b.order.total.equals(a.order.total)).toBe(true);
    await expect(
      commerce.checkout.place(db.primary, request(cartId, { email: 'other@example.com' }), k),
    ).rejects.toMatchObject({ code: 'idempotency_key_reuse' });
    // A different key cannot place the (now converted) cart again.
    await expect(commerce.checkout.place(db.primary, request(cartId), key())).rejects.toMatchObject(
      {
        code: 'cart_closed',
      },
    );
    const n = await one<{ n: string }>(
      sql`SELECT count(*) AS n FROM orders WHERE cart_id = ${cartId}`,
    );
    expect(Number(n.n)).toBe(1);
    expect(
      await one<{ reserved: number }>(
        sql`SELECT reserved FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 1 });
  });

  it('20 concurrent retries of the same request create exactly one order', async () => {
    const { variantId } = await seedVariant(db, { onHand: 5 });
    const cartId = await cartWith(variantId, 1);
    const k = key();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => commerce.checkout.place(db.primary, request(cartId), k)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(new Set(ok.map((r) => r.value.order.orderId)).size).toBe(1);
    const n = await one<{ n: string }>(
      sql`SELECT count(*) AS n FROM orders WHERE cart_id = ${cartId}`,
    );
    expect(Number(n.n)).toBe(1);
    expect(
      await one<{ reserved: number }>(
        sql`SELECT reserved FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 1 });
  });

  it('sells exactly the stock under a stampede of 300 shoppers for 20 units, with no partial orders', async () => {
    const { variantId } = await seedVariant(db, { onHand: 20, price: 1000n });
    const carts = await Promise.all(
      Array.from({ length: 300 }, async () => {
        const cart = await commerce.carts.create(db.primary, { currency: 'AUD' });
        // Stock is only checked softly at add time, so all 300 can hold the item in a cart.
        await db.primary.execute(
          sql`INSERT INTO cart_lines (cart_id, variant_id, quantity) VALUES (${cart.id}, ${variantId}, 1)`,
        );
        return cart.id;
      }),
    );
    const limiter = new Semaphore('checkout', 24, 1000);
    const outcomes = await Promise.allSettled(
      carts.map((cartId) =>
        limiter.run(() => commerce.checkout.place(db.primary, request(cartId), key())),
      ),
    );
    const placed = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o) => o.status === 'rejected');
    expect(placed).toHaveLength(20);
    expect(failed.every((f) => (f.reason as { code?: string }).code === 'insufficient_stock')).toBe(
      true,
    );
    expect(
      await one<{ reserved: number; on_hand: number }>(
        sql`SELECT reserved, on_hand FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 20, on_hand: 20 });
    // Losers left nothing behind: no order rows, cart still open and re-tryable.
    const orderCount = await one<{ n: string }>(sql`
      SELECT count(*) AS n FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE l.variant_id = ${variantId}`);
    expect(Number(orderCount.n)).toBe(20);
    const openCarts = await one<{ n: string }>(sql`
      SELECT count(*) AS n FROM carts c JOIN cart_lines l ON l.cart_id = c.id
      WHERE l.variant_id = ${variantId} AND c.status = 'open'`);
    expect(Number(openCarts.n)).toBe(280);
  }, 120_000);

  it('refuses when the price moves between review and confirm (quote_changed) and writes nothing', async () => {
    const { variantId } = await seedVariant(db, { onHand: 5, price: 1000n });
    const cartId = await cartWith(variantId, 1);
    const repricing: HookRunner = {
      async run(_hook, input) {
        await db.primary.execute(
          sql`UPDATE variant_prices SET amount = 1200 WHERE variant_id = ${variantId}`,
        );
        return { payload: input, veto: null };
      },
    };
    const c = createCommerce({ hooks: repricing });
    await expect(c.checkout.place(db.primary, request(cartId), key())).rejects.toMatchObject({
      code: 'quote_changed',
    });
    expect(
      await one<{ reserved: number }>(
        sql`SELECT reserved FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 0 });
    expect((await commerce.carts.get(db.primary, cartId)).status).toBe('open');
    // The shopper confirms again at the new price and it works.
    const retry = await commerce.checkout.place(db.primary, request(cartId), key());
    expect(retry.order.total.amount).toBe(1200n + 995n);
  });

  it('an extension veto stops checkout before anything is written', async () => {
    const { variantId } = await seedVariant(db, { onHand: 5 });
    const cartId = await cartWith(variantId, 1);
    const veto: HookRunner = {
      async run(_hook, input) {
        return { payload: input, veto: { code: 'fraud_review', message: 'Held for review' } };
      },
    };
    await expect(
      createCommerce({ hooks: veto }).checkout.place(db.primary, request(cartId), key()),
    ).rejects.toMatchObject({ code: 'fraud_review' });
    expect((await commerce.carts.get(db.primary, cartId)).status).toBe('open');
    expect(
      await one<{ reserved: number }>(
        sql`SELECT reserved FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 0 });
  });

  it('rejects malformed input before touching the database', async () => {
    await expect(
      commerce.checkout.place(db.primary, { cartId: 'nope' } as never, key()),
    ).rejects.toThrow();
    const { variantId } = await seedVariant(db, { onHand: 1 });
    const cartId = await cartWith(variantId, 1);
    await expect(
      commerce.checkout.place(db.primary, request(cartId), 'short'),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('promotions at checkout', () => {
  it('applies a coupon, records the redemption, and enforces the global usage limit atomically', async () => {
    await commerce.promotions.create(db.primary, {
      name: 'Ten off',
      code: 'TEN',
      kind: 'percent_off',
      basisPoints: 1000,
      usageLimit: 1,
    });
    const { variantId } = await seedVariant(db, { onHand: 10, price: 10000n });
    const [c1, c2] = await Promise.all([
      cartWith(variantId, 1, 'ten'),
      cartWith(variantId, 1, 'TEN'),
    ]);
    const results = await Promise.allSettled([
      commerce.checkout.place(db.primary, request(c1!), key()),
      commerce.checkout.place(db.primary, request(c2!), key()),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'promotion_exhausted' });
    const placed = (ok[0] as PromiseFulfilledResult<{ order: { total: { amount: bigint } } }>)
      .value;
    expect(placed.order.total.amount).toBe(9000n + 995n);
    const promo = await one<{ usage_count: number }>(
      sql`SELECT usage_count FROM promotions WHERE code = 'ten'`,
    );
    expect(promo.usage_count).toBe(1);
    // The loser's stock hold rolled back with everything else.
    expect(
      await one<{ reserved: number }>(
        sql`SELECT reserved FROM inventory_levels WHERE variant_id = ${variantId}`,
      ),
    ).toMatchObject({ reserved: 1 });
  });

  it('enforces per-customer limits even under concurrency', async () => {
    await commerce.promotions.create(db.primary, {
      name: 'Once each',
      code: 'ONCE',
      kind: 'fixed_off',
      amount: { amount: '500', currency: 'AUD' },
      perCustomerLimit: 1,
    });
    const { variantId } = await seedVariant(db, { onHand: 10, price: 5000n });
    const carts = await Promise.all([1, 2, 3, 4].map(() => cartWith(variantId, 1, 'once')));
    const results = await Promise.allSettled(
      carts.map((cartId) =>
        commerce.checkout.place(db.primary, request(cartId, { email: 'same@example.com' }), key()),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => (r.reason as { code: string }).code === 'promotion_limit_reached'),
    ).toBe(true);
  });

  it('a malformed stored promotion is skipped, not fatal', async () => {
    await db.primary.execute(
      sql`INSERT INTO promotions (name, definition) VALUES ('broken', '{"kind":"percent_off","basisPoints":"lots"}'::jsonb)`,
    );
    const bad: string[] = [];
    const c = createCommerce({ onInvalidPromotion: (id) => bad.push(id) });
    const { variantId } = await seedVariant(db, { onHand: 3, price: 1000n });
    const cartId = await cartWith(variantId, 1);
    const q = await c.quotes.quote(db.primary, {
      cartId,
      destination: au,
      shippingMethodId: 'standard',
    });
    expect(q.discountTotal.amount).toBe(0n);
    expect(bad).toHaveLength(1);
  });
});

describe('order lifecycle and stock', () => {
  async function placeOne(onHand = 5, qty = 2) {
    const { variantId } = await seedVariant(db, { onHand });
    const cartId = await cartWith(variantId, qty);
    const { order } = await commerce.checkout.place(db.primary, request(cartId), key());
    return { variantId, cartId, orderId: order.orderId };
  }
  const stock = (variantId: string) =>
    one<{ reserved: number; on_hand: number }>(
      sql`SELECT reserved, on_hand FROM inventory_levels WHERE variant_id = ${variantId}`,
    );

  it('paid commits the hold into a permanent decrement', async () => {
    const { variantId, orderId } = await placeOne();
    const t = await commerce.orders.transition(db.primary, orderId, 'paid', { actor: 'payments' });
    expect(t).toMatchObject({ from: 'pending_payment', to: 'paid', stockShortfall: false });
    expect(await stock(variantId)).toMatchObject({ reserved: 0, on_hand: 3 });
    const events = await db.primary.execute<{ event_type: string }>(
      sql`SELECT event_type FROM outbox_events WHERE aggregate_id = ${orderId} ORDER BY created_at, id`,
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(['order.placed', 'order.status_changed']);
  });

  it('cancelling an unpaid order releases the hold; cancelling a paid one restocks', async () => {
    const a = await placeOne();
    await commerce.orders.transition(db.primary, a.orderId, 'cancelled', { actor: 'shopper' });
    expect(await stock(a.variantId)).toMatchObject({ reserved: 0, on_hand: 5 });
    const b = await placeOne();
    await commerce.orders.transition(db.primary, b.orderId, 'paid', { actor: 'payments' });
    await commerce.orders.transition(db.primary, b.orderId, 'cancelled', {
      actor: 'admin',
      reason: 'oos at warehouse',
    });
    expect(await stock(b.variantId)).toMatchObject({ reserved: 0, on_hand: 5 });
  });

  it('illegal and racing transitions are refused; only one of two racing finalisers wins', async () => {
    const { orderId, variantId } = await placeOne();
    await commerce.orders.transition(db.primary, orderId, 'cancelled', { actor: 'a' });
    await expect(
      commerce.orders.transition(db.primary, orderId, 'paid', { actor: 'b' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    const race = await placeOne();
    const results = await Promise.allSettled([
      commerce.orders.transition(db.primary, race.orderId, 'paid', { actor: 'webhook-1' }),
      commerce.orders.transition(db.primary, race.orderId, 'paid', { actor: 'webhook-2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'illegal_transition' },
    });
    // Stock was committed exactly once.
    expect(await stock(race.variantId)).toMatchObject({ reserved: 0, on_hand: 3 });
    expect(variantId).toBeDefined();
  });

  it('a hold that lapsed before payment is re-secured; if the stock is gone the order is flagged, not lost', async () => {
    const lapsed = await placeOne(2, 2);
    await commerce.inventory.sweepExpired(db.primary, new Date(Date.now() + 3 * 3_600_000));
    expect(await stock(lapsed.variantId)).toMatchObject({ reserved: 0, on_hand: 2 });
    const ok = await commerce.orders.transition(db.primary, lapsed.orderId, 'paid', {
      actor: 'payments',
    });
    expect(ok.stockShortfall).toBe(false);
    expect(await stock(lapsed.variantId)).toMatchObject({ reserved: 0, on_hand: 0 });

    const gone = await placeOne(2, 2);
    await commerce.inventory.sweepExpired(db.primary, new Date(Date.now() + 3 * 3_600_000));
    await db.primary.execute(
      sql`UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = ${gone.variantId}`,
    );
    const flagged = await commerce.orders.transition(db.primary, gone.orderId, 'paid', {
      actor: 'payments',
    });
    expect(flagged.stockShortfall).toBe(true);
    expect((await commerce.orders.get(db.primary, gone.orderId)).status).toBe('paid');
    const attn = await db.primary.execute<{ event_type: string }>(
      sql`SELECT event_type FROM outbox_events WHERE aggregate_id = ${gone.orderId} AND event_type = 'order.attention_required'`,
    );
    expect(attn.rows).toHaveLength(1);
  });

  it('cancelUnpaid cancels only stale unpaid orders and frees their stock', async () => {
    const stale = await placeOne();
    const fresh = await placeOne();
    const paid = await placeOne();
    await commerce.orders.transition(db.primary, paid.orderId, 'paid', { actor: 'payments' });
    await db.primary.execute(
      sql`UPDATE orders SET placed_at = now() - interval '2 hours' WHERE id IN (${stale.orderId}::uuid, ${paid.orderId}::uuid)`,
    );
    const n = await commerce.orders.cancelUnpaid(db.primary, 30);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await commerce.orders.get(db.primary, stale.orderId)).status).toBe('cancelled');
    expect((await commerce.orders.get(db.primary, fresh.orderId)).status).toBe('pending_payment');
    expect((await commerce.orders.get(db.primary, paid.orderId)).status).toBe('paid');
    expect(await stock(stale.variantId)).toMatchObject({ reserved: 0, on_hand: 5 });
  });
});
