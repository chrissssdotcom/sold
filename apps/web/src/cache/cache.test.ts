import { describe, expect, it, vi } from 'vitest';
import { NEXT_CACHE_TAGS_HEADER, SoldCacheHandlerCore, tagsFromValue } from './handler';
import { deserialize, serialize } from './serialize';
import { MemoryCacheStore, type CacheStore } from './store';

function setup(over: { clock?: () => number; random?: () => number; store?: CacheStore } = {}) {
  let t = 1_000;
  const clock = over.clock ?? (() => t);
  const store = over.store ?? new MemoryCacheStore(clock);
  const handler = new SoldCacheHandlerCore({
    store,
    ...(over.random ? { random: over.random } : {}),
  });
  return { handler, store, advance: (ms: number) => (t += ms) };
}

const page = (tags: string, html = '<p>hi</p>') => ({
  kind: 'APP_PAGE',
  html,
  headers: { [NEXT_CACHE_TAGS_HEADER]: tags },
});

describe('serialize', () => {
  it('round-trips Buffers, Maps and BigInts compactly', () => {
    const value = {
      html: 'x',
      rsc: Buffer.from([1, 2, 3, 255]),
      segs: new Map([['a', Buffer.from('b')]]),
      n: 9_007_199_254_740_993n,
    };
    const raw = serialize(value);
    expect(raw).toContain('"$sold":"buf"');
    expect(raw).not.toContain('"data":[');
    const back = deserialize<typeof value>(raw);
    expect([...back.rsc]).toEqual([1, 2, 3, 255]);
    expect(back.segs.get('a')?.toString()).toBe('b');
    expect(back.n).toBe(9_007_199_254_740_993n);
  });

  it('cannot confuse user data that looks like a tag', () => {
    const lookalike = { $sold: 'buf', b64: 'AAEC' };
    const back = deserialize<{ v: unknown }>(serialize({ v: lookalike }));
    expect(back.v).toEqual(lookalike);
    expect(Buffer.isBuffer(back.v)).toBe(false);
  });
});

describe('tagsFromValue', () => {
  it('reads tags from the response headers of page entries', () => {
    expect(tagsFromValue(page('_N_T_/layout,_N_T_/isr,product:1'))).toEqual([
      '_N_T_/layout',
      '_N_T_/isr',
      'product:1',
    ]);
    expect(tagsFromValue({ kind: 'FETCH' })).toEqual([]);
    expect(tagsFromValue(null)).toEqual([]);
  });
});

describe('SoldCacheHandlerCore', () => {
  it('returns what was set, with tags and lastModified', async () => {
    const { handler } = setup();
    await handler.set('k', { kind: 'FETCH', data: 1 }, { tags: ['product:1'] });
    expect(await handler.get('k')).toMatchObject({
      value: { data: 1 },
      tags: ['product:1'],
      lastModified: 1_000,
    });
  });

  it('PAGES: invalidates by the tags in the response header, which Next does not pass in ctx.tags', async () => {
    const { handler, advance } = setup();
    // Real Next: ctx has NO tags for APP_PAGE; the tags are inside the value's headers.
    await handler.set('/isr', page('_N_T_/isr,collection:9'), {});
    await handler.set('/other', page('_N_T_/other'), {});
    advance(10);
    await handler.revalidateTag('collection:9');
    expect(await handler.get('/isr', { kind: 'APP_PAGE' })).toBeNull();
    expect(await handler.get('/other', { kind: 'APP_PAGE' })).not.toBeNull();
  });

  it('PAGES: revalidatePath arrives as implicit path tags, matched via header tags and via ctx.softTags', async () => {
    const { handler, advance } = setup();
    await handler.set('/isr', page('_N_T_/layout,_N_T_/isr'), {});
    advance(10);
    await handler.revalidateTag(['_N_T_/isr']);
    expect(await handler.get('/isr', { kind: 'APP_PAGE' })).toBeNull();

    // An entry whose header lacks the tag is still invalidated when the requested route's soft tags include it.
    await handler.set('/x', page('unrelated'), {});
    advance(10);
    await handler.revalidateTag('_N_T_/x');
    expect(await handler.get('/x', { kind: 'APP_PAGE', softTags: ['_N_T_/x'] })).toBeNull();
    expect(await handler.get('/x', { kind: 'APP_PAGE' })).not.toBeNull();
  });

  it('an entry written after the revalidation is fresh', async () => {
    const { handler, advance } = setup();
    await handler.revalidateTag(['product:1']);
    advance(10);
    await handler.set('a', { v: 1 }, { tags: ['product:1'] });
    expect(await handler.get('a')).not.toBeNull();
  });

  it('a revalidation at the exact same instant invalidates (safe side)', async () => {
    const { handler } = setup();
    await handler.set('a', { v: 1 }, { tags: ['t'] });
    await handler.revalidateTag('t');
    expect(await handler.get('a')).toBeNull();
  });

  it('uses the time the render STARTED, so an invalidation during a render is not lost', async () => {
    const { handler, advance } = setup();
    expect(await handler.get('/slow', { kind: 'APP_PAGE' })).toBeNull(); // miss: render begins at t=1000
    advance(50);
    await handler.revalidateTag('product:1'); // invalidation lands while the render is in flight (t=1050)
    advance(50);
    await handler.set('/slow', page('product:1'), {}); // render finishes with pre-invalidation data (t=1100)
    expect(await handler.get('/slow', { kind: 'APP_PAGE' })).toBeNull(); // must NOT be served as fresh
  });

  it('ignores a stale render-start marker', async () => {
    const { handler, advance } = setup();
    await handler.get('/old');
    advance(10 * 60_000);
    await handler.set('/old', page('x'), {});
    expect(await handler.get('/old')).toMatchObject({ lastModified: 1_000 + 10 * 60_000 });
  });

  it('set(null) deletes', async () => {
    const { handler } = setup();
    await handler.set('a', { v: 1 });
    await handler.set('a', null);
    expect(await handler.get('a')).toBeNull();
  });

  it('TTL follows cacheControl.expire, jittered +-10%, floored at 60s', async () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const store = { ...new MemoryCacheStore(), now: () => 1, set: setSpy } as unknown as CacheStore;
    const low = new SoldCacheHandlerCore({ store, random: () => 0, maxTtlSeconds: 1000 });
    const high = new SoldCacheHandlerCore({ store, random: () => 1, maxTtlSeconds: 1000 });
    await low.set('a', { v: 1 });
    await high.set('a', { v: 1 });
    await low.set('b', { v: 1 }, { cacheControl: { expire: 200 } });
    await low.set('c', { v: 1 }, { cacheControl: { expire: 5 } });
    expect(setSpy.mock.calls.map((c) => c[2])).toEqual([900, 1100, 180, 60]);
  });

  it('fails open on store errors for get/set, but surfaces revalidateTag failures', async () => {
    const down = () => Promise.reject(new Error('down'));
    const broken: CacheStore = {
      now: () => 1,
      get: down,
      set: down,
      del: down,
      revalidateTags: down,
      close: async () => undefined,
    };
    const { handler } = setup({ store: broken });
    expect(await handler.get('k')).toBeNull();
    await expect(handler.set('k', { v: 1 })).resolves.toBeUndefined();
    await expect(handler.revalidateTag('t')).rejects.toThrow('down');
  });

  it('ignores empty or non-string tags', async () => {
    const { handler, store } = setup();
    const spy = vi.spyOn(store, 'revalidateTags');
    await handler.revalidateTag(['', 3, undefined]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts the v16 durations argument without changing behaviour', async () => {
    const { handler, advance } = setup();
    await handler.set('a', { v: 1 }, { tags: ['t'] });
    advance(1);
    await handler.revalidateTag('t', { expire: 300 });
    expect(await handler.get('a')).toBeNull();
  });
});
