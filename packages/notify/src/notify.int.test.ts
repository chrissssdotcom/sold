import { createCommerce, relayOutbox, type Commerce } from '@sold/commerce';
import { openMigrated, seedVariant } from '@sold/commerce/testing';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyOnEvent } from './consumers';
import { NotificationService } from './service';
import { MemoryTransport } from './transport';

let testDb: TestDatabase;
let db: Db;
let commerce: Commerce;
const site = { name: 'Test Shop', url: 'https://shop.example' };
const notify = new NotificationService({
  site,
  from: 'Test Shop <shop@example.test>',
  maxAttempts: 3,
});
let n = 0;
const key = () => `k-${++n}-${Math.random().toString(36).slice(2, 8)}`;
const welcome = { name: 'Sam', accountUrl: 'https://shop.example/en-au/account' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 20);
  commerce = createCommerce();
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const row = async (dedupe: string) =>
  (
    await db.primary.execute<Record<string, unknown>>(
      sql`SELECT * FROM notifications WHERE dedupe_key = ${dedupe}`,
    )
  ).rows[0]!;
const makeDue = (dedupe: string) =>
  db.primary.execute(
    sql`UPDATE notifications SET available_at = now() - interval '1 second' WHERE dedupe_key = ${dedupe}`,
  );

describe('queue', () => {
  it('enqueue is idempotent per key; delivery sends once and records the provider id', async () => {
    const k = key();
    const t = new MemoryTransport();
    expect(
      await notify.enqueue(db.primary, {
        dedupeKey: k,
        template: 'welcome',
        to: ' Sam@Example.TEST ',
        data: welcome,
      }),
    ).toBe(true);
    expect(
      await notify.enqueue(db.primary, {
        dedupeKey: k,
        template: 'welcome',
        to: 'sam@example.test',
        data: welcome,
      }),
    ).toBe(false);
    const r = await notify.deliverDue(db.primary, t);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const mine = t.sent.filter((m) => m.idempotencyKey === k);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe('sam@example.test'); // normalised
    expect(mine[0]!.from).toBe('Test Shop <shop@example.test>');
    expect(await row(k)).toMatchObject({
      status: 'sent',
      provider_id: expect.stringMatching(/^mem-/),
    });
    // Nothing left to do: a second pass sends nothing for this key.
    await notify.deliverDue(db.primary, t);
    expect(t.sent.filter((m) => m.idempotencyKey === k)).toHaveLength(1);
  });

  it('refuses unusable addresses and data that does not fit the template, at enqueue time', async () => {
    expect(
      await notify.enqueue(db.primary, {
        dedupeKey: key(),
        template: 'welcome',
        to: 'not-an-email',
        data: welcome,
      }),
    ).toBe(false);
    expect(
      await notify.enqueue(db.primary, {
        dedupeKey: key(),
        template: 'welcome',
        to: 'a\nb@example.test',
        data: welcome,
      }),
    ).toBe(false);
    await expect(
      notify.enqueue(db.primary, {
        dedupeKey: key(),
        template: 'welcome',
        to: 'a@example.test',
        data: { accountUrl: 'javascript:alert(1)' },
      }),
    ).rejects.toThrow();
  });

  it('retries a transient failure with backoff, then succeeds', async () => {
    const k = key();
    const t = new MemoryTransport();
    t.failNext = 1;
    await notify.enqueue(db.primary, {
      dedupeKey: k,
      template: 'welcome',
      to: 'retry@example.test',
      data: welcome,
    });
    await notify.deliverDue(db.primary, t);
    const failed = await row(k);
    expect(failed).toMatchObject({ status: 'queued', attempts: 1 });
    expect(new Date(failed['available_at'] as string).getTime()).toBeGreaterThan(
      Date.now() + 10_000,
    ); // backed off, not hammered
    expect(String(failed['last_error'])).toContain('simulated');
    await makeDue(k);
    await notify.deliverDue(db.primary, t);
    expect(await row(k)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('gives up after maxAttempts, and immediately on a permanent failure', async () => {
    const t = new MemoryTransport();
    const k1 = key();
    t.failNext = 99;
    await notify.enqueue(db.primary, {
      dedupeKey: k1,
      template: 'welcome',
      to: 'give-up@example.test',
      data: welcome,
    });
    for (let i = 0; i < 3; i++) {
      await makeDue(k1);
      await notify.deliverDue(db.primary, t);
    }
    expect(await row(k1)).toMatchObject({ status: 'failed', attempts: 3 });

    const k2 = key();
    t.permanent = true;
    t.failNext = 1;
    await notify.enqueue(db.primary, {
      dedupeKey: k2,
      template: 'welcome',
      to: 'bounce@example.test',
      data: welcome,
    });
    await notify.deliverDue(db.primary, t);
    expect(await row(k2)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('never mails a suppressed address, even transactional mail', async () => {
    const t = new MemoryTransport();
    const k = key();
    await notify.suppress(db.primary, 'Nope@Example.test', 'hard bounce');
    await notify.enqueue(db.primary, {
      dedupeKey: k,
      template: 'welcome',
      to: 'nope@example.test',
      data: welcome,
    });
    const r = await notify.deliverDue(db.primary, t);
    expect(r.suppressed).toBeGreaterThanOrEqual(1);
    expect(t.sent.find((m) => m.idempotencyKey === k)).toBeUndefined();
    expect(await row(k)).toMatchObject({ status: 'suppressed' });
  });

  it('a worker that died mid-send is recovered when its lease expires', async () => {
    const k = key();
    const t = new MemoryTransport();
    await notify.enqueue(db.primary, {
      dedupeKey: k,
      template: 'welcome',
      to: 'lease@example.test',
      data: welcome,
    });
    // Simulate a claim by a worker that then crashed: status 'sending', lease in the future.
    await db.primary.execute(
      sql`UPDATE notifications SET status='sending', attempts=1, available_at = now() + interval '5 minutes' WHERE dedupe_key=${k}`,
    );
    await notify.deliverDue(db.primary, t);
    expect(t.sent.find((m) => m.idempotencyKey === k)).toBeUndefined(); // leased: another worker owns it
    await makeDue(k); // the lease expires
    await notify.deliverDue(db.primary, t);
    expect(t.sent.filter((m) => m.idempotencyKey === k)).toHaveLength(1);
  });

  it('many workers delivering at once send each message exactly once', async () => {
    const t = new MemoryTransport();
    const keys = Array.from({ length: 40 }, () => key());
    for (const k of keys)
      await notify.enqueue(db.primary, {
        dedupeKey: k,
        template: 'welcome',
        to: `c-${k}@example.test`,
        data: welcome,
      });
    await Promise.all(
      Array.from({ length: 8 }, () => notify.deliverDue(db.primary, t, { batch: 10 })),
    );
    await notify.deliverDue(db.primary, t, { batch: 50 });
    const counts = new Map<string, number>();
    for (const m of t.sent) counts.set(m.idempotencyKey, (counts.get(m.idempotencyKey) ?? 0) + 1);
    for (const k of keys) expect(counts.get(k), k).toBe(1);
  });

  it('delayed emails wait until due', async () => {
    const k = key();
    const t = new MemoryTransport();
    await notify.enqueue(db.primary, {
      dedupeKey: k,
      template: 'welcome',
      to: 'later@example.test',
      data: welcome,
      delaySeconds: 3600,
    });
    await notify.deliverDue(db.primary, t);
    expect(t.sent.find((m) => m.idempotencyKey === k)).toBeUndefined();
    expect(await row(k)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('order events -> emails (through the real outbox relay)', () => {
  const au = {
    line1: '1 George St',
    city: 'Sydney',
    region: 'NSW',
    postalCode: '2000',
    country: 'AU',
  };

  async function placeOrder(email: string) {
    const { variantId } = await seedVariant(db, {
      onHand: 5,
      price: 2500n,
      title: 'Ember <b>candle</b>',
    });
    const cart = await commerce.carts.create(db.primary, { currency: 'AUD' });
    await commerce.carts.addItem(db.primary, cart.id, variantId, 2);
    const { order } = await commerce.checkout.place(
      db.primary,
      { cartId: cart.id, email, shippingAddress: au, shippingMethodId: 'standard' },
      `notify-${key()}`,
    );
    return order;
  }

  const deps = () => ({
    db: db.primary,
    notify,
    orders: commerce.orders,
    orderUrl: (id: string) => `https://shop.example/en-au/order/${id}`,
  });

  it('order.placed queues exactly one confirmation, even when the event is delivered twice', async () => {
    const email = `buyer-${key()}@example.test`;
    const order = await placeOrder(email);
    // Deliver the same outbox event twice (at-least-once relay) by invoking the consumer directly with the same event id.
    const ev = {
      eventId: `evt-${key()}`,
      eventType: 'order.placed',
      payload: { orderId: order.orderId },
    };
    expect(await notifyOnEvent(deps(), ev)).toBe(true);
    expect(await notifyOnEvent(deps(), ev)).toBe(true);
    const t = new MemoryTransport();
    await notify.deliverDue(db.primary, t, { batch: 100 });
    const mine = t.sent.filter((m) => m.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain(`#${order.number}`);
    expect(mine[0]!.html).toContain('Ember &lt;b&gt;candle&lt;/b&gt; - Default × 2'); // product title escaped
    expect(mine[0]!.text).toContain('$50.00');
    expect(mine[0]!.html).toContain(`https://shop.example/en-au/order/${order.orderId}`);
  });

  it('works end to end through relayOutbox: placing an order produces one email', async () => {
    const email = `relay-${key()}@example.test`;
    const order = await placeOrder(email);
    await relayOutbox(
      db.primary,
      async (e) => {
        await notifyOnEvent(deps(), e);
      },
      { batch: 500 },
    );
    const t = new MemoryTransport();
    await notify.deliverDue(db.primary, t, { batch: 100 });
    expect(t.sent.filter((m) => m.to === email)).toHaveLength(1);
    void order;
  });

  it('shipping and cancellation emails follow status changes; unrelated events are ignored', async () => {
    const email = `ship-${key()}@example.test`;
    const order = await placeOrder(email);
    const ship = {
      eventId: `evt-${key()}`,
      eventType: 'order.status_changed',
      payload: { orderId: order.orderId, from: 'processing', to: 'shipped' },
    };
    const cancel = {
      eventId: `evt-${key()}`,
      eventType: 'order.status_changed',
      payload: { orderId: order.orderId, from: 'paid', to: 'cancelled' },
    };
    const paid = {
      eventId: `evt-${key()}`,
      eventType: 'order.status_changed',
      payload: { orderId: order.orderId, from: 'pending_payment', to: 'paid' },
    };
    expect(await notifyOnEvent(deps(), ship)).toBe(true);
    expect(await notifyOnEvent(deps(), cancel)).toBe(true);
    expect(await notifyOnEvent(deps(), paid)).toBe(false);
    expect(
      await notifyOnEvent(deps(), { eventId: 'x', eventType: 'cart.updated', payload: {} }),
    ).toBe(false);
    const t = new MemoryTransport();
    await notify.deliverDue(db.primary, t, { batch: 100 });
    const subjects = t.sent.filter((m) => m.to === email).map((m) => m.subject);
    expect(subjects.some((s) => s.includes('shipped'))).toBe(true);
    expect(subjects.some((s) => s.includes('cancelled'))).toBe(true);
  });
});

describe('stats', () => {
  it('reports queue depth and failures for alerting', async () => {
    const s = await notify.stats(db.primary);
    expect(s.failed).toBeGreaterThanOrEqual(2);
    expect(typeof s.queued).toBe('number');
  });
});
