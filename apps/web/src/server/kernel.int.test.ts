import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@sold/core/env';
import {
  createKernel,
  toKernelLogger,
  type GeneratedRegistry,
  type Kernel,
} from '@sold/core/extensions';
import { createLogger } from '@sold/core/observability';
import { createDb, migrate, type Db } from '@sold/db';
import { migrateExtension } from '@sold/db/extension-migrations';
import { PgBossQueue } from '@sold/jobs';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as generated from '../../.generated/extensions';
import { handleExtensionRequest } from './extension-http';

/**
 * The extension framework end to end on REAL infrastructure: PostgreSQL, the real pg-boss queue, the kernel wired
 * exactly as the worker wires it, and the canonical loyalty-points extension (the one docs/extending.md walks through).
 */
const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const registry = generated as unknown as GeneratedRegistry;

let testDb: TestDatabase;
let db: Db;
let queue: PgBossQueue;
let kernel: Kernel;

const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};
const points = async (customer: string) =>
  (
    await db.pools.primary.query<{ points: string }>(
      `SELECT points::text FROM ext_loyalty_points_accounts WHERE customer_id = $1`,
      [customer],
    )
  ).rows[0]?.points;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate({ url: testDb.url, dir: join(repoRoot, 'packages/db/migrations') });
  db = createDb({ primaryUrl: testDb.url });
  queue = new PgBossQueue({
    connectionString: testDb.url,
    pollingIntervalSeconds: 0.5,
    poolMax: 4,
  });
  await queue.start();
  const env = loadEnv({ DATABASE_URL: testDb.url, SOLD_ENVIRONMENT: 'local', LOG_LEVEL: 'silent' });
  const log = toKernelLogger(createLogger({ service: 'test', level: 'silent' }));
  kernel = createKernel({ env, log, db, queue, registry, migrateExtension });
  await kernel.migrate();
  await kernel.reconcile();
  await kernel.verifyMigrations();
  await kernel.warm();
  await kernel.startWorkers();
}, 120_000);

afterAll(async () => {
  await queue?.stop({ timeoutMs: 5_000 });
  await db?.close();
  await testDb?.destroy();
});

describe('extensions on real infrastructure', () => {
  it('the generated registry and the kernel agree on what is loaded', () => {
    expect(kernel.extensions.map((e) => e.manifest.name)).toEqual(['loyalty-points']);
    expect(kernel.describe().order).toEqual(['loyalty-points@1.0.0']);
  });

  it('order.placed reaches the observer through pg-boss and is applied exactly once', async () => {
    const order = (id: string) => ({
      orderId: id,
      orderNumber: id,
      customerId: 'cust-e2e',
      total: { amount: 5_000n, currency: 'AUD' },
      placedAt: new Date(),
    });
    await kernel.bus.publish('order.placed', order('e2e-1'), { eventId: 'evt-e2e-1' });
    await kernel.bus.publish('order.placed', order('e2e-1'), { eventId: 'evt-e2e-1' }); // duplicate publish of the same event
    await until(async () => (await points('cust-e2e')) !== undefined);
    // Give a duplicate delivery time to (not) land, then check the balance: 50 dollars x 1 point.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await points('cust-e2e')).toBe('50');
    const awards = await db.pools.primary.query(
      `SELECT 1 FROM ext_loyalty_points_awards WHERE order_id = 'e2e-1'`,
    );
    expect(awards.rowCount).toBe(1);
  }, 60_000);

  it('the extension queues and schedule exist in pg-boss under their namespaced names', async () => {
    const boss = (
      queue as unknown as {
        boss: {
          getQueue(n: string): Promise<unknown>;
          getSchedules(): Promise<{ name: string; key: string }[]>;
        };
      }
    ).boss;
    expect(await boss.getQueue('ext.loyalty-points.events')).toBeTruthy();
    expect(await boss.getQueue('ext.loyalty-points.expire')).toBeTruthy();
    expect((await boss.getSchedules()).map((s) => `${s.name}#${s.key}`)).toContain(
      'ext.loyalty-points.expire#loyalty-points/expire',
    );
  });

  it('cart interceptor: veto and pass, using settings written through the kernel', async () => {
    const run = (quantity: number) =>
      kernel.interceptors.run('cart.item.adding', { cartId: 'c', variantId: 'v', quantity });
    expect((await run(10)).veto).toBeNull();
    expect((await run(11)).veto?.code).toBe('max_quantity_exceeded');
  });

  it('HTTP: a protected extension route fails closed with no actor; unknown routes 404', async () => {
    const log = { child: () => log, warn: () => undefined, error: () => undefined };
    const deps = { kernel, log: log as never, timeoutMs: 2_000, maxBodyBytes: 1_000 };
    const denied = await handleExtensionRequest(
      deps,
      new Request('http://x/x/loyalty-points/balance/cust-e2e'),
      'req-12345678',
    );
    expect(denied.status).toBe(401);
    const missing = await handleExtensionRequest(
      deps,
      new Request('http://x/x/loyalty-points/nope'),
      'req-12345678',
    );
    expect(missing.status).toBe(404);
  });

  it('verifyMigrations fails fast, naming the extension, when migrations were not applied', async () => {
    const fresh = await createTestDatabase();
    const freshDb = createDb({ primaryUrl: fresh.url });
    try {
      await migrate({ url: fresh.url, dir: join(repoRoot, 'packages/db/migrations') });
      const env = loadEnv({
        DATABASE_URL: fresh.url,
        SOLD_ENVIRONMENT: 'local',
        LOG_LEVEL: 'silent',
      });
      const k = createKernel({
        env,
        log: toKernelLogger(createLogger({ service: 't', level: 'silent' })),
        db: freshDb,
        queue,
        registry,
      });
      await expect(k.verifyMigrations()).rejects.toThrow(
        /not applied for: loyalty-points \(0001_init\.sql\).*db:migrate/,
      );
      await expect(k.migrate()).rejects.toThrow(/cannot run migrations/); // a serving process has no migrator
    } finally {
      await freshDb.close();
      await fresh.destroy();
    }
  });
});
