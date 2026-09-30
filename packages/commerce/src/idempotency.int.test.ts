import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashRequest, runIdempotent } from './idempotency';
import { openMigrated } from './test-support';

let testDb: TestDatabase;
let db: Db;
beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url);
  await db.primary.execute(sql`CREATE TABLE effects (n int)`);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

describe('hashRequest', () => {
  it('ignores key order and distinguishes values', () => {
    expect(hashRequest({ a: 1n, b: [1, 2] })).toBe(hashRequest({ b: [1, 2], a: 1n }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});

describe('runIdempotent', () => {
  it('runs once and replays the stored response (bigint/Date survive)', async () => {
    let runs = 0;
    const fn = async (tx: Parameters<Parameters<typeof db.primary.transaction>[0]>[0]) => {
      runs++;
      await tx.execute(sql`INSERT INTO effects VALUES (1)`);
      return { total: 12345678901234567890n, at: new Date('2026-01-02T03:04:05Z') };
    };
    const a = await runIdempotent(db.primary, 'checkout', 'k1', { cart: 1 }, fn);
    const b = await runIdempotent(db.primary, 'checkout', 'k1', { cart: 1 }, fn);
    expect(runs).toBe(1);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.value).toEqual({ total: 12345678901234567890n, at: new Date('2026-01-02T03:04:05Z') });
  });

  it('refuses key reuse with a different request', async () => {
    await runIdempotent(db.primary, 's', 'k2', { a: 1 }, async () => 1);
    await expect(
      runIdempotent(db.primary, 's', 'k2', { a: 2 }, async () => 2),
    ).rejects.toMatchObject({
      code: 'idempotency_key_reuse',
    });
  });

  it('50 concurrent duplicates run the effect exactly once', async () => {
    await db.primary.execute(sql`TRUNCATE effects`);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        runIdempotent(db.primary, 'race', 'same', { x: 1 }, async (tx) => {
          await tx.execute(sql`INSERT INTO effects VALUES (2)`);
          return 'done';
        }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.value === 'done')).toBe(true);
    const count = (await db.primary.execute<{ c: string }>(sql`SELECT count(*) AS c FROM effects`))
      .rows[0]!;
    expect(Number(count.c)).toBe(1);
  });

  it('a failed run leaves no key behind, so a retry runs again', async () => {
    await expect(
      runIdempotent(db.primary, 'fail', 'k3', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const again = await runIdempotent(db.primary, 'fail', 'k3', {}, async () => 'ok');
    expect(again).toEqual({ value: 'ok', replayed: false });
  });
});
