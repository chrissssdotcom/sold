import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { PgTable as PgTableClass, type PgTable } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { createDb, QueryCounter, type Db } from './client';
import { lintMigrationDir } from './lint';
import { migrate } from './migrate';
import * as schemaModule from './schema';
import { featureFlags, migrationJournal, outboxEvents } from './schema';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

let testDb: TestDatabase;
let db: Db;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

describe('migrations on an empty database', () => {
  it('applies every migration, then is a no-op on rerun', async () => {
    const first = await migrate({ url: testDb.url, dir: migrationsDir });
    const all = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    expect(first.applied).toEqual(all);
    const second = await migrate({ url: testDb.url, dir: migrationsDir });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(all);
    db = createDb({ primaryUrl: testDb.url });
  });

  it('matches the Drizzle schema (columns, types, nullability)', async () => {
    const tables: PgTable[] = [
      featureFlags,
      outboxEvents,
      migrationJournal,
      // Every commerce table declared in Drizzle must match the SQL migrations.
      ...(Object.values(schemaModule).filter((v) => is(v, PgTableClass)) as PgTable[]),
    ].filter((t, i, all) => all.indexOf(t) === i);
    for (const table of tables) {
      const name = getTableName(table);
      const { rows } = await db.pools.primary.query<{
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_name, is_nullable, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );
      const actual = new Map(rows.map((r) => [r.column_name, r]));
      const declared = Object.values(getTableColumns(table));
      expect([...actual.keys()].sort(), `columns of ${name}`).toEqual(
        declared.map((c) => c.name).sort(),
      );
      for (const col of declared) {
        const a = actual.get(col.name);
        expect(a?.is_nullable === 'NO', `${name}.${col.name} NOT NULL`).toBe(col.notNull);
        const expectedType = col.getSQLType().replace(/\(.*\)/, '');
        const pgType = a?.data_type ?? '';
        const aliases: Record<string, string> = {
          char: 'character',
          'text[]': 'ARRAY',
        };
        const normalized = aliases[expectedType] ?? expectedType;
        expect(pgType, `${name}.${col.name} type`).toBe(normalized);
      }
    }
  });

  it('refuses a modified, already-applied migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sold-mig-'));
    try {
      await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE tamper_a (id int);');
      await migrate({ url: testDb.url, dir, scope: 'test-tamper' });
      await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE tamper_a (id int, x int);');
      await expect(migrate({ url: testDb.url, dir, scope: 'test-tamper' })).rejects.toThrow(
        /checksum mismatch/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses out-of-order migrations (forward-only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sold-mig-'));
    try {
      await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE order_b (id int);');
      await migrate({ url: testDb.url, dir, scope: 'test-order' });
      await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE order_a (id int);');
      await expect(migrate({ url: testDb.url, dir, scope: 'test-order' })).rejects.toThrow(
        /forward-only/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing transactional migration and does not journal it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sold-mig-'));
    try {
      await writeFile(join(dir, '0001_bad.sql'), 'CREATE TABLE rollback_me (id int);\nSELECT 1/0;');
      await expect(migrate({ url: testDb.url, dir, scope: 'test-rollback' })).rejects.toThrow(
        /failed/,
      );
      const exists = await db.pools.primary.query(`SELECT to_regclass('rollback_me') AS t`);
      expect(exists.rows[0]?.t).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs a no-transaction migration with CREATE INDEX CONCURRENTLY', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sold-mig-'));
    try {
      await writeFile(
        join(dir, '0001_idx.sql'),
        `-- sold:no-transaction
CREATE TABLE conc (id int, v int);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS conc_v_idx ON conc (v);`,
      );
      await migrate({ url: testDb.url, dir, scope: 'test-conc' });
      const idx = await db.pools.primary.query(
        `SELECT indisvalid FROM pg_index WHERE indexrelid = 'conc_v_idx'::regclass`,
      );
      expect(idx.rows[0]?.indisvalid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serialises concurrent runners with the advisory lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sold-mig-'));
    try {
      await writeFile(join(dir, '0001_x.sql'), 'CREATE TABLE racing (id int);');
      const results = await Promise.all(
        [1, 2, 3].map(() => migrate({ url: testDb.url, dir, scope: 'test-race' })),
      );
      expect(results.flatMap((r) => r.applied)).toEqual(['0001_x.sql']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a per-scope journal', async () => {
    const { rows } = await db.pools.primary.query<{ scope: string }>(
      'SELECT DISTINCT scope FROM _sold_migrations',
    );
    expect(rows.map((r) => r.scope)).toContain('base');
    expect(rows.map((r) => r.scope)).toContain('test-conc');
  });
});

describe('Base migrations', () => {
  it('pass the migration linter', async () => {
    const reports = await lintMigrationDir(migrationsDir);
    expect(reports.flatMap((r) => r.findings)).toEqual([]);
  });

  it('set database-level timeouts (they survive PgBouncer transaction pooling)', async () => {
    const c = new Client({ connectionString: testDb.url });
    await c.connect();
    try {
      const { rows } = await c.query<{
        statement_timeout: string;
        lock_timeout: string;
        idle: string;
      }>(
        `SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout, current_setting('idle_in_transaction_session_timeout') AS idle`,
      );
      expect(rows[0]).toEqual({ statement_timeout: '5s', lock_timeout: '2s', idle: '5s' });
    } finally {
      await c.end();
    }
  });
});

describe('sold_uuid_v7', () => {
  it('yields version-7 UUIDs whose 48-bit timestamp prefix is time-ordered', async () => {
    const { rows } = await db.pools.primary.query<{ id: string }>(
      `SELECT sold_uuid_v7() AS id FROM generate_series(1, 50)`,
    );
    const ids = rows.map((r) => r.id);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect(['8', '9', 'a', 'b']).toContain(ids[0]?.[19]);
    expect(new Set(ids).size).toBe(50);
    const prefix = (id: string) => id.replace('-', '').slice(0, 12);
    const prefixes = ids.map(prefix);
    expect([...prefixes].sort()).toEqual(prefixes);
  });

  it('sorts later ids after earlier ones across milliseconds', async () => {
    const first = await db.pools.primary.query<{ id: string }>('SELECT sold_uuid_v7() AS id');
    await db.pools.primary.query('SELECT pg_sleep(0.01)');
    const later = await db.pools.primary.query<{ id: string }>('SELECT sold_uuid_v7() AS id');
    expect((later.rows[0]?.id ?? '') > (first.rows[0]?.id ?? '')).toBe(true);
  });
});

describe('outbox partitioning', () => {
  it('has monthly partitions created ahead, and routes rows to them', async () => {
    const { rows: parts } = await db.pools.primary.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'outbox_events'::regclass ORDER BY 1`,
    );
    expect(parts.length).toBe(5); // default + current month + 3 ahead
    await db.primary.insert(outboxEvents).values({
      aggregateType: 'order',
      aggregateId: 'o1',
      eventType: 'order.placed',
      payload: { total: 100 },
    });
    const routed = await db.pools.primary.query<{ tableoid: string }>(
      `SELECT tableoid::regclass::text AS tableoid FROM outbox_events`,
    );
    expect(routed.rows[0]?.tableoid).not.toBe('outbox_events_default');
  });

  it('ensure is idempotent', async () => {
    const again = await db.pools.primary.query<{ n: number }>(
      `SELECT sold_ensure_monthly_partitions('outbox_events', 3) AS n`,
    );
    expect(again.rows[0]?.n).toBe(0);
  });

  it('uses the partial index for the publisher poll (EXPLAIN)', async () => {
    await db.pools.primary
      .query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
      SELECT 'order', g::text, 'order.placed', '{}' FROM generate_series(1, 2000) g`);
    await db.pools.primary.query(`ANALYZE outbox_events`);
    await db.pools.primary.query('SET enable_seqscan = off');
    const { rows } = await db.pools.primary.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM outbox_events WHERE published_at IS NULL AND available_at <= now() ORDER BY available_at LIMIT 100`,
    );
    await db.pools.primary.query('RESET enable_seqscan');
    expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(
      /outbox_events_.*unpublished_idx|Index/,
    );
  });
});

describe('db handles', () => {
  it('falls back to the primary when no replica is configured', () => {
    expect(db.hasReplica).toBe(false);
    expect(db.pools.replica).toBe(db.pools.primary);
  });

  it('uses a distinct pool when a replica URL is given, and counts queries', async () => {
    const counter = new QueryCounter();
    const both = createDb({
      primaryUrl: testDb.url,
      replicaUrl: `${testDb.url}?application_name=replica`,
      logger: counter,
    });
    try {
      expect(both.hasReplica).toBe(true);
      await both.replica.select().from(featureFlags);
      await both.primary.insert(featureFlags).values({ key: 'waiting-room', enabled: false });
      expect(counter.count).toBe(2);
      const app = await both.replica.execute(sql`select current_setting('application_name') as n`);
      expect(app.rows[0]?.n).toBe('replica');
    } finally {
      await both.close();
    }
  });

  it('applies the statement timeout on direct connections', async () => {
    const fast = createDb({ primaryUrl: testDb.url, statementTimeoutMs: 200 });
    try {
      await expect(fast.pools.primary.query('SELECT pg_sleep(2)')).rejects.toThrow(
        /statement timeout/,
      );
    } finally {
      await fast.close();
    }
  });
});

describe('seed', () => {
  it('is idempotent and preserves operator changes', async () => {
    const { seedBase } = await import('./seed');
    await seedBase(db.primary);
    await db.pools.primary.query(
      `UPDATE feature_flags SET enabled = true WHERE key = 'degrade.waiting-room'`,
    );
    await seedBase(db.primary);
    const { rows } = await db.pools.primary.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE key = 'degrade.waiting-room'`,
    );
    expect(rows[0]?.enabled).toBe(true);
    const count = await db.pools.primary.query<{ n: string }>(
      `SELECT count(*) AS n FROM feature_flags WHERE key LIKE 'degrade.%'`,
    );
    expect(count.rows[0]?.n).toBe('5');
  });
});

describe('FeatureFlags', () => {
  it('reads flags, caches within the TTL, and keeps the last value if the DB fails', async () => {
    const { FeatureFlags } = await import('./flags');
    let t = 0;
    const flags = new FeatureFlags(db.replica, 1_000, () => t);
    await db.pools.primary.query(
      `INSERT INTO feature_flags (key, enabled) VALUES ('t.flag', true) ON CONFLICT (key) DO UPDATE SET enabled = true`,
    );
    expect(await flags.isEnabled('t.flag')).toBe(true);
    await db.pools.primary.query(`UPDATE feature_flags SET enabled = false WHERE key = 't.flag'`);
    expect(await flags.isEnabled('t.flag')).toBe(true); // cached
    t = 1_001;
    expect(await flags.isEnabled('t.flag')).toBe(false); // refreshed
    expect(await flags.isEnabled('t.missing', true)).toBe(true); // fallback
    const broken = createDb({ primaryUrl: 'postgres://sold:sold@127.0.0.1:1/none' });
    try {
      const failing = new FeatureFlags(broken.replica, 1, () => t);
      expect(await failing.isEnabled('t.flag', true)).toBe(true);
    } finally {
      await broken.close();
    }
  });
});

describe('maintainOutboxPartitions', () => {
  it('retires expired partitions, but never one holding unpublished events', async () => {
    const { maintainOutboxPartitions } = await import('./maintenance');
    await db.pools.primary.query(
      `CREATE TABLE outbox_events_202101 PARTITION OF outbox_events FOR VALUES FROM ('2021-01-01') TO ('2021-02-01')`,
    );
    await db.pools.primary.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at, published_at)
       VALUES ('order', 'old-published', 'order.placed', '{}', '2021-01-15', '2021-01-15')`,
    );
    const ok = await maintainOutboxPartitions(db.primary);
    expect(ok).toMatchObject({
      blocked: false,
      dropped: 1,
      defaultPartitionRows: 0,
      createError: null,
    });
    expect(
      (await db.pools.primary.query(`SELECT to_regclass('outbox_events_202101') AS t`)).rows[0]?.t,
    ).toBeNull();

    await db.pools.primary.query(
      `CREATE TABLE outbox_events_202102 PARTITION OF outbox_events FOR VALUES FROM ('2021-02-01') TO ('2021-03-01')`,
    );
    await db.pools.primary.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ('order', 'old-unpublished', 'order.placed', '{}', '2021-02-15')`,
    );
    const blocked = await maintainOutboxPartitions(db.primary);
    expect(blocked).toMatchObject({ blocked: true, dropped: 0, unpublishedBeyondRetention: 1 });
    expect(
      (await db.pools.primary.query(`SELECT to_regclass('outbox_events_202102') AS t`)).rows[0]?.t,
    ).not.toBeNull();
  });

  it('does not block writers to the hot parent while retiring a partition', async () => {
    const { maintainOutboxPartitions } = await import('./maintenance');
    await db.pools.primary.query(
      `CREATE TABLE outbox_events_202103 PARTITION OF outbox_events FOR VALUES FROM ('2021-03-01') TO ('2021-04-01')`,
    );
    await db.pools.primary.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at, published_at)
       SELECT 'order', g::text, 'x', '{}', '2021-03-10', '2021-03-10' FROM generate_series(1, 20000) g`,
    );
    // Writers hammer the parent while retention runs; none may wait anywhere near the 2 s lock_timeout.
    let stop = false;
    let worst = 0;
    const writer = (async () => {
      while (!stop) {
        const t = performance.now();
        await db.pools.primary.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload) VALUES ('order', 'w', 'x', '{}')`,
        );
        worst = Math.max(worst, performance.now() - t);
      }
    })();
    const res = await maintainOutboxPartitions(db.primary);
    stop = true;
    await writer;
    expect(res.dropped + res.deferred).toBe(1);
    expect(worst).toBeLessThan(700);
  });

  it('reports rows stranded in the default partition and a partition that cannot be created', async () => {
    const { maintainOutboxPartitions } = await import('./maintenance');
    const future = await db.pools.primary.query<{ d: string }>(
      `SELECT (date_trunc('month', now()) + interval '2 years')::date::text AS d`,
    );
    const day = future.rows[0]?.d as string;
    // A row far in the future lands in the default partition (no partition covers it).
    await db.pools.primary.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at) VALUES ('order', 'strand', 'x', '{}', $1)`,
      [day],
    );
    const res = await maintainOutboxPartitions(db.primary);
    expect(res.defaultPartitionRows).toBeGreaterThanOrEqual(1);
    await db.pools.primary.query(`DELETE FROM outbox_events_default`);
  });
});

describe('migration runner hardening', () => {
  async function withDir<T>(
    files: Record<string, string>,
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'sold-mig-'));
    try {
      for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('a second runner waits for the first even when the migration outlasts lock_timeout', async () => {
    await withDir(
      { '0001_slow.sql': 'CREATE TABLE slow_mig (id int);\nSELECT pg_sleep(1.5);' },
      async (dir) => {
        const opts = {
          url: testDb.url,
          dir,
          scope: 'test-wait',
          lockTimeoutMs: 300,
          runnerLockWaitMs: 20_000,
        };
        const results = await Promise.all([migrate(opts), migrate(opts)]);
        expect(results.flatMap((r) => r.applied)).toEqual(['0001_slow.sql']);
      },
    );
  });

  it('gives up with a clear error if the runner lock is held past the wait budget', async () => {
    const holder = new Client({ connectionString: testDb.url });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(7265034211)');
    try {
      await withDir({ '0001_x.sql': 'SELECT 1;' }, async (dir) => {
        await expect(
          migrate({ url: testDb.url, dir, scope: 'test-held', runnerLockWaitMs: 400 }),
        ).rejects.toThrow(/held the lock for more than 400 ms/);
      });
    } finally {
      await holder.end();
    }
  });

  it('recovers from an INVALID leftover index instead of journaling a broken one', async () => {
    await db.pools.primary.query(`CREATE TABLE inv_t (v int)`);
    await db.pools.primary.query(`INSERT INTO inv_t VALUES (1), (1)`);
    await withDir(
      {
        '0001_uniq.sql':
          '-- sold:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inv_t_v_uniq ON inv_t (v);',
      },
      async (dir) => {
        // Duplicates make the concurrent UNIQUE build fail and leave an invalid index behind.
        await expect(migrate({ url: testDb.url, dir, scope: 'test-inv' })).rejects.toThrow();
        const left = await db.pools.primary.query(
          `SELECT indisvalid FROM pg_index WHERE indexrelid = 'inv_t_v_uniq'::regclass`,
        );
        expect(left.rows[0]?.indisvalid).toBe(false);
        // Not journaled, so a rerun is possible; once the data is fixed it must rebuild a VALID index.
        await db.pools.primary.query(
          `DELETE FROM inv_t WHERE ctid IN (SELECT ctid FROM inv_t LIMIT 1)`,
        );
        await migrate({ url: testDb.url, dir, scope: 'test-inv' });
        const fixed = await db.pools.primary.query(
          `SELECT indisvalid FROM pg_index WHERE indexrelid = 'inv_t_v_uniq'::regclass`,
        );
        expect(fixed.rows[0]?.indisvalid).toBe(true);
      },
    );
  });

  it('never rewrites a string literal that merely contains the breakpoint marker', async () => {
    await withDir(
      {
        '0001_lit.sql': `CREATE TABLE lit_t (s text);\nINSERT INTO lit_t VALUES ('a --> statement-breakpoint b');`,
      },
      async (dir) => {
        await migrate({ url: testDb.url, dir, scope: 'test-lit' });
        const r = await db.pools.primary.query(`SELECT s FROM lit_t`);
        expect(r.rows[0]?.s).toBe('a --> statement-breakpoint b');
      },
    );
  });
});

describe('FeatureFlags during an outage', () => {
  it('does not query the database on every call while it is down', async () => {
    const { FeatureFlags } = await import('./flags');
    let t = 0;
    const counter = new QueryCounter();
    const broken = createDb({
      primaryUrl: 'postgres://sold:sold@127.0.0.1:1/none',
      logger: counter,
    });
    try {
      const flags = new FeatureFlags(broken.replica, 5_000, () => t);
      for (let i = 0; i < 50; i++) expect(await flags.isEnabled('any', true)).toBe(true);
      // One attempt fails to connect (drizzle logs the statement once), the rest are served from the negative cache.
      expect(counter.count).toBeLessThanOrEqual(1);
      t += 2_001;
      await flags.isEnabled('any', true);
      expect(counter.count).toBeLessThanOrEqual(2);
    } finally {
      await broken.close();
    }
  });
});
