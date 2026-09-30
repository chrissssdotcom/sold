import { CircuitBreaker, withTimeout } from '@sold/core/resilience';
import { Redis } from 'ioredis';

/** What the handler persists for one cache entry. */
export interface StoredEntry {
  /** Serialised `{ value, lastModified, tags }`. */
  payload: string;
  /** Epoch ms on the STORE's clock (not the writer's), so instances with skewed clocks agree. */
  lastModified: number;
  tags: string[];
}

/** Shared-store contract behind the Next cache handler. */
export interface CacheStore {
  /** Current time on the store's clock. Synchronous: implementations keep a measured offset. */
  now(): number;
  /**
   * The entry, or null when missing or when any of its tags (plus `extraTags`) was revalidated at or after
   * `lastModified`. Freshness is decided inside the store in ONE round trip.
   */
  get(key: string, extraTags: readonly string[]): Promise<string | null>;
  set(key: string, entry: StoredEntry, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  revalidateTags(tags: readonly string[], at: number): Promise<void>;
  close(): Promise<void>;
}

/** Local dev / ephemeral only. Not shared across instances, so never correct for scaled-out deploys. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { entry: StoredEntry; expiresAt: number }>();
  private readonly tagTimes = new Map<string, number>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly maxEntries = 5_000,
  ) {}

  now(): number {
    return this.clock();
  }

  async get(key: string, extraTags: readonly string[]): Promise<string | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return null;
    }
    for (const tag of [...hit.entry.tags, ...extraTags]) {
      const revalidated = this.tagTimes.get(tag);
      if (revalidated !== undefined && revalidated >= hit.entry.lastModified) return null;
    }
    return hit.entry.payload;
  }

  async set(key: string, entry: StoredEntry, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { entry, expiresAt: this.clock() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async revalidateTags(tags: readonly string[], at: number): Promise<void> {
    for (const t of tags) this.tagTimes.set(t, at);
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
  /** How often to re-measure the offset between the local and the Redis clock. */
  clockSyncMs?: number;
  /** The local wall clock. Injectable so tests can simulate a skewed machine. */
  localClock?: () => number;
  onError?: (error: Error, op: string) => void;
}

// One round trip: read the entry's freshness metadata and every tag time, and only return the (possibly
// multi-MB) payload when it is still fresh. Never decodes the payload inside Redis.
const GET_SCRIPT = `
local lm = redis.call('HGET', KEYS[1], 'lm')
if not lm then return false end
local tags = cjson.decode(redis.call('HGET', KEYS[1], 't') or '[]')
for i = 1, #ARGV do tags[#tags + 1] = ARGV[i] end
if #tags > 0 then
  local times = redis.call('HMGET', KEYS[2], unpack(tags))
  local modified = tonumber(lm)
  for i = 1, #times do
    if times[i] and tonumber(times[i]) >= modified then return false end
  end
end
return redis.call('HGET', KEYS[1], 'v')
`;

/**
 * Redis-backed store. Every command has a timeout and sits behind a circuit breaker, so a slow or dead Redis
 * degrades to cache misses instead of dragging requests down (Section 8A.8). Timestamps come from the Redis
 * clock (measured offset), so skewed instance clocks cannot lose or resurrect invalidations.
 */
export class RedisCacheStore implements CacheStore {
  private readonly redis: Redis & {
    soldCacheGet(keys: number, ...args: string[]): Promise<string | null>;
  };
  private readonly breaker: CircuitBreaker;
  private readonly tagsKey: string;
  private readonly timeoutMs: number;
  private offsetMs = 0;
  private readonly localClock: () => number;
  private syncTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: RedisCacheStoreOptions) {
    this.localClock = opts.localClock ?? Date.now;
    this.timeoutMs = opts.commandTimeoutMs ?? 250;
    this.tagsKey = opts.tagsKey ?? 'sold:cache:tags';
    const client = new Redis(opts.url, {
      // Commands issued while (re)connecting queue briefly instead of failing (the first requests
      // after boot must not all miss); each is still bounded by `withTimeout` and the breaker, and
      // `maxRetriesPerRequest` flushes the queue when the server stays unreachable.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    client.defineCommand('soldCacheGet', { lua: GET_SCRIPT });
    this.redis = client as unknown as RedisCacheStore['redis'];
    this.redis.on('error', (e: Error) => opts.onError?.(e, 'connection'));
    this.breaker = new CircuitBreaker({
      name: 'redis-cache',
      failureThreshold: 5,
      cooldownMs: 5_000,
    });
    void this.syncClock();
    this.syncTimer = setInterval(() => void this.syncClock(), opts.clockSyncMs ?? 30_000);
    this.syncTimer.unref();
  }

  now(): number {
    return this.localClock() + this.offsetMs;
  }

  /** offset = redisTime - localMidpoint; error is bounded by half the round trip. */
  private async syncClock(): Promise<void> {
    try {
      const before = this.localClock();
      const [sec, micro] = await withTimeout(this.redis.time(), this.timeoutMs, 'redis time');
      const after = this.localClock();
      this.offsetMs =
        Number(sec) * 1000 + Math.floor(Number(micro) / 1000) - Math.round((before + after) / 2);
    } catch (error) {
      this.opts.onError?.(error as Error, 'time');
    }
  }

  private run<T>(op: string, fn: () => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    return this.breaker
      .exec(() => withTimeout(fn(), timeoutMs, `redis ${op}`))
      .catch((error: Error) => {
        this.opts.onError?.(error, op);
        throw error;
      });
  }

  async get(key: string, extraTags: readonly string[]): Promise<string | null> {
    // Reads may return multi-MB payloads: allow more time than a metadata command.
    const value = await this.run(
      'get',
      () => this.redis.soldCacheGet(2, this.opts.keyPrefix + key, this.tagsKey, ...extraTags),
      this.timeoutMs * 4,
    );
    return value ?? null;
  }

  async set(key: string, entry: StoredEntry, ttlSeconds: number): Promise<void> {
    const k = this.opts.keyPrefix + key;
    // Serialising and writing a large entry takes longer: scale the budget with its size (~1 ms per 10 KB).
    const budget = this.timeoutMs + Math.ceil(entry.payload.length / 10_240);
    await this.run(
      'set',
      () =>
        this.redis
          .multi()
          .hset(
            k,
            'v',
            entry.payload,
            'lm',
            String(entry.lastModified),
            't',
            JSON.stringify(entry.tags),
          )
          .expire(k, Math.max(1, Math.trunc(ttlSeconds)))
          .exec(),
      budget,
    );
  }

  async del(key: string): Promise<void> {
    await this.run('del', () => this.redis.del(this.opts.keyPrefix + key));
  }

  async revalidateTags(tags: readonly string[], at: number): Promise<void> {
    if (tags.length === 0) return;
    const args = tags.flatMap((t) => [t, String(at)]);
    await this.run('hset', () => this.redis.hset(this.tagsKey, ...args));
  }

  async close(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
