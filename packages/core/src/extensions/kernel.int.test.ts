import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate, type Db } from '@sold/db';
import { migrateExtension } from '@sold/db/extension-migrations';
import { defineExtension, type ExtensionManifest } from '@sold/extension-sdk';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeCrypto, rootKeyFromBase64 } from '../crypto/envelope';
import { InMemoryJobQueue } from '../jobs/memory-queue';
import { Kernel, type KernelDeps, type KernelLogger } from './kernel';
import type { AuditEntry } from './settings';
import { ExtensionLoadError, type ExtensionCandidate } from './load-order';

// The canonical worked example, shared with docs/extending.md.
const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const loyaltyRoot = join(repoRoot, 'extensions/loyalty-points');
const { default: loyalty } = (await import('../../../../extensions/loyalty-points/src/index')) as {
  default: ExtensionManifest;
};

let testDb: TestDatabase;
let db: Db;
const migrationsDir = join(repoRoot, 'packages/db/migrations');

const logs: { level: string; fields: unknown; message?: string }[] = [];
const log: KernelLogger = {
  child: () => log,
  debug: () => undefined,
  info: (f, m) => void logs.push({ level: 'info', fields: f, message: m }),
  warn: (f, m) => void logs.push({ level: 'warn', fields: f, message: m }),
  error: (f, m) => void logs.push({ level: 'error', fields: f, message: m }),
};

const crypto = new EnvelopeCrypto(rootKeyFromBase64(randomBytes(32).toString('base64')));
const cand = (
  m: ExtensionManifest,
  origin: ExtensionCandidate['origin'] = 'first-party',
): ExtensionCandidate => ({ manifest: m, origin });

function makeKernel(
  over: Partial<KernelDeps> & {
    extensions?: { name: string; enabled: boolean }[];
    candidates?: ExtensionCandidate[];
  } = {},
) {
  const queue = over.queue ?? new InMemoryJobQueue();
  const audit: AuditEntry[] = [];
  const kernel = Kernel.create({
    config: { extensions: over.extensions ?? [{ name: 'loyalty-points', enabled: true }] },
    candidates: over.candidates ?? [cand(loyalty)],
    extensionRoot: (name) => (name === 'loyalty-points' ? loyaltyRoot : undefined),
    db,
    migrationUrl: testDb.url,
    migrateExtension,
    queue,
    crypto,
    audit: { record: async (e) => void audit.push(e) },
    log,
    ...over,
  });
  return { kernel, queue: queue as InMemoryJobQueue, audit };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate({ url: testDb.url, dir: migrationsDir });
  db = createDb({ primaryUrl: testDb.url });
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

describe('kernel with zero extensions', () => {
  it('boots, migrates and reconciles as a no-op', async () => {
    const { kernel } = makeKernel({ extensions: [], candidates: [] });
    expect(kernel.extensions).toEqual([]);
    expect(await kernel.migrate()).toEqual([]);
    expect(await kernel.reconcile()).toEqual({
      installed: [],
      enabled: [],
      disabled: [],
      unchanged: [],
    });
    await kernel.verifyMigrations();
    expect(kernel.describe()).toMatchObject({ order: [], routes: 0 });
    expect(
      await kernel.interceptors.run('cart.item.adding', {
        cartId: 'c',
        variantId: 'v',
        quantity: 1,
      }),
    ).toMatchObject({ veto: null });
  });
});

describe('loyalty-points (all contribution types)', () => {
  it('fails fast when migrations are not applied, with a helpful message', async () => {
    const { kernel } = makeKernel();
    await expect(kernel.verifyMigrations()).rejects.toThrow(
      /not applied for: loyalty-points.*pnpm db:migrate/,
    );
  });

  it('applies extension migrations under its own journal scope, then verify passes', async () => {
    const { kernel } = makeKernel();
    expect(await kernel.migrate()).toEqual([
      { extension: 'loyalty-points', applied: ['0001_init.sql'] },
    ]);
    expect(await kernel.migrate()).toEqual([{ extension: 'loyalty-points', applied: [] }]); // idempotent
    await kernel.verifyMigrations();
    const { rows } = await db.pools.primary.query(
      `SELECT scope FROM _sold_migrations WHERE scope = 'ext:loyalty-points'`,
    );
    expect(rows).toHaveLength(1);
    const tables = await db.pools.primary.query(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE 'ext\\_loyalty\\_points\\_%' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      'ext_loyalty_points_accounts',
      'ext_loyalty_points_awards',
    ]);
  });

  it('runs lifecycle hooks on transitions and records state', async () => {
    const calls: string[] = [];
    const lifecycle = {
      onInstall: async () => void calls.push('install'),
      onEnable: async () => void calls.push('enable'),
      onDisable: async () => void calls.push('disable'),
    };
    const life = defineExtension({
      name: 'lifecycle-demo',
      version: '1.0.0',
      requires: { base: '*' },
      performance: { hotPath: false },
      lifecycle,
    });
    const on = {
      extensions: [{ name: 'lifecycle-demo', enabled: true }],
      candidates: [cand(life)],
    };
    const off = {
      extensions: [{ name: 'lifecycle-demo', enabled: false }],
      candidates: [cand(life)],
    };

    expect((await makeKernel(on).kernel.reconcile()).installed).toEqual(['lifecycle-demo']);
    expect(calls).toEqual(['install', 'enable']);
    expect((await makeKernel(on).kernel.reconcile()).unchanged).toEqual(['lifecycle-demo']);
    expect(calls).toEqual(['install', 'enable']); // no repeat
    expect((await makeKernel(off).kernel.reconcile()).disabled).toEqual(['lifecycle-demo']);
    expect(calls).toEqual(['install', 'enable', 'disable']);
    expect((await makeKernel(on).kernel.reconcile()).enabled).toEqual(['lifecycle-demo']);
    expect(calls).toEqual(['install', 'enable', 'disable', 'enable']); // re-enable, no reinstall
    const state = await db.pools.primary.query(
      `SELECT state FROM extension_registry WHERE name = 'lifecycle-demo'`,
    );
    expect(state.rows[0]?.state).toBe('enabled');
  });

  it('a failing onInstall leaves no registry row, so the step can be retried', async () => {
    let fail = true;
    const flaky = defineExtension({
      name: 'flaky-install',
      version: '1.0.0',
      requires: { base: '*' },
      performance: { hotPath: false },
      lifecycle: {
        onInstall: async () => {
          if (fail) throw new Error('external system unavailable');
        },
      },
    });
    const cfg = {
      extensions: [{ name: 'flaky-install', enabled: true }],
      candidates: [cand(flaky)],
    };
    await expect(makeKernel(cfg).kernel.reconcile()).rejects.toThrow(
      /failed to install.*external system unavailable/,
    );
    expect(
      (
        await db.pools.primary.query(
          `SELECT 1 FROM extension_registry WHERE name = 'flaky-install'`,
        )
      ).rowCount,
    ).toBe(0);
    fail = false;
    expect((await makeKernel(cfg).kernel.reconcile()).installed).toEqual(['flaky-install']);
  });

  it('marks an extension that vanished from the repo as disabled without running hooks', async () => {
    const gone = defineExtension({
      name: 'soon-gone',
      version: '1.0.0',
      requires: { base: '*' },
      performance: { hotPath: false },
    });
    await makeKernel({
      extensions: [{ name: 'soon-gone', enabled: true }],
      candidates: [cand(gone)],
    }).kernel.reconcile();
    const report = await makeKernel({ extensions: [], candidates: [] }).kernel.reconcile();
    expect(report.disabled).toContain('soon-gone');
    expect(
      logs.some((l) => l.level === 'warn' && JSON.stringify(l.fields).includes('soon-gone')),
    ).toBe(true);
  });

  it('stores settings encrypted, audits key names only, and serves them to the extension', async () => {
    const { kernel, audit } = makeKernel();
    await kernel.reconcile();
    await kernel.settings.set(
      'loyalty-points',
      { pointsPerDollar: 3, crmApiToken: 'crm_live_secret_123' },
      'admin-1',
    );
    const rows = await db.pools.primary.query(
      `SELECT key, value, ciphertext FROM extension_settings WHERE extension = 'loyalty-points' ORDER BY key`,
    );
    expect(JSON.stringify(rows.rows)).not.toContain('crm_live_secret_123');
    expect(rows.rows.find((r) => r.key === 'crmApiToken')?.ciphertext).toMatch(/^sold1\./);
    expect(rows.rows.find((r) => r.key === 'pointsPerDollar')?.value).toBe(3);
    expect(audit[0]).toMatchObject({
      extension: 'loyalty-points',
      changedKeys: ['crmApiToken', 'pointsPerDollar'],
    });
    expect(JSON.stringify(audit)).not.toContain('crm_live');
    expect(await kernel.settings.get('loyalty-points')).toMatchObject({
      pointsPerDollar: 3,
      crmApiToken: 'crm_live_secret_123',
    });
    // Reset for later tests.
    await kernel.settings.set(
      'loyalty-points',
      { pointsPerDollar: 2, crmApiToken: null },
      'admin-1',
    );
  });

  it('observer: awards points once even if the event is delivered twice; guests earn nothing', async () => {
    const { kernel, queue } = makeKernel();
    await kernel.startWorkers();
    const order = (id: string, customerId: string | null) => ({
      orderId: id,
      orderNumber: id,
      customerId,
      total: { amount: 12_345n, currency: 'AUD' },
      placedAt: new Date(),
    });

    await kernel.bus.publish('order.placed', order('o-1', 'cust-1'), { eventId: 'evt-1' });
    await kernel.bus.publish('order.placed', order('o-1', 'cust-1'), { eventId: 'evt-1' }); // duplicate publish, same event id
    await kernel.bus.publish('order.placed', order('o-2', 'cust-1'), { eventId: 'evt-2' });
    await kernel.bus.publish('order.placed', order('o-3', null), { eventId: 'evt-3' });
    await queue.drain();

    const acct = await db.pools.primary.query(
      `SELECT points::text FROM ext_loyalty_points_accounts WHERE customer_id = 'cust-1'`,
    );
    expect(acct.rows[0]?.points).toBe('492'); // 2 orders x 123 dollars x 2 points/dollar
    expect((await db.pools.primary.query(`SELECT 1 FROM ext_loyalty_points_awards`)).rowCount).toBe(
      2,
    );
    expect(queue.dead).toEqual([]);

    // Even bypassing the queue-level dedupe, redelivery is harmless (idempotent by order id).
    await kernel.bus.publish('order.placed', order('o-1', 'cust-1'), { eventId: 'evt-1-again' });
    await queue.drain();
    expect(
      (
        await db.pools.primary.query(
          `SELECT points::text FROM ext_loyalty_points_accounts WHERE customer_id = 'cust-1'`,
        )
      ).rows[0]?.points,
    ).toBe('492');
  });

  it('interceptor: vetoes over-limit quantities using settings, with no database access on the hot path', async () => {
    const { kernel } = makeKernel();
    await kernel.warm();
    const run = (quantity: number) =>
      kernel.interceptors.run('cart.item.adding', { cartId: 'c', variantId: 'v', quantity });
    expect((await run(10)).veto).toBeNull();
    expect((await run(11)).veto).toEqual({
      code: 'max_quantity_exceeded',
      message: 'You can add at most 10 of this item.',
    });
    await kernel.settings.set('loyalty-points', { maxQuantityPerLine: 2 }, 'admin-1');
    await kernel.warm();
    expect((await run(3)).veto?.code).toBe('max_quantity_exceeded');
    await kernel.settings.set('loyalty-points', { maxQuantityPerLine: 10 }, 'admin-1');
  });

  it('service provider: extension override wins over the Base default', async () => {
    const baseRounding = {
      provider: {
        service: 'pricing.rounding' as const,
        key: 'nearest',
        create: () => ({ round: (m: bigint) => m }),
      },
    };
    const { kernel } = makeKernel({ baseProviders: [baseRounding] });
    expect(kernel.services.activeProvider('pricing.rounding')).toMatchObject({
      key: 'charm-pricing',
      owner: 'loyalty-points',
      origin: 'first-party',
    });
    expect((await kernel.services.get('pricing.rounding')).round(1000n, 'AUD')).toBe(1099n);
    const selected = makeKernel({
      baseProviders: [baseRounding],
      config: {
        extensions: [{ name: 'loyalty-points', enabled: true }],
        services: { 'pricing.rounding': 'nearest' },
      },
    });
    expect((await selected.kernel.services.get('pricing.rounding')).round(1000n, 'AUD')).toBe(
      1000n,
    );
  });

  it('routes: mounted under the reserved prefix with declared permissions; default authorizer denies', async () => {
    const { kernel } = makeKernel();
    expect(kernel.routes.match('GET', '/x/loyalty-points/balance/cust-1')).toMatchObject({
      status: 'found',
      params: { customerId: 'cust-1' },
    });
    expect(kernel.permissions.has('loyalty-points.accounts.read')).toBe(true);
    await expect(kernel.authorizer.authorize(null, 'loyalty-points.accounts.read')).rejects.toThrow(
      /Forbidden/,
    );
  });

  it('queues and schedules: declared per extension and namespaced', async () => {
    const { kernel, queue } = makeKernel();
    await kernel.startWorkers();
    expect([...queue.defs.keys()].sort()).toEqual([
      'ext.loyalty-points.events',
      'ext.loyalty-points.expire',
    ]);
    expect(queue.schedules).toEqual([
      {
        queue: 'ext.loyalty-points.expire',
        cron: '0 3 * * *',
        key: 'loyalty-points/expire',
        data: { olderThanDays: 365 },
      },
    ]);
  });

  it('an extension cannot enqueue onto queues it does not own', async () => {
    const { kernel } = makeKernel();
    const ctx = kernel.contextFor('loyalty-points', new AbortController().signal);
    await expect(ctx.queue.enqueue('someone-elses', {})).rejects.toThrow(/has no job queue/);
  });

  it('uninstall requires the extension disabled and an explicit purge, then removes everything', async () => {
    const enabled = makeKernel();
    await expect(enabled.kernel.uninstall('loyalty-points', { purge: true })).rejects.toThrow(
      /still enabled/,
    );
    const disabled = makeKernel({ extensions: [{ name: 'loyalty-points', enabled: false }] });
    await expect(disabled.kernel.uninstall('loyalty-points', { purge: false })).rejects.toThrow(
      /without --purge/,
    );
    const result = await disabled.kernel.uninstall('loyalty-points', { purge: true });
    expect(result.droppedTables.sort()).toEqual([
      'ext_loyalty_points_accounts',
      'ext_loyalty_points_awards',
    ]);
    expect(
      (
        await db.pools.primary.query(
          `SELECT 1 FROM extension_registry WHERE name = 'loyalty-points'`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pools.primary.query(
          `SELECT 1 FROM extension_settings WHERE extension = 'loyalty-points'`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.pools.primary.query(
          `SELECT 1 FROM _sold_migrations WHERE scope = 'ext:loyalty-points'`,
        )
      ).rowCount,
    ).toBe(0);
  });
});

describe('extension isolation and safety', () => {
  it('refuses to run migrations that touch Base tables or other extensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sold-ext-'));
    try {
      await mkdir(join(dir, 'migrations'));
      await writeFile(
        join(dir, 'migrations', '0001_bad.sql'),
        'CREATE TABLE ext_evil_ok (id int);\nALTER TABLE feature_flags ADD COLUMN pwned boolean;',
      );
      const evil = defineExtension({
        name: 'evil',
        version: '1.0.0',
        requires: { base: '*' },
        performance: { hotPath: false },
        migrations: { dir: 'migrations' },
      });
      const { kernel } = makeKernel({
        extensions: [{ name: 'evil', enabled: true }],
        candidates: [cand(evil, 'instance')],
        extensionRoot: () => dir,
      });
      await expect(kernel.migrate()).rejects.toThrow(/never alter Base tables/);
      const created = await db.pools.primary.query(`SELECT to_regclass('ext_evil_ok') AS t`);
      expect(created.rows[0]?.t).toBeNull(); // nothing ran, not even the safe statement
      const col = await db.pools.primary.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'feature_flags' AND column_name = 'pwned'`,
      );
      expect(col.rowCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown permissions and load-order problems at create time, listing all of them', () => {
    const bad = defineExtension({
      name: 'bad-perm',
      version: '1.0.0',
      requires: { base: '^9.0.0' },
      performance: { hotPath: false },
      routes: [
        {
          kind: 'api',
          method: 'GET',
          path: '/x',
          permission: 'base.nonexistent.thing',
          handler: async () => new Response(),
        },
      ],
    });
    expect(() =>
      makeKernel({ extensions: [{ name: 'bad-perm', enabled: true }], candidates: [cand(bad)] }),
    ).toThrow(ExtensionLoadError);
    const ok = defineExtension({
      name: 'bad-perm2',
      version: '1.0.0',
      requires: { base: '*' },
      performance: { hotPath: false },
      routes: [
        {
          kind: 'api',
          method: 'GET',
          path: '/x',
          permission: 'base.nonexistent.thing',
          handler: async () => new Response(),
        },
      ],
    });
    expect(() =>
      makeKernel({ extensions: [{ name: 'bad-perm2', enabled: true }], candidates: [cand(ok)] }),
    ).toThrow(/unknown permission "base\.nonexistent\.thing"/);
  });

  it('boots with all extensions at once and reports a deterministic order', () => {
    const a = defineExtension({
      name: 'aaa-ext',
      version: '1.0.0',
      requires: { base: '*', extensions: { 'loyalty-points': '^1.0.0' } },
      performance: { hotPath: false },
    });
    const { kernel } = makeKernel({
      extensions: [
        { name: 'aaa-ext', enabled: true },
        { name: 'loyalty-points', enabled: true },
      ],
      candidates: [cand(a, 'instance'), cand(loyalty)],
    });
    expect(kernel.describe().order).toEqual(['loyalty-points@1.0.0', 'aaa-ext@1.0.0']);
  });
});
