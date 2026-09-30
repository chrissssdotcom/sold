import { createHash } from 'node:crypto';

/**
 * Vendor-neutral job queue (Section 8A.7). pg-boss is the default adapter; a Service Bus adapter
 * ships for when queue throughput or age SLOs outgrow Postgres (thresholds in docs/scaling.md).
 * Nothing outside an adapter may import a queue vendor.
 */

/** Queue classes: separate concurrency, retry and priority so a bulk backlog can never starve the order path. */
export const queueClasses = ['critical', 'default', 'bulk'] as const;
export type QueueClass = (typeof queueClasses)[number];

export interface QueueClassPolicy {
  /** Max jobs a single worker process runs at once for a queue of this class. */
  concurrency: number;
  /** Higher runs first within the queue. */
  priority: number;
  retryLimit: number;
  retryDelaySeconds: number;
  /** Retries back off exponentially with jitter, capped here. */
  retryDelayMaxSeconds: number;
  expireInSeconds: number;
  /** Alert when the oldest waiting job is older than this (alert on age, not just depth). */
  maxAgeSeconds: number;
}

export const queueClassPolicies: Record<QueueClass, QueueClassPolicy> = {
  // Order path follow-ups: outbox relay, payment webhooks, inventory release.
  critical: {
    concurrency: 20,
    priority: 10,
    retryLimit: 10,
    retryDelaySeconds: 2,
    retryDelayMaxSeconds: 300,
    expireInSeconds: 120,
    maxAgeSeconds: 30,
  },
  // Emails, webhooks out, search indexing, cache purge.
  default: {
    concurrency: 10,
    priority: 5,
    retryLimit: 8,
    retryDelaySeconds: 5,
    retryDelayMaxSeconds: 900,
    expireInSeconds: 300,
    maxAgeSeconds: 300,
  },
  // Reports, backfills, FX history, lifecycle campaigns. First to be paused by the degradation ladder.
  bulk: {
    concurrency: 3,
    priority: 0,
    retryLimit: 5,
    retryDelaySeconds: 30,
    retryDelayMaxSeconds: 3600,
    expireInSeconds: 1800,
    maxAgeSeconds: 3600,
  },
};

export interface QueueDefinition {
  name: string;
  class: QueueClass;
  /** Failed-out jobs move to `<name>.dead` for inspection and redrive. Default true. */
  deadLetter?: boolean;
}

export interface JobContext<T> {
  id: string;
  queue: string;
  data: T;
  /** 0 on the first attempt. */
  retryCount: number;
  /** Aborted when the worker is shutting down or the job expired: stop work promptly. */
  signal: AbortSignal;
}

export type JobHandler<T> = (job: JobContext<T>) => Promise<void>;

export interface EnqueueOptions {
  /**
   * Makes the enqueue idempotent: a second enqueue with the same key on the same queue is a no-op
   * (returns null). Use it for anything triggered by a retryable request or webhook.
   */
  idempotencyKey?: string;
  startAfterSeconds?: number;
}

export interface QueueHealth {
  name: string;
  /** Waiting to run (created + retry). */
  depth: number;
  active: number;
  failed: number;
  /** Age of the oldest job that is ready to run and has not started. 0 when empty. */
  oldestAgeSeconds: number;
}

export interface JobQueue {
  readonly kind: string;
  start(): Promise<void>;
  /** Stop taking new jobs and wait for in-flight jobs (graceful drain). */
  stop(options?: { timeoutMs?: number }): Promise<void>;
  ensureQueue(definition: QueueDefinition): Promise<void>;
  enqueue<T extends object>(
    queue: string,
    data: T,
    options?: EnqueueOptions,
  ): Promise<string | null>;
  work<T extends object>(queue: string, handler: JobHandler<T>): Promise<void>;
  /** Recurring job. `key` allows several schedules per queue. */
  schedule(queue: string, cron: string, data?: object, key?: string): Promise<void>;
  health(queue: string): Promise<QueueHealth>;
}

export function deadLetterName(queue: string): string {
  return `${queue}.dead`;
}

/** Deterministic UUID (v5-style layout) from a queue + idempotency key, for adapters keyed on job id. */
export function idempotentJobId(queue: string, key: string): string {
  const h = createHash('sha256').update(`${queue}\u0000${key}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
