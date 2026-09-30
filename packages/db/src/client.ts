import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger as DrizzleLogger } from 'drizzle-orm/logger';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;

/**
 * Explicit handles (Section 8A.4). The role is part of the type, so code that needs
 * read-your-writes cannot accidentally be handed a replica handle.
 */
export type PrimaryDb = NodePgDatabase<Schema> & { readonly __role: 'primary' };
export type ReplicaDb = NodePgDatabase<Schema> & { readonly __role: 'replica' };

export interface DbOptions {
  primaryUrl: string;
  /** Falls back to the primary when unset (local, ephemeral, dev). */
  replicaUrl?: string | undefined;
  poolMax?: number;
  /**
   * `none`: connect directly; timeouts are sent as startup parameters.
   * `pgbouncer`: transaction pooling; session state is unreliable, so the timeouts come from
   * database-level defaults set by migration `0000_init` instead of startup parameters.
   */
  pooler?: 'none' | 'pgbouncer';
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  applicationName?: string;
  logger?: DrizzleLogger;
}

export interface Db {
  primary: PrimaryDb;
  replica: ReplicaDb;
  /** True when a distinct replica URL was configured. */
  hasReplica: boolean;
  /**
   * `probe` is a dedicated single-connection pool to the primary for health checks, so a readiness probe never
   * queues behind (or is starved by) request traffic and cannot itself exhaust the application pool.
   */
  pools: { primary: Pool; replica: Pool; probe: Pool };
  close(): Promise<void>;
}

function poolConfig(url: string, opts: DbOptions): PoolConfig {
  const config: PoolConfig = {
    connectionString: url,
    max: opts.poolMax ?? 10,
    application_name: opts.applicationName ?? 'sold',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  };
  if ((opts.pooler ?? 'none') === 'none') {
    config.statement_timeout = opts.statementTimeoutMs ?? 5_000;
    config.lock_timeout = opts.lockTimeoutMs ?? 2_000;
    config.idle_in_transaction_session_timeout = opts.idleInTransactionTimeoutMs ?? 5_000;
  }
  return config;
}

export function createDb(opts: DbOptions): Db {
  const primaryPool = new Pool(poolConfig(opts.primaryUrl, opts));
  const hasReplica = Boolean(opts.replicaUrl && opts.replicaUrl !== opts.primaryUrl);
  const replicaPool = hasReplica
    ? new Pool(poolConfig(opts.replicaUrl as string, opts))
    : primaryPool;
  const probePool = new Pool({
    ...poolConfig(opts.primaryUrl, opts),
    max: 1,
    application_name: `${opts.applicationName ?? 'sold'}-probe`,
  });
  probePool.on('error', () => undefined);
  const drizzleOpts = { schema, ...(opts.logger ? { logger: opts.logger } : {}) };

  // An idle client erroring (e.g. failover) must not crash the process.
  for (const pool of new Set([primaryPool, replicaPool])) pool.on('error', () => undefined);

  return {
    // The role brand is type-level only (no runtime property), hence the cast through unknown.
    primary: drizzle(primaryPool, drizzleOpts) as unknown as PrimaryDb,
    replica: drizzle(replicaPool, drizzleOpts) as unknown as ReplicaDb,
    hasReplica,
    pools: { primary: primaryPool, replica: replicaPool, probe: probePool },
    async close() {
      await Promise.all([
        primaryPool.end(),
        probePool.end(),
        hasReplica ? replicaPool.end() : Promise.resolve(),
      ]);
    },
  };
}

/** Drizzle logger that counts statements: use in tests to assert query budgets (no N+1). */
export class QueryCounter implements DrizzleLogger {
  readonly queries: string[] = [];
  logQuery(query: string): void {
    this.queries.push(query);
  }
  get count(): number {
    return this.queries.length;
  }
  reset(): void {
    this.queries.length = 0;
  }
}

/**
 * Schema-less drizzle handles for extensions: they bring their own tables (`ext_<name>_*`) and must not see
 * Base's schema object. They share the app's pools, so extension queries count against the same
 * connection budget, timeouts and pool-saturation metrics.
 */
export function createExtensionDb(db: Db): { primary: NodePgDatabase; replica: NodePgDatabase } {
  return { primary: drizzle(db.pools.primary), replica: drizzle(db.pools.replica) };
}
