import { fileURLToPath } from 'node:url';
import { migrate } from '@sold/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { PgBossQueue } from './pgboss';

let db: TestDatabase;
let queue: PgBossQueue;

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};

beforeAll(async () => {
  db = await createTestDatabase();
  // Run against a database with Base's migrations applied, so the DB-level 5 s statement timeout etc. are in force:
  // the queue must cope with the real production defaults.
  await migrate({
    url: db.url,
    dir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
  });
  queue = new PgBossQueue({ connectionString: db.url, pollingIntervalSeconds: 0.5, poolMax: 4 });
  await queue.start();
});
afterAll(async () => {
  await queue?.stop({ timeoutMs: 5_000 });
  await db?.destroy();
});

describe('PgBossQueue', () => {
  it('processes an enqueued job', async () => {
    await queue.ensureQueue({ name: 'test-basic', class: 'default' });
    const seen: unknown[] = [];
    await queue.work<{ n: number }>('test-basic', async (job) => {
      seen.push(job.data);
    });
    await queue.enqueue('test-basic', { n: 1 });
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('dedupes enqueues that share an idempotency key', async () => {
    await queue.ensureQueue({ name: 'test-idem', class: 'default' });
    const first = await queue.enqueue('test-idem', { n: 1 }, { idempotencyKey: 'order-42' });
    const second = await queue.enqueue('test-idem', { n: 1 }, { idempotencyKey: 'order-42' });
    const other = await queue.enqueue('test-idem', { n: 2 }, { idempotencyKey: 'order-43' });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(other).not.toBeNull();
    expect((await queue.health('test-idem')).depth).toBe(2);
  });

  it('retries a failing job, then dead-letters it after the retry limit', async () => {
    await queue.ensureQueue({ name: 'test-dead', class: 'critical' });
    let attempts = 0;
    await queue.work('test-dead', async () => {
      attempts++;
      throw new Error('boom');
    });
    // Speed up: override retry policy for this queue.
    await (
      queue as unknown as { boss: { updateQueue(n: string, o: object): Promise<void> } }
    ).boss.updateQueue('test-dead', {
      retryLimit: 2,
      retryDelay: 0,
      retryBackoff: false,
    });
    await queue.enqueue('test-dead', { n: 1 });
    await until(() => attempts >= 3, 30_000);
    // Job lands in the dead-letter queue with its payload intact.
    await queue.ensureQueue({ name: 'test-dead.dead', class: 'bulk', deadLetter: false });
    await until(async () => (await queue.health('test-dead.dead')).depth === 1, 30_000);
    expect(attempts).toBe(3);
  });

  it('reports the age of the oldest waiting job (alert on age, not just depth)', async () => {
    await queue.ensureQueue({ name: 'test-age', class: 'bulk' });
    expect((await queue.health('test-age')).oldestAgeSeconds).toBe(0);
    await queue.enqueue('test-age', { n: 1 });
    await new Promise((r) => setTimeout(r, 1_500));
    const h = await queue.health('test-age');
    expect(h.depth).toBe(1);
    expect(h.deadLetterDepth).toBe(0);
    expect(h.oldestAgeSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refuses queues that were not declared', async () => {
    await expect(queue.enqueue('nope', {})).rejects.toThrow(/ensureQueue/);
  });

  it('runs multiple jobs concurrently up to the class limit and drains on stop', async () => {
    await queue.ensureQueue({ name: 'test-conc', class: 'bulk' }); // bulk concurrency = 3
    let active = 0;
    let peak = 0;
    let done = 0;
    await queue.work('test-conc', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 300));
      active--;
      done++;
    });
    for (let i = 0; i < 9; i++) await queue.enqueue('test-conc', { i });
    await until(() => done === 9, 30_000);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('updates the policy of an existing queue when the class policy changes', async () => {
    await queue.ensureQueue({ name: 'test-policy', class: 'bulk' });
    const boss = (
      queue as unknown as { boss: { getQueue(n: string): Promise<{ retryLimit: number } | null> } }
    ).boss;
    const before = await boss.getQueue('test-policy');
    // Simulate an older release having created the queue with a different limit.
    await (
      queue as unknown as { boss: { updateQueue(n: string, o: object): Promise<void> } }
    ).boss.updateQueue('test-policy', { retryLimit: 99 });
    expect((await boss.getQueue('test-policy'))?.retryLimit).toBe(99);
    await queue.ensureQueue({ name: 'test-policy', class: 'bulk' });
    expect((await boss.getQueue('test-policy'))?.retryLimit).toBe(before?.retryLimit);
  });

  it('health() is an index-only scan of the backlog even with a large job history', async () => {
    await queue.ensureQueue({ name: 'test-big', class: 'default' });
    const boss = (
      queue as unknown as {
        boss: {
          getDb(): {
            executeSql(q: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
          };
        };
      }
    ).boss;
    const sqlDb = boss.getDb();
    // 300k completed jobs of history across other queues plus a small live backlog on this one.
    await sqlDb.executeSql(`INSERT INTO pgboss.job (name, state, data, completed_on)
      SELECT 'test-big', 'completed', '{}', now() FROM generate_series(1, 300000)`);
    await sqlDb.executeSql(
      `INSERT INTO pgboss.job (name, state, data) SELECT 'test-big', 'created', '{}' FROM generate_series(1, 50)`,
    );
    await sqlDb.executeSql('ANALYZE pgboss.job');
    const plan = await sqlDb.executeSql(
      `EXPLAIN SELECT count(*), min(created_on) FROM pgboss.job WHERE name = $1 AND state < 'active' AND NOT blocked`,
      ['test-big'],
    );
    const text = plan.rows.map((r) => String(r['QUERY PLAN'])).join('\n');
    expect(text).toMatch(/job_common_i11/);
    expect(text).not.toMatch(/Seq Scan/);
    const started = performance.now();
    const h = await queue.health('test-big');
    expect(performance.now() - started).toBeLessThan(250);
    expect(h.depth).toBe(50);
  });
});
