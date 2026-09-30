import { createServer } from 'node:http';
import { loadEnv } from '@sold/core/env';
import { createKernel, toKernelLogger, type GeneratedRegistry } from '@sold/core/extensions';
import { queueClassPolicies } from '@sold/core/jobs';
import { createLogger } from '@sold/core/observability';
import { createDb, FeatureFlags } from '@sold/db';
import { PgBossQueue } from '@sold/jobs';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import * as generated from '../.generated/extensions';
import { startCommerceJobs } from './commerce-jobs';
import { baseQueues, registerBaseJobs } from './jobs';
import { bearerMatches } from '../src/server/auth';
import { installExtensionSafety } from '../src/server/extension-safety';
import { createExtensionSafetyMetrics } from '../src/server/metrics';

const env = loadEnv({ ...process.env, SOLD_ROLE: 'worker' });
const log = createLogger({
  service: 'sold-worker',
  level: env.LOG_LEVEL,
  version: env.SOLD_VERSION,
  environment: env.SOLD_ENVIRONMENT,
});

const db = createDb({
  primaryUrl: env.DATABASE_URL,
  replicaUrl: env.DATABASE_REPLICA_URL,
  poolMax: Math.min(env.DB_POOL_MAX, 5),
  pooler: env.DATABASE_POOLER,
  applicationName: 'sold-worker',
});
// pg-boss needs a direct (session) connection: advisory locks and LISTEN/NOTIFY do not survive transaction pooling.
const queue = new PgBossQueue({
  connectionString: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
  poolMax: 5,
  onError: (error) => log.error({ err: error }, 'queue error'),
});
const flags = new FeatureFlags(db.replica);

let ready = false;
let draining = false;

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'sold_node_' });
new Gauge({
  name: 'sold_app_info',
  help: 'Build info',
  labelNames: ['version', 'environment', 'build_id'],
  registers: [registry],
}).set(
  { version: env.SOLD_VERSION, environment: env.SOLD_ENVIRONMENT, build_id: env.SOLD_BUILD_ID },
  1,
);
// Extension code can leave floating promises and throwing timers behind. In the worker those would end the
// process (and every other extension's jobs with it): contain what is attributable, exit on the rest.
installExtensionSafety({
  log,
  metrics: createExtensionSafetyMetrics(registry),
  exitOnUnattributed: true,
});
const depth = new Gauge({
  name: 'sold_queue_depth',
  help: 'Jobs waiting to run',
  labelNames: ['queue', 'class'],
  registers: [registry],
});
const oldest = new Gauge({
  name: 'sold_queue_oldest_job_age_seconds',
  help: 'Age of the oldest ready job. Alert on this, not on depth.',
  labelNames: ['queue', 'class'],
  registers: [registry],
});
const maxAge = new Gauge({
  name: 'sold_queue_max_age_seconds',
  help: 'Age budget per queue class',
  labelNames: ['queue', 'class'],
  registers: [registry],
});

async function collectQueueMetrics(): Promise<void> {
  await Promise.all(
    baseQueues.map(async (def) => {
      const h = await queue.health(def.name);
      const labels = { queue: def.name, class: def.class };
      depth.set(labels, h.depth);
      oldest.set(labels, h.oldestAgeSeconds);
      maxAge.set(labels, queueClassPolicies[def.class].maxAgeSeconds);
    }),
  );
}

// Probes and metrics for the orchestrator. Deliberately tiny and dependency-free.
const port = Number(process.env.WORKER_PORT ?? 3001);
const server = createServer((req, res) => {
  const send = (status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  void (async () => {
    try {
      if (req.url === '/live') return send(200, '{"status":"alive"}');
      if (req.url === '/ready') {
        if (!ready || draining)
          return send(503, JSON.stringify({ status: 'unavailable', draining }));
        await db.pools.primary.query('SELECT 1');
        return send(200, '{"status":"ok"}');
      }
      if (req.url === '/metrics') {
        if (!bearerMatches(req.headers.authorization ?? null, env.METRICS_TOKEN))
          return send(401, 'unauthorized', 'text/plain');
        await collectQueueMetrics().catch((error) =>
          log.warn({ err: error }, 'queue metrics unavailable'),
        );
        return send(200, await registry.metrics(), registry.contentType);
      }
      return send(404, '{"error":"not_found"}');
    } catch {
      return send(503, '{"status":"unavailable"}');
    }
  })();
});

const stopRelay = new AbortController();

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  stopRelay.abort();
  log.info({ signal }, 'worker draining: finishing in-flight jobs');
  try {
    await queue.stop({ timeoutMs: 30_000 });
  } catch (error) {
    log.error({ err: error }, 'queue did not stop cleanly');
  }
  server.close();
  await db.close();
  log.info('worker stopped');
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  server.listen(port, '0.0.0.0', () => log.info({ port }, 'worker probes listening'));
  await queue.start();
  await registerBaseJobs(queue, { db: db.primary, flags, log });

  // Extensions: same kernel as the web app, but this process CONSUMES observer deliveries, jobs and schedules.
  const kernel = createKernel({
    env,
    log: toKernelLogger(log),
    db,
    queue,
    registry: generated as unknown as GeneratedRegistry,
  });
  await kernel.verifyMigrations(); // migrations are a release-pipeline step, never run by a serving process
  await kernel.warm();
  await kernel.startWorkers();
  log.info(
    { extensions: kernel.extensions.map((e) => `${e.manifest.name}@${e.manifest.version}`) },
    'extension workers started',
  );
  await startCommerceJobs({
    env,
    db: db.primary,
    queue,
    log,
    publish: (event, payload, o) => kernel.bus.publish(event, payload, o),
    signal: stopRelay.signal,
  });
  ready = true;
  log.info('worker ready');
}

main().catch((error) => {
  log.error({ err: error }, 'worker failed to start');
  process.exit(1);
});
