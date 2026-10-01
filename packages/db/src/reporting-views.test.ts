import { describe, expect, it } from 'vitest';
import { validateReportingViewSql } from './reporting-views';

const ok = (sql: string) => validateReportingViewSql('loyalty-points', 'balances', sql);

describe('reporting view SQL (the owner can read everything, so the parser decides what is allowed)', () => {
  it("accepts reads of the extension's own tables: aggregates, joins, CTEs", async () => {
    expect(await ok('SELECT customer_id, points FROM ext_loyalty_points_accounts')).toEqual([]);
    expect(
      await ok(
        'SELECT a.customer_id, count(*) FROM ext_loyalty_points_accounts a JOIN ext_loyalty_points_awards w USING (customer_id) GROUP BY 1',
      ),
    ).toEqual([]);
    expect(
      await ok(
        "WITH t AS (SELECT * FROM ext_loyalty_points_awards) SELECT date_trunc('day', awarded_at), sum(points) FROM t GROUP BY 1",
      ),
    ).toEqual([]);
    expect(await ok('SELECT points FROM public.ext_loyalty_points_accounts;')).toEqual([]);
  });

  it("refuses any table that is not the extension's own (Base data, other extensions, catalogues)", async () => {
    for (const q of [
      'SELECT email FROM users',
      'SELECT * FROM orders',
      'SELECT * FROM public.orders',
      'SELECT * FROM ext_reviews_reviews',
      'SELECT * FROM pg_catalog.pg_roles',
      'SELECT * FROM information_schema.tables',
      'SELECT * FROM reporting.daily_sales',
      'SELECT * FROM ext_loyalty_points_accounts a JOIN users u ON u.id::text = a.customer_id',
      'SELECT (SELECT email FROM users LIMIT 1) FROM ext_loyalty_points_accounts',
      'WITH x AS (SELECT * FROM sessions) SELECT * FROM ext_loyalty_points_accounts',
      'WITH accounts AS (SELECT * FROM users) SELECT * FROM accounts',
    ]) {
      const issues = await ok(q);
      expect(issues.length, q).toBeGreaterThan(0);
    }
  });

  it('refuses functions that reach files, the OS, sessions or the catalogue', async () => {
    for (const q of [
      "SELECT pg_read_file('/etc/passwd') FROM ext_loyalty_points_accounts",
      "SELECT lo_import('/etc/passwd') FROM ext_loyalty_points_accounts",
      "SELECT set_config('role','postgres',false) FROM ext_loyalty_points_accounts",
      "SELECT current_setting('server_version') FROM ext_loyalty_points_accounts",
      "SELECT dblink('x','select 1') FROM ext_loyalty_points_accounts",
      "SELECT query_to_xml('select * from users', true, false, '') FROM ext_loyalty_points_accounts",
      "SELECT nextval('x') FROM ext_loyalty_points_accounts",
      'SELECT public.my_function(1) FROM ext_loyalty_points_accounts',
    ])
      expect((await ok(q)).length, q).toBeGreaterThan(0);
  });

  it('refuses anything that is not one plain SELECT', async () => {
    for (const q of [
      'DELETE FROM ext_loyalty_points_accounts',
      'SELECT 1; SELECT 2',
      'SELECT * INTO ext_loyalty_points_copy FROM ext_loyalty_points_accounts',
      'WITH d AS (DELETE FROM ext_loyalty_points_accounts RETURNING *) SELECT * FROM d',
      'SELECT * FROM ext_loyalty_points_accounts FOR UPDATE',
      'CREATE TABLE x (a int)',
      'not sql at all',
      '',
    ])
      expect((await ok(q)).length, q).toBeGreaterThan(0);
  });

  it('refuses unsafe view names', async () => {
    for (const name of ['Bad', 'a-b', '', 'x'.repeat(50), 'a"; DROP VIEW x; --'])
      expect(
        (
          await validateReportingViewSql(
            'loyalty-points',
            name,
            'SELECT 1 FROM ext_loyalty_points_accounts',
          )
        ).length,
        name,
      ).toBeGreaterThan(0);
  });
});
