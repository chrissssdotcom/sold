import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  BASE_READ_TABLES,
  extensionPrefix,
  extensionToken,
  ownsObject,
  prefixCollisions,
} from './extension-access';

/**
 * Database roles for extensions (ADR-0004).
 *
 * Each extension gets its OWN login role `<prefix><name>` and its own connection pool, so the session user of an
 * extension's connection IS the extension role. There is no `SET ROLE` to undo and nothing to escape to: the role
 * is a member of nothing, so `SET ROLE`, `RESET ROLE` and `SET SESSION AUTHORIZATION` land on nothing useful. (A
 * single shared login role that `SET LOCAL ROLE`s into per-extension roles would let one extension `SET ROLE` into
 * another, because the check is against the SESSION user's memberships.)
 *
 * Privileges of an extension role:
 *  - SELECT/INSERT/UPDATE/DELETE on every table and view named `ext_<name>_*`, USAGE on its sequences;
 *  - SELECT on `BASE_READ_TABLES` (one documented allowlist);
 *  - nothing else: no `extension_settings`, `extension_registry`, `_sold_migrations`, `feature_flags`, outbox,
 *    idempotency keys, the `pgboss` schema, or another extension's tables; no CREATE anywhere.
 *
 * Grants are per table and re-issued on every provisioning run (default privileges are deliberately not used).
 * Roles are cluster-level; this code is run by the release pipeline (`sold ext:migrate`), never by web/worker.
 */

export const DEFAULT_ROLE_PREFIX = 'sold_ext_';

export class ExtensionIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionIsolationError';
  }
}

export interface ExtensionRoleConfig {
  /** Role name prefix; roles are cluster-wide, so deployments sharing a cluster use different prefixes. */
  rolePrefix: string;
  /** Secret the per-role passwords are derived from (`SOLD_EXTENSION_DB_SECRET`). */
  secret: string;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /** Server-side cap on concurrent connections of one extension role (defence against pool exhaustion). */
  connectionLimit?: number;
}

const ROLE_PREFIX = /^[a-z][a-z0-9_]{0,24}$/;

export function extensionRoleName(rolePrefix: string, extension: string): string {
  if (!ROLE_PREFIX.test(rolePrefix))
    throw new ExtensionIsolationError(`Invalid role prefix "${rolePrefix}"`);
  const role = `${rolePrefix}${extensionToken(extension)}`;
  if (!/^[a-z][a-z0-9_]*$/.test(role) || Buffer.byteLength(role) > 63)
    throw new ExtensionIsolationError(`Cannot derive a role name for extension "${extension}"`);
  return role;
}

/** Deterministic per-role password derived from the deployment secret; never stored anywhere but the database. */
export function extensionRolePassword(secret: string, role: string): string {
  if (secret.length < 32)
    throw new ExtensionIsolationError('SOLD_EXTENSION_DB_SECRET must be at least 32 characters');
  return createHmac('sha256', secret).update(`sold-extension-db:v1:${role}`).digest('base64url');
}

/** Connection string for an extension: the base URL's host, port, database and options with the role's credentials. */
export function extensionConnectionString(
  baseUrl: string,
  role: string,
  config: ExtensionRoleConfig,
): string {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = extensionRolePassword(config.secret, role);
  return url.toString();
}

export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

interface RoleFacts {
  current: string;
  superuser: boolean;
  createRole: boolean;
}

async function principal(client: PoolClient): Promise<RoleFacts> {
  const { rows } = await client.query<{
    current: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT current_user AS current, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
  );
  const r = rows[0];
  return {
    current: r?.current ?? '?',
    superuser: r?.rolsuper ?? false,
    createRole: r?.rolcreaterole ?? false,
  };
}

export const CREATEROLE_HELP =
  'Extension database isolation needs the migration principal to be able to create roles. One-time fix, run by a ' +
  'superuser: ALTER ROLE <migration user> CREATEROLE;  (see docs/runbooks/database.md, "Extension database roles"). ' +
  'Local development and tests can set SOLD_EXTENSION_DB_ISOLATION=off instead.';

export interface ProvisionResult {
  role: string;
  tables: string[];
  sequences: string[];
  /** Names with the extension's prefix that were NOT granted because they are not valid owned names. */
  ignored: string[];
}

interface Relation {
  name: string;
  kind: string;
}

/** Relations in `public` whose name starts with the exact prefix, from the catalogue (never from a pattern match alone). */
async function ownedRelations(
  client: PoolClient,
  extension: string,
  others: readonly string[],
): Promise<{ owned: Relation[]; weird: string[] }> {
  const prefix = extensionPrefix(extension);
  const { rows } = await client.query<{ relname: string; relkind: string }>(
    `SELECT c.relname, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND left(c.relname, length($1)) = $1
      ORDER BY c.relname`,
    [prefix],
  );
  const owned: Relation[] = [];
  const weird: string[] = [];
  for (const r of rows) {
    if (ownsObject(extension, r.relname, others)) owned.push({ name: r.relname, kind: r.relkind });
    else if (!foreignByPrefix(extension, r.relname, others)) weird.push(r.relname);
  }
  return { owned, weird };
}

/** True when the name sits in the namespace of another known extension with a longer prefix. */
function foreignByPrefix(extension: string, name: string, others: readonly string[]): boolean {
  const own = extensionPrefix(extension);
  return others.some(
    (o) =>
      o !== extension &&
      extensionPrefix(o).length > own.length &&
      name.startsWith(extensionPrefix(o)),
  );
}

async function createOrAlterRole(
  client: PoolClient,
  role: string,
  config: ExtensionRoleConfig,
  superuser: boolean,
): Promise<void> {
  const password = quoteLiteral(extensionRolePassword(config.secret, role));
  const limit = Math.max(1, Math.trunc(config.connectionLimit ?? 20));
  const base = `LOGIN NOINHERIT NOCREATEROLE CONNECTION LIMIT ${limit} PASSWORD ${password}`;
  const existing = await client.query<{
    rolsuper: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  const found = existing.rows[0];
  if (!found) {
    await client.query('SAVEPOINT create_role');
    try {
      await client.query(`CREATE ROLE ${quoteIdent(role)} NOSUPERUSER NOCREATEDB ${base}`);
      await client.query('RELEASE SAVEPOINT create_role');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT create_role');
      // A concurrent provisioner created it first: fall through and align it.
      const code = (error as { code?: string }).code;
      if (code !== '42710' && code !== '23505') throw error;
      await client.query(`ALTER ROLE ${quoteIdent(role)} ${base}`);
    }
  } else {
    // A role must never gain memberships or privileged attributes: they would carry privileges we did not grant.
    const members = await client.query<{ roleid: string }>(
      `SELECT r.rolname AS roleid FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
      [role],
    );
    if (members.rows.length > 0)
      throw new ExtensionIsolationError(
        `Extension role "${role}" is a member of ${members.rows.map((m) => m.roleid).join(', ')}: refusing to use it. Remove the membership or drop the role.`,
      );
    const privileged = Object.entries({
      SUPERUSER: found.rolsuper,
      CREATEDB: found.rolcreatedb,
      REPLICATION: found.rolreplication,
      BYPASSRLS: found.rolbypassrls,
    })
      .filter(([, on]) => on)
      .map(([name]) => name);
    // Only a superuser may change these attributes; anyone else must refuse rather than continue with them set.
    if (privileged.length > 0 && !superuser)
      throw new ExtensionIsolationError(
        `Extension role "${role}" has ${privileged.join(', ')}: refusing to use it. A superuser must remove it (ALTER ROLE ${role} NO${privileged.join(' NO')}) or drop the role.`,
      );
    const reset = superuser ? 'NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS ' : '';
    await client.query(`ALTER ROLE ${quoteIdent(role)} ${reset}${base}`);
  }
  // Role-level settings apply at login, which is exactly when a per-extension connection starts (PgBouncer-safe).
  const settings: [string, number][] = [
    ['statement_timeout', config.statementTimeoutMs ?? 5_000],
    ['lock_timeout', config.lockTimeoutMs ?? 2_000],
    ['idle_in_transaction_session_timeout', config.idleInTransactionTimeoutMs ?? 5_000],
  ];
  for (const [name, ms] of settings)
    await client.query(
      `ALTER ROLE ${quoteIdent(role)} SET ${name} = ${quoteLiteral(`${Math.trunc(ms)}ms`)}`,
    );
}

/**
 * Create (idempotently) the extension's login role and align its privileges with what exists NOW: run after the
 * extension's migrations, and again on every reconcile. Throws `ExtensionIsolationError` with the operator action
 * when the principal cannot manage roles.
 */
export async function provisionExtensionRole(
  pool: Pool,
  opts: { extension: string; otherExtensions?: readonly string[]; config: ExtensionRoleConfig },
): Promise<ProvisionResult> {
  const { extension, config } = opts;
  const others = opts.otherExtensions ?? [];
  const role = extensionRoleName(config.rolePrefix, extension);
  const client = await pool.connect();
  try {
    const me = await principal(client);
    if (!me.superuser && !me.createRole)
      throw new ExtensionIsolationError(
        `Cannot provision database role "${role}": "${me.current}" lacks CREATEROLE. ${CREATEROLE_HELP}`,
      );
    await client.query('BEGIN');
    try {
      // Concurrent runners (rolling deploys) must not update the same role row at once ("tuple concurrently updated").
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `sold.extension-role:${role}`,
      ]);
      await createOrAlterRole(client, role, config, me.superuser);
      const q = quoteIdent(role);
      // Start from nothing in `public`, then grant exactly what is documented.
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${q}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${q}`);
      await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${q}`);

      const { owned, weird } = await ownedRelations(client, extension, others);
      const tables: string[] = [];
      const sequences: string[] = [];
      for (const r of owned) {
        const target = `public.${quoteIdent(r.name)}`;
        if (r.kind === 'S') {
          await client.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${target} TO ${q}`);
          sequences.push(r.name);
        } else if (r.kind === 'm') {
          await client.query(`GRANT SELECT ON ${target} TO ${q}`);
          tables.push(r.name);
        } else if (r.kind === 'r' || r.kind === 'p' || r.kind === 'v') {
          await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${target} TO ${q}`);
          tables.push(r.name);
        }
      }
      for (const base of BASE_READ_TABLES) {
        const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
          `public.${quoteIdent(base)}`,
        ]);
        if (exists.rows[0]?.ok)
          await client.query(`GRANT SELECT ON public.${quoteIdent(base)} TO ${q}`);
      }
      await client.query('COMMIT');
      return { role, tables, sequences, ignored: weird };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export interface OwnedObjects {
  views: string[];
  matviews: string[];
  tables: string[];
  foreignTables: string[];
  sequences: string[];
  /** `regprocedure` text (already quoted by the server), e.g. `ext_foo_f(integer)`. */
  functions: string[];
  types: string[];
}

/** Every catalogue object in `public` that belongs to the extension. Never interpolate these names: quote them. */
export async function listOwnedObjects(
  client: Pick<PoolClient, 'query'>,
  extension: string,
  others: readonly string[],
): Promise<OwnedObjects> {
  const prefix = extensionPrefix(extension);
  const mine = (name: string) =>
    name.startsWith(prefix) && !foreignByPrefix(extension, name, others);
  const rels = await client.query<{ relname: string; relkind: string }>(
    `SELECT c.relname, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
        AND left(c.relname, length($1)) = $1`,
    [prefix],
  );
  const funcs = await client.query<{ proname: string; sig: string }>(
    `SELECT p.proname, p.oid::regprocedure::text AS sig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND left(p.proname, length($1)) = $1
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
    [prefix],
  );
  const types = await client.query<{ typname: string }>(
    `SELECT t.typname
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
        AND left(t.typname, length($1)) = $1`,
    [prefix],
  );
  const out: OwnedObjects = {
    views: [],
    matviews: [],
    tables: [],
    foreignTables: [],
    sequences: [],
    functions: [],
    types: [],
  };
  for (const r of rels.rows) {
    if (!mine(r.relname)) continue;
    if (r.relkind === 'v') out.views.push(r.relname);
    else if (r.relkind === 'm') out.matviews.push(r.relname);
    else if (r.relkind === 'S') out.sequences.push(r.relname);
    else if (r.relkind === 'f') out.foreignTables.push(r.relname);
    else if (r.relkind === 'c') out.types.push(r.relname);
    else out.tables.push(r.relname);
  }
  for (const f of funcs.rows) if (mine(f.proname)) out.functions.push(f.sig);
  for (const t of types.rows) if (mine(t.typname)) out.types.push(t.typname);
  return out;
}

export interface PurgeResult {
  dropped: OwnedObjects;
  roleDropped: boolean;
  roleDropError?: string;
}

/**
 * Remove everything an extension owns: views, tables, sequences, functions and types (each name quoted, never
 * interpolated), its migration journal rows, its registry row (which cascades its settings) and its database role.
 * All in one transaction on the given client. Refuses when another known extension's namespace overlaps this one,
 * because the objects could not be attributed reliably.
 */
export async function purgeExtension(
  client: PoolClient,
  opts: {
    extension: string;
    knownExtensions: readonly string[];
    config: ExtensionRoleConfig | undefined;
  },
): Promise<PurgeResult> {
  const { extension } = opts;
  const others = opts.knownExtensions.filter((n) => n !== extension);
  const collisions = prefixCollisions([extension, ...others]).filter(
    ([a, b]) => a === extension || b === extension,
  );
  if (collisions.length > 0)
    throw new ExtensionIsolationError(
      `Refusing to purge "${extension}": its table prefix ${extensionPrefix(extension)} overlaps with ${collisions.map(([a, b]) => (a === extension ? b : a)).join(', ')}, so its objects cannot be told apart from theirs.`,
    );
  await client.query('BEGIN');
  try {
    const objs = await listOwnedObjects(client, extension, others);
    for (const v of objs.views)
      await client.query(`DROP VIEW IF EXISTS public.${quoteIdent(v)} CASCADE`);
    for (const v of objs.matviews)
      await client.query(`DROP MATERIALIZED VIEW IF EXISTS public.${quoteIdent(v)} CASCADE`);
    for (const t of objs.tables)
      await client.query(`DROP TABLE IF EXISTS public.${quoteIdent(t)} CASCADE`);
    for (const t of objs.foreignTables)
      await client.query(`DROP FOREIGN TABLE IF EXISTS public.${quoteIdent(t)} CASCADE`);
    for (const s of objs.sequences)
      await client.query(`DROP SEQUENCE IF EXISTS public.${quoteIdent(s)} CASCADE`);
    // `sig` comes from regprocedure::text: the server has already quoted it.
    for (const f of objs.functions) await client.query(`DROP ROUTINE IF EXISTS ${f} CASCADE`);
    for (const t of objs.types)
      await client.query(`DROP TYPE IF EXISTS public.${quoteIdent(t)} CASCADE`);
    await client.query(`DELETE FROM _sold_migrations WHERE scope = $1`, [`ext:${extension}`]);
    await client.query(`DELETE FROM extension_registry WHERE name = $1`, [extension]);

    let roleDropped = false;
    let roleDropError: string | undefined;
    if (opts.config) {
      const role = extensionRoleName(opts.config.rolePrefix, extension);
      const q = quoteIdent(role);
      const exists =
        (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role])).rowCount === 1;
      if (exists) {
        await client.query('SAVEPOINT drop_role');
        try {
          await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${q}`);
          await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${q}`);
          await client.query(`REVOKE ALL ON SCHEMA public FROM ${q}`);
          await client.query(`DROP ROLE ${q}`);
          await client.query('RELEASE SAVEPOINT drop_role');
          roleDropped = true;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT drop_role');
          roleDropError = (error as Error).message;
        }
      } else roleDropped = true;
    }
    await client.query('COMMIT');
    return { dropped: objs, roleDropped, ...(roleDropError ? { roleDropError } : {}) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
