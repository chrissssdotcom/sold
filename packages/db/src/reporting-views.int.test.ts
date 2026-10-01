import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, sql, type Db } from './index';
import { migrate } from './migrate';
import { syncReportingViews } from './reporting-views';
import { fileURLToPath } from 'node:url';

let testDb: TestDatabase;
let db: Db;
let grafana: Db;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate({ url: testDb.url, dir: fileURLToPath(new URL('../migrations', import.meta.url)) });
  db = createDb({ primaryUrl: testDb.url, poolMax: 3 });
  await db.primary.execute(
    sql`CREATE TABLE ext_demo_things (id serial PRIMARY KEY, kind text NOT NULL)`,
  );
  await db.primary.execute(sql`INSERT INTO ext_demo_things (kind) VALUES ('a'), ('a'), ('b')`);
  await db.primary.execute(sql.raw(`ALTER ROLE sold_grafana LOGIN PASSWORD 'pw-for-test'`));
  const url = new URL(testDb.url);
  url.username = 'sold_grafana';
  url.password = 'pw-for-test';
  grafana = createDb({ primaryUrl: url.toString(), poolMax: 2 });
});
afterAll(async () => {
  await grafana?.close();
  await db?.close();
  await testDb?.destroy();
});

const viewNames = async () =>
  (
    await db.primary.execute<{ viewname: string }>(
      sql`SELECT viewname FROM pg_views WHERE schemaname = 'reporting' AND viewname LIKE 'ext\\_%' ORDER BY 1`,
    )
  ).rows.map((r) => r.viewname);

describe('syncReportingViews', () => {
  it('creates valid views readable by the reporting role, skips rejected ones, and removes views that are gone', async () => {
    const r1 = await syncReportingViews(db.primary, [
      {
        extension: 'demo',
        name: 'by_kind',
        sql: 'SELECT kind, count(*) AS n FROM ext_demo_things GROUP BY kind',
      },
      { extension: 'demo', name: 'leaks', sql: 'SELECT email FROM users' },
    ]);
    expect(r1.created).toEqual(['ext_demo_by_kind']);
    expect(r1.rejected.map((r) => r.view)).toEqual(['ext_demo_leaks']);
    expect(await viewNames()).toEqual(['ext_demo_by_kind']);

    const rows = (
      await grafana.primary.execute<{ kind: string; n: string }>(
        sql`SELECT kind, n::int AS n FROM reporting.ext_demo_by_kind ORDER BY kind`,
      )
    ).rows;
    expect(rows).toEqual([
      { kind: 'a', n: 2 },
      { kind: 'b', n: 1 },
    ]);
    // Still no access to the extension's table itself.
    await expect(grafana.primary.execute(sql`SELECT * FROM ext_demo_things`)).rejects.toThrow();

    // Idempotent, and changing the definition replaces the view.
    await syncReportingViews(db.primary, [
      {
        extension: 'demo',
        name: 'by_kind',
        sql: 'SELECT kind, count(*) AS n FROM ext_demo_things GROUP BY kind HAVING count(*) > 1',
      },
    ]);
    expect(
      (await grafana.primary.execute(sql`SELECT * FROM reporting.ext_demo_by_kind`)).rows,
    ).toHaveLength(1);

    // The extension is disabled or no longer declares the view: it is dropped.
    const r3 = await syncReportingViews(db.primary, []);
    expect(r3.dropped).toEqual(['ext_demo_by_kind']);
    expect(await viewNames()).toEqual([]);
  });

  it('never touches the Base reporting views', async () => {
    await syncReportingViews(db.primary, []);
    const base = (
      await db.primary.execute<{ viewname: string }>(
        sql`SELECT viewname FROM pg_views WHERE schemaname = 'reporting' AND viewname NOT LIKE 'ext\\_%'`,
      )
    ).rows;
    expect(base.length).toBeGreaterThanOrEqual(8);
  });
});
