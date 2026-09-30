import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRedis, type TestRedis } from '@sold/testing';
import { NEXT_CACHE_TAGS_HEADER, SoldCacheHandlerCore } from './handler';
import { RedisCacheStore } from './store';

let redis: TestRedis | null;
const stores: RedisCacheStore[] = [];

const instance = (prefix = 'sold:cache:build1:', extra: { clockOffsetMs?: number } = {}) => {
  if (!redis) throw new Error('no redis');
  // A skewed machine: its wall clock is off by `clockOffsetMs`. The store measures the offset to Redis with
  // that same clock, so timestamps must still agree across instances.
  const localClock = () => Date.now() + (extra.clockOffsetMs ?? 0);
  const store = new RedisCacheStore({
    url: redis.url,
    keyPrefix: prefix,
    commandTimeoutMs: 300,
    localClock,
  });
  stores.push(store);
  return { store, handler: new SoldCacheHandlerCore({ store }) };
};
const page = (tags: string) => ({
  kind: 'APP_PAGE',
  rsc: Buffer.from('payload'),
  headers: { [NEXT_CACHE_TAGS_HEADER]: tags },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  redis = await createTestRedis();
  if (!redis)
    throw new Error('redis-server not available: install redis or set SOLD_TEST_REDIS_URL');
});
afterAll(async () => {
  await Promise.all(stores.map((s) => s.close()));
  await redis?.stop();
});

describe('shared cache across instances (Redis)', () => {
  it('an entry written by one instance is served by another, Buffers intact', async () => {
    const a = instance();
    const b = instance();
    await a.handler.set('page:/', page('page:/'));
    const hit = await b.handler.get('page:/', { kind: 'APP_PAGE' });
    expect(Buffer.isBuffer((hit?.value as { rsc: Buffer }).rsc)).toBe(true);
  });

  it('page tag revalidation (from the response header) on one instance is seen immediately by another', async () => {
    const a = instance();
    const b = instance();
    await a.handler.set('/product/9', page('_N_T_/product/9,product:9'));
    expect(await b.handler.get('/product/9', { kind: 'APP_PAGE' })).not.toBeNull();
    await sleep(5);
    await b.handler.revalidateTag('product:9');
    expect(await a.handler.get('/product/9', { kind: 'APP_PAGE' })).toBeNull();
  });

  it('soft tags from the requested route are honoured atomically in Redis', async () => {
    const a = instance();
    await a.handler.set('/soft', page('unrelated'));
    await sleep(5);
    await a.handler.revalidateTag('_N_T_/soft');
    expect(await a.handler.get('/soft', { kind: 'APP_PAGE', softTags: ['_N_T_/soft'] })).toBeNull();
  });

  it('isolates builds by key prefix', async () => {
    const v1 = instance('sold:cache:v1:');
    const v2 = instance('sold:cache:v2:');
    await v1.handler.set('k', { v: 1 }, { tags: ['t'] });
    expect(await v2.handler.get('k')).toBeNull();
  });

  it('expires entries via Redis TTL', async () => {
    const a = instance('sold:cache:ttl:');
    await a.store.set('short', { payload: 'x', lastModified: a.store.now(), tags: [] }, 1);
    expect(await a.store.get('short', [])).toBe('x');
    await sleep(1200);
    expect(await a.store.get('short', [])).toBeNull();
  });

  it('is immune to instance clock skew: timestamps come from the Redis clock', async () => {
    const fast = instance('sold:cache:skew:', { clockOffsetMs: 5_000 }); // 5 s ahead
    const slow = instance('sold:cache:skew:', { clockOffsetMs: -5_000 }); // 5 s behind
    await sleep(50); // let both clocks sync
    // The writer's wall clock is far AHEAD: with local timestamps this entry would look newer than any later invalidation.
    await fast.handler.set('/skew', page('skew:tag'));
    await sleep(20);
    await slow.handler.revalidateTag('skew:tag');
    expect(await fast.handler.get('/skew', { kind: 'APP_PAGE' })).toBeNull();
    // ...and the reverse: a writer 5 s BEHIND must not have its fresh entry rejected.
    await slow.handler.set('/skew2', page('skew:tag2'));
    expect(await fast.handler.get('/skew2', { kind: 'APP_PAGE' })).not.toBeNull();
  });
});

describe('Redis loss', () => {
  it('fails open (misses) quickly and opens the circuit; revalidateTag surfaces the failure', async () => {
    const victim = await createTestRedis();
    if (!victim) throw new Error('redis-server not available');
    if (process.env.SOLD_TEST_REDIS_URL) return; // cannot kill an external Redis
    const store = new RedisCacheStore({ url: victim.url, keyPrefix: 'p:', commandTimeoutMs: 200 });
    const handler = new SoldCacheHandlerCore({ store });
    try {
      await handler.set('k', { v: 1 });
      expect(await handler.get('k')).not.toBeNull();
      await victim.kill();
      const started = Date.now();
      for (let i = 0; i < 8; i++) expect(await handler.get('k')).toBeNull();
      expect(Date.now() - started).toBeLessThan(4_000);
      await expect(handler.revalidateTag('k')).rejects.toThrow();
    } finally {
      await store.close();
    }
  });
});
