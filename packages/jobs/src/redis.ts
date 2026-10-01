import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { Redis } from 'ioredis';
import {
  assertQueueSafeName,
  deadLetterName,
  idempotentJobId,
  queueClassPolicies,
  type EnqueueOptions,
  type JobHandler,
  type JobQueue,
  type QueueClassPolicy,
  type QueueDefinition,
  type QueueHealth,
} from '@sold/core/jobs';

/**
 * A second `JobQueue` adapter, on Redis. It exists to prove the seam (the rest of the system only ever sees `JobQueue`) and as the
 * option for when queue throughput or latency outgrows Postgres. Semantics match pg-boss's contract: **at-least-once**, per-queue
 * retry with exponential backoff and jitter, dead-letter after the retry limit, idempotent enqueue, delayed jobs, lease expiry so a
 * crashed worker's jobs are retried, graceful stop.
 *
 * Layout per queue `q`: `sq:{q}:ready` (ZSET, score = earliest run time ms), `sq:{q}:active` (ZSET, score = lease expiry ms),
 * `sq:{q}:jobs` (HASH id -> JSON), `sq:{q}:dead` (HASH id -> JSON). Every state change is one Lua script, so a crash can never leave a
 * job in two states or none.
 *
 * Durability is Redis's: with default persistence a Redis crash can lose recently enqueued jobs. Use AOF `everysec` (or stay on
 * pg-boss, whose jobs live in the same database as the orders) if losing a few seconds of jobs is not acceptable.
 */

// KEYS: ready, active, jobs, dead   ARGV: now, limit, leaseMs
const CLAIM = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], ARGV[1] + ARGV[3], id)
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', KEYS[3], id) or ''
end
return out`;

// KEYS: ready, active, jobs, dead   ARGV: now, retryLimit, baseDelayMs, maxDelayMs
// Return expired leases to the queue (counting the lost attempt) or dead-letter them.
const REAP = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 100)
local n = 0
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  local raw = redis.call('HGET', KEYS[3], id)
  if raw then
    local job = cjson.decode(raw)
    job.retryCount = job.retryCount + 1
    if job.retryCount > tonumber(ARGV[2]) then
      redis.call('HDEL', KEYS[3], id)
      redis.call('HSET', KEYS[4], id, cjson.encode(job))
    else
      redis.call('HSET', KEYS[3], id, cjson.encode(job))
      local delay = math.min(tonumber(ARGV[4]), tonumber(ARGV[3]) * (2 ^ (job.retryCount - 1)))
      redis.call('ZADD', KEYS[1], ARGV[1] + delay, id)
    end
    n = n + 1
  end
end
return n`;

export interface RedisQueueOptions {
  redis: Redis;
  /** Prefix for every key; lets several environments share one Redis. */
  prefix?: string;
  /** Override class policies (tests use tiny delays). */
  policies?: Partial<Record<keyof typeof queueClassPolicies, Partial<QueueClassPolicy>>>;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

interface Registered {
  def: QueueDefinition;
  policy: QueueClassPolicy;
}

export class RedisQueue implements JobQueue {
  readonly kind = 'redis';
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly queues = new Map<string, Registered>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private running = false;
  private readonly pollMs: number;
  private readonly policies: NonNullable<RedisQueueOptions['policies']>;
  private readonly onError: (e: unknown) => void;

  constructor(opts: RedisQueueOptions) {
    this.redis = opts.redis;
    this.prefix = opts.prefix ?? 'sold';
    this.pollMs = opts.pollIntervalMs ?? 250;
    this.policies = opts.policies ?? {};
    this.onError = opts.onError ?? (() => undefined);
  }

  private k(queue: string, part: 'ready' | 'active' | 'jobs' | 'dead'): string {
    return `${this.prefix}:q:${queue}:${part}`;
  }
  private keys(queue: string): [string, string, string, string] {
    return [
      this.k(queue, 'ready'),
      this.k(queue, 'active'),
      this.k(queue, 'jobs'),
      this.k(queue, 'dead'),
    ];
  }
  private reg(queue: string): Registered {
    const r = this.queues.get(queue);
    if (!r) throw new Error(`Queue "${queue}" has not been declared (ensureQueue)`);
    return r;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (this.inflight.size > 0 && Date.now() < deadline)
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    this.abort.abort(); // whatever is still running past the grace period is told to stop
  }

  async ensureQueue(definition: QueueDefinition): Promise<void> {
    assertQueueSafeName('queue', definition.name);
    const base = queueClassPolicies[definition.class];
    this.queues.set(definition.name, {
      def: definition,
      policy: { ...base, ...(this.policies[definition.class] ?? {}) },
    });
  }

  async enqueue<T extends object>(
    queue: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    const { policy } = this.reg(queue);
    void policy;
    const id = options.idempotencyKey
      ? idempotentJobId(queue, options.idempotencyKey)
      : randomUUID();
    if (options.idempotencyKey) {
      // A week of memory for "already enqueued": a retried webhook or request cannot enqueue twice in that window.
      const first = await this.redis.set(`${this.prefix}:idem:${id}`, '1', 'EX', 7 * 86_400, 'NX');
      if (first === null) return null;
    }
    const job = JSON.stringify({ data, retryCount: 0, createdAt: Date.now() });
    const runAt = Date.now() + Math.max(0, options.startAfterSeconds ?? 0) * 1000;
    await this.redis
      .multi()
      .hset(this.k(queue, 'jobs'), id, job)
      .zadd(this.k(queue, 'ready'), runAt, id)
      .exec();
    return id;
  }

  async work<T extends object>(queue: string, handler: JobHandler<T>): Promise<void> {
    const { policy } = this.reg(queue);
    let active = 0;
    // Ticks must not overlap: two at once would each see the same free slots and together claim more than the concurrency limit.
    let ticking = false;
    let again = false;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      if (ticking) {
        again = true;
        return;
      }
      ticking = true;
      try {
        await this.redis.eval(
          REAP,
          4,
          ...this.keys(queue),
          Date.now(),
          policy.retryLimit,
          policy.retryDelaySeconds * 1000,
          policy.retryDelayMaxSeconds * 1000,
        );
        const room = policy.concurrency - active;
        if (room <= 0) return;
        const claimed = (await this.redis.eval(
          CLAIM,
          4,
          ...this.keys(queue),
          Date.now(),
          room,
          policy.expireInSeconds * 1000,
        )) as string[];
        for (let i = 0; i < claimed.length; i += 2) {
          const id = claimed[i]!;
          const raw = claimed[i + 1]!;
          active += 1;
          const p = this.run(queue, id, raw, policy, handler as JobHandler<object>).finally(() => {
            active -= 1;
            this.inflight.delete(p);
            void tick(); // a slot just opened: refill now instead of waiting for the next poll
          });
          this.inflight.add(p);
        }
      } catch (error) {
        this.onError(error);
      } finally {
        ticking = false;
        if (again) {
          again = false;
          void tick();
        }
      }
    };
    const timer = setInterval(() => void tick(), this.pollMs);
    timer.unref?.();
    this.timers.add(timer);
    void tick();
  }

  private async run(
    queue: string,
    id: string,
    raw: string,
    policy: QueueClassPolicy,
    handler: JobHandler<object>,
  ): Promise<void> {
    const job = raw ? (JSON.parse(raw) as { data: object; retryCount: number }) : null;
    if (!job) {
      await this.redis.zrem(this.k(queue, 'active'), id); // the payload vanished (deleted): nothing to run
      return;
    }
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    this.abort.signal.addEventListener('abort', onStop);
    const timeout = setTimeout(() => ctl.abort(), policy.expireInSeconds * 1000);
    try {
      await handler({ id, queue, data: job.data, retryCount: job.retryCount, signal: ctl.signal });
      await this.redis
        .multi()
        .zrem(this.k(queue, 'active'), id)
        .hdel(this.k(queue, 'jobs'), id)
        .exec();
    } catch {
      await this.fail(queue, id, job, policy);
    } finally {
      clearTimeout(timeout);
      this.abort.signal.removeEventListener('abort', onStop);
    }
  }

  private async fail(
    queue: string,
    id: string,
    job: { data: object; retryCount: number },
    policy: QueueClassPolicy,
  ): Promise<void> {
    const next = { ...job, retryCount: job.retryCount + 1 };
    const multi = this.redis.multi().zrem(this.k(queue, 'active'), id);
    if (next.retryCount > policy.retryLimit) {
      multi.hdel(this.k(queue, 'jobs'), id);
      if (this.reg(queue).def.deadLetter !== false)
        multi.hset(this.k(queue, 'dead'), id, JSON.stringify(next));
    } else {
      const base = Math.min(
        policy.retryDelayMaxSeconds * 1000,
        policy.retryDelaySeconds * 1000 * 2 ** (next.retryCount - 1),
      );
      const delay = base * (0.8 + Math.random() * 0.4); // jitter: a downstream outage must not become a thundering herd
      multi
        .hset(this.k(queue, 'jobs'), id, JSON.stringify(next))
        .zadd(this.k(queue, 'ready'), Date.now() + delay, id);
    }
    await multi.exec();
  }

  async schedule(queue: string, cron: string, data: object = {}, key = 'default'): Promise<void> {
    assertQueueSafeName('schedule key', key);
    this.reg(queue);
    const parsed = CronExpressionParser.parse(cron);
    void parsed;
    let lastMinute = -1;
    const timer = setInterval(() => {
      if (!this.running) return;
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60_000);
      if (minute === lastMinute) return;
      lastMinute = minute;
      // Is `now` (to the minute) a firing time of this cron expression?
      const prev = CronExpressionParser.parse(cron, { currentDate: new Date(minute * 60_000 + 1) })
        .prev()
        .toDate()
        .getTime();
      if (Math.floor(prev / 60_000) !== minute) return;
      // Every worker sees the tick; one claim per (schedule, minute) wins, so a fleet enqueues each firing once.
      void this.enqueue(queue, data, { idempotencyKey: `schedule:${key}:${minute}` }).catch(
        (e: unknown) => this.onError(e),
      );
    }, 1000);
    timer.unref?.();
    this.timers.add(timer);
  }

  async health(queue: string): Promise<QueueHealth> {
    this.reg(queue);
    const now = Date.now();
    const [depth, oldest, dead] = await Promise.all([
      this.redis.zcount(this.k(queue, 'ready'), '-inf', now),
      this.redis.call('ZRANGE', this.k(queue, 'ready'), 0, 0, 'WITHSCORES') as Promise<string[]>,
      this.redis.hlen(this.k(queue, 'dead')),
    ]);
    const score = oldest.length === 2 ? Number(oldest[1]) : null;
    return {
      name: queue,
      depth,
      oldestAgeSeconds: score !== null && score <= now ? Math.floor((now - score) / 1000) : 0,
      deadLetterDepth: dead,
    };
  }

  /** The dead-letter name, for tooling that lists or redrives. */
  deadLetterOf(queue: string): string {
    return deadLetterName(queue);
  }
}
