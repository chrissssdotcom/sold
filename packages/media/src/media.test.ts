import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MediaRejected, processImage } from './pipeline';
import { LocalDiskStore } from './store';

const solid = (w: number, h: number, channels: 3 | 4 = 3) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels,
      background: channels === 4 ? { r: 200, g: 30, b: 30, alpha: 0.5 } : { r: 200, g: 30, b: 30 },
    },
  });
const rejected = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e: unknown) => e,
  )) as MediaRejected | null;

describe('processImage', () => {
  it('re-encodes a JPEG, makes WebP renditions up to its own width, and never upscales', async () => {
    const out = await processImage(await solid(1200, 800).jpeg().toBuffer());
    expect(out.mime).toBe('image/jpeg');
    expect([out.width, out.height]).toEqual([1200, 800]);
    expect(out.renditions.map((r) => r.file)).toEqual([
      'orig.jpg',
      '320.webp',
      '640.webp',
      '1024.webp',
    ]);
    for (const r of out.renditions.slice(1))
      expect((await sharp(r.data).metadata()).format).toBe('webp');
    expect((await sharp(out.renditions[3]!.data).metadata()).width).toBe(1024);
  });

  it('a small image gets one WebP at its own size', async () => {
    const out = await processImage(await solid(100, 60).png().toBuffer());
    expect(out.renditions.map((r) => r.file)).toEqual(['orig.png', '100.webp']);
  });

  it('keeps PNG transparency', async () => {
    const out = await processImage(await solid(400, 300, 4).png().toBuffer());
    expect((await sharp(out.renditions[0]!.data).metadata()).hasAlpha).toBe(true);
    expect((await sharp(out.renditions[1]!.data).metadata()).hasAlpha).toBe(true);
  });

  it('applies EXIF orientation and then strips metadata (no GPS or camera data survives)', async () => {
    const withExif = await solid(600, 300)
      .jpeg()
      .withExif({
        IFD0: { Make: 'SecretCam', Software: 'PrivateSoft' },
        IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 0/1' },
      })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();
    const out = await processImage(withExif);
    expect([out.width, out.height]).toEqual([300, 600]); // rotated upright
    for (const r of out.renditions) {
      const m = await sharp(r.data).metadata();
      expect(m.exif, r.file).toBeUndefined();
      expect(r.data.includes(Buffer.from('SecretCam')), r.file).toBe(false);
    }
  });

  it('discards anything appended to an image (polyglot payloads do not survive re-encoding)', async () => {
    const evil = Buffer.concat([
      await solid(200, 200).jpeg().toBuffer(),
      Buffer.from('<script>alert(1)</script>PAYLOAD-MARKER'),
    ]);
    const out = await processImage(evil);
    for (const r of out.renditions)
      expect(r.data.includes(Buffer.from('PAYLOAD-MARKER'))).toBe(false);
  });

  it('refuses SVG, text, HTML, empty and truncated files with a plain reason', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    for (const [name, data] of [
      ['svg', svg],
      ['text', Buffer.from('hello')],
      ['html', Buffer.from('<html><script>x</script></html>')],
      ['empty', Buffer.alloc(0)],
      ['truncated', (await solid(500, 500).jpeg().toBuffer()).subarray(0, 300)],
    ] as const) {
      const e = await rejected(processImage(data));
      expect(e, name).toBeInstanceOf(MediaRejected);
    }
    expect((await rejected(processImage(svg)))!.code).toBe('unsupported_type');
    expect((await rejected(processImage(Buffer.alloc(0))))!.code).toBe('too_large');
  });

  it('refuses a decompression bomb: tiny file, enormous pixel count', async () => {
    const bomb = await solid(9000, 9000).png({ compressionLevel: 9 }).toBuffer(); // 81 MP of one colour compresses to almost nothing
    expect(bomb.length).toBeLessThan(2_000_000);
    expect((await rejected(processImage(bomb)))!.code).toBe('too_many_pixels');
  });

  it('refuses oversize uploads', async () => {
    expect((await rejected(processImage(Buffer.alloc(13 * 1024 * 1024, 1))))!.code).toBe(
      'too_large',
    );
  });

  it('turns an animated or still GIF into a PNG still', async () => {
    const gif = await solid(120, 80).gif().toBuffer();
    const out = await processImage(gif);
    expect(out.mime).toBe('image/png');
    expect(out.renditions[0]!.file).toBe('orig.png');
  });
});

describe('LocalDiskStore', () => {
  const id = '01a0f4e7-3f9c-79a3-807b-ce822a32b487';
  it('round-trips, replaces atomically and deletes by prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-'));
    const s = new LocalDiskStore(dir);
    await s.put(`${id}/640.webp`, Buffer.from('a'));
    await s.put(`${id}/640.webp`, Buffer.from('b'));
    expect((await s.get(`${id}/640.webp`))!.toString()).toBe('b');
    expect(await s.get(`${id}/missing.webp`)).toBeNull();
    await s.deletePrefix(id);
    expect(await s.get(`${id}/640.webp`)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses keys that could escape the directory or have the wrong shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-'));
    const s = new LocalDiskStore(dir);
    for (const key of [
      '../etc/passwd',
      `${id}/../../x.webp`,
      `${id}/a/b.webp`,
      '/abs/x.webp',
      `${id}\\x.webp`,
      `${id}/x`,
      `${id}/.hidden.webp`,
      '',
    ]) {
      await expect(s.put(key, Buffer.from('x')), key).rejects.toThrow('invalid media key');
      expect(await s.get(key), key).toBeNull();
    }
    await expect(s.deletePrefix('../..')).rejects.toThrow();
  });
});
