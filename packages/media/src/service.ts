import { createHash } from 'node:crypto';
import type { DbOrTx } from '@sold/commerce';
import { desc, eq, lt, schema, sql, type ReplicaDb } from '@sold/db';
import { processImage } from './pipeline';
import type { MediaStore } from './store';

const { mediaAssets } = schema;

export interface MediaVariant {
  file: string;
  width: number;
  mime: string;
  bytes: number;
}
export interface MediaAsset {
  id: string;
  originalName: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  alt: string;
  variants: MediaVariant[];
  createdAt: Date;
  /** URL of a good default rendition (WebP at about 1024 px). */
  url: string;
}

export const mediaUrl = (id: string, file: string) => `/media/${id}/${file}`;

function toAsset(r: typeof mediaAssets.$inferSelect): MediaAsset {
  const variants = r.variants as MediaVariant[];
  const pick =
    variants
      .filter((v) => v.file.endsWith('.webp'))
      .sort((a, b) => Math.abs(a.width - 1024) - Math.abs(b.width - 1024))[0] ?? variants[0]!;
  return {
    id: r.id,
    originalName: r.originalName,
    mime: r.mime,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    alt: r.alt,
    variants,
    createdAt: r.createdAt,
    url: mediaUrl(r.id, pick.file),
  };
}

export class MediaService {
  constructor(private readonly store: MediaStore) {}

  /** Process and store an upload. Identical bytes return the existing asset (`created: false`). */
  async upload(
    db: DbOrTx,
    input: { data: Buffer; name: string; createdBy: string },
  ): Promise<{ asset: MediaAsset; created: boolean }> {
    const sha = createHash('sha256').update(input.data).digest('hex');
    const [existing] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.sha256, sha))
      .limit(1);
    if (existing) return { asset: toAsset(existing), created: false };

    const processed = await processImage(input.data); // throws MediaRejected before anything is stored
    const original = processed.renditions[0]!;
    const [row] = await db
      .insert(mediaAssets)
      .values({
        sha256: sha,
        originalName:
          [...input.name]
            .filter((c) => c.charCodeAt(0) >= 32)
            .join('')
            .slice(0, 200) || 'upload',
        mime: processed.mime,
        bytes: original.data.length,
        width: processed.width,
        height: processed.height,
        variants: processed.renditions.map((r) => ({
          file: r.file,
          width: r.width,
          mime: r.mime,
          bytes: r.data.length,
        })),
        createdBy: input.createdBy,
      })
      .onConflictDoNothing({ target: mediaAssets.sha256 })
      .returning();
    if (!row) {
      // A concurrent upload of the same bytes won the race: return theirs.
      const [won] = await db.select().from(mediaAssets).where(eq(mediaAssets.sha256, sha)).limit(1);
      return { asset: toAsset(won!), created: false };
    }
    try {
      for (const r of processed.renditions) await this.store.put(`${row.id}/${r.file}`, r.data);
    } catch (error) {
      // Do not leave a catalogue row pointing at files that were never written.
      await db.delete(mediaAssets).where(eq(mediaAssets.id, row.id));
      await this.store.deletePrefix(row.id).catch(() => undefined);
      throw error;
    }
    return { asset: toAsset(row), created: true };
  }

  async list(
    db: DbOrTx,
    opts: { limit?: number; before?: string } = {},
  ): Promise<{ items: MediaAsset[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(
        opts.before
          ? lt(
              sql`(${mediaAssets.createdAt}, ${mediaAssets.id})`,
              sql`(SELECT created_at, id FROM media_assets WHERE id = ${opts.before})`,
            )
          : undefined,
      )
      .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toAsset),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async setAlt(db: DbOrTx, id: string, alt: string): Promise<boolean> {
    const r = await db
      .update(mediaAssets)
      .set({ alt: alt.slice(0, 300) })
      .where(eq(mediaAssets.id, id))
      .returning({ id: mediaAssets.id });
    return r.length > 0;
  }

  /** Delete the asset and its files. Pages that still reference its URL will show a broken image: the console warns. */
  async remove(db: DbOrTx, id: string): Promise<boolean> {
    const r = await db
      .delete(mediaAssets)
      .where(eq(mediaAssets.id, id))
      .returning({ id: mediaAssets.id });
    if (r.length === 0) return false;
    await this.store.deletePrefix(id);
    return true;
  }

  /** The bytes of one rendition, for the serving route. Only files listed in the catalogue are served. */
  async read(
    db: DbOrTx | ReplicaDb,
    id: string,
    file: string,
  ): Promise<{ data: Buffer; mime: string } | null> {
    const [row] = await db
      .select({ variants: mediaAssets.variants })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id))
      .limit(1);
    const v = (row?.variants as MediaVariant[] | undefined)?.find((x) => x.file === file);
    if (!v) return null;
    const data = await this.store.get(`${id}/${file}`);
    return data ? { data, mime: v.mime } : null;
  }
}
