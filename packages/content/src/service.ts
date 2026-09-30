import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError, writeOutbox } from '@sold/commerce';
import { and, eq, schema, sql, type PrimaryDb, type ReplicaDb } from '@sold/db';
import type { BlockRegistry } from './registry';
import { validateTree, type BlockNode } from './tree';

const { pages, pageVersions } = schema;

const pathSchema = z
  .string()
  .regex(/^\/([a-z0-9-]+(\/[a-z0-9-]+)*)?$/, 'lowercase path like / or /about');
const localeSchema = z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/);

export const seoSchema = z.strictObject({
  title: z.string().max(70).optional(),
  description: z.string().max(200).optional(),
  ogImage: z.url().optional(),
  noindex: z.boolean().optional(),
});
export type PageSeo = z.infer<typeof seoSchema>;

export interface PageRecord {
  id: string;
  path: string;
  locale: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  publishedVersionId: string | null;
  seo: PageSeo;
}

export interface PublishedPage {
  page: PageRecord;
  version: number;
  tree: BlockNode[];
}

export interface VersionSummary {
  id: string;
  version: number;
  note: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * Pages and their immutable versions. Saving never edits a version: it appends the next one, so history, diff and
 * rollback are free, and a draft can never leak into the live site. `publish` is a pointer move (one row, atomic).
 */
export class PageService {
  constructor(private readonly registry: BlockRegistry) {}

  async create(
    db: PrimaryDb,
    input: { path: string; locale: string; title: string; seo?: PageSeo; actor: string },
  ): Promise<PageRecord> {
    const path = pathSchema.parse(input.path);
    const locale = localeSchema.parse(input.locale);
    const seo = seoSchema.parse(input.seo ?? {});
    if (!input.title.trim() || input.title.length > 200)
      throw new ValidationError('A title of 1-200 characters is required');
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(pages)
        .values({ path, locale, title: input.title.trim(), seo })
        .onConflictDoNothing({ target: [pages.locale, pages.path] })
        .returning();
      const page = inserted[0];
      if (!page)
        throw new ConflictError(
          'page_exists',
          'A page already exists at that path for this locale',
        );
      await tx
        .insert(pageVersions)
        .values({ pageId: page.id, version: 1, tree: [], note: 'created', createdBy: input.actor });
      return toRecord(page);
    });
  }

  /** Save a draft: validates against the block registry and appends the next version. */
  async saveDraft(
    db: PrimaryDb,
    pageId: string,
    tree: unknown,
    opts: { actor: string; note?: string; expectedVersion?: number },
  ): Promise<{ versionId: string; version: number }> {
    const validated = validateTree(tree, this.registry);
    return db.transaction(async (tx) => {
      // Lock the page row: concurrent editors serialise, each gets its own version number.
      const locked = await tx.execute<{ id: string }>(
        sql`SELECT id FROM pages WHERE id = ${pageId} FOR UPDATE`,
      );
      if (locked.rows.length === 0) throw new NotFoundError('Page', pageId);
      const latest =
        (
          await tx.execute<{ v: number | null }>(
            sql`SELECT max(version) AS v FROM page_versions WHERE page_id = ${pageId}`,
          )
        ).rows[0]?.v ?? 0;
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== latest)
        throw new ConflictError(
          'page_version_conflict',
          'Someone else saved this page; reload to see their changes',
          {
            expected: opts.expectedVersion,
            actual: latest,
          },
        );
      const [row] = await tx
        .insert(pageVersions)
        .values({
          pageId,
          version: latest + 1,
          tree: validated,
          note: opts.note ?? '',
          createdBy: opts.actor,
        })
        .returning({ id: pageVersions.id, version: pageVersions.version });
      if (!row) throw new Error('version insert failed');
      return { versionId: row.id, version: row.version };
    });
  }

  /** Make a version live. Rolling back is publishing an older version. Emits `page.published` for cache purge. */
  async publish(db: PrimaryDb, pageId: string, version: number, actor: string): Promise<void> {
    await db.transaction(async (tx) => {
      const page = (
        await tx.execute<{ path: string; locale: string }>(
          sql`SELECT path, locale FROM pages WHERE id = ${pageId} FOR UPDATE`,
        )
      ).rows[0];
      if (!page) throw new NotFoundError('Page', pageId);
      const [v] = await tx
        .select({ id: pageVersions.id })
        .from(pageVersions)
        .where(and(eq(pageVersions.pageId, pageId), eq(pageVersions.version, version)));
      if (!v) throw new NotFoundError('Page version', String(version));
      await tx
        .update(pages)
        .set({ status: 'published', publishedVersionId: v.id })
        .where(eq(pages.id, pageId));
      await writeOutbox(tx, {
        aggregateType: 'page',
        aggregateId: pageId,
        eventType: 'page.published',
        payload: { pageId, path: page.path, locale: page.locale, version, actor },
      });
    });
  }

  async unpublish(db: PrimaryDb, pageId: string, actor: string): Promise<void> {
    await db.transaction(async (tx) => {
      const page = (
        await tx.execute<{ path: string; locale: string }>(
          sql`SELECT path, locale FROM pages WHERE id = ${pageId} FOR UPDATE`,
        )
      ).rows[0];
      if (!page) throw new NotFoundError('Page', pageId);
      await tx
        .update(pages)
        .set({ status: 'draft', publishedVersionId: null })
        .where(eq(pages.id, pageId));
      await writeOutbox(tx, {
        aggregateType: 'page',
        aggregateId: pageId,
        eventType: 'page.unpublished',
        payload: { pageId, path: page.path, locale: page.locale, actor },
      });
    });
  }

  /** The live page for a request: ONE query, only ever the published version. Reads a replica. */
  async getPublished(
    db: PrimaryDb | ReplicaDb,
    locale: string,
    path: string,
  ): Promise<PublishedPage | null> {
    const rows = await db
      .select({ page: pages, version: pageVersions.version, tree: pageVersions.tree })
      .from(pages)
      .innerJoin(pageVersions, eq(pageVersions.id, pages.publishedVersionId))
      .where(and(eq(pages.locale, locale), eq(pages.path, path), eq(pages.status, 'published')))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { page: toRecord(row.page), version: row.version, tree: row.tree as BlockNode[] };
  }

  /** The latest version, draft or live, for the editor and preview. */
  async getLatest(db: PrimaryDb, pageId: string): Promise<PublishedPage> {
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
    if (!page) throw new NotFoundError('Page', pageId);
    const [v] = await db
      .select()
      .from(pageVersions)
      .where(eq(pageVersions.pageId, pageId))
      .orderBy(sql`${pageVersions.version} DESC`)
      .limit(1);
    return { page: toRecord(page), version: v?.version ?? 0, tree: (v?.tree ?? []) as BlockNode[] };
  }

  async listVersions(db: PrimaryDb, pageId: string, limit = 50): Promise<VersionSummary[]> {
    const rows = await db
      .select()
      .from(pageVersions)
      .where(eq(pageVersions.pageId, pageId))
      .orderBy(sql`${pageVersions.version} DESC`)
      .limit(Math.min(limit, 200));
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      note: r.note,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    }));
  }

  async updateMeta(
    db: PrimaryDb,
    pageId: string,
    meta: { title?: string; seo?: PageSeo },
  ): Promise<void> {
    const set: Partial<typeof pages.$inferInsert> = {};
    if (meta.title !== undefined) set.title = meta.title.trim();
    if (meta.seo !== undefined) set.seo = seoSchema.parse(meta.seo);
    if (Object.keys(set).length === 0) return;
    const r = await db
      .update(pages)
      .set(set)
      .where(eq(pages.id, pageId))
      .returning({ id: pages.id });
    if (r.length === 0) throw new NotFoundError('Page', pageId);
  }
}

function toRecord(p: typeof pages.$inferSelect): PageRecord {
  return {
    id: p.id,
    path: p.path,
    locale: p.locale,
    title: p.title,
    status: p.status as PageRecord['status'],
    publishedVersionId: p.publishedVersionId,
    seo: p.seo as PageSeo,
  };
}
