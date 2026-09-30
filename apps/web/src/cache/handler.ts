import { loadEnv } from '@sold/core/env';
import { deserialize, serialize } from './serialize';
import { MemoryCacheStore, RedisCacheStore, type CacheStore } from './store';

/**
 * Shared Next.js cache handler (ISR / data cache / route handler cache), Section 8A.2.
 *
 * What Next actually passes (verified against next@16 `incremental-cache`, and by the end-to-end test):
 *  - FETCH entries carry their tags in `ctx.tags`.
 *  - APP_PAGE / APP_ROUTE entries do NOT: their tags are in `value.headers['x-next-cache-tags']`, and on `get`
 *    the implicit path tags of the requested route arrive as `ctx.softTags`. Next's own staleness check for
 *    pages reads a process-local manifest a custom handler never updates, so THIS handler must decide.
 *
 * Behaviour:
 *  - Consistent across instances: entries and tag revalidation times live in Redis; freshness is decided
 *    inside Redis in one round trip.
 *  - An entry is a miss when any of its tags (header + ctx + soft) was revalidated at or after it was rendered.
 *  - Timestamps come from the store clock and use the time the render STARTED (the miss), so an invalidation
 *    that lands while a page is rendering is never lost, and skewed instance clocks cannot break ordering.
 *  - Fail-open: a store error on read/write is a miss / no-op. `revalidateTag` failures are surfaced.
 *  - TTL follows `cacheControl.expire` (else 7 days), jittered so entries written together expire apart.
 *
 * Known limits (see docs/scaling.md): `revalidateTag`'s stale window (`durations`) is treated as immediate
 * expiry; and Next keeps route cache-control (`revalidate`) per process, so a route that was not prerendered
 * at build re-renders once on the first hit per instance.
 */
export const NEXT_CACHE_TAGS_HEADER = 'x-next-cache-tags';

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
    const body: Record<string, unknown> =
      typeof fields === 'string' ? { msg: fields } : { ...fields, msg: message };
    if (body.err instanceof Error) body.err = body.err.message;
    console.error(JSON.stringify({ level, time: new Date().toISOString(), ...base, ...body }));
  };
  return { warn: emit('warn'), error: emit('error') };
}

interface CacheEntry {
  value: unknown;
  lastModified: number;
  tags: string[];
}

export interface GetContext {
  kind?: string;
  tags?: string[];
  softTags?: string[];
}

export interface SetContext {
  tags?: string[];
  cacheControl?: { revalidate?: number | false; expire?: number };
}

export interface HandlerDeps {
  store: CacheStore;
  logger?: CacheLogger;
  random?: () => number;
  maxTtlSeconds?: number;
  /** How long a render-start timestamp is remembered while waiting for the matching `set`. */
  pendingTtlMs?: number;
}

/** Tags a page/route entry carries in its response headers. */
export function tagsFromValue(value: unknown): string[] {
  const headers = (value as { headers?: Record<string, unknown> } | null | undefined)?.headers;
  const raw = headers?.[NEXT_CACHE_TAGS_HEADER];
  return typeof raw === 'string' && raw.length > 0 ? raw.split(',') : [];
}

export class SoldCacheHandlerCore {
  private readonly store: CacheStore;
  private readonly log: CacheLogger | undefined;
  private readonly random: () => number;
  private readonly maxTtl: number;
  private readonly pendingTtlMs: number;
  /** key -> store-clock time of the last miss: the moment the render that follows started. Bounded. */
  private readonly renderStarted = new Map<string, number>();
  private static readonly MAX_PENDING = 10_000;

  constructor(deps: HandlerDeps) {
    this.store = deps.store;
    this.log = deps.logger;
    this.random = deps.random ?? Math.random;
    this.maxTtl = deps.maxTtlSeconds ?? 7 * 24 * 3600;
    this.pendingTtlMs = deps.pendingTtlMs ?? 120_000;
  }

  async get(key: string, ctx: GetContext = {}): Promise<CacheEntry | null> {
    try {
      const extra = [...(ctx.tags ?? []), ...(ctx.softTags ?? [])];
      const raw = await this.store.get(key, extra);
      if (raw) return deserialize<CacheEntry>(raw);
    } catch (error) {
      this.log?.warn({ err: error, key }, 'cache get failed; treating as miss');
    }
    this.markRenderStart(key);
    return null;
  }

  async set(key: string, data: unknown, ctx: SetContext = {}): Promise<void> {
    try {
      if (data === null || data === undefined) {
        await this.store.del(key);
        return;
      }
      const tags = [...new Set([...(ctx.tags ?? []), ...tagsFromValue(data)])];
      // The render began at the miss; if we never saw one (e.g. a prerender at build), use "now".
      const lastModified = this.takeRenderStart(key) ?? this.store.now();
      const entry: CacheEntry = { value: data, lastModified, tags };
      await this.store.set(
        key,
        { payload: serialize(entry), lastModified, tags },
        this.ttlFor(ctx),
      );
    } catch (error) {
      this.log?.warn({ err: error, key }, 'cache set failed; entry not stored');
    }
  }

  async revalidateTag(tags: unknown, _durations?: unknown): Promise<void> {
    const list = [tags].flat().filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (list.length === 0) return;
    // Not swallowed: callers (publish, price change) must know the invalidation did not happen.
    await this.store.revalidateTags(list, this.store.now());
  }

  resetRequestCache(): void {
    // No per-request memoisation layer: the shared store is the source of truth.
  }

  private markRenderStart(key: string): void {
    if (this.renderStarted.size >= SoldCacheHandlerCore.MAX_PENDING) {
      const oldest = this.renderStarted.keys().next().value;
      if (oldest !== undefined) this.renderStarted.delete(oldest);
    }
    // Keep the EARLIEST miss: concurrent requests for the same key all started before the eventual `set`.
    if (!this.renderStarted.has(key)) this.renderStarted.set(key, this.store.now());
  }

  private takeRenderStart(key: string): number | undefined {
    const started = this.renderStarted.get(key);
    this.renderStarted.delete(key);
    if (started === undefined || this.store.now() - started > this.pendingTtlMs) return undefined;
    return started;
  }

  private ttlFor(ctx: SetContext): number {
    const expire = ctx.cacheControl?.expire;
    const base =
      typeof expire === 'number' && expire > 0 ? Math.min(expire, this.maxTtl) : this.maxTtl;
    return Math.max(60, Math.round(base * (0.9 + this.random() * 0.2)));
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

  get(key: string, ctx?: GetContext) {
    return this.core.get(key, ctx);
  }
  set(key: string, data: unknown, ctx?: SetContext) {
    return this.core.set(key, data, ctx);
  }
  revalidateTag(tags: unknown, durations?: unknown) {
    return this.core.revalidateTag(tags, durations);
  }
  resetRequestCache() {
    this.core.resetRequestCache();
  }
}
