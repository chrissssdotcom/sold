import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookRunner } from '../hooks';
import { openMigrated, seedVariant } from '../test-support';
import { CartService } from './service';

let testDb: TestDatabase;
let db: Db;
beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const carts = new CartService();

describe('cart', () => {
  it('adds, accumulates, sets and removes lines; bumps version', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    expect(cart.version).toBe(1);
    const a = await carts.addItem(db.primary, cart.id, variantId, 2);
    const b = await carts.addItem(db.primary, cart.id, variantId, 3);
    expect(b.lines).toEqual([expect.objectContaining({ variantId, quantity: 5 })]);
    expect(b.version).toBe(a.version + 1);
    const c = await carts.setQuantity(db.primary, cart.id, variantId, 1);
    expect(c.lines[0]?.quantity).toBe(1);
    const d = await carts.setQuantity(db.primary, cart.id, variantId, 0);
    expect(d.lines).toEqual([]);
  });

  it('refuses unsellable things: over stock, wrong currency, unknown variant, bad quantity', async () => {
    const { variantId } = await seedVariant(db, { onHand: 2 });
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    await expect(carts.addItem(db.primary, cart.id, variantId, 3)).rejects.toMatchObject({
      code: 'insufficient_stock',
    });
    const nzd = await carts.create(db.primary, { currency: 'NZD' });
    await expect(carts.addItem(db.primary, nzd.id, variantId, 1)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      carts.addItem(db.primary, cart.id, '00000000-0000-7000-8000-000000000000', 1),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(carts.addItem(db.primary, cart.id, variantId, 0)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(carts.addItem(db.primary, cart.id, variantId, 1.5)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(carts.addItem(db.primary, cart.id, variantId, 100)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('does not sell draft products', async () => {
    const { variantId, productId } = await seedVariant(db, { onHand: 5 });
    await db.primary.execute(sql`UPDATE products SET status = 'draft' WHERE id = ${productId}`);
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    await expect(carts.addItem(db.primary, cart.id, variantId, 1)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('concurrent adds to one cart lose no updates', async () => {
    const { variantId } = await seedVariant(db, { onHand: 500 });
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    await Promise.all(
      Array.from({ length: 40 }, () => carts.addItem(db.primary, cart.id, variantId, 1)),
    );
    const final = await carts.get(db.primary, cart.id);
    expect(final.lines[0]?.quantity).toBe(40);
    expect(final.version).toBe(41);
  });

  it('optimistic concurrency: a stale expectedVersion is refused', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    await carts.addItem(db.primary, cart.id, variantId, 1);
    await expect(
      carts.addItem(db.primary, cart.id, variantId, 1, { expectedVersion: cart.version }),
    ).rejects.toMatchObject({ code: 'cart_version_conflict' });
  });

  it('interceptors can veto or reduce a quantity; a veto is a domain error', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    const limit = {
      async run(_hook: string, input: { quantity: number }) {
        return { payload: { ...input, quantity: Math.min(input.quantity, 2) }, veto: null };
      },
    } as unknown as HookRunner;
    const limited = new CartService({ hooks: limit });
    const c = await limited.addItem(db.primary, cart.id, variantId, 5);
    expect(c.lines[0]?.quantity).toBe(2);
    const veto: HookRunner = {
      async run(_hook, input) {
        return { payload: input, veto: { code: 'drop_closed', message: 'The drop has ended' } };
      },
    };
    await expect(
      new CartService({ hooks: veto }).addItem(db.primary, cart.id, variantId, 1),
    ).rejects.toMatchObject({
      code: 'drop_closed',
    });
  });

  it('coupons are normalised, deduplicated and capped', async () => {
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    await carts.applyCoupon(db.primary, cart.id, ' SAVE10 ');
    const c = await carts.applyCoupon(db.primary, cart.id, 'save10');
    expect(c.couponCodes).toEqual(['save10']);
    expect((await carts.removeCoupon(db.primary, cart.id, 'SAVE10')).couponCodes).toEqual([]);
    await expect(carts.applyCoupon(db.primary, cart.id, 'bad code!')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('merges a guest cart into the customer cart, summing quantities, and abandons the guest cart', async () => {
    const a = await seedVariant(db, { onHand: 50 });
    const b = await seedVariant(db, { onHand: 50 });
    const guest = await carts.create(db.primary, { currency: 'AUD' });
    const mine = await carts.create(db.primary, { currency: 'AUD' });
    await carts.addItem(db.primary, guest.id, a.variantId, 2);
    await carts.addItem(db.primary, guest.id, b.variantId, 1);
    await carts.addItem(db.primary, mine.id, a.variantId, 3);
    const merged = await carts.merge(db.primary, guest.id, mine.id);
    const qty = Object.fromEntries(merged.lines.map((l) => [l.variantId, l.quantity]));
    expect(qty).toEqual({ [a.variantId]: 5, [b.variantId]: 1 });
    expect((await carts.get(db.primary, guest.id)).status).toBe('abandoned');
    await expect(carts.addItem(db.primary, guest.id, a.variantId, 1)).rejects.toMatchObject({
      code: 'cart_closed',
    });
  });

  it('a closed cart cannot be modified', async () => {
    const { variantId } = await seedVariant(db, { onHand: 5 });
    const cart = await carts.create(db.primary, { currency: 'AUD' });
    await carts.markConverted(db.primary, cart.id);
    await expect(carts.addItem(db.primary, cart.id, variantId, 1)).rejects.toMatchObject({
      code: 'cart_closed',
    });
  });
});
