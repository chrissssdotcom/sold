import { openMigrated } from '@sold/commerce/testing';
import { defineBlock, z } from '@sold/extension-sdk';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockRegistry } from './registry';
import { PageService } from './service';

let testDb: TestDatabase;
let db: Db;
const hero = defineBlock({
  type: 'hero',
  title: 'Hero',
  propsSchema: z.object({ heading: z.string().min(1) }),
  defaultProps: { heading: 'x' },
  component: async () => ({ default: () => null }),
  thumbnail: 'data:,',
});
const pages = new PageService(new BlockRegistry().register(hero));
const tree = (heading: string) => [{ id: 'h1', type: 'hero', props: { heading } }];

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 15);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

describe('pages', () => {
  it('creates a draft with an empty first version; duplicates and bad paths are refused', async () => {
    const p = await pages.create(db.primary, {
      path: '/',
      locale: 'en-au',
      title: 'Home',
      actor: 'u1',
    });
    expect(p.status).toBe('draft');
    expect((await pages.getLatest(db.primary, p.id)).version).toBe(1);
    await expect(
      pages.create(db.primary, { path: '/', locale: 'en-au', title: 'Again', actor: 'u1' }),
    ).rejects.toMatchObject({ code: 'page_exists' });
    for (const path of ['about', '/About', '/a//b', '/a/', '/a b', '/../x'])
      await expect(
        pages.create(db.primary, { path, locale: 'en-au', title: 't', actor: 'u' }),
      ).rejects.toThrow();
    await expect(
      pages.create(db.primary, { path: '/x', locale: 'EN', title: 't', actor: 'u' }),
    ).rejects.toThrow();
  });

  it('drafts never leak: only the published version is served; publish/rollback move a pointer', async () => {
    const p = await pages.create(db.primary, {
      path: '/about',
      locale: 'en-au',
      title: 'About',
      actor: 'u1',
    });
    const v2 = await pages.saveDraft(db.primary, p.id, tree('First'), {
      actor: 'u1',
      note: 'first',
    });
    expect(v2.version).toBe(2);
    expect(await pages.getPublished(db.replica, 'en-au', '/about')).toBeNull(); // still draft
    await pages.publish(db.primary, p.id, 2, 'u1');
    expect((await pages.getPublished(db.replica, 'en-au', '/about'))?.tree[0]?.props).toEqual({
      heading: 'First',
    });
    const v3 = await pages.saveDraft(db.primary, p.id, tree('Second'), { actor: 'u1' });
    expect(v3.version).toBe(3);
    // the editor sees the draft, visitors still see v2
    expect((await pages.getLatest(db.primary, p.id)).tree[0]?.props).toEqual({ heading: 'Second' });
    expect((await pages.getPublished(db.replica, 'en-au', '/about'))?.version).toBe(2);
    await pages.publish(db.primary, p.id, 3, 'u1');
    expect((await pages.getPublished(db.replica, 'en-au', '/about'))?.version).toBe(3);
    await pages.publish(db.primary, p.id, 2, 'u1'); // rollback
    expect((await pages.getPublished(db.replica, 'en-au', '/about'))?.tree[0]?.props).toEqual({
      heading: 'First',
    });
    expect((await pages.listVersions(db.primary, p.id)).map((v) => v.version)).toEqual([3, 2, 1]);
    // every publish announced itself for cache purge
    const events = await db.primary.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM outbox_events WHERE aggregate_id = ${p.id} AND event_type = 'page.published'`,
    );
    expect(Number(events.rows[0]?.n)).toBe(3);
    await pages.unpublish(db.primary, p.id, 'u1');
    expect(await pages.getPublished(db.replica, 'en-au', '/about')).toBeNull();
  });

  it('refuses an invalid tree without writing a version', async () => {
    const p = await pages.create(db.primary, {
      path: '/bad',
      locale: 'en-au',
      title: 'Bad',
      actor: 'u',
    });
    await expect(
      pages.saveDraft(db.primary, p.id, [{ id: 'a', type: 'nope', props: {} }], { actor: 'u' }),
    ).rejects.toMatchObject({ code: 'invalid_page_tree' });
    expect((await pages.listVersions(db.primary, p.id)).map((v) => v.version)).toEqual([1]);
  });

  it('concurrent editors get distinct versions; a stale expectedVersion is refused', async () => {
    const p = await pages.create(db.primary, {
      path: '/race',
      locale: 'en-au',
      title: 'Race',
      actor: 'u',
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pages.saveDraft(db.primary, p.id, tree(`v${i}`), { actor: `u${i}` }),
      ),
    );
    expect(new Set(results.map((r) => r.version)).size).toBe(10);
    await expect(
      pages.saveDraft(db.primary, p.id, tree('x'), { actor: 'u', expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'page_version_conflict' });
    await expect(
      pages.saveDraft(db.primary, p.id, tree('x'), { actor: 'u', expectedVersion: 11 }),
    ).resolves.toMatchObject({ version: 12 });
  });

  it("the database will not publish without a version or point at another page's version", async () => {
    const p = await pages.create(db.primary, {
      path: '/db',
      locale: 'en-au',
      title: 'Db',
      actor: 'u',
    });
    const msg = (q: ReturnType<typeof sql>) =>
      db.primary.execute(q).then(
        () => '',
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(await msg(sql`UPDATE pages SET status = 'published' WHERE id = ${p.id}`)).toMatch(
      /pages_published_check/,
    );
    await expect(pages.publish(db.primary, p.id, 99, 'u')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('serves a published page with a single query', async () => {
    const p = await pages.create(db.primary, {
      path: '/one-query',
      locale: 'en-au',
      title: 'One',
      actor: 'u',
    });
    await pages.saveDraft(db.primary, p.id, tree('q'), { actor: 'u' });
    await pages.publish(db.primary, p.id, 2, 'u');
    const { QueryCounter, createDb } = await import('@sold/db');
    const counter = new QueryCounter();
    const counted = createDb({ primaryUrl: testDb.url, logger: counter });
    try {
      await pages.getPublished(counted.replica, 'en-au', '/one-query');
      expect(counter.queries).toHaveLength(1);
    } finally {
      await counted.close();
    }
  });
});
