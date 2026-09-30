import { Redis } from 'ioredis';
import { Semaphore } from '@sold/core';
import { sql, type Db } from '@sold/db';
import {
  createTestDatabase,
  createTestRedis,
  type TestDatabase,
  type TestRedis,
} from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InsufficientStockError } from '../errors';
import { openMigrated, seedVariant } from '../test-support';
import {
  GatedReservationStrategy,
  InventoryGate,
  InventoryService,
  PostgresReservationStrategy,
  type InventoryReservationStrategy,
} from './index';

let testDb: TestDatabase;
let db: Db;
let testRedis: TestRedis | null;
let redis: Redis;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 20);
  testRedis = await createTestRedis();
  if (testRedis) redis = new Redis(testRedis.url);
});
afterAll(async () => {
  redis?.disconnect();
  await testRedis?.stop();
  await db?.close();
  await testDb?.destroy();
});

const pg = () => new PostgresReservationStrategy();

async function invariants(variantId: string) {
  const level = (
    await db.primary.execute<{ on_hand: number; reserved: number }>(
      sql`SELECT on_hand, reserved FROM inventory_levels WHERE variant_id = ${variantId}`,
    )
  ).rows[0]!;
  const held = (
    await db.primary.execute<{ q: string | null; n: string }>(
      sql`SELECT sum(quantity) AS q, count(*) AS n FROM inventory_reservations
          WHERE variant_id = ${variantId} AND status = 'held'`,
    )
  ).rows[0]!;
  return { ...level, heldUnits: Number(held.q ?? 0), heldRows: Number(held.n) };
}

/** Fire `buyers` concurrent reservations, bounded like a real web tier (in-flight cap + bounded queue). */
async function stampede(
  service: InventoryService,
  variantId: string,
  buyers: number,
  qty: () => number,
) {
  const limiter = new Semaphore('stampede', 64, buyers);
  let ok = 0;
  let soldOut = 0;
  const other: unknown[] = [];
  await Promise.all(
    Array.from({ length: buyers }, (_, i) =>
      limiter
        .run(() => service.reserve(db.primary, `buyer-${i}`, variantId, qty()))
        .then(() => void ok++)
        .catch((e: unknown) => {
          if (e instanceof InsufficientStockError) soldOut++;
          else other.push(e);
        }),
    ),
  );
  return { ok, soldOut, other };
}

describe('hot-SKU drop: 5,000 buyers, 100 units', () => {
  it('Postgres strategy sells exactly 100 and never oversells', async () => {
    const { variantId } = await seedVariant(db, { onHand: 100 });
    const service = new InventoryService({ strategy: pg() });
    const started = Date.now();
    const r = await stampede(service, variantId, 5_000, () => 1);
    const elapsedMs = Date.now() - started;
    expect(r.other).toEqual([]);
    expect(r.ok).toBe(100);
    expect(r.soldOut).toBe(4_900);
    const inv = await invariants(variantId);
    expect(inv).toMatchObject({ on_hand: 100, reserved: 100, heldUnits: 100, heldRows: 100 });
    process.stdout.write(`[drop] postgres strategy: 5000 buyers in ${elapsedMs}ms\n`);
  }, 120_000);

  it('gated strategy sells exactly 100 and shields Postgres from the losers', async () => {
    if (!testRedis) return expect.soft(true, 'redis unavailable: skipped').toBe(true);
    const { variantId } = await seedVariant(db, { onHand: 100 });
    let reachedPostgres = 0;
    const inner: InventoryReservationStrategy = {
      name: 'counting',
      reserve: (d, req) => (reachedPostgres++, pg().reserve(d, req)),
      release: (d, o, v) => pg().release(d, o, v),
      commit: (t, o) => pg().commit(t, o),
      expire: (d, n, l) => pg().expire(d, n, l),
    };
    const gate = new InventoryGate({
      redis,
      availability: async (id) =>
        (await new InventoryService({ strategy: pg() }).level(db.primary, id)).available,
    });
    const service = new InventoryService({
      strategy: new GatedReservationStrategy(inner, gate),
      gate,
    });
    const started = Date.now();
    const r = await stampede(service, variantId, 5_000, () => 1);
    const elapsedMs = Date.now() - started;
    expect(r.other).toEqual([]);
    expect(r.ok).toBe(100);
    expect(r.soldOut).toBe(4_900);
    expect(await invariants(variantId)).toMatchObject({
      on_hand: 100,
      reserved: 100,
      heldUnits: 100,
    });
    // The gate turned away nearly everyone before they reached the database row.
    expect(reachedPostgres).toBeLessThan(400);
    process.stdout.write(
      `[drop] gated strategy: 5000 buyers in ${elapsedMs}ms, ${reachedPostgres} reached postgres\n`,
    );
  }, 120_000);

  it('mixed quantities never exceed stock', async () => {
    const { variantId } = await seedVariant(db, { onHand: 100 });
    const service = new InventoryService({ strategy: pg() });
    let n = 0;
    const r = await stampede(service, variantId, 400, () => 1 + (n++ % 3));
    expect(r.other).toEqual([]);
    const inv = await invariants(variantId);
    expect(inv.reserved).toBe(inv.heldUnits);
    expect(inv.reserved).toBeLessThanOrEqual(100);
  }, 60_000);
});

describe('reservation lifecycle', () => {
  it('is idempotent per (owner, variant) and adjusts quantity', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const service = new InventoryService({ strategy: pg() });
    const a = await service.reserve(db.primary, 'cart-1', variantId, 3);
    const b = await service.reserve(db.primary, 'cart-1', variantId, 3);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.reservationId).toBe(a.reservationId);
    expect(await invariants(variantId)).toMatchObject({ reserved: 3, heldRows: 1 });
    await service.reserve(db.primary, 'cart-1', variantId, 5);
    expect(await invariants(variantId)).toMatchObject({ reserved: 5, heldUnits: 5 });
    await service.reserve(db.primary, 'cart-1', variantId, 2);
    expect(await invariants(variantId)).toMatchObject({ reserved: 2, heldUnits: 2 });
    await expect(service.reserve(db.primary, 'cart-1', variantId, 11)).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    // A refused adjustment leaves the existing hold untouched.
    expect(await invariants(variantId)).toMatchObject({ reserved: 2, heldUnits: 2 });
  });

  it('concurrent identical requests create one hold', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const service = new InventoryService({ strategy: pg() });
    await Promise.all(
      Array.from({ length: 20 }, () => service.reserve(db.primary, 'same', variantId, 4)),
    );
    expect(await invariants(variantId)).toMatchObject({ reserved: 4, heldRows: 1 });
  });

  it('release returns stock; expiry sweep returns stock past TTL only', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const service = new InventoryService({ strategy: pg() });
    await service.reserve(db.primary, 'a', variantId, 2, 60);
    await service.reserve(db.primary, 'b', variantId, 3, 1);
    expect(await service.release(db.primary, 'a')).toEqual([{ variantId, quantity: 2 }]);
    expect(await invariants(variantId)).toMatchObject({ reserved: 3 });
    expect(await service.sweepExpired(db.primary, new Date())).toBe(0);
    expect(await service.sweepExpired(db.primary, new Date(Date.now() + 5_000))).toBe(1);
    expect(await invariants(variantId)).toMatchObject({ reserved: 0, heldRows: 0 });
    // releasing twice is harmless
    expect(await service.release(db.primary, 'a')).toEqual([]);
  });

  it('commit turns a hold into a permanent decrement inside the caller transaction', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const strategy = pg();
    const service = new InventoryService({ strategy });
    await service.reserve(db.primary, 'order-1', variantId, 4);
    await db.primary.transaction(async (tx) => {
      expect(await strategy.commit(tx, 'order-1')).toEqual([{ variantId, quantity: 4 }]);
    });
    expect(await invariants(variantId)).toMatchObject({ on_hand: 6, reserved: 0, heldRows: 0 });
    // A rolled-back order transaction leaves the hold intact.
    await service.reserve(db.primary, 'order-2', variantId, 2);
    await expect(
      db.primary.transaction(async (tx) => {
        await strategy.commit(tx, 'order-2');
        throw new Error('payment failed');
      }),
    ).rejects.toThrow('payment failed');
    expect(await invariants(variantId)).toMatchObject({ on_hand: 6, reserved: 2, heldRows: 1 });
  });

  it('reserveMany is all-or-nothing', async () => {
    const a = await seedVariant(db, { onHand: 5 });
    const b = await seedVariant(db, { onHand: 1 });
    const service = new InventoryService({ strategy: pg() });
    await expect(
      service.reserveMany(db.primary, 'cart-x', [
        { variantId: a.variantId, quantity: 2 },
        { variantId: b.variantId, quantity: 2 },
      ]),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await invariants(a.variantId)).toMatchObject({ reserved: 0, heldRows: 0 });
    expect(await invariants(b.variantId)).toMatchObject({ reserved: 0, heldRows: 0 });
  });

  it('multi-line checkouts locking the same variants in opposite request order do not deadlock', async () => {
    const a = await seedVariant(db, { onHand: 1_000 });
    const b = await seedVariant(db, { onHand: 1_000 });
    const service = new InventoryService({ strategy: pg() });
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) =>
        service.reserveMany(
          db.primary,
          `multi-${i}`,
          i % 2 === 0
            ? [
                { variantId: a.variantId, quantity: 1 },
                { variantId: b.variantId, quantity: 1 },
              ]
            : [
                { variantId: b.variantId, quantity: 1 },
                { variantId: a.variantId, quantity: 1 },
              ],
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await invariants(a.variantId)).toMatchObject({ reserved: 60 });
  });

  it('backorder variants sell past zero; commit never drives on_hand negative', async () => {
    const { variantId } = await seedVariant(db, { onHand: 1 });
    const strategy = pg();
    const service = new InventoryService({ strategy });
    await service.setOnHand(db.primary, variantId, 1, { allowBackorder: true });
    await service.reserve(db.primary, 'pre-1', variantId, 5);
    await db.primary.transaction((tx) => strategy.commit(tx, 'pre-1'));
    expect(await invariants(variantId)).toMatchObject({ on_hand: 0, reserved: 0 });
  });

  it('setOnHand refuses to drop below reserved stock', async () => {
    const { variantId } = await seedVariant(db, { onHand: 10 });
    const service = new InventoryService({ strategy: pg() });
    await service.reserve(db.primary, 'c', variantId, 6);
    await expect(service.setOnHand(db.primary, variantId, 5)).rejects.toThrow(/below/);
    await service.setOnHand(db.primary, variantId, 6);
    expect(await invariants(variantId)).toMatchObject({ on_hand: 6, reserved: 6 });
  });

  it('the database itself refuses an oversell written around the application', async () => {
    const { variantId } = await seedVariant(db, { onHand: 2 });
    const error = await db.primary
      .execute(sql`UPDATE inventory_levels SET reserved = 3 WHERE variant_id = ${variantId}`)
      .then(() => null)
      .catch((e: unknown) => e as Error & { cause?: { message?: string } });
    expect(error?.cause?.message ?? error?.message).toMatch(/inventory_levels_bounds_check/);
  });
});

describe('admission gate', () => {
  it('fails open when Redis is unavailable, and stays correct', async () => {
    const { variantId } = await seedVariant(db, { onHand: 20 });
    const broken = {
      eval: () => Promise.reject(new Error('redis down')),
      del: () => Promise.reject(new Error('redis down')),
    };
    const events: string[] = [];
    const gate = new InventoryGate({
      redis: broken,
      availability: async () => 20,
      onEvent: (e) => events.push(e),
    });
    const service = new InventoryService({
      strategy: new GatedReservationStrategy(pg(), gate),
      gate,
    });
    const r = await stampede(service, variantId, 200, () => 1);
    expect(r.other).toEqual([]);
    expect(r.ok).toBe(20);
    expect(events).toContain('redis_error');
  });

  it('re-derives a wrong (stale-low) counter from Postgres after invalidation', async () => {
    if (!testRedis) return;
    const { variantId } = await seedVariant(db, { onHand: 5 });
    const gate = new InventoryGate({
      redis,
      availability: async () => 5,
    });
    const service = new InventoryService({
      strategy: new GatedReservationStrategy(pg(), gate),
      gate,
    });
    await redis.set(`inv:gate:${variantId}`, '0', 'EX', 30); // simulated drift: gate says sold out
    await expect(service.reserve(db.primary, 'x', variantId, 1)).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
    await service.setOnHand(db.primary, variantId, 5); // admin action invalidates the counter
    await expect(service.reserve(db.primary, 'x', variantId, 1)).resolves.toMatchObject({
      created: true,
    });
  });
});
