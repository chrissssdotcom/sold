import { openMigrated } from '@sold/commerce/testing';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaRejected } from './pipeline';
import { MediaService } from './service';
import { MemoryStore, type MediaStore } from './store';

let testDb: TestDatabase;
let db: Db;
beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 5);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const img = (w: number, h: number, r: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 10, b: 10 } } })
    .jpeg()
    .toBuffer();

describe('MediaService', () => {
  it('stores renditions, dedupes identical bytes (also under concurrency), and serves only catalogued files', async () => {
    const store = new MemoryStore();
    const svc = new MediaService(store);
    const data = await img(1500, 1000, 90);
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map(() => svc.upload(db.primary, { data, name: 'photo.jpg', createdBy: 't' })),
    );
    expect(new Set([a!.asset.id, b!.asset.id, c!.asset.id]).size).toBe(1);
    expect([a, b, c].filter((x) => x!.created)).toHaveLength(1);
    const { asset } = a!;
    expect(asset.url).toMatch(new RegExp(`^/media/${asset.id}/1024\\.webp$`));
    expect(asset.variants.map((v) => v.file)).toEqual(
      ['orig.jpg', '320.webp', '640.webp', '1024.webp', '1600.webp'].filter(
        (f) => f !== '1600.webp',
      ),
    );
    const got = await svc.read(db.primary, asset.id, '640.webp');
    expect(got!.mime).toBe('image/webp');
    expect((await sharp(got!.data).metadata()).width).toBe(640);
    expect(await svc.read(db.primary, asset.id, '999.webp')).toBeNull(); // not catalogued
    expect(
      await svc.read(db.primary, '00000000-0000-7000-8000-000000000000', '640.webp'),
    ).toBeNull();
  });

  it('rejects bad input before anything is stored or catalogued', async () => {
    const store = new MemoryStore();
    const svc = new MediaService(store);
    const before = (
      await db.primary.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM media_assets`)
    ).rows[0]!.n;
    await expect(
      svc.upload(db.primary, { data: Buffer.from('<svg/>'), name: 'x.svg', createdBy: 't' }),
    ).rejects.toBeInstanceOf(MediaRejected);
    expect(store.files.size).toBe(0);
    expect(
      (await db.primary.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM media_assets`))
        .rows[0]!.n,
    ).toBe(before);
  });

  it('rolls the catalogue row back if storing the files fails', async () => {
    const failing: MediaStore = {
      put: async () => Promise.reject(new Error('disk full')),
      get: async () => null,
      deletePrefix: async () => undefined,
    };
    const svc = new MediaService(failing);
    const data = await img(400, 300, 20);
    await expect(svc.upload(db.primary, { data, name: 'f.jpg', createdBy: 't' })).rejects.toThrow(
      'disk full',
    );
    const left = await db.primary.execute(
      sql`SELECT 1 FROM media_assets WHERE original_name = 'f.jpg'`,
    );
    expect(left.rows).toHaveLength(0);
    // And a retry with a working store succeeds (the failed attempt did not poison the dedupe key).
    const ok = await new MediaService(new MemoryStore()).upload(db.primary, {
      data,
      name: 'f.jpg',
      createdBy: 't',
    });
    expect(ok.created).toBe(true);
  });

  it('lists newest first with a cursor, edits alt text, and deletes the files with the row', async () => {
    const store = new MemoryStore();
    const svc = new MediaService(store);
    const made = [];
    for (let i = 0; i < 4; i++)
      made.push(
        (
          await svc.upload(db.primary, {
            data: await img(200 + i, 150, 100 + i * 20),
            name: `p${i}.jpg`,
            createdBy: 't',
          })
        ).asset,
      );
    const p1 = await svc.list(db.primary, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await svc.list(db.primary, { limit: 2, before: p1.nextCursor! });
    expect(p2.items.some((x) => p1.items.some((y) => y.id === x.id))).toBe(false);
    const target = made[0]!;
    expect(await svc.setAlt(db.primary, target.id, 'A red candle')).toBe(true);
    expect(
      (await svc.list(db.primary, { limit: 100 })).items.find((x) => x.id === target.id)!.alt,
    ).toBe('A red candle');
    expect([...store.files.keys()].some((k) => k.startsWith(target.id))).toBe(true);
    expect(await svc.remove(db.primary, target.id)).toBe(true);
    expect([...store.files.keys()].some((k) => k.startsWith(target.id))).toBe(false);
    expect(await svc.remove(db.primary, target.id)).toBe(false);
  });
});
