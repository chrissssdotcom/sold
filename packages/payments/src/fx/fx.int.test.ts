import { Money } from '@sold/core';
import { openMigrated, seedVariant } from '@sold/commerce/testing';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticFxProvider } from './provider';
import { FxRateUnavailableError, FxService } from './service';

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

const one = async <T>(q: ReturnType<typeof sql>) =>
  (await db.primary.execute<T & Record<string, unknown>>(q)).rows[0]!;

describe('rate ingestion', () => {
  it('appends history and serves the latest, or the rate in force at a past instant', async () => {
    const t = { now: new Date('2026-06-01T00:00:00Z') };
    const fx = new FxService({ now: () => t.now });
    await fx.refresh(db.primary, new StaticFxProvider({ AUDUSD: '0.65' }), 'AUD', ['USD']);
    t.now = new Date('2026-06-02T00:00:00Z');
    await fx.refresh(db.primary, new StaticFxProvider({ AUDUSD: '0.66' }), 'AUD', ['USD']);
    expect((await fx.latest(db.primary, 'AUD', 'USD'))?.rate).toEqual({
      numerator: 66n,
      denominator: 100n,
    });
    const past = await fx.latest(db.primary, 'AUD', 'USD', {
      at: new Date('2026-06-01T12:00:00Z'),
    });
    expect(past?.rate).toEqual({ numerator: 65n, denominator: 100n });
    // reporting can reproduce an old conversion exactly
    const conv = await fx.convert(db.primary, Money.of(10_000n, 'AUD'), 'USD', 'half-up', {
      at: new Date('2026-06-01T12:00:00Z'),
    });
    expect(conv.money.amount).toBe(6_500n);
    const rows = await one<{ n: string }>(
      sql`SELECT count(*) AS n FROM fx_rates WHERE base = 'AUD' AND quote = 'USD'`,
    );
    expect(Number(rows.n)).toBe(2);
  });

  it('rejects a wild move and keeps the previous rate in force', async () => {
    const fx = new FxService({ maxMoveBps: 2_000 });
    await fx.refresh(db.primary, new StaticFxProvider({ AUDGBP: '0.50' }), 'AUD', ['GBP']);
    const bad = await fx.refresh(db.primary, new StaticFxProvider({ AUDGBP: '5.00' }), 'AUD', [
      'GBP',
    ]);
    expect(bad.accepted).toEqual([]);
    expect(bad.rejected[0]?.reason).toMatch(/moved more than 20%/);
    const near = await fx.refresh(db.primary, new StaticFxProvider({ AUDGBP: '0.59' }), 'AUD', [
      'GBP',
    ]);
    expect(near.accepted).toHaveLength(1); // +18%
    const edge = await fx.refresh(db.primary, new StaticFxProvider({ AUDGBP: '0.30' }), 'AUD', [
      'GBP',
    ]);
    expect(edge.rejected).toHaveLength(1); // -49%
    expect((await fx.latest(db.primary, 'AUD', 'GBP'))?.rate).toEqual({
      numerator: 59n,
      denominator: 100n,
    });
  });

  it('reports currencies the provider did not return', async () => {
    const fx = new FxService();
    const r = await fx.refresh(db.primary, new StaticFxProvider({}), 'AUD', ['CAD']);
    expect(r.rejected).toEqual([{ quote: 'CAD', reason: 'not returned by provider' }]);
  });

  it('refuses stale and missing rates rather than guessing', async () => {
    const clock = { now: new Date('2026-06-01T00:00:00Z') };
    const fx = new FxService({ maxAgeHours: 24, now: () => clock.now });
    await fx.refresh(db.primary, new StaticFxProvider({ AUDCHF: '0.55' }), 'AUD', ['CHF']);
    expect(
      (await fx.convert(db.primary, Money.of(1000n, 'AUD'), 'CHF', 'half-up')).money.amount,
    ).toBe(550n);
    clock.now = new Date('2026-06-03T00:00:00Z');
    await expect(
      fx.convert(db.primary, Money.of(1000n, 'AUD'), 'CHF', 'half-up'),
    ).rejects.toMatchObject({ reason: 'stale' });
    await expect(
      fx.convert(db.primary, Money.of(1000n, 'AUD'), 'SEK', 'half-up'),
    ).rejects.toBeInstanceOf(FxRateUnavailableError);
  });

  it('the database refuses a non-positive rate and a self-pair', async () => {
    const msg = (q: ReturnType<typeof sql>) =>
      db.primary.execute(q).then(
        () => '',
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(
      await msg(
        sql`INSERT INTO fx_rates (base, quote, rate_num, rate_den, source) VALUES ('AUD','NOK',0,1,'x')`,
      ),
    ).toMatch(/fx_rates_positive_check/);
    expect(
      await msg(
        sql`INSERT INTO fx_rates (base, quote, rate_num, rate_den, source) VALUES ('AUD','AUD',1,1,'x')`,
      ),
    ).toMatch(/fx_rates_distinct_check/);
  });
});

describe('derived prices', () => {
  const price = (variantId: string, currency: string) =>
    one<{ amount: string; source: string }>(
      sql`SELECT amount::text, source FROM variant_prices WHERE variant_id = ${variantId} AND currency = ${currency}`,
    );

  it('derives USD (.99) and JPY (fixed exponent) prices, never touching manual ones, and is idempotent', async () => {
    const fx = new FxService();
    await fx.refresh(
      db.primary,
      new StaticFxProvider({ AUDUSD: '0.6543', AUDJPY: '96.5' }),
      'AUD',
      ['USD', 'JPY'],
    );
    const a = await seedVariant(db, { onHand: 1, price: 2000n }); // A$20.00
    const b = await seedVariant(db, { onHand: 1, price: 4999n });
    await db.primary.execute(
      sql`INSERT INTO variant_prices (variant_id, currency, amount) VALUES (${b.variantId}, 'USD', 1234)`,
    ); // manual override

    const targets = [
      { code: 'USD', rounding: '.99' },
      { code: 'JPY', rounding: 'ending:0/10' },
    ];
    const first = await fx.deriveAll(db.primary, { base: 'AUD', targets });
    expect(first.skippedNoRate).toEqual([]);
    // 2000 * 0.6543 = 1308.6 -> 1309 (half-up) -> nearest x.99 = 1299
    expect(await price(a.variantId, 'USD')).toMatchObject({ amount: '1299', source: 'derived' });
    // 2000 * 96.5 / 100 (AUD 2 decimals -> JPY 0 decimals): A$20.00 = 1930 yen
    expect(await price(a.variantId, 'JPY')).toMatchObject({ amount: '1930', source: 'derived' });
    expect(await price(b.variantId, 'USD')).toMatchObject({ amount: '1234', source: 'manual' }); // untouched
    expect(first.written).toBeGreaterThanOrEqual(3);

    const second = await fx.deriveAll(db.primary, { base: 'AUD', targets });
    expect(second.written).toBe(0); // nothing changed: no rewrites
    expect(second.unchanged).toBeGreaterThanOrEqual(3);

    await fx.refresh(db.primary, new StaticFxProvider({ AUDUSD: '0.70' }), 'AUD', ['USD']);
    const third = await fx.deriveAll(db.primary, {
      base: 'AUD',
      targets: [{ code: 'USD', rounding: '.99' }],
    });
    expect(third.written).toBeGreaterThanOrEqual(1);
    expect(await price(a.variantId, 'USD')).toMatchObject({ amount: '1399' }); // 1400 -> 13.99
  });

  it('skips currencies with no fresh rate instead of inventing prices', async () => {
    const fx = new FxService();
    const r = await fx.deriveAll(db.primary, { base: 'AUD', targets: [{ code: 'ZAR' }] });
    expect(r).toMatchObject({ written: 0, skippedNoRate: ['ZAR'] });
  });

  it('works in batches across many variants', async () => {
    const fx = new FxService();
    await fx.refresh(db.primary, new StaticFxProvider({ AUDNZD: '1.08' }), 'AUD', ['NZD']);
    const variants = await Promise.all(
      Array.from({ length: 25 }, () => seedVariant(db, { onHand: 1, price: 1000n })),
    );
    const r = await fx.deriveAll(db.primary, {
      base: 'AUD',
      targets: [{ code: 'NZD' }],
      batchSize: 7,
    });
    expect(r.written).toBeGreaterThanOrEqual(25);
    for (const v of variants.slice(0, 5))
      expect(await price(v.variantId, 'NZD')).toMatchObject({ amount: '1080' });
  });
});
