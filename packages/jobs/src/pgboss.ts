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
  /**
   * Session settings for the queue's own connections. The database-wide defaults (5 s statement timeout) are sized
   * for request-path queries and would kill pg-boss maintenance on a large backlog, so the queue overrides them.
   */
  sessionOptions?: string;
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
      options:
        opts.sessionOptions ??
        '-c statement_timeout=60000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000',
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
      await this.upsertQueue(deadLetterName(def.name), { retentionSeconds: 30 * 24 * 3600 });
    }
    await this.upsertQueue(def.name, {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: true,
      retryDelayMax: policy.retryDelayMaxSeconds,
      expireInSeconds: policy.expireInSeconds,
      ...(withDeadLetter ? { deadLetter: deadLetterName(def.name) } : {}),
    });
  }

  /** `createQueue` never changes an existing queue, so policy edits would silently not apply: update when it exists. */
  private async upsertQueue(
    name: string,
    options: Parameters<PgBoss['createQueue']>[1] & object,
  ): Promise<void> {
    if (await this.boss.getQueue(name)) await this.boss.updateQueue(name, options);
    else await this.boss.createQueue(name, options);
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
    const def = this.definitions.get(queue);
    const [own, dead] = await Promise.all([
      this.unfinished(queue),
      def && def.deadLetter !== false
        ? this.unfinished(deadLetterName(queue))
        : Promise.resolve({ depth: 0, age: 0 }),
    ]);
    return {
      name: queue,
      depth: own.depth,
      oldestAgeSeconds: own.age,
      deadLetterDepth: dead.depth,
    };
  }

  /**
   * Depth and oldest-ready age of unfinished jobs. The predicate (`state < 'active' AND NOT blocked`) is exactly
   * that of pg-boss's partial index `job_common_i11`, so this is an index-only scan over the backlog and never
   * touches the (much larger) history of completed jobs. Verified with EXPLAIN in the integration tests.
   * pg-boss's own counters are refreshed by a periodic maintenance pass and can lag, which is unacceptable for
   * an age alert.
   */
  private async unfinished(queue: string): Promise<{ depth: number; age: number }> {
    const { rows } = await this.boss.getDb().executeSql(
      `SELECT count(*)::int AS depth,
              COALESCE(EXTRACT(EPOCH FROM now() - min(created_on) FILTER (WHERE start_after <= now())), 0)::float8 AS age
         FROM ${this.schema}.job
        WHERE name = $1 AND state < 'active' AND NOT blocked`,
      [queue],
    );
    return {
      depth: Number(rows[0]?.depth ?? 0),
      age: Math.max(0, Math.round(Number(rows[0]?.age ?? 0))),
    };
  }

  private definition(queue: string): QueueDefinition {
    const def = this.definitions.get(queue);
    if (!def) throw new Error(`Queue "${queue}" was not declared with ensureQueue()`);
    return def;
  }
}
