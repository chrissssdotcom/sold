import { CircuitBreaker, withTimeout } from '@sold/core/resilience';
import { Redis } from 'ioredis';

/** Minimal shared-store contract behind the Next cache handler. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Epoch-ms revalidation time per tag (0 when never revalidated), in input order. */
  getTagTimes(tags: string[]): Promise<number[]>;
  setTagTimes(tags: string[], at: number): Promise<void>;
  close(): Promise<void>;
}

/** Local dev / ephemeral only. Not shared across instances, so never correct for scaled-out deploys. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly tags = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 5_000,
  ) {}

  async get(key: string): Promise<string | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async getTagTimes(tags: string[]): Promise<number[]> {
    return tags.map((t) => this.tags.get(t) ?? 0);
  }

  async setTagTimes(tags: string[], at: number): Promise<void> {
    for (const t of tags) this.tags.set(t, at);
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

export interface RedisCacheStoreOptions {
  url: string;
  /** Prefix for entry keys (include the build ID: rolling deploys must never mix builds). */
  keyPrefix: string;
  /** Hash holding tag revalidation times; NOT build-scoped, so invalidation reaches every build. */
  tagsKey?: string;
  commandTimeoutMs?: number;
  onError?: (error: Error, op: string) => void;
}

/**
 * Redis-backed store. Every command has a short timeout and sits behind a circuit breaker, so a
 * slow or dead Redis degrades to cache misses instead of dragging requests down (Section 8A.8).
 */
export class RedisCacheStore implements CacheStore {
  private readonly redis: Redis;
  private readonly breaker: CircuitBreaker;
  private readonly tagsKey: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RedisCacheStoreOptions) {
    this.timeoutMs = opts.commandTimeoutMs ?? 250;
    this.tagsKey = opts.tagsKey ?? 'sold:cache:tags';
    this.redis = new Redis(opts.url, {
      // Commands issued while (re)connecting queue briefly instead of failing (the first requests
      // after boot must not all miss); each is still bounded by `withTimeout` and the breaker, and
      // `maxRetriesPerRequest` flushes the queue when the server stays unreachable.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    this.redis.on('error', (e: Error) => opts.onError?.(e, 'connection'));
    this.breaker = new CircuitBreaker({
      name: 'redis-cache',
      failureThreshold: 5,
      cooldownMs: 5_000,
    });
  }

  private run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    return this.breaker
      .exec(() => withTimeout(fn(), this.timeoutMs, `redis ${op}`))
      .catch((error: Error) => {
        this.opts.onError?.(error, op);
        throw error;
      });
  }

  get(key: string): Promise<string | null> {
    return this.run('get', () => this.redis.get(this.opts.keyPrefix + key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.run('set', () =>
      this.redis.set(this.opts.keyPrefix + key, value, 'EX', Math.max(1, Math.trunc(ttlSeconds))),
    );
  }

  async del(key: string): Promise<void> {
    await this.run('del', () => this.redis.del(this.opts.keyPrefix + key));
  }

  async getTagTimes(tags: string[]): Promise<number[]> {
    if (tags.length === 0) return [];
    const values = await this.run('hmget', () => this.redis.hmget(this.tagsKey, ...tags));
    return values.map((v) => (v ? Number(v) : 0));
  }

  async setTagTimes(tags: string[], at: number): Promise<void> {
    if (tags.length === 0) return;
    const args = tags.flatMap((t) => [t, String(at)]);
    await this.run('hset', () => this.redis.hset(this.tagsKey, ...args));
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
