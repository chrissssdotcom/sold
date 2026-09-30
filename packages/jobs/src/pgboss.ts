import {
  deadLetterName,
  idempotentJobId,
  queueClassPolicies,
  type EnqueueOptions,
  type JobHandler,
  type JobQueue,
  type QueueDefinition,
  type QueueHealth,
} from '@sold/core/jobs';
import { PgBoss } from 'pg-boss';

export interface PgBossQueueOptions {
  /**
   * Must be a DIRECT (session) connection, not PgBouncer transaction pooling: pg-boss relies on
   * advisory locks and LISTEN/NOTIFY. Use DATABASE_MIGRATION_URL.
   */
  connectionString: string;
  schema?: string;
  /** Connections for this process's queue client. Budgeted separately from the app pool. */
  poolMax?: number;
  pollingIntervalSeconds?: number;
  onError?: (error: Error) => void;
}

/** Default JobQueue adapter: Postgres-backed, no extra infrastructure. Throughput ceiling is measured in Phase 7. */
export class PgBossQueue implements JobQueue {
  readonly kind = 'pg-boss';
  private readonly boss: PgBoss;
  private readonly schema: string;
  private readonly definitions = new Map<string, QueueDefinition>();
  private readonly pollingIntervalSeconds: number;

  constructor(opts: PgBossQueueOptions) {
    this.schema = opts.schema ?? 'pgboss';
    this.pollingIntervalSeconds = opts.pollingIntervalSeconds ?? 2;
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: this.schema,
      max: opts.poolMax ?? 5,
      application_name: 'sold-queue',
    });
    this.boss.on('error', (error) => opts.onError?.(error));
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: options.timeoutMs ?? 30_000 });
  }

  async ensureQueue(def: QueueDefinition): Promise<void> {
    this.definitions.set(def.name, def);
    const policy = queueClassPolicies[def.class];
    const withDeadLetter = def.deadLetter !== false;
    if (withDeadLetter) {
      // Dead-letter queues keep failed payloads for a long time so they can be inspected and redriven.
      await this.boss.createQueue(deadLetterName(def.name), { retentionSeconds: 30 * 24 * 3600 });
    }
    await this.boss.createQueue(def.name, {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: true,
      retryDelayMax: policy.retryDelayMaxSeconds,
      expireInSeconds: policy.expireInSeconds,
      ...(withDeadLetter ? { deadLetter: deadLetterName(def.name) } : {}),
    });
  }

  async enqueue<T extends object>(
    queue: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    const def = this.definition(queue);
    return this.boss.send(queue, data, {
      priority: queueClassPolicies[def.class].priority,
      ...(options.idempotencyKey ? { id: idempotentJobId(queue, options.idempotencyKey) } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async work<T extends object>(queue: string, handler: JobHandler<T>): Promise<void> {
    const def = this.definition(queue);
    await this.boss.work<T>(
      queue,
      {
        localConcurrency: queueClassPolicies[def.class].concurrency,
        pollingIntervalSeconds: this.pollingIntervalSeconds,
        batchSize: 1,
      },
      async (jobs) => {
        for (const job of jobs) {
          // A throw here fails the job; pg-boss then retries with backoff and finally dead-letters it.
          await handler({
            id: job.id,
            queue,
            data: job.data,
            retryCount: job.retryCount,
            signal: job.signal,
          });
        }
      },
    );
  }

  async schedule(queue: string, cron: string, data: object = {}, key = ''): Promise<void> {
    this.definition(queue);
    await this.boss.schedule(queue, cron, data, key ? { key } : undefined);
  }

  async health(queue: string): Promise<QueueHealth> {
    // Depth/active/age are read live and only over unfinished jobs (state < 'completed'), so the
    // query never scans retained history. pg-boss's own counters are refreshed by a periodic
    // maintenance pass and can lag, which is unacceptable for an age alert. `failed` uses them.
    const { rows } = await this.boss.getDb().executeSql(
      `SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS depth,
              count(*) FILTER (WHERE state = 'active')::int AS active,
              COALESCE(EXTRACT(EPOCH FROM now() - min(created_on)
                FILTER (WHERE state IN ('created', 'retry') AND start_after <= now())), 0)::float8 AS age
         FROM ${this.schema}.job
        WHERE name = $1 AND state < 'completed'`,
      [queue],
    );
    const [stats] = await this.boss.getQueueStats(queue);
    const row = rows[0] ?? {};
    return {
      name: queue,
      depth: Number(row.depth ?? 0),
      active: Number(row.active ?? 0),
      failed: stats?.failedCount ?? 0,
      oldestAgeSeconds: Math.max(0, Math.round(Number(row.age ?? 0))),
    };
  }

  private definition(queue: string): QueueDefinition {
    const def = this.definitions.get(queue);
    if (!def) throw new Error(`Queue "${queue}" was not declared with ensureQueue()`);
    return def;
  }
}
