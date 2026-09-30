import { describe, expect, it } from 'vitest';
import { lintMigrationSql } from './index';

/**
 * Adversarial corpus. Every "must flag" case was an unsafe statement the earlier regex linter let through
 * (found by independent review); every "must accept" case is a safe statement it wrongly rejected, or a
 * boundary of a rule. The linter now works on PostgreSQL's real AST, so these are structural, not textual.
 */
const flagged = async (sql: string) => [
  ...new Set((await lintMigrationSql(sql)).map((f) => f.rule)),
];
const NT = '-- sold:no-transaction\n';

const mustFlag: [string, string, string][] = [
  [
    'ADD CONSTRAINT with a quoted name containing a space (UNIQUE)',
    'ALTER TABLE t ADD CONSTRAINT "x y" UNIQUE (a);',
    'add-unique-or-pk',
  ],
  [
    'ADD CONSTRAINT with a quoted name containing a space (CHECK)',
    'ALTER TABLE t ADD CONSTRAINT "x y" CHECK (a > 0);',
    'add-constraint-not-valid',
  ],
  [
    'ADD EXCLUDE constraint',
    'ALTER TABLE t ADD CONSTRAINT e EXCLUDE USING gist (a WITH =);',
    'add-exclusion',
  ],
  [
    'inline REFERENCES on ADD COLUMN',
    'ALTER TABLE t ADD COLUMN c int REFERENCES o (id) ON DELETE CASCADE;',
    'add-column-constraint',
  ],
  [
    'inline CHECK on ADD COLUMN',
    'ALTER TABLE t ADD COLUMN c int CHECK (c > 0);',
    'add-column-constraint',
  ],
  [
    'GENERATED ... STORED column',
    'ALTER TABLE t ADD COLUMN c int GENERATED ALWAYS AS (a + 1) STORED;',
    'add-column-rewrite',
  ],
  ['serial column', 'ALTER TABLE t ADD COLUMN c serial;', 'add-column-rewrite'],
  ['bigserial column', 'ALTER TABLE t ADD COLUMN c bigserial;', 'add-column-rewrite'],
  [
    'IDENTITY column',
    'ALTER TABLE t ADD COLUMN c int GENERATED ALWAYS AS IDENTITY;',
    'add-column-rewrite',
  ],
  [
    'DEFAULT uuidv7()',
    'ALTER TABLE t ADD COLUMN c uuid DEFAULT uuidv7();',
    'add-column-volatile-default',
  ],
  [
    'volatile call nested inside another function',
    "ALTER TABLE t ADD COLUMN c text DEFAULT concat(random()::text, 'x');",
    'add-column-volatile-default',
  ],
  [
    'user-defined function default (unknown volatility)',
    'ALTER TABLE t ADD COLUMN c uuid DEFAULT sold_uuid_v7();',
    'add-column-volatile-default',
  ],
  [
    'second ADD COLUMN in one statement is NOT NULL without default',
    'ALTER TABLE t ADD COLUMN a int DEFAULT 0, ADD COLUMN b int NOT NULL;',
    'add-column-not-null-no-default',
  ],
  [
    'a column literally named "default"',
    'ALTER TABLE t ADD COLUMN "default" int NOT NULL;',
    'add-column-not-null-no-default',
  ],
  ['DROP without the COLUMN keyword', 'ALTER TABLE t DROP a;', 'destructive'],
  ['DROP FUNCTION', 'DROP FUNCTION f();', 'destructive'],
  ['DROP VIEW', 'DROP VIEW v;', 'destructive'],
  ['DROP TYPE', 'DROP TYPE x;', 'destructive'],
  ['DROP SCHEMA', 'DROP SCHEMA s CASCADE;', 'destructive'],
  ['RENAME a table', 'ALTER TABLE t RENAME TO u;', 'destructive'],
  ['RENAME a column', 'ALTER TABLE t RENAME COLUMN a TO b;', 'destructive'],
  ['TRUNCATE', 'TRUNCATE t;', 'destructive'],
  ['SET LOGGED', 'ALTER TABLE t SET LOGGED;', 'blocking-command'],
  [
    'ATTACH PARTITION',
    "ALTER TABLE t ATTACH PARTITION p FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');",
    'partition-change',
  ],
  ['DETACH PARTITION', 'ALTER TABLE t DETACH PARTITION p;', 'partition-change'],
  ['DELETE without WHERE', 'DELETE FROM t;', 'unbounded-dml'],
  ['UPDATE without WHERE', 'UPDATE t SET a = 1;', 'unbounded-dml'],
  ['dynamic SQL inside a DO block', "DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$;", 'dynamic-sql'],
  [
    'a DROP after an E-string with an escaped quote (hid it from the splitter)',
    "INSERT INTO t VALUES (E'\\''); DROP TABLE x;",
    'destructive',
  ],
  [
    'a DROP after a nested block comment',
    '/* a /* nested */ still comment */ DROP TABLE x;',
    'destructive',
  ],
  [
    'SET NOT NULL on a quoted table name',
    'ALTER TABLE "x y" ALTER COLUMN a SET NOT NULL;',
    'set-not-null',
  ],
  ['ALTER COLUMN TYPE', 'ALTER TABLE t ALTER COLUMN a TYPE text;', 'alter-column-type'],
  ['SET DATA TYPE', 'ALTER TABLE t ALTER COLUMN a SET DATA TYPE bigint;', 'alter-column-type'],
  ['non-concurrent unique index', 'CREATE UNIQUE INDEX i ON t (a);', 'index-not-concurrent'],
  ['non-concurrent DROP INDEX', 'DROP INDEX i;', 'drop-index-not-concurrent'],
  [
    'CONCURRENTLY in a transactional file',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);',
    'concurrent-in-transaction',
  ],
  [
    'DROP INDEX CONCURRENTLY in a transactional file',
    'DROP INDEX CONCURRENTLY IF EXISTS i;',
    'concurrent-in-transaction',
  ],
  [
    'CONCURRENTLY without IF NOT EXISTS',
    `${NT}CREATE INDEX CONCURRENTLY i ON t (a);`,
    'concurrent-if-not-exists',
  ],
  [
    'several statements in a no-transaction file without breakpoints',
    `${NT}CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (a);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (b);`,
    'no-transaction-needs-breakpoints',
  ],
  [
    'a quoted mixed-case table is not the same table as the lower-case one',
    'CREATE TABLE "Foo" (id int); ALTER TABLE foo ADD COLUMN x int NOT NULL;',
    'add-column-not-null-no-default',
  ],
  [
    'FK on a new table without ON DELETE',
    'CREATE TABLE a (id int, b int REFERENCES b (id));',
    'fk-on-delete-explicit',
  ],
  [
    'table-level FK without ON DELETE',
    'CREATE TABLE a (id int, b int, FOREIGN KEY (b) REFERENCES p (id));',
    'fk-on-delete-explicit',
  ],
  [
    'ADD FOREIGN KEY without NOT VALID',
    'ALTER TABLE a ADD FOREIGN KEY (b) REFERENCES p (id) ON DELETE RESTRICT;',
    'add-constraint-not-valid',
  ],
  ['LOCK TABLE', 'LOCK TABLE t;', 'blocking-command'],
  ['VACUUM FULL', 'VACUUM FULL t;', 'blocking-command'],
  ['CLUSTER', 'CLUSTER t;', 'blocking-command'],
  ['REINDEX without CONCURRENTLY', 'REINDEX TABLE t;', 'blocking-command'],
  ['REFRESH MATERIALIZED VIEW (blocking)', 'REFRESH MATERIALIZED VIEW m;', 'blocking-command'],
  [
    'an allow comment AFTER the statement does not apply to it',
    'DROP TABLE x; -- sold:allow destructive: too late',
    'destructive',
  ],
  [
    'an allow comment inside the statement does not apply',
    'DROP TABLE x /* sold:allow destructive: nope */;',
    'destructive',
  ],
  [
    'a malformed allow annotation',
    '-- sold:allow destructive\nDROP TABLE x;',
    'allow-needs-reason',
  ],
  ['invalid SQL is rejected, not skipped', 'CREATE TABL x (id int);', 'syntax-error'],
];

const mustAccept: [string, string][] = [
  [
    "the NOT VALID CHECK recipe for NOT NULL (the linter's own advice)",
    'ALTER TABLE t ADD CONSTRAINT c CHECK (a IS NOT NULL) NOT VALID;',
  ],
  ['VALIDATE CONSTRAINT', 'ALTER TABLE t VALIDATE CONSTRAINT c;'],
  [
    'SET NOT NULL with a reason',
    '-- sold:allow set-not-null: check constraint c was validated in 0007, so PostgreSQL skips the scan\nALTER TABLE t ALTER COLUMN a SET NOT NULL;',
  ],
  ['an index on a TEMP table', 'CREATE TEMP TABLE tmp (a int); CREATE INDEX i ON tmp (a);'],
  ['REFRESH MATERIALIZED VIEW ... WITH NO DATA', 'REFRESH MATERIALIZED VIEW m WITH NO DATA;'],
  ['REFRESH MATERIALIZED VIEW CONCURRENTLY', 'REFRESH MATERIALIZED VIEW CONCURRENTLY m;'],
  ['ADD COLUMN DEFAULT now()', 'ALTER TABLE t ADD COLUMN c timestamptz DEFAULT now();'],
  ['ADD COLUMN constant default', 'ALTER TABLE t ADD COLUMN c int DEFAULT 0;'],
  [
    'ADD COLUMN NOT NULL with a constant default',
    "ALTER TABLE t ADD COLUMN c jsonb NOT NULL DEFAULT '{}'::jsonb;",
  ],
  ['ADD COLUMN nullable', 'ALTER TABLE t ADD COLUMN c text;'],
  [
    'ADD FOREIGN KEY ... NOT VALID',
    'ALTER TABLE a ADD CONSTRAINT f FOREIGN KEY (b) REFERENCES p (id) ON DELETE RESTRICT NOT VALID;',
  ],
  ['ADD UNIQUE ... USING INDEX', 'ALTER TABLE t ADD CONSTRAINT u UNIQUE USING INDEX i;'],
  [
    'a well-formed no-transaction file',
    `${NT}CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (a);\n--> statement-breakpoint\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (b);`,
  ],
  [
    'keywords inside string literals',
    "CREATE TABLE t2 (id int); INSERT INTO t2 VALUES (1); SELECT 'DROP TABLE x';",
  ],
  [
    'keywords inside a function body',
    "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 'drop table x' $$;",
  ],
  [
    'everything on a table created in the same migration (schema-qualified vs not)',
    'CREATE TABLE public.t9 (id int); ALTER TABLE t9 ADD COLUMN x int NOT NULL; CREATE INDEX i9 ON t9 (x);',
  ],
  ['renaming an index', 'ALTER INDEX i RENAME TO j;'],
  ['COMMENT ON', "COMMENT ON TABLE t IS 'x';"],
  ['INSERT of seed data', 'INSERT INTO t (a) VALUES (1), (2);'],
  ['bounded UPDATE / DELETE', 'UPDATE t SET a = 1 WHERE id = 5; DELETE FROM t WHERE id = 5;'],
  [
    'DROP of a table created in the same migration',
    'CREATE TABLE scratch (id int); DROP TABLE scratch;',
  ],
];

describe('migration linter: adversarial corpus (must flag)', () => {
  it.each(mustFlag)('%s', async (_name, sql, rule) => {
    expect(await flagged(sql)).toContain(rule);
  });
});

describe('migration linter: adversarial corpus (must accept)', () => {
  it.each(mustAccept)('%s', async (_name, sql) => {
    expect(await flagged(sql)).toEqual([]);
  });
});
