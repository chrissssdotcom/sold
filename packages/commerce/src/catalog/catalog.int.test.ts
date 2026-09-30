import { Money } from '@sold/core';
import { QueryCounter, createDb, schema, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMigrated } from '../test-support';
import { CatalogService } from './service';

let testDb: TestDatabase;
let db: Db;
const catalog = new CatalogService();

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const variant = (sku: string, price = '1999') => ({
  sku,
  prices: [
    { currency: 'AUD', amount: price },
    { currency: 'JPY', amount: '1500' },
  ],
  onHand: 5,
});

describe('catalog', () => {
  it('creates a product with variants, prices and stock atomically', async () => {
    const p = await catalog.create(db.primary, {
      handle: 'tee',
      title: 'Tee',
      status: 'active',
      variants: [variant('TEE-S'), variant('TEE-M', '2099')],
    });
    expect(p.variants.map((v) => v.sku)).toEqual(['TEE-S', 'TEE-M']);
    const aud = p.variants[1]!.prices.find((x) => x.currency === 'AUD')!;
    expect(aud.amount.equals(Money.of(2099n, 'AUD'))).toBe(true);
    const stock = await db.primary.select().from(schema.inventoryLevels);
    expect(stock.filter((s) => p.variants.some((v) => v.id === s.variantId))).toHaveLength(2);
  });

  it('rolls everything back when a SKU or handle is taken', async () => {
    await expect(
      catalog.create(db.primary, { handle: 'tee', title: 'x', variants: [variant('NEW-1')] }),
    ).rejects.toMatchObject({ code: 'handle_taken' });
    await expect(
      catalog.create(db.primary, { handle: 'other', title: 'x', variants: [variant('TEE-S')] }),
    ).rejects.toMatchObject({ code: 'sku_taken' });
    const rows = await db.primary.select().from(schema.products);
    expect(rows.map((r) => r.handle)).not.toContain('other');
  });

  it('rejects bad input (currency, duplicate sku, handle)', async () => {
    await expect(
      catalog.create(db.primary, { handle: 'Bad Handle', title: 'x', variants: [variant('A')] }),
    ).rejects.toThrow();
    await expect(
      catalog.create(db.primary, {
        handle: 'dupe',
        title: 'x',
        variants: [variant('D1'), variant('D1')],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      catalog.create(db.primary, {
        handle: 'zzz',
        title: 'x',
        variants: [{ sku: 'Z1', prices: [{ currency: 'XXQ', amount: '1' }] }],
      }),
    ).rejects.toThrow();
  });

  it('a product page costs 3 queries regardless of variant count (no N+1)', async () => {
    await catalog.create(db.primary, {
      handle: 'big',
      title: 'Big',
      status: 'active',
      variants: Array.from({ length: 40 }, (_, i) => variant(`BIG-${i}`)),
    });
    const counter = new QueryCounter();
    const counted = createDb({ primaryUrl: testDb.url, logger: counter });
    try {
      const p = await catalog.getActiveByHandle(counted.replica, 'big');
      expect(p.variants).toHaveLength(40);
      expect(counter.queries).toHaveLength(3);
    } finally {
      await counted.close();
    }
  });

  it('hides draft products from the storefront', async () => {
    await catalog.create(db.primary, {
      handle: 'secret',
      title: 'S',
      variants: [variant('SEC-1')],
    });
    await expect(catalog.getActiveByHandle(db.replica, 'secret')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keyset pagination visits every active product exactly once, newest first', async () => {
    for (let i = 0; i < 25; i++)
      await catalog.create(db.primary, {
        handle: `page-${i}`,
        title: `P${i}`,
        status: 'active',
        variants: [variant(`PG-${i}`)],
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await catalog.listActive(db.replica, {
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const all = await db.primary.select().from(schema.products);
    const active = all.filter((p) => p.status === 'active').map((p) => p.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...active].sort());
    await expect(catalog.listActive(db.replica, { cursor: 'nonsense' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('updates prices per currency and status', async () => {
    const p = await catalog.create(db.primary, {
      handle: 'upd',
      title: 'U',
      variants: [variant('UPD-1')],
    });
    const v = p.variants[0]!;
    await catalog.setPrice(db.primary, v.id, { currency: 'AUD', amount: Money.of(500n, 'AUD') });
    await catalog.setStatus(db.primary, p.id, 'active');
    const fresh = await catalog.getActiveByHandle(db.primary, 'upd');
    expect(fresh.variants[0]!.prices.find((x) => x.currency === 'AUD')!.amount.amount).toBe(500n);
    await expect(
      catalog.setPrice(db.primary, v.id, { currency: 'AUD', amount: Money.of(500n, 'JPY') }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
