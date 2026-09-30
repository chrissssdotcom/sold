import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import type { Db } from './client';
import { BASE_FORBIDDEN_TABLES } from './extension-access';
import {
  extensionConnectionString,
  extensionRoleName,
  type ExtensionRoleConfig,
} from './extension-roles';

/** The two drizzle handles an extension receives as `ctx.db`. */
export interface ExtensionDbHandles {
  /** Writes, and reads that need read-your-writes. */
  primary: NodePgDatabase;
  /** Reads that tolerate replica lag. */
  replica: NodePgDatabase;
}

export interface ExtensionPoolStats {
  extension: string;
  role: string;
  total: number;
  idle: number;
  waiting: number;
}

/**
 * Where `ctx.db` comes from. `enforce`: one connection pool per extension, connected as that extension's own database
 * role (see `extension-roles.ts`). `off`: the shared application pools (local development and tests only; refused in
 * production by the env schema).
 */
export interface ExtensionDbProvider {
  readonly mode: 'enforce' | 'off';
  for(extension: string): ExtensionDbHandles;
  /** The role an extension's handle connects as (`enforce` only). */
  roleFor(extension: string): string | undefined;
  /** Boot-time check on a real connection: who it connects as and what that role can reach. */
  verify(extension: string): Promise<{ user: string; problems: string[] }>;
  stats(): ExtensionPoolStats[];
  close(): Promise<void>;
}

/** `off`: every extension shares the application pools (and therefore its privileges). */
export function sharedExtensionDbProvider(db: Db): ExtensionDbProvider {
  const handles: ExtensionDbHandles = {
    primary: drizzle(db.pools.primary),
    replica: drizzle(db.pools.replica),
  };
  return {
    mode: 'off',
    for: () => handles,
    roleFor: () => undefined,
    async verify() {
      const { rows } = await db.pools.primary.query(`SELECT current_user AS user`);
      return { user: String(rows[0]?.user), problems: [] };
    },
    stats: () => [],
    close: async () => undefined,
  };
}

/** What a connected extension role must NOT be able to do. Returns the problems found (empty = as designed). */
async function inspectRole(pool: Pool, expectedRole: string): Promise<string[]> {
  const { rows } = await pool.query<{
    user: string;
    session_user: string;
    privileged: boolean;
    member_of_roles: boolean;
    can_create_public: boolean;
    can_use_pgboss: boolean;
    forbidden: string[];
  }>(
    `SELECT current_user AS "user", session_user AS session_user,
            (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication) AS privileged,
            EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member_of_roles,
            has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public,
            (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss')
              AND has_schema_privilege(current_user, 'pgboss', 'USAGE')) AS can_use_pgboss,
            coalesce((SELECT array_agg(t) FROM unnest($1::text[]) AS t
                       WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL
                         AND has_table_privilege(current_user, 'public.' || quote_ident(t), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')),
                     '{}') AS forbidden
       FROM pg_roles r WHERE r.rolname = current_user`,
    [BASE_FORBIDDEN_TABLES],
  );
  const r = rows[0];
  if (!r) return ['role not found'];
  const problems: string[] = [];
  if (r.user !== expectedRole || r.session_user !== expectedRole)
    problems.push(`connected as ${r.session_user}/${r.user}, expected ${expectedRole}`);
  if (r.privileged) problems.push('role has SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS/REPLICATION');
  if (r.member_of_roles) problems.push('role is a member of other roles');
  if (r.can_create_public) problems.push('role can CREATE in schema public');
  if (r.can_use_pgboss) problems.push('role can use the pgboss schema');
  if (r.forbidden.length > 0)
    problems.push(`role can access platform tables: ${r.forbidden.join(', ')}`);
  return problems;
}

export interface ScopedExtensionDbOptions {
  /** Host, port, database and parameters come from here; its credentials are replaced per extension. */
  primaryUrl: string;
  replicaUrl?: string | undefined;
  config: ExtensionRoleConfig;
  /** Maximum connections PER EXTENSION and pool (the budget is `extensions x poolMax`, and idle pools hold none). */
  poolMax?: number;
  pooler?: 'none' | 'pgbouncer';
  applicationName?: string;
}

interface Entry {
  role: string;
  primary: Pool;
  replica: Pool;
  handles: ExtensionDbHandles;
}

export function scopedExtensionDbProvider(opts: ScopedExtensionDbOptions): ExtensionDbProvider {
  const entries = new Map<string, Entry>();
  const hasReplica = Boolean(opts.replicaUrl && opts.replicaUrl !== opts.primaryUrl);

  const poolFor = (url: string, extension: string, role: string, kind: string): Pool => {
    const config: PoolConfig = {
      connectionString: extensionConnectionString(url, role, opts.config),
      max: opts.poolMax ?? 3,
      application_name: `${opts.applicationName ?? 'sold'}-ext-${extension}-${kind}`.slice(0, 63),
      connectionTimeoutMillis: 5_000,
      // Idle extension connections are released quickly: most extensions are idle most of the time.
      idleTimeoutMillis: 10_000,
    };
    if ((opts.pooler ?? 'none') === 'none') {
      // The role also carries these as role-level settings (applied at login, so PgBouncer-safe).
      config.statement_timeout = opts.config.statementTimeoutMs ?? 5_000;
      config.lock_timeout = opts.config.lockTimeoutMs ?? 2_000;
      config.idle_in_transaction_session_timeout = opts.config.idleInTransactionTimeoutMs ?? 5_000;
    }
    const pool = new Pool(config);
    pool.on('error', () => undefined);
    return pool;
  };

  const entry = (extension: string): Entry => {
    let e = entries.get(extension);
    if (!e) {
      const role = extensionRoleName(opts.config.rolePrefix, extension);
      const primary = poolFor(opts.primaryUrl, extension, role, 'rw');
      const replica = hasReplica
        ? poolFor(opts.replicaUrl as string, extension, role, 'ro')
        : primary;
      e = {
        role,
        primary,
        replica,
        handles: { primary: drizzle(primary), replica: drizzle(replica) },
      };
      entries.set(extension, e);
    }
    return e;
  };

  return {
    mode: 'enforce',
    for: (extension) => entry(extension).handles,
    roleFor: (extension) => entry(extension).role,
    async verify(extension) {
      const e = entry(extension);
      return { user: e.role, problems: await inspectRole(e.primary, e.role) };
    },
    stats: () =>
      [...entries.entries()].map(([extension, e]) => ({
        extension,
        role: e.role,
        total: e.primary.totalCount,
        idle: e.primary.idleCount,
        waiting: e.primary.waitingCount,
      })),
    async close() {
      const pools = new Set<Pool>();
      for (const e of entries.values()) {
        pools.add(e.primary);
        pools.add(e.replica);
      }
      entries.clear();
      await Promise.all([...pools].map((p) => p.end()));
    },
  };
}
