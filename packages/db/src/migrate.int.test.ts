import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { createDb, QueryCounter, type Db } from './client';
import { lintMigrationDir } from './lint';
import { migrate } from './migrate';
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
    expect(first.applied).toEqual(['0000_init.sql']);
    const second = await migrate({ url: testDb.url, dir: migrationsDir });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0000_init.sql']);
    db = createDb({ primaryUrl: testDb.url });
  });

  it('matches the Drizzle schema (columns, types, nullability)', async () => {
    const tables: PgTable[] = [featureFlags, outboxEvents, migrationJournal];
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
        const normalized =
          expectedType === 'timestamp with time zone' ? 'timestamp with time zone' : expectedType;
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

  it('ensure is idempotent and retention drops only expired partitions', async () => {
    const again = await db.pools.primary.query<{ n: number }>(
      `SELECT sold_ensure_monthly_partitions('outbox_events', 3) AS n`,
    );
    expect(again.rows[0]?.n).toBe(0);
    await db.pools.primary.query(
      `CREATE TABLE outbox_events_202001 PARTITION OF outbox_events FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`,
    );
    const dropped = await db.pools.primary.query<{ n: number }>(
      `SELECT sold_drop_old_partitions('outbox_events', 3) AS n`,
    );
    expect(dropped.rows[0]?.n).toBe(1);
    const left = await db.pools.primary.query(
      `SELECT 1 FROM pg_inherits WHERE inhparent = 'outbox_events'::regclass`,
    );
    expect(left.rowCount).toBe(5);
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
  it('drops expired partitions only when nothing in them is unpublished', async () => {
    const { maintainOutboxPartitions } = await import('./maintenance');
    await db.pools.primary.query(
      `CREATE TABLE outbox_events_202101 PARTITION OF outbox_events FOR VALUES FROM ('2021-01-01') TO ('2021-02-01')`,
    );
    await db.pools.primary.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at, published_at)
       VALUES ('order', 'old-published', 'order.placed', '{}', '2021-01-15', '2021-01-15')`,
    );
    const ok = await maintainOutboxPartitions(db.primary);
    expect(ok).toMatchObject({ blocked: false, dropped: 1 });

    await db.pools.primary.query(
      `CREATE TABLE outbox_events_202102 PARTITION OF outbox_events FOR VALUES FROM ('2021-02-01') TO ('2021-03-01')`,
    );
    await db.pools.primary.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ('order', 'old-unpublished', 'order.placed', '{}', '2021-02-15')`,
    );
    const blocked = await maintainOutboxPartitions(db.primary);
    expect(blocked).toMatchObject({ blocked: true, dropped: 0, unpublishedBeyondRetention: 1 });
    const still = await db.pools.primary.query(`SELECT to_regclass('outbox_events_202102') AS t`);
    expect(still.rows[0]?.t).not.toBeNull();
  });
});
