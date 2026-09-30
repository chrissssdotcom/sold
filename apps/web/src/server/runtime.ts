import { loadEnv, type Env } from '@sold/core/env';
import { createLogger, type Logger } from '@sold/core/observability';
import { createDb, type Db } from '@sold/db';
import { Redis } from 'ioredis';
import { createMetrics, type Metrics, type PoolStats } from './metrics';

/**
 * Process-wide singletons. These are handles and instrumentation only: no correctness-critical
 * state lives here (scale gate d). Stored on globalThis so dev HMR does not leak pools.
 */
export interface Runtime {
  env: Env;
  log: Logger;
  db: Db;
  metrics: Metrics;
  redis: Redis | null;
  draining: { value: boolean };
}

const slot = globalThis as unknown as { __soldRuntime?: Runtime };

function create(): Runtime {
  const env = loadEnv();
  const log = createLogger({
    service: `sold-${env.SOLD_ROLE}`,
    level: env.LOG_LEVEL,
    version: env.SOLD_VERSION,
    environment: env.SOLD_ENVIRONMENT,
  });
  const db = createDb({
    primaryUrl: env.DATABASE_URL,
    replicaUrl: env.DATABASE_REPLICA_URL,
    poolMax: env.DB_POOL_MAX,
    pooler: env.DATABASE_POOLER,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
    idleInTransactionTimeoutMs: env.DB_IDLE_IN_TX_TIMEOUT_MS,
    applicationName: `sold-${env.SOLD_ROLE}`,
  });
  const redis = env.REDIS_URL
    ? new Redis(env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1_500,
      })
    : null;
  redis?.on('error', () => undefined);
  const pools = () => {
    const stats = (p: Db['pools']['primary']) => ({
      total: p.totalCount,
      idle: p.idleCount,
      waiting: p.waitingCount,
    });
    const out: Record<string, PoolStats> = { primary: stats(db.pools.primary) };
    if (db.hasReplica) out.replica = stats(db.pools.replica);
    return out;
  };
  const metrics = createMetrics(
    { version: env.SOLD_VERSION, environment: env.SOLD_ENVIRONMENT, buildId: env.SOLD_BUILD_ID },
    pools,
  );
  return { env, log, db, metrics, redis, draining: { value: false } };
}

export function getRuntime(): Runtime {
  slot.__soldRuntime ??= create();
  return slot.__soldRuntime;
}

/** Mark draining (readiness turns 503), wait for the LB to notice, then release connections. */
export async function drainAndClose(): Promise<void> {
  const rt = slot.__soldRuntime;
  if (!rt) return;
  rt.draining.value = true;
  rt.log.info({ drainSeconds: rt.env.SOLD_DRAIN_SECONDS }, 'SIGTERM received: draining');
  await new Promise((r) => setTimeout(r, rt.env.SOLD_DRAIN_SECONDS * 1000));
  await Promise.allSettled([rt.db.close(), rt.redis?.quit()]);
}
