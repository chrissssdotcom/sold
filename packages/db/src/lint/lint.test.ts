import { describe, expect, it } from 'vitest';
import { lintMigrationSql } from './index';
import { splitSql } from './sql';

const rulesHit = (sql: string) => lintMigrationSql(sql).map((f) => f.rule);

describe('splitSql', () => {
  it('handles quotes, dollar quoting and comments', () => {
    const s = splitSql(`-- head\nSELECT 'a;b'; /* x; y */ DO $$ BEGIN PERFORM 1; END $$; SELECT 2`);
    expect(s.map((x) => x.text)).toEqual([
      `SELECT 'a;b'`,
      'DO $$ BEGIN PERFORM 1; END $$',
      'SELECT 2',
    ]);
    expect(s[0]?.leadingComments).toEqual(['head']);
  });
});

describe('migration linter', () => {
  it('allows anything on a table created in the same migration', () => {
    expect(
      rulesHit(
        `CREATE TABLE t (id int PRIMARY KEY, x int NOT NULL); CREATE INDEX t_x ON t (x); ALTER TABLE t ADD COLUMN y int NOT NULL;`,
      ),
    ).toEqual([]);
  });

  it('rejects non-concurrent index on an existing table', () => {
    expect(rulesHit('CREATE INDEX i ON orders (created_at);')).toContain('index-not-concurrent');
    expect(rulesHit('CREATE UNIQUE INDEX i ON orders (number);')).toContain('index-not-concurrent');
  });

  it('accepts concurrent index in a no-transaction file, rejects it otherwise', () => {
    const stmt = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON orders (created_at);';
    expect(rulesHit(`-- sold:no-transaction\n${stmt}`)).toEqual([]);
    expect(rulesHit(stmt)).toEqual(['concurrent-in-transaction']);
    expect(rulesHit(`-- sold:no-transaction\nCREATE INDEX CONCURRENTLY i ON orders (x);`)).toEqual([
      'concurrent-if-not-exists',
    ]);
  });

  it('rejects unsafe ADD COLUMN', () => {
    expect(rulesHit('ALTER TABLE orders ADD COLUMN note text NOT NULL;')).toContain(
      'add-column-not-null-no-default',
    );
    expect(rulesHit('ALTER TABLE orders ADD COLUMN ref uuid DEFAULT gen_random_uuid();')).toContain(
      'add-column-volatile-default',
    );
    expect(rulesHit("ALTER TABLE orders ADD COLUMN note text NOT NULL DEFAULT '';")).toEqual([]);
    expect(rulesHit('ALTER TABLE orders ADD COLUMN placed_at timestamptz DEFAULT now();')).toEqual(
      [],
    );
    expect(rulesHit('ALTER TABLE orders ADD COLUMN note text;')).toEqual([]);
  });

  it('rejects rewrites and full-scan changes', () => {
    expect(rulesHit('ALTER TABLE orders ALTER COLUMN total TYPE bigint;')).toContain(
      'alter-column-type',
    );
    expect(rulesHit('ALTER TABLE orders ALTER COLUMN total SET NOT NULL;')).toContain(
      'set-not-null',
    );
  });

  it('requires NOT VALID for FK/CHECK and USING INDEX for unique/pk', () => {
    expect(rulesHit('ALTER TABLE orders ADD CONSTRAINT c CHECK (total >= 0);')).toContain(
      'add-constraint-not-valid',
    );
    expect(rulesHit('ALTER TABLE orders ADD CONSTRAINT c CHECK (total >= 0) NOT VALID;')).toEqual(
      [],
    );
    expect(
      rulesHit(
        'ALTER TABLE orders ADD CONSTRAINT f FOREIGN KEY (c) REFERENCES customers (id) ON DELETE RESTRICT;',
      ),
    ).toEqual(['add-constraint-not-valid']);
    expect(rulesHit('ALTER TABLE orders ADD CONSTRAINT u UNIQUE (number);')).toContain(
      'add-unique-or-pk',
    );
    expect(
      rulesHit('ALTER TABLE orders ADD CONSTRAINT u UNIQUE USING INDEX orders_number_idx;'),
    ).toEqual([]);
  });

  it('requires an explicit ON DELETE on foreign keys', () => {
    expect(rulesHit('CREATE TABLE a (id int, b int REFERENCES b (id));')).toContain(
      'fk-on-delete-explicit',
    );
    expect(rulesHit('CREATE TABLE a (id int, b int REFERENCES b (id) ON DELETE CASCADE);')).toEqual(
      [],
    );
    expect(
      rulesHit(
        'CREATE TABLE a (id int, b int REFERENCES b (id) ON DELETE CASCADE, c int REFERENCES c (id));',
      ),
    ).toContain('fk-on-delete-explicit');
  });

  it('treats destructive changes as contract-phase, allowed only with a reason', () => {
    expect(rulesHit('DROP TABLE legacy;')).toContain('destructive');
    expect(rulesHit('ALTER TABLE orders DROP COLUMN old;')).toContain('destructive');
    expect(rulesHit('ALTER TABLE orders RENAME COLUMN a TO b;')).toContain('destructive');
    expect(
      rulesHit(
        '-- sold:allow destructive: column unused since v1.4, see ADR-0007\nALTER TABLE orders DROP COLUMN old;',
      ),
    ).toEqual([]);
    expect(rulesHit('-- sold:allow destructive\nALTER TABLE orders DROP COLUMN old;')).toContain(
      'allow-needs-reason',
    );
  });

  it('rejects blocking commands', () => {
    expect(rulesHit('LOCK TABLE orders;')).toContain('blocking-command');
    expect(rulesHit('VACUUM FULL orders;')).toContain('blocking-command');
    expect(rulesHit('REINDEX TABLE orders;')).toContain('blocking-command');
    expect(rulesHit('REFRESH MATERIALIZED VIEW reporting.daily;')).toContain('blocking-command');
    expect(rulesHit('REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.daily;')).toEqual([]);
  });

  it('does not flag keywords inside string literals or function bodies', () => {
    expect(
      rulesHit(`CREATE TABLE t (id int); INSERT INTO t VALUES (1); SELECT 'DROP TABLE x';`),
    ).toEqual([]);
    expect(
      rulesHit(`CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 'drop table x' $$;`),
    ).toEqual([]);
  });
});
