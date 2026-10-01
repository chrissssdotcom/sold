/**
 * Local throughput measurement for the two JobQueue adapters: enqueue rate and end-to-end drain rate with a no-op handler.
 *   pnpm --filter @sold/jobs bench            (needs Postgres and Redis; see env below)
 * This is a SANITY MEASUREMENT on one machine with everything (database, Redis, the benchmark) sharing its CPU. It is not a
 * capacity claim: it exists to show relative cost, catch regressions, and give docs/scaling.md an honest, labelled number.
 */
import { performance } from 'node:perf_hooks';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { PgBossQueue } from '../src/pgboss';
import { RedisQueue } from '../src/redis';
import type { JobQueue } from '@sold/core/jobs';

const N = Number(process.env['BENCH_JOBS'] ?? 3000);
const pgUrl = process.env['BENCH_DATABASE_URL'] ?? 'postgres://sold:sold@localhost:5432/sold_bench';
const redisUrl = process.env['BENCH_REDIS_URL'] ?? 'redis://127.0.0.1:6379/5';

async function run(name: string, queue: JobQueue, pollMs: number) {
  await queue.start();
  await queue.ensureQueue({ name: 'bench', class: 'critical' });
  let done = 0;
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  const t0 = performance.now();
  // Enqueue in parallel batches, as a busy web tier would.
  for (let i = 0; i < N; i += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, N - i) }, (_, k) => queue.enqueue('bench', { i: i + k })),
    );
  const enqueueMs = performance.now() - t0;
  await queue.work('bench', async () => {
    if (++done === N) resolve();
  });
  await finished;
  const totalMs = performance.now() - t0;
  const latency = Math.round(totalMs - enqueueMs);
  process.stdout.write(
    `${name.padEnd(8)} jobs=${N}  enqueue ${(N / (enqueueMs / 1000)).toFixed(0).padStart(6)}/s  drain ${(N / (latency / 1000)).toFixed(0).padStart(6)}/s  end-to-end ${(N / (totalMs / 1000)).toFixed(0).padStart(6)}/s  (poll ${pollMs} ms)\n`,
  );
  await queue.stop({ timeoutMs: 5000 });
}

async function main() {
  const admin = new Client({ connectionString: pgUrl.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS sold_bench WITH (FORCE)');
  await admin.query('CREATE DATABASE sold_bench');
  await admin.end();

  const redis = new Redis(redisUrl);
  await redis.flushdb();
  await run('redis', new RedisQueue({ redis, prefix: 'bench', pollIntervalMs: 50 }), 50);
  await redis.quit();

  // A fresh schema per variant so one run's leftovers cannot affect the next.
  for (const batchSize of [1, 10, 25]) {
    await run(
      `pg-boss b${batchSize}`,
      new PgBossQueue({
        connectionString: pgUrl,
        schema: `bench_b${batchSize}`,
        role: 'worker',
        poolMax: 10,
        pollingIntervalSeconds: 0.5,
        batchSize,
      }),
      500,
    );
  }

  const drop = new Client({ connectionString: pgUrl.replace(/\/[^/]+$/, '/postgres') });
  await drop.connect();
  await drop.query('DROP DATABASE IF EXISTS sold_bench WITH (FORCE)');
  await drop.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
