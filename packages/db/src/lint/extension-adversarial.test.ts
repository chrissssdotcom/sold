import { describe, expect, it } from 'vitest';
import { lintExtensionMigrationSql } from './index';

/**
 * Regression table for the independent review of the extension migration linter (ADR-0004). Every case was run
 * against the real linter of the time; those marked "allow" produced NO finding then and were bypasses or
 * deliberate allowances. Each is now either REJECTED with the named rule, or explicitly ALLOWED because it only
 * touches the extension's own objects.
 *
 * Applied to a real database (see extension-migrations.int.test.ts), the bypasses in this table changed Base data,
 * created superusers, swallowed Base INSERTs and left half-applied migrations.
 */
type Expect = 'allow' | string;
const cases: [label: string, sql: string, expect: Expect][] = [
  [
    'CONTROL update base',
    `UPDATE feature_flags SET enabled = true WHERE key='x';`,
    'extension-namespace',
  ],
  ['CONTROL insert base', `INSERT INTO feature_flags(key) VALUES ('x');`, 'extension-namespace'],
  ['CONTROL alter base', `ALTER TABLE feature_flags ADD COLUMN evil text;`, 'extension-namespace'],
  [
    'CONTROL create idx on base',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ext_foo_i ON feature_flags(key);`,
    'extension-namespace',
  ],
  [
    'writable CTE UPDATE base',
    `WITH u AS (UPDATE feature_flags SET enabled = true WHERE key='x' RETURNING 1) SELECT * FROM u;`,
    'extension-namespace',
  ],
  [
    'writable CTE DELETE base',
    `WITH d AS (DELETE FROM feature_flags WHERE key='x' RETURNING 1) SELECT count(*) FROM d;`,
    'extension-namespace',
  ],
  [
    'writable CTE INSERT base',
    `WITH i AS (INSERT INTO feature_flags(key) VALUES ('evil') RETURNING key) SELECT * FROM i;`,
    'extension-namespace',
  ],
  [
    'INSERT ext SELECT from writable CTE on base',
    `WITH d AS (DELETE FROM feature_flags RETURNING key) INSERT INTO ext_foo_t SELECT key FROM d;`,
    'extension-namespace',
  ],
  [
    'MERGE into base',
    `MERGE INTO feature_flags f USING (VALUES ('x')) AS v(k) ON f.key = v.k WHEN MATCHED THEN UPDATE SET enabled = true;`,
    'extension-namespace',
  ],
  [
    'SELECT function w/ side effect (setval on base seq)',
    `SELECT setval('some_base_seq', 1);`,
    'extension-forbidden',
  ],
  [
    'SELECT pg_terminate_backend',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid();`,
    'extension-forbidden',
  ],
  [
    'SELECT set_config search_path',
    `SELECT set_config('search_path', 'pg_temp', false);`,
    'extension-forbidden',
  ],
  ['SELECT pg_read_file', `SELECT pg_read_file('/etc/passwd');`, 'extension-forbidden'],
  ['SELECT lo_import', `SELECT lo_import('/etc/passwd');`, 'extension-forbidden'],
  ['SELECT ext function that writes base', `SELECT ext_foo_do_evil();`, 'allow'],
  [
    'CREATE FUNCTION body writes base (invoker)',
    `CREATE FUNCTION ext_foo_f() RETURNS void LANGUAGE sql AS $$ UPDATE feature_flags SET enabled = true $$;`,
    'extension-namespace',
  ],
  [
    'CREATE FUNCTION SECURITY DEFINER',
    `CREATE FUNCTION ext_foo_f2() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`,
    'extension-forbidden',
  ],
  [
    'CREATE TRIGGER on ext table calling writer',
    `CREATE TRIGGER ext_foo_trg AFTER INSERT ON ext_foo_t FOR EACH ROW EXECUTE FUNCTION ext_foo_f();`,
    'allow',
  ],
  [
    'CREATE TRIGGER on base',
    `CREATE TRIGGER ext_foo_trg BEFORE INSERT ON feature_flags FOR EACH ROW EXECUTE FUNCTION ext_foo_f();`,
    'extension-namespace',
  ],
  [
    'CREATE RULE on base',
    `CREATE RULE ext_foo_r AS ON INSERT TO feature_flags DO INSTEAD NOTHING;`,
    'extension-forbidden',
  ],
  [
    'CREATE RULE on ext w/ base action',
    `CREATE RULE ext_foo_r2 AS ON INSERT TO ext_foo_t DO ALSO DELETE FROM feature_flags;`,
    'extension-forbidden',
  ],
  ['DROP RULE base', `DROP RULE some_rule ON feature_flags;`, 'extension-forbidden'],
  [
    'ALTER FUNCTION base',
    `ALTER FUNCTION sold_touch_updated_at() SECURITY DEFINER;`,
    'extension-forbidden',
  ],
  ['DROP FUNCTION base', `DROP FUNCTION sold_touch_updated_at();`, 'extension-namespace'],
  [
    'CREATE OR REPLACE FUNCTION base name',
    `CREATE OR REPLACE FUNCTION sold_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
    'extension-forbidden',
  ],
  [
    'CREATE OR REPLACE FUNCTION schema-qualified pg_catalog',
    `CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '1970-01-01'::timestamptz $$;`,
    'extension-namespace',
  ],
  [
    'CREATE TABLE INHERITS base',
    `CREATE TABLE ext_foo_child () INHERITS (feature_flags);`,
    'extension-namespace',
  ],
  [
    'CREATE TABLE PARTITION OF base',
    `CREATE TABLE ext_foo_p PARTITION OF outbox_events FOR VALUES FROM ('2099-01-01') TO ('2099-02-01');`,
    'extension-namespace',
  ],
  [
    'ALTER TABLE ext INHERIT base',
    `ALTER TABLE ext_foo_t INHERIT feature_flags;`,
    'extension-namespace',
  ],
  [
    'ALTER TABLE base ATTACH PARTITION ext',
    `ALTER TABLE outbox_events ATTACH PARTITION ext_foo_t FOR VALUES FROM ('2098-01-01') TO ('2098-02-01');`,
    'extension-namespace',
  ],
  [
    'CREATE TABLE ... AS from base (allowed read)',
    `CREATE TABLE ext_foo_copy AS SELECT * FROM feature_flags;`,
    'extension-namespace',
  ],
  [
    'CREATE TABLE ext with FK to base ON DELETE RESTRICT',
    `CREATE TABLE ext_foo_fk (k text REFERENCES feature_flags(key) ON DELETE RESTRICT);`,
    'extension-namespace',
  ],
  [
    'CREATE TABLE LIKE base',
    `CREATE TABLE ext_foo_like (LIKE feature_flags INCLUDING ALL);`,
    'extension-namespace',
  ],
  ['ALTER POLICY on base', `ALTER POLICY p ON feature_flags USING (true);`, 'extension-forbidden'],
  ['CREATE POLICY', `CREATE POLICY p ON feature_flags USING (true);`, 'extension-forbidden'],
  [
    'ALTER DEFAULT PRIVILEGES',
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC;`,
    'extension-forbidden',
  ],
  ['SET ROLE', `SET ROLE postgres;`, 'extension-forbidden'],
  ['SET LOCAL ROLE', `SET LOCAL ROLE postgres;`, 'extension-forbidden'],
  [
    'SET LOCAL session_replication_role',
    `SET LOCAL session_replication_role = replica;`,
    'extension-forbidden',
  ],
  ['SET LOCAL search_path', `SET LOCAL search_path = pg_temp, public;`, 'extension-forbidden'],
  ['REASSIGN OWNED', `REASSIGN OWNED BY sold TO postgres;`, 'extension-forbidden'],
  ['DROP OWNED', `DROP OWNED BY sold;`, 'extension-forbidden'],
  ['ALTER TABLE ext OWNER TO', `ALTER TABLE ext_foo_t OWNER TO postgres;`, 'extension-forbidden'],
  [
    'ALTER TABLE base OWNER TO',
    `ALTER TABLE feature_flags OWNER TO postgres;`,
    'extension-forbidden',
  ],
  [
    'SECURITY LABEL on base',
    `SECURITY LABEL ON TABLE feature_flags IS 'x';`,
    'extension-forbidden',
  ],
  ['COMMENT ON base table', `COMMENT ON TABLE feature_flags IS 'pwned';`, 'extension-namespace'],
  [
    'COMMENT ON base column',
    `COMMENT ON COLUMN feature_flags.key IS 'pwned';`,
    'extension-namespace',
  ],
  ['REVOKE on base', `REVOKE ALL ON feature_flags FROM PUBLIC;`, 'extension-forbidden'],
  [
    'ALTER TABLE ext ENABLE ROW LEVEL SECURITY',
    `ALTER TABLE ext_foo_t ENABLE ROW LEVEL SECURITY;`,
    'extension-forbidden',
  ],
  [
    'ALTER TABLE ext SET SCHEMA',
    `ALTER TABLE ext_foo_t SET SCHEMA pg_catalog;`,
    'extension-forbidden',
  ],
  [
    'ALTER TABLE ext RENAME TO base name',
    `ALTER TABLE ext_foo_t RENAME TO orders;`,
    'extension-namespace',
  ],
  ['ALTER TABLE ext RENAME COLUMN', `ALTER TABLE ext_foo_t RENAME COLUMN a TO b;`, 'destructive'],
  [
    'ALTER INDEX base',
    `ALTER INDEX outbox_events_unpublished_idx RENAME TO ext_foo_i;`,
    'extension-namespace',
  ],
  [
    'ALTER INDEX base SET',
    `ALTER INDEX outbox_events_unpublished_idx SET (fillfactor = 10);`,
    'extension-namespace',
  ],
  [
    'DROP INDEX base',
    `DROP INDEX CONCURRENTLY IF EXISTS outbox_events_unpublished_idx;`,
    'extension-namespace',
  ],
  ['ALTER TYPE base', `ALTER TYPE some_enum ADD VALUE 'x';`, 'extension-namespace'],
  ['ALTER SEQUENCE base', `ALTER SEQUENCE some_base_seq RESTART WITH 1;`, 'extension-namespace'],
  ['DROP TABLE base', `DROP TABLE feature_flags;`, 'extension-namespace'],
  ['DROP VIEW base', `DROP VIEW IF EXISTS some_base_view;`, 'extension-namespace'],
  ['ALTER VIEW base', `ALTER VIEW some_base_view RENAME TO ext_foo_v;`, 'extension-namespace'],
  ['DROP SCHEMA', `DROP SCHEMA reporting CASCADE;`, 'extension-forbidden'],
  [
    'DROP TRIGGER base',
    `DROP TRIGGER feature_flags_touch ON feature_flags;`,
    'extension-namespace',
  ],
  [
    'ALTER TABLE base DISABLE TRIGGER',
    `ALTER TABLE feature_flags DISABLE TRIGGER ALL;`,
    'extension-forbidden',
  ],
  ['TRUNCATE base', `TRUNCATE feature_flags;`, 'extension-namespace'],
  ['TRUNCATE ext + base', `TRUNCATE ext_foo_t, feature_flags;`, 'extension-namespace'],
  ['LOCK base', `LOCK TABLE feature_flags IN ACCESS EXCLUSIVE MODE;`, 'extension-forbidden'],
  ['LOCK ext (blocking) ', `LOCK TABLE ext_foo_t IN ACCESS EXCLUSIVE MODE;`, 'extension-forbidden'],
  [
    'REFRESH MATVIEW base',
    `REFRESH MATERIALIZED VIEW CONCURRENTLY some_base_mv;`,
    'extension-namespace',
  ],
  [
    'CREATE PUBLICATION',
    `CREATE PUBLICATION ext_foo_pub FOR TABLE feature_flags;`,
    'extension-forbidden',
  ],
  [
    'CREATE SUBSCRIPTION',
    `CREATE SUBSCRIPTION ext_foo_sub CONNECTION 'host=evil' PUBLICATION p;`,
    'extension-forbidden',
  ],
  [
    'CREATE STATISTICS on base',
    `CREATE STATISTICS ext_foo_st ON key, enabled FROM feature_flags;`,
    'extension-forbidden',
  ],
  [
    'CREATE AGGREGATE/OPERATOR',
    `CREATE OPERATOR === (LEFTARG = int, RIGHTARG = int, FUNCTION = int4eq);`,
    'extension-forbidden',
  ],
  ['CREATE CAST', `CREATE CAST (text AS int4) WITH INOUT;`, 'extension-forbidden'],
  ['CREATE TYPE base name', `CREATE TYPE sold_currency AS ENUM ('A');`, 'extension-namespace'],
  ['CREATE LANGUAGE', `CREATE LANGUAGE ext_foo_lang;`, 'extension-forbidden'],
  ['LOAD library', `LOAD 'auto_explain';`, 'extension-forbidden'],
  [
    'PREPARE/EXECUTE writes base',
    `PREPARE p AS UPDATE feature_flags SET enabled = true;`,
    'extension-forbidden',
  ],
  ['EXECUTE p', `EXECUTE p;`, 'extension-forbidden'],
  ['DISCARD ALL', `DISCARD ALL;`, 'extension-forbidden'],
  ['COMMIT inside migration', `COMMIT; CREATE TABLE ext_foo_a (x int);`, 'extension-forbidden'],
  ['ROLLBACK inside', `ROLLBACK;`, 'extension-forbidden'],
  ['SAVEPOINT', `SAVEPOINT a;`, 'extension-forbidden'],
  ['CHECKPOINT', `CHECKPOINT;`, 'extension-forbidden'],
  ['ALTER SYSTEM', `ALTER SYSTEM SET work_mem = '1GB';`, 'extension-forbidden'],
  ['GRANT', `GRANT ALL ON feature_flags TO PUBLIC;`, 'extension-forbidden'],
  ['NOTIFY', `NOTIFY chan;`, 'extension-forbidden'],
  ['COPY PROGRAM', `COPY ext_foo_t FROM PROGRAM 'id';`, 'extension-forbidden'],
  ['DO block', `DO $$ BEGIN UPDATE feature_flags SET enabled=true; END $$;`, 'extension-forbidden'],
  [
    'schema-qualified public.base',
    `UPDATE public.feature_flags SET enabled = true WHERE key='x';`,
    'extension-namespace',
  ],
  [
    'quoted upper ident',
    `UPDATE "Feature_Flags" SET enabled = true WHERE 1=1;`,
    'extension-namespace',
  ],
  [
    'unicode escape ident U&',
    `UPDATE U&"feature\\005Fflags" SET enabled = true WHERE key='x';`,
    'extension-namespace',
  ],
  ['unicode escape ext prefix U&', `INSERT INTO U&"ext\\005Ffoo\\005Ft" VALUES (1);`, 'allow'],
  [
    'prefix collision: ext_foo_bar_ (another extension foo-bar)',
    `ALTER TABLE ext_foo_bar_orders ADD COLUMN x text;`,
    'allow',
  ],
  [
    'prefix collision insert into foo-bar tbl',
    `INSERT INTO ext_foo_bar_accounts VALUES (1);`,
    'allow',
  ],
  ['prefix collision drop', `DROP TABLE ext_foo_bar_accounts;`, 'destructive'],
  ['prefix coll: ext extension name "foo-" ', `CREATE TABLE ext_foo__x (a int);`, 'allow'],
  ['tablename exactly prefix ext_foo_', `CREATE TABLE ext_foo_ (a int);`, 'extension-namespace'],
  [
    'table named ext_foo_ shadowing pg_temp',
    `CREATE TEMP TABLE feature_flags (key text); UPDATE feature_flags SET key='x' WHERE 1=1;`,
    'extension-forbidden',
  ],
  [
    'pg_temp schema qualified base name',
    `UPDATE pg_temp.feature_flags SET enabled=true WHERE key='x';`,
    'extension-namespace',
  ],
  [
    'UPDATE ... FROM base (write ext, read base)',
    `UPDATE ext_foo_t SET a = f.key FROM feature_flags f WHERE true;`,
    'extension-namespace',
  ],
  ['UPDATE ext returning', `UPDATE ext_foo_t SET a = 1 WHERE b = 2;`, 'allow'],
  ['INSERT ext ON CONFLICT', `INSERT INTO ext_foo_t VALUES (1) ON CONFLICT DO NOTHING;`, 'allow'],
  [
    'DELETE ext USING base',
    `DELETE FROM ext_foo_t USING feature_flags f WHERE true;`,
    'extension-namespace',
  ],
  [
    'UPDATE ext_foo_t ... child inheritance (updates all descendants)',
    `UPDATE ext_foo_t SET a = 1 WHERE true;`,
    'allow',
  ],
  ['ALTER TABLE ONLY ext ... ', `ALTER TABLE ONLY ext_foo_t ADD COLUMN c text;`, 'allow'],
  [
    'ALTER TABLE ext ADD FK to base NOT VALID',
    `ALTER TABLE ext_foo_t ADD CONSTRAINT ext_foo_fk FOREIGN KEY (k) REFERENCES feature_flags(key) ON DELETE CASCADE NOT VALID;`,
    'extension-namespace',
  ],
  [
    'CREATE VIEW over base w/ security_barrier off',
    `CREATE VIEW ext_foo_v AS SELECT * FROM feature_flags;`,
    'extension-forbidden',
  ],
  [
    'CREATE VIEW writable base via auto-updatable view',
    `CREATE VIEW ext_foo_v2 AS SELECT * FROM feature_flags;`,
    'extension-forbidden',
  ],
  [
    'CREATE MATERIALIZED VIEW',
    `CREATE MATERIALIZED VIEW ext_foo_mv AS SELECT * FROM feature_flags;`,
    'extension-namespace',
  ],
  ['CREATE SCHEMA', `CREATE SCHEMA foo;`, 'extension-forbidden'],
  [
    'CREATE TABLE IF NOT EXISTS base name',
    `CREATE TABLE IF NOT EXISTS feature_flags (key text);`,
    'extension-namespace',
  ],
  [
    'CREATE SEQUENCE OWNED BY base col',
    `CREATE SEQUENCE ext_foo_seq OWNED BY feature_flags.key;`,
    'extension-namespace',
  ],
  [
    'CREATE INDEX w/ expression fn',
    `CREATE INDEX ext_foo_ix ON ext_foo_t ((pg_sleep(1) IS NULL));`,
    'extension-forbidden',
  ],
  ['CREATE EXTENSION', `CREATE EXTENSION dblink;`, 'extension-forbidden'],
  [
    'INSERT into pg_catalog',
    `INSERT INTO pg_catalog.pg_class(relname) VALUES ('x');`,
    'extension-namespace',
  ],
  [
    'INSERT into _sold_migrations',
    `INSERT INTO _sold_migrations(scope,name,checksum) VALUES ('base','9999.sql','x');`,
    'extension-namespace',
  ],
  [
    'sold:allow annotation forging namespace',
    `-- sold:allow extension-namespace: trust me\nUPDATE feature_flags SET enabled = true WHERE key='x';`,
    'extension-namespace',
  ],
  [
    'sold:allow annotation forging forbidden',
    `-- sold:allow extension-forbidden: trust me\nGRANT ALL ON feature_flags TO PUBLIC;`,
    'extension-forbidden',
  ],
  [
    'sold:allow forbidden w/ CREATE ROLE',
    `-- sold:allow extension-forbidden: needed\nCREATE ROLE evil SUPERUSER LOGIN PASSWORD 'x';`,
    'extension-forbidden',
  ],
  [
    'sold:allow namespace on DROP TABLE base',
    `-- sold:allow extension-namespace: x\n-- sold:allow destructive: x\nDROP TABLE feature_flags;`,
    'extension-namespace',
  ],
];

const rulesOf = async (sql: string, others: string[] = []) => [
  ...new Set(
    (await lintExtensionMigrationSql(sql, 'foo', { otherExtensions: others })).map((f) => f.rule),
  ),
];

describe('extension migration linter: review corpus (120 cases)', () => {
  it('has all 120 reviewer cases', () => expect(cases).toHaveLength(120));

  for (const [label, sql, expected] of cases) {
    it(`${expected === 'allow' ? 'allows' : 'rejects'}: ${label}`, async () => {
      const rules = await rulesOf(sql);
      if (expected === 'allow') expect(rules, sql).toEqual([]);
      else expect(rules, sql).toContain(expected);
    });
  }

  it('only ten statements are allowed: own-namespace objects and functions, own-table data changes', () => {
    const allowed = cases.filter(([, , expected]) => expected === 'allow').map(([label]) => label);
    expect(allowed).toHaveLength(10);
    // The three collision cases are allowed ONLY while the other extension is unknown (see the next block).
    expect(allowed.filter((l) => l.startsWith('prefix collision'))).toHaveLength(2);
  });
});

describe('prefix collisions (foo vs foo-bar)', () => {
  const collisions = cases.filter(([label]) => label.startsWith('prefix collision'));

  it('the collision cases are rejected once the other extension is known', async () => {
    expect(collisions.length).toBeGreaterThanOrEqual(3);
    for (const [label, sql] of collisions)
      expect(await rulesOf(sql, ['foo-bar']), label).toContain('extension-namespace');
  });

  it('a name in the longer namespace is never owned, whatever the statement', async () => {
    for (const sql of [
      'CREATE TABLE ext_foo_bar_new (a int);',
      'INSERT INTO ext_foo_bar_accounts VALUES (1);',
      'ALTER TABLE ext_foo_bar_accounts ADD COLUMN x int;',
      'DROP TABLE ext_foo_bar_accounts;',
      'CREATE INDEX ext_foo_bar_i ON ext_foo_t (a);',
    ])
      expect(await rulesOf(sql, ['foo-bar']), sql).toContain('extension-namespace');
    // foo-bar itself may of course use its own namespace.
    expect(
      (
        await lintExtensionMigrationSql('CREATE TABLE ext_foo_bar_new (a int);', 'foo-bar', {
          otherExtensions: ['foo'],
        })
      ).map((f) => f.rule),
    ).toEqual([]);
  });
});

describe('extension rules are not waivable', () => {
  it('ignores and reports every "-- sold:allow extension-*" annotation', async () => {
    for (const rule of ['extension-namespace', 'extension-forbidden', 'extension-base-fk']) {
      const found = await lintExtensionMigrationSql(
        `-- sold:allow ${rule}: trust me\nGRANT ALL ON feature_flags TO PUBLIC;`,
        'foo',
      );
      expect(found.map((f) => f.rule)).toContain('extension-forbidden');
      expect(found.map((f) => f.rule)).toContain('extension-allow-ignored');
    }
  });

  it("still honours annotations for the ordinary online-safety rules on the extension's own tables", async () => {
    const sql =
      '-- sold:allow destructive: contract phase, code no longer reads it\nDROP TABLE ext_foo_old;';
    expect(await rulesOf(sql)).toEqual([]);
  });
});

describe('what an extension migration MAY do', () => {
  const ok = async (sql: string) => expect(await rulesOf(sql), sql).toEqual([]);

  it('creates and changes its own objects and reads the Base allowlist', async () => {
    await ok(`CREATE TABLE ext_foo_a (
      id uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
      order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
      note text, created_at timestamptz NOT NULL DEFAULT now());`);
    await ok('CREATE SEQUENCE ext_foo_seq;');
    await ok("CREATE TYPE ext_foo_kind AS ENUM ('a', 'b');");
    await ok('CREATE VIEW ext_foo_v AS SELECT id FROM ext_foo_a;');
    await ok(
      'CREATE VIEW ext_foo_v2 WITH (security_invoker = true) AS SELECT o.id FROM orders o JOIN ext_foo_a a ON a.order_id = o.id;',
    );
    await ok('CREATE FUNCTION ext_foo_f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$;');
    await ok(
      'CREATE TRIGGER ext_foo_touch BEFORE UPDATE ON ext_foo_a FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();',
    );
    await ok("INSERT INTO ext_foo_a (order_id) SELECT id FROM orders WHERE status = 'placed';");
    await ok("SELECT nextval('ext_foo_seq'::regclass);");
    await ok("SELECT sold_ensure_monthly_partitions('ext_foo_a'::regclass, 3);");
  });

  it("refuses a view over Base tables unless it is security_invoker (it would run with the owner's rights)", async () => {
    expect(await rulesOf('CREATE VIEW ext_foo_v AS SELECT id FROM orders;')).toContain(
      'extension-forbidden',
    );
  });

  it('refuses a foreign key to a Base table that could block Base deletes', async () => {
    expect(
      await rulesOf('CREATE TABLE ext_foo_b (o uuid REFERENCES orders (id) ON DELETE RESTRICT);'),
    ).toContain('extension-base-fk');
    expect(
      await rulesOf('CREATE TABLE ext_foo_b (o uuid REFERENCES orders (id) ON DELETE NO ACTION);'),
    ).toContain('extension-base-fk');
  });

  it('refuses non-SQL functions, side-effect calls and object names with unsafe characters', async () => {
    expect(
      await rulesOf(
        'CREATE FUNCTION ext_foo_p() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$;',
      ),
    ).toContain('extension-forbidden');
    expect(await rulesOf("SELECT nextval('orders_id_seq')")).toContain('extension-forbidden');
    expect(
      await rulesOf('CREATE TABLE "ext_foo_a"";DROP TABLE feature_flags;--" (a int);'),
    ).toContain('extension-namespace');
    expect(await rulesOf('CREATE TEMP TABLE ext_foo_tmp (a int);')).toContain(
      'extension-forbidden',
    );
  });
});
