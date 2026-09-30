import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_FORBIDDEN_TABLES, BASE_READ_TABLES } from './extension-access';
import { scopedExtensionDbProvider, type ExtensionDbProvider } from './extension-db';
import { migrateExtension } from './extension-migrations';
import {
  ExtensionIsolationError,
  extensionRoleName,
  listOwnedObjects,
  provisionExtensionRole,
  purgeExtension,
  quoteIdent,
  type ExtensionRoleConfig,
} from './extension-roles';
import { migrate } from './migrate';

/**
 * Extension database roles against a REAL server with a NON-superuser application principal (CREATEROLE only, owner of
 * the database): privileges really bite here, a superuser would bypass every check.
 */
const adminUrl =
  process.env.SOLD_TEST_DATABASE_URL ?? 'postgres://sold:sold@localhost:5432/postgres';
const baseDir = fileURLToPath(new URL('../migrations', import.meta.url));
const suffix = randomBytes(4).toString('hex');
const appRole = `sold_app_${suffix}`;
const plainRole = `sold_plain_${suffix}`; // no CREATEROLE
const config: ExtensionRoleConfig = {
  rolePrefix: `t${suffix}_`,
  secret: randomBytes(24).toString('hex'),
};

let testDb: TestDatabase;
let appUrl: string;
let app: Pool;
let admin: Pool;
let provider: ExtensionDbProvider;

const withUser = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

async function migrateExt(extension: string, files: Record<string, string>, known: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'sold-extroles-'));
  try {
    for (const [n, s] of Object.entries(files)) await writeFile(join(dir, n), s);
    await migrateExtension({ url: appUrl, dir, extension, knownExtensions: known });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const provision = (extension: string, others: string[] = []) =>
  provisionExtensionRole(app, { extension, otherExtensions: others, config });
/** The statement fails with a privilege error (drizzle wraps the driver error: the SQLSTATE is on `cause`). */
const denied = async (p: Promise<unknown>) => {
  const error = (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code?: string; cause?: { code?: string } } | undefined;
  expect(error, 'the statement must fail').toBeDefined();
  expect((error?.cause ?? error)?.code).toMatch(/^(42501|0A000|25006|42809)$/);
};

beforeAll(async () => {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`CREATE ROLE ${appRole} LOGIN CREATEROLE PASSWORD 'app'`);
  await c.query(`CREATE ROLE ${plainRole} LOGIN PASSWORD 'plain'`);
  await c.end();
  testDb = await createTestDatabase();
  const c2 = new Client({ connectionString: adminUrl });
  await c2.connect();
  await c2.query(`ALTER DATABASE ${testDb.name} OWNER TO ${appRole}`);
  await c2.end();
  appUrl = withUser(testDb.url, appRole, 'app');
  await migrate({ url: appUrl, dir: baseDir });
  app = new Pool({ connectionString: appUrl, max: 4 });
  admin = new Pool({ connectionString: testDb.url, max: 2 });
  provider = scopedExtensionDbProvider({ primaryUrl: appUrl, config, poolMax: 2 });
  await admin.query(`INSERT INTO feature_flags (key, enabled) VALUES ('checkout.new', false)`);
  await admin
    .query(`INSERT INTO products (handle, title) VALUES ('p', 'P')`)
    .catch(() => undefined);
}, 120_000);

afterAll(async () => {
  await provider?.close();
  await app?.end();
  await admin?.end();
  await testDb?.destroy();
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  for (const role of await c
    .query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [
      `${config.rolePrefix}%`,
    ])
    .then((r) => r.rows.map((x) => x.rolname)))
    await c.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await c.query(`DROP ROLE IF EXISTS ${appRole}`);
  await c.query(`DROP ROLE IF EXISTS ${plainRole}`);
  await c.end();
});

describe('provisioning as a non-superuser CREATEROLE principal', () => {
  it('creates a least-privilege login role and grants exactly the documented tables', async () => {
    await migrateExt('rolea', {
      '0001.sql': `CREATE TABLE ext_rolea_items (id serial PRIMARY KEY, note text);
        CREATE VIEW ext_rolea_v AS SELECT id FROM ext_rolea_items;`,
    });
    const result = await provision('rolea');
    const role = extensionRoleName(config.rolePrefix, 'rolea');
    expect(result).toMatchObject({
      role,
      tables: ['ext_rolea_items', 'ext_rolea_v'],
      sequences: ['ext_rolea_items_id_seq'],
      ignored: [],
    });

    const { rows } = await admin.query(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit,
              (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS memberships
         FROM pg_roles r WHERE rolname = $1`,
      [role],
    );
    expect(rows[0]).toMatchObject({
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      memberships: 0,
    });
    // Role-level timeouts apply at login, which is what makes them PgBouncer-safe.
    const cfg = await admin.query(`SELECT rolconfig FROM pg_roles WHERE rolname = $1`, [role]);
    expect(cfg.rows[0].rolconfig).toEqual(
      expect.arrayContaining([
        'statement_timeout=5000ms',
        'lock_timeout=2000ms',
        'idle_in_transaction_session_timeout=5000ms',
      ]),
    );
  });

  it('is idempotent and safe to run concurrently', async () => {
    await Promise.all([provision('rolea'), provision('rolea'), provision('rolea')]);
    await provision('rolea');
  });

  it('the boot-time verification passes for a correctly provisioned role', async () => {
    expect(await provider.verify('rolea')).toEqual({
      user: extensionRoleName(config.rolePrefix, 'rolea'),
      problems: [],
    });
  });

  it('own tables work (including serial sequences); the Base read allowlist is readable, never writable', async () => {
    const { primary } = provider.for('rolea');
    await primary.execute(`INSERT INTO ext_rolea_items (note) VALUES ('a'), ('b')`);
    expect((await primary.execute(`SELECT count(*)::int AS n FROM ext_rolea_v`)).rows[0]).toEqual({
      n: 2,
    });
    await primary.execute(`UPDATE ext_rolea_items SET note = 'c' WHERE id = 1`);
    await primary.execute(`DELETE FROM ext_rolea_items WHERE id = 2`);
    for (const table of BASE_READ_TABLES) await primary.execute(`SELECT count(*) FROM ${table}`);
    await denied(primary.execute(`INSERT INTO products (handle, title) VALUES ('x', 'x')`));
    await denied(primary.execute(`UPDATE orders SET id = id`));
    await denied(primary.execute(`DELETE FROM carts`));
  });

  it('cannot reach platform state or secrets, in either direction', async () => {
    const { primary } = provider.for('rolea');
    for (const table of BASE_FORBIDDEN_TABLES) {
      await denied(primary.execute(`SELECT * FROM ${table}`));
      await denied(primary.execute(`DELETE FROM ${table}`));
    }
    await denied(
      primary.execute(
        `INSERT INTO _sold_migrations (scope, name, checksum) VALUES ('base', 'x', 'y')`,
      ),
    );
  });

  it('a table created after provisioning is invisible to the role until the next provisioning run (per-table grants)', async () => {
    await app.query(`CREATE TABLE ext_rolea_late (id int)`);
    const { primary } = provider.for('rolea');
    await denied(primary.execute(`SELECT * FROM ext_rolea_late`));
    await provision('rolea');
    await primary.execute(`SELECT * FROM ext_rolea_late`);
  });

  it('refuses to reuse a role that gained a membership', async () => {
    const role = extensionRoleName(config.rolePrefix, 'rolea');
    await admin.query(`GRANT pg_read_all_data TO ${quoteIdent(role)}`);
    await expect(provision('rolea')).rejects.toThrow(/member of pg_read_all_data/);
    // ... and the boot-time check notices too.
    expect((await provider.verify('rolea')).problems.join()).toMatch(/member of other roles/);
    await admin.query(`REVOKE pg_read_all_data FROM ${quoteIdent(role)}`);
    await provision('rolea');
  });

  it('the boot-time check fails closed when a role gained access to platform state', async () => {
    const role = extensionRoleName(config.rolePrefix, 'rolea');
    await admin.query(`GRANT SELECT ON extension_settings TO ${quoteIdent(role)}`);
    expect((await provider.verify('rolea')).problems.join()).toMatch(
      /platform tables: extension_settings/,
    );
    await provision('rolea'); // re-provisioning revokes anything not documented
    expect((await provider.verify('rolea')).problems).toEqual([]);
  });
});

describe('without the CREATEROLE privilege', () => {
  it('fails with an actionable error, and changes nothing', async () => {
    const plain = new Pool({ connectionString: withUser(testDb.url, plainRole, 'plain'), max: 1 });
    try {
      const error = await provisionExtensionRole(plain, { extension: 'nope', config }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExtensionIsolationError);
      expect((error as Error).message).toMatch(/lacks CREATEROLE/);
      expect((error as Error).message).toMatch(/ALTER ROLE <migration user> CREATEROLE/);
      expect((error as Error).message).toMatch(/docs\/runbooks\/database\.md/);
      expect(
        (
          await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [
            extensionRoleName(config.rolePrefix, 'nope'),
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await plain.end();
    }
  });
});

describe('purge', () => {
  const objects = `
    CREATE TABLE ext_purge_items (id serial PRIMARY KEY, n int);
    CREATE VIEW ext_purge_v AS SELECT id FROM ext_purge_items;
    CREATE SEQUENCE ext_purge_seq;
    CREATE FUNCTION ext_purge_f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a + 1 $$;
    CREATE TYPE ext_purge_kind AS ENUM ('a', 'b');`;

  it('drops tables, views, sequences, functions, types, journal rows and the role; a reinstall succeeds', async () => {
    await migrateExt('purge', { '0001.sql': objects });
    await provision('purge');
    await admin.query(
      `INSERT INTO extension_registry (name, version, state) VALUES ('purge', '1.0.0', 'enabled')`,
    );
    await admin.query(
      `INSERT INTO extension_settings (extension, key, value, updated_by) VALUES ('purge', 'k', '1', 't')`,
    );

    const client = await app.connect();
    let result;
    try {
      result = await purgeExtension(client, {
        extension: 'purge',
        knownExtensions: ['purge'],
        config,
      });
    } finally {
      client.release();
    }
    expect(result.dropped.tables).toEqual(['ext_purge_items']);
    expect(result.dropped.views).toEqual(['ext_purge_v']);
    expect(result.dropped.functions).toEqual(['ext_purge_f(integer)']);
    expect(result.dropped.types).toEqual(['ext_purge_kind']);
    expect(result.roleDropped).toBe(true);

    const left = await admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname LIKE 'ext\\_purge\\_%'
       UNION ALL SELECT proname FROM pg_proc WHERE proname LIKE 'ext\\_purge\\_%'
       UNION ALL SELECT typname FROM pg_type WHERE typname LIKE 'ext\\_purge\\_%'`,
    );
    expect(left.rows).toEqual([]);
    expect(
      (await admin.query(`SELECT 1 FROM _sold_migrations WHERE scope = 'ext:purge'`)).rowCount,
    ).toBe(0);
    expect(
      (await admin.query(`SELECT 1 FROM extension_registry WHERE name = 'purge'`)).rowCount,
    ).toBe(0);
    expect(
      (await admin.query(`SELECT 1 FROM extension_settings WHERE extension = 'purge'`)).rowCount,
    ).toBe(0);
    expect(
      (
        await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [
          extensionRoleName(config.rolePrefix, 'purge'),
        ])
      ).rowCount,
    ).toBe(0);

    // The same migrations apply again ("function already exists" used to break reinstall).
    await migrateExt('purge', { '0001.sql': objects });
    await provision('purge');
    expect((await provider.verify('purge')).problems).toEqual([]);
  });

  it('never interpolates catalogue names: a table named like an injection payload is dropped, nothing else is', async () => {
    const evil = `ext_inj_a";DROP TABLE feature_flags;--`;
    await app.query(`CREATE TABLE ${quoteIdent(evil)} (x int)`);
    await app.query(`CREATE TABLE ext_inj_b (x int)`);
    const client = await app.connect();
    try {
      const result = await purgeExtension(client, {
        extension: 'inj',
        knownExtensions: ['inj'],
        config: undefined,
      });
      expect(result.dropped.tables.sort()).toEqual([evil, 'ext_inj_b'].sort());
    } finally {
      client.release();
    }
    expect(
      (await admin.query(`SELECT 1 FROM pg_tables WHERE tablename = 'feature_flags'`)).rowCount,
    ).toBe(1);
    expect(
      (await admin.query(`SELECT enabled FROM feature_flags WHERE key = 'checkout.new'`)).rows,
    ).toEqual([{ enabled: false }]);
  });

  it('refuses when another known extension\'s prefix overlaps: foo-bar data must survive "uninstall foo --purge"', async () => {
    await app.query(`CREATE TABLE ext_ovl_bar_accounts (id int)`);
    await app.query(`INSERT INTO ext_ovl_bar_accounts VALUES (1)`);
    const client = await app.connect();
    try {
      await expect(
        purgeExtension(client, {
          extension: 'ovl',
          knownExtensions: ['ovl', 'ovl-bar'],
          config: undefined,
        }),
      ).rejects.toThrow(/overlaps with ovl-bar/);
      await expect(
        purgeExtension(client, {
          extension: 'ovl-bar',
          knownExtensions: ['ovl', 'ovl-bar'],
          config: undefined,
        }),
      ).rejects.toThrow(/overlaps with ovl/);
    } finally {
      client.release();
    }
    expect((await app.query(`SELECT id FROM ext_ovl_bar_accounts`)).rows).toEqual([{ id: 1 }]);
    const owned = await listOwnedObjects(app, 'ovl', ['ovl-bar']);
    expect(owned.tables).toEqual([]); // the catalogue listing itself also attributes by longest prefix
  });
});
