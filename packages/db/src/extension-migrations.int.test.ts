import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import { migrateExtension, UnsafeExtensionMigrationError } from './extension-migrations';
import { migrate } from './migrate';

/**
 * The migration linter bypasses found by the independent review, applied to a REAL database. Every scenario used to
 * change Base data, create a superuser, swallow Base INSERTs or leave a half-applied migration behind. Now the
 * extension migrator refuses (the same allowlist lint gate CI runs, applied again at apply time) and the database is
 * untouched.
 */
const baseDir = fileURLToPath(new URL('../migrations', import.meta.url));
let testDb: TestDatabase;
let db: Db;
const q = async (text: string) => (await db.pools.primary.query(text)).rows;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate({ url: testDb.url, dir: baseDir });
  db = createDb({ primaryUrl: testDb.url });
  await q(`INSERT INTO feature_flags (key, enabled) VALUES ('checkout.new', false)`);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

async function apply(
  extension: string,
  files: Record<string, string>,
  knownExtensions: string[] = [],
): Promise<{ ok: boolean; message: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sold-extmig-'));
  try {
    for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
    try {
      await migrateExtension({ url: testDb.url, dir, extension, knownExtensions });
      return { ok: true, message: '' };
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeExtensionMigrationError);
      return { ok: false, message: (error as Error).message };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const flags = async () =>
  JSON.stringify(await q(`SELECT key, enabled FROM feature_flags ORDER BY 1`));
const untouched = JSON.stringify([{ key: 'checkout.new', enabled: false }]);

describe('unsafe extension migrations are refused before anything runs', () => {
  const scenarios: [string, string][] = [
    [
      'writable CTE updating a Base table',
      `WITH u AS (UPDATE feature_flags SET enabled = true WHERE key = 'checkout.new' RETURNING 1) SELECT * FROM u;`,
    ],
    [
      'MERGE into a Base table',
      `MERGE INTO feature_flags f USING (VALUES ('pwn')) AS v(k) ON f.key = v.k WHEN NOT MATCHED THEN INSERT (key) VALUES (v.k);`,
    ],
    [
      '"-- sold:allow extension-namespace" above an INSERT into a Base table',
      `-- sold:allow extension-namespace: trust me\nINSERT INTO feature_flags (key) VALUES ('pwn-allow');`,
    ],
    [
      '"-- sold:allow extension-forbidden" + CREATE ROLE ... SUPERUSER',
      `-- sold:allow extension-forbidden: needed\nCREATE ROLE sold_review_pwn SUPERUSER;`,
    ],
    [
      'CREATE RULE on a Base table',
      `CREATE RULE ext_foo_r AS ON INSERT TO feature_flags DO INSTEAD NOTHING;`,
    ],
    [
      'CREATE TABLE ... INHERITS (Base table)',
      `CREATE TABLE ext_foo_child (extra text) INHERITS (feature_flags);`,
    ],
    [
      'PARTITION OF a Base partitioned table',
      `CREATE TABLE ext_foo_p PARTITION OF outbox_events FOR VALUES FROM ('2099-01-01') TO ('2099-02-01');`,
    ],
    [
      'ALTER FUNCTION on a Base function',
      `ALTER FUNCTION sold_touch_updated_at() SECURITY DEFINER;`,
    ],
    [
      'SET LOCAL session_replication_role',
      `SET LOCAL session_replication_role = replica;\nCREATE TABLE ext_foo_z (x int);`,
    ],
    [
      'ALTER TABLE ... SET SCHEMA pg_catalog',
      `CREATE TABLE ext_foo_t (x int);\n--> statement-breakpoint\nALTER TABLE ext_foo_t SET SCHEMA pg_catalog;`,
    ],
    [
      'COMMIT inside the file (half-applied migration)',
      `CREATE TABLE ext_foo_a (x int);\nCOMMIT;\nCREATE TABLE ext_foo_half (x int);\nSELECT 1/0;`,
    ],
    [
      'a side-effect SELECT (pg_terminate_backend)',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity;`,
    ],
  ];

  for (const [label, sql] of scenarios) {
    it(label, async () => {
      const result = await apply('foo', { '0001.sql': sql });
      expect(result.ok, result.message).toBe(false);
      expect(await flags()).toBe(untouched);
      expect(await q(`SELECT rolname FROM pg_roles WHERE rolname = 'sold_review_pwn'`)).toEqual([]);
      expect(
        await q(`SELECT tablename FROM pg_tables WHERE tablename LIKE 'ext\\_foo\\_%'`),
      ).toEqual([]);
      expect(await q(`SELECT 1 FROM _sold_migrations WHERE scope = 'ext:foo'`)).toEqual([]);
      // The Base function and the outbox are as migrated.
      expect(
        await q(`SELECT prosecdef FROM pg_proc WHERE proname = 'sold_touch_updated_at'`),
      ).toEqual([{ prosecdef: false }]);
    });
  }

  it('a foreign extension namespace is refused (foo may not touch foo-bar tables)', async () => {
    await q(`CREATE TABLE ext_foo_bar_accounts (id int PRIMARY KEY)`);
    const result = await apply(
      'foo',
      {
        '0001.sql': `ALTER TABLE ext_foo_bar_accounts ADD COLUMN pwned text;\nINSERT INTO ext_foo_bar_accounts (id) VALUES (999);`,
      },
      ['foo', 'foo-bar'],
    );
    expect(result.ok).toBe(false);
    expect(
      await q(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'ext_foo_bar_accounts'`,
      ),
    ).toEqual([{ column_name: 'id' }]);
    expect(await q(`SELECT id FROM ext_foo_bar_accounts`)).toEqual([]);
    await q(`DROP TABLE ext_foo_bar_accounts`);
  });

  it('the refusal names the file, line, rule and reason', async () => {
    const result = await apply('foo', {
      '0001.sql': `CREATE TABLE ext_foo_ok (x int);\nGRANT ALL ON feature_flags TO PUBLIC;`,
    });
    expect(result.message).toMatch(
      /0001\.sql:2 \[extension-forbidden\] Extensions may not change privileges/,
    );
  });
});

describe('a safe extension migration still applies, atomically', () => {
  it('applies own-namespace DDL and data, journals it under ext:<name>', async () => {
    const result = await apply('safe', {
      '0001.sql': `CREATE TABLE ext_safe_a (id int PRIMARY KEY, n int);\nINSERT INTO ext_safe_a VALUES (1, 1);\nCREATE VIEW ext_safe_v AS SELECT id FROM ext_safe_a;`,
    });
    expect(result.ok, result.message).toBe(true);
    expect(await q(`SELECT name FROM _sold_migrations WHERE scope = 'ext:safe'`)).toEqual([
      { name: '0001.sql' },
    ]);
  });
});
