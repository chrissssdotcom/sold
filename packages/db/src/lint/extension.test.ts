import { describe, expect, it } from 'vitest';
import { lintExtensionMigrationSql } from './index';

const hits = (sql: string, ext = 'loyalty') =>
  lintExtensionMigrationSql(sql, ext).map((f) => f.rule);

describe('extension migration linter', () => {
  it('accepts a well-namespaced extension migration', () => {
    const sql = `
      CREATE TABLE ext_loyalty_accounts (
        id uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
        customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
        points bigint NOT NULL DEFAULT 0 CHECK (points >= 0)
      );
      CREATE INDEX ext_loyalty_accounts_customer_idx ON ext_loyalty_accounts (customer_id);
      CREATE VIEW ext_loyalty_points_v AS SELECT id FROM ext_loyalty_accounts;`;
    expect(hits(sql)).toEqual([]);
  });

  it('rejects tables that are not namespaced', () => {
    expect(hits('CREATE TABLE accounts (id int);')).toContain('extension-namespace');
    expect(hits('CREATE TABLE ext_other_accounts (id int);')).toContain('extension-namespace');
    expect(
      hits('CREATE TABLE ext_loyalty_a (id int); CREATE TABLE public.orders_extra (id int);'),
    ).toContain('extension-namespace');
  });

  it('never allows altering, dropping, truncating or writing to Base tables', () => {
    for (const sql of [
      'ALTER TABLE orders ADD COLUMN loyalty_points int;',
      'ALTER TABLE public.orders ADD COLUMN x int;',
      'DROP TABLE orders;',
      'TRUNCATE orders;',
      'INSERT INTO products (id) VALUES (1);',
      "UPDATE customers SET email = 'x';",
      'DELETE FROM orders;',
      'CREATE TRIGGER t BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION f();',
      "COMMENT ON TABLE orders IS 'x';",
    ]) {
      expect(hits(sql), sql).toContain('extension-namespace');
    }
  });

  it('the failure message points to the sanctioned alternatives', () => {
    const [f] = lintExtensionMigrationSql('ALTER TABLE orders ADD COLUMN x int;', 'loyalty').filter(
      (x) => x.rule === 'extension-namespace',
    );
    expect(f?.message).toMatch(/never alter Base tables/);
    expect(f?.message).toMatch(/side table|metadata jsonb/);
  });

  it('requires index, view, function, type and sequence names to be namespaced too (shared namespace)', () => {
    const base = 'CREATE TABLE ext_loyalty_a (id int);';
    expect(hits(`${base} CREATE INDEX a_idx ON ext_loyalty_a (id);`)).toContain(
      'extension-namespace',
    );
    expect(hits('CREATE VIEW points AS SELECT 1;')).toContain('extension-namespace');
    expect(hits('CREATE FUNCTION award() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;')).toContain(
      'extension-namespace',
    );
    expect(hits("CREATE TYPE tier AS ENUM ('a');")).toContain('extension-namespace');
    expect(hits('CREATE SEQUENCE seq;')).toContain('extension-namespace');
  });

  it('forbids schema, extension, privilege, role, session and server changes', () => {
    for (const sql of [
      'CREATE SCHEMA loyalty;',
      'CREATE EXTENSION pgcrypto;',
      'GRANT ALL ON ext_loyalty_a TO public;',
      'CREATE ROLE evil;',
      'ALTER DATABASE sold SET statement_timeout = 0;',
      'SET statement_timeout = 0;',
      "COPY ext_loyalty_a FROM PROGRAM 'curl x';",
      'DO $$ BEGIN PERFORM 1; END $$;',
    ]) {
      expect(hits(sql), sql).toContain('extension-forbidden');
    }
  });

  it('still applies the online-safety rules to the extension own tables created earlier', () => {
    // Existing extension table from a previous release: plain index build is unsafe.
    expect(hits('CREATE INDEX ext_loyalty_a_idx ON ext_loyalty_a (id);')).toContain(
      'index-not-concurrent',
    );
    expect(hits('ALTER TABLE ext_loyalty_a ADD COLUMN n int NOT NULL;')).toContain(
      'add-column-not-null-no-default',
    );
  });

  it('handles quoting, case and schema qualification when checking names', () => {
    expect(hits('CREATE TABLE "ext_loyalty_a" (id int);')).toEqual([]);
    expect(hits('CREATE TABLE public."EXT_LOYALTY_B" (id int);')).toEqual([]);
    expect(hits('CREATE TABLE "orders" (id int);')).toContain('extension-namespace');
  });

  it('kebab-case extension names map to underscored prefixes', () => {
    expect(hits('CREATE TABLE ext_loyalty_points_a (id int);', 'loyalty-points')).toEqual([]);
    expect(hits('CREATE TABLE ext_loyalty_a (id int);', 'loyalty-points')).toContain(
      'extension-namespace',
    );
  });
});
