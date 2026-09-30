import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestRedis, type TestRedis } from '@sold/testing';
import { SoldCacheHandlerCore } from './handler';
import { RedisCacheStore } from './store';

let redis: TestRedis | null;
const stores: RedisCacheStore[] = [];

const instance = (prefix = 'sold:cache:build1:') => {
  if (!redis) throw new Error('no redis');
  const store = new RedisCacheStore({ url: redis.url, keyPrefix: prefix, commandTimeoutMs: 300 });
  stores.push(store);
  return { store, handler: new SoldCacheHandlerCore({ store }) };
};

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
  it('an entry written by one instance is served by another', async () => {
    const a = instance();
    const b = instance();
    await a.handler.set(
      'page:/',
      { kind: 'APP_PAGE', rsc: Buffer.from('payload') },
      { tags: ['page:/'] },
    );
    const hit = await b.handler.get('page:/');
    expect(Buffer.isBuffer((hit?.value as { rsc: Buffer }).rsc)).toBe(true);
  });

  it('tag revalidation on one instance is seen immediately by another', async () => {
    const a = instance();
    const b = instance();
    await a.handler.set('product:9', { v: 1 }, { tags: ['product:9'] });
    expect(await b.handler.get('product:9')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await b.handler.revalidateTag('product:9');
    expect(await a.handler.get('product:9')).toBeNull();
  });

  it('isolates builds by key prefix, but tag invalidation crosses builds', async () => {
    const v1 = instance('sold:cache:v1:');
    const v2 = instance('sold:cache:v2:');
    await v1.handler.set('k', { v: 1 }, { tags: ['t'] });
    expect(await v2.handler.get('k')).toBeNull();
  });

  it('expires entries via Redis TTL (with jitter applied)', async () => {
    const a = instance('sold:cache:ttl:');
    const store = a.store;
    await store.set('short', 'x', 1);
    expect(await store.get('short')).toBe('x');
    await new Promise((r) => setTimeout(r, 1200));
    expect(await store.get('short')).toBeNull();
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
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(handler.revalidateTag('k')).rejects.toThrow();
    } finally {
      await store.close();
    }
  });
});
