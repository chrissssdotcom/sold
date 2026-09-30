import { loadEnv } from '@sold/core/env';
import { deserialize, serialize } from './serialize';
import { MemoryCacheStore, RedisCacheStore, type CacheStore } from './store';

/**
 * Shared Next.js cache handler (ISR / data cache / route handler cache), Section 8A.2.
 *
 * - Consistent across instances: entries and tag revalidation times live in Redis.
 * - Tag revalidation is a timestamp per tag; an entry older than any of its tags' timestamp is a miss.
 * - Fail-open: any store error on read/write is a cache miss / no-op, never a request failure.
 *   `revalidateTag` failures are surfaced (an invalidation that silently did nothing is a bug).
 * - Jittered TTLs so entries written together do not expire together (stampede prevention).
 */

type CacheLogger = Record<
  'warn' | 'error',
  (fields: Record<string, unknown> | string, message?: string) => void
>;

/**
 * Minimal JSON logger. This file is bundled into a standalone CJS file Next loads at runtime;
 * pino (worker threads, dynamic requires) must not be bundled into it.
 */
function jsonLogger(base: Record<string, unknown>): CacheLogger {
  const emit = (level: string) => (fields: Record<string, unknown> | string, message?: string) => {
    const body = typeof fields === 'string' ? { msg: fields } : { ...fields, msg: message };
    if (body && 'err' in body && body.err instanceof Error) body.err = body.err.message;
    console.error(JSON.stringify({ level, time: new Date().toISOString(), ...base, ...body }));
  };
  return { warn: emit('warn'), error: emit('error') };
}

interface CacheEntry {
  value: unknown;
  lastModified: number;
  tags: string[];
}

export interface HandlerDeps {
  store: CacheStore;
  logger?: CacheLogger;
  now?: () => number;
  random?: () => number;
  maxTtlSeconds?: number;
}

export class SoldCacheHandlerCore {
  private readonly store: CacheStore;
  private readonly log: CacheLogger | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxTtl: number;

  constructor(deps: HandlerDeps) {
    this.store = deps.store;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.maxTtl = deps.maxTtlSeconds ?? 7 * 24 * 3600;
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await this.store.get(key);
      if (!raw) return null;
      const entry = deserialize<CacheEntry>(raw);
      const times = await this.store.getTagTimes(entry.tags);
      if (times.some((t) => t >= entry.lastModified)) return null;
      return entry;
    } catch (error) {
      this.log?.warn({ err: error, key }, 'cache get failed; treating as miss');
      return null;
    }
  }

  async set(key: string, data: unknown, ctx: { tags?: string[] } = {}): Promise<void> {
    try {
      if (data === null || data === undefined) {
        await this.store.del(key);
        return;
      }
      const entry: CacheEntry = { value: data, lastModified: this.now(), tags: ctx.tags ?? [] };
      await this.store.set(key, serialize(entry), this.jitteredTtl());
    } catch (error) {
      this.log?.warn({ err: error, key }, 'cache set failed; entry not stored');
    }
  }

  async revalidateTag(tags: unknown): Promise<void> {
    const list = [tags].flat().filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (list.length === 0) return;
    // Not swallowed: callers (publish, price change) must know the invalidation did not happen.
    await this.store.setTagTimes(list, this.now());
  }

  resetRequestCache(): void {
    // No per-request memoisation layer: the shared store is the source of truth.
  }

  private jitteredTtl(): number {
    return Math.round(this.maxTtl * (0.9 + this.random() * 0.2));
  }
}

let shared: SoldCacheHandlerCore | undefined;

function build(): SoldCacheHandlerCore {
  const env = loadEnvForCache();
  const logger = jsonLogger({ service: 'sold-cache', environment: env.SOLD_ENVIRONMENT });
  if (env.REDIS_URL) {
    const store = new RedisCacheStore({
      url: env.REDIS_URL,
      keyPrefix: `sold:cache:${env.SOLD_BUILD_ID}:`,
      onError: (error, op) => logger.warn({ err: error, op }, 'redis cache error'),
    });
    return new SoldCacheHandlerCore({ store, logger });
  }
  if (env.SOLD_ENVIRONMENT === 'stage' || env.SOLD_ENVIRONMENT === 'prod') {
    logger.error(
      'REDIS_URL is not set: the ISR cache is per-instance and NOT consistent across replicas',
    );
  }
  return new SoldCacheHandlerCore({ store: new MemoryCacheStore(), logger });
}

/** The cache handler only needs a few variables; do not require DATABASE_URL during `next build`. */
function loadEnvForCache() {
  return loadEnv({ DATABASE_URL: 'postgres://unused/unused', ...process.env });
}

/** Class referenced by `cacheHandler` in next.config; Next instantiates it per use, so state is shared. */
export default class SoldCacheHandler {
  private readonly core: SoldCacheHandlerCore;

  constructor(_options?: unknown) {
    shared ??= build();
    this.core = shared;
  }

  get(key: string) {
    return this.core.get(key);
  }
  set(key: string, data: unknown, ctx?: { tags?: string[] }) {
    return this.core.set(key, data, ctx);
  }
  revalidateTag(tags: unknown) {
    return this.core.revalidateTag(tags);
  }
  resetRequestCache() {
    this.core.resetRequestCache();
  }
}
