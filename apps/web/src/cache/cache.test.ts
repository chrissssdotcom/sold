import { describe, expect, it, vi } from 'vitest';
import { SoldCacheHandlerCore } from './handler';
import { deserialize, serialize } from './serialize';
import { MemoryCacheStore, type CacheStore } from './store';

function setup(over: { now?: () => number; random?: () => number; store?: CacheStore } = {}) {
  let t = 1_000;
  const now = over.now ?? (() => t);
  const store = over.store ?? new MemoryCacheStore(now);
  const handler = new SoldCacheHandlerCore({
    store,
    now,
    ...(over.random ? { random: over.random } : {}),
  });
  return { handler, store, advance: (ms: number) => (t += ms) };
}

describe('serialize', () => {
  it('round-trips Buffers and Maps compactly', () => {
    const value = {
      html: 'x',
      rsc: Buffer.from([1, 2, 3, 255]),
      segs: new Map([['a', Buffer.from('b')]]),
    };
    const raw = serialize(value);
    expect(raw).toContain('"__sold":"buf"');
    expect(raw).not.toContain('"data":[');
    const back = deserialize<typeof value>(raw);
    expect(Buffer.isBuffer(back.rsc)).toBe(true);
    expect([...back.rsc]).toEqual([1, 2, 3, 255]);
    expect(back.segs.get('a')?.toString()).toBe('b');
  });
});

describe('SoldCacheHandlerCore', () => {
  it('returns what was set, with tags and lastModified', async () => {
    const { handler } = setup();
    await handler.set('k', { kind: 'APP_PAGE', html: '<p>hi</p>' }, { tags: ['product:1'] });
    const hit = await handler.get('k');
    expect(hit).toMatchObject({
      value: { html: '<p>hi</p>' },
      tags: ['product:1'],
      lastModified: 1_000,
    });
  });

  it('misses after any of its tags is revalidated, but not after unrelated tags', async () => {
    const { handler, advance } = setup();
    await handler.set('a', { v: 1 }, { tags: ['product:1', 'collection:9'] });
    await handler.set('b', { v: 2 }, { tags: ['product:2'] });
    advance(10);
    await handler.revalidateTag('collection:9');
    expect(await handler.get('a')).toBeNull();
    expect(await handler.get('b')).not.toBeNull();
  });

  it('an entry written after the revalidation is fresh', async () => {
    const { handler, advance } = setup();
    await handler.revalidateTag(['product:1']);
    advance(10);
    await handler.set('a', { v: 1 }, { tags: ['product:1'] });
    expect(await handler.get('a')).not.toBeNull();
  });

  it('set(null) deletes', async () => {
    const { handler } = setup();
    await handler.set('a', { v: 1 });
    await handler.set('a', null);
    expect(await handler.get('a')).toBeNull();
  });

  it('jitters TTLs by +-10%', async () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const store = { ...new MemoryCacheStore(), set: setSpy } as unknown as CacheStore;
    const low = new SoldCacheHandlerCore({ store, random: () => 0, maxTtlSeconds: 1000 });
    const high = new SoldCacheHandlerCore({ store, random: () => 1, maxTtlSeconds: 1000 });
    await low.set('a', { v: 1 });
    await high.set('a', { v: 1 });
    expect(setSpy.mock.calls.map((c) => c[2])).toEqual([900, 1100]);
  });

  it('fails open on store errors for get/set, but surfaces revalidateTag failures', async () => {
    const broken: CacheStore = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
      del: () => Promise.reject(new Error('down')),
      getTagTimes: () => Promise.reject(new Error('down')),
      setTagTimes: () => Promise.reject(new Error('down')),
      close: async () => undefined,
    };
    const { handler } = setup({ store: broken });
    expect(await handler.get('k')).toBeNull();
    await expect(handler.set('k', { v: 1 })).resolves.toBeUndefined();
    await expect(handler.revalidateTag('t')).rejects.toThrow('down');
  });

  it('ignores empty or non-string tags', async () => {
    const { handler, store } = setup();
    const spy = vi.spyOn(store, 'setTagTimes');
    await handler.revalidateTag(['', 3, undefined]);
    expect(spy).not.toHaveBeenCalled();
  });
});
