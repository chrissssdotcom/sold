import {
  idempotentJobId,
  queueClassPolicies,
  type EnqueueOptions,
  type JobHandler,
  type JobQueue,
  type QueueDefinition,
  type QueueHealth,
} from './queue';

interface Pending {
  id: string;
  data: object;
  retryCount: number;
}

/**
 * In-process `JobQueue` for tests and single-process tools. Same contract as the pg-boss adapter
 * (idempotent enqueue, retries up to the class limit, dead-lettering) but synchronous and deterministic:
 * call `drain()` to run everything that is queued. Not for production: it is not durable.
 */
export class InMemoryJobQueue implements JobQueue {
  readonly kind = 'memory';
  readonly defs = new Map<string, QueueDefinition>();
  readonly schedules: { queue: string; cron: string; key: string; data: object }[] = [];
  readonly dead: { queue: string; data: object; error: string }[] = [];
  private readonly queues = new Map<string, Pending[]>();
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly seen = new Set<string>();
  private counter = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async ensureQueue(def: QueueDefinition): Promise<void> {
    this.defs.set(def.name, def);
    if (!this.queues.has(def.name)) this.queues.set(def.name, []);
  }

  async enqueue<T extends object>(
    queue: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    if (!this.defs.has(queue))
      throw new Error(`Queue "${queue}" was not declared with ensureQueue()`);
    const id = options.idempotencyKey
      ? idempotentJobId(queue, options.idempotencyKey)
      : `mem-${++this.counter}`;
    if (this.seen.has(`${queue}:${id}`)) return null;
    this.seen.add(`${queue}:${id}`);
    // Round-trip through JSON like a real queue would, so non-serialisable payloads fail in tests too.
    this.queues.get(queue)?.push({ id, data: JSON.parse(JSON.stringify(data)), retryCount: 0 });
    return id;
  }

  async work<T extends object>(queue: string, handler: JobHandler<T>): Promise<void> {
    if (!this.defs.has(queue))
      throw new Error(`Queue "${queue}" was not declared with ensureQueue()`);
    this.handlers.set(queue, handler as unknown as JobHandler<never>);
  }

  async schedule(queue: string, cron: string, data: object = {}, key = ''): Promise<void> {
    this.schedules.push({ queue, cron, key, data });
  }

  async health(queue: string): Promise<QueueHealth> {
    return {
      name: queue,
      depth: this.queues.get(queue)?.length ?? 0,
      oldestAgeSeconds: 0,
      deadLetterDepth: this.dead.filter((d) => d.queue === queue).length,
    };
  }

  /** Run every queued job (including retries) until the queues are empty. */
  async drain(): Promise<void> {
    for (let progress = true; progress;) {
      progress = false;
      for (const [queue, list] of this.queues) {
        const handler = this.handlers.get(queue);
        const def = this.defs.get(queue);
        if (!handler || !def) continue;
        const job = list.shift();
        if (!job) continue;
        progress = true;
        try {
          await (handler as JobHandler<object>)({
            id: job.id,
            queue,
            data: job.data,
            retryCount: job.retryCount,
            signal: new AbortController().signal,
          });
        } catch (error) {
          if (job.retryCount < queueClassPolicies[def.class].retryLimit)
            list.push({ ...job, retryCount: job.retryCount + 1 });
          else
            this.dead.push({
              queue,
              data: job.data,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }
    }
  }
}
