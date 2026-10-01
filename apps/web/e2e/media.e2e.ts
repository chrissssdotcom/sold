import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright-core';
import { deflateSync, crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;

/** A valid w x h RGB PNG made from scratch (no image library needed in the e2e package). `seed` makes each one unique. */
function png(w: number, h: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = (x * 4 + seed) & 255;
    row[2 + x * 3] = (seed * 7) & 255;
    row[3 + x * 3] = 120;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const jar = new Map<string, string>();
async function call(
  method: string,
  path: string,
  body?: BodyInit,
  headers: Record<string, string> = {},
  auth = true,
) {
  const cookie = auth ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { origin: base! }),
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    jar.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
  return res;
}

run('media library', () => {
  let browser: Browser;
  beforeAll(async () => {
    const r = await call(
      'POST',
      '/api/admin/auth/login',
      JSON.stringify({ email: ownerEmail, password: ownerPassword }),
      { 'content-type': 'application/json' },
    );
    expect(r.status).toBe(200);
    browser = await chromium.launch({
      executablePath:
        process.env['SOLD_E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    });
  });
  afterAll(async () => browser?.close());

  it('uploads, re-encodes, dedupes and serves with immutable caching and no sniffing', async () => {
    const seed = Math.floor(Math.random() * 200);
    const file = png(900, 600, seed);
    const up = await call('POST', '/api/admin/media?name=holiday.png', file, {
      'content-type': 'image/png',
    });
    expect(up.status).toBe(201);
    const { asset } = (await up.json()) as {
      asset: { id: string; url: string; variants: { file: string }[] };
    };
    expect(asset.variants.map((v) => v.file)).toEqual(['orig.png', '320.webp', '640.webp']);
    const again = await call('POST', '/api/admin/media?name=copy.png', file, {
      'content-type': 'image/png',
    });
    expect(again.status).toBe(200); // same bytes: same asset
    expect(((await again.json()) as { asset: { id: string } }).asset.id).toBe(asset.id);

    const served = await fetch(`${base}${asset.url}`); // public: no cookie
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(
      Buffer.from(await served.arrayBuffer())
        .subarray(8, 12)
        .toString(),
    ).toBe('WEBP');
  });

  it('refuses SVG, scripts dressed as images, empty bodies, and unauthenticated or cross-site uploads', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(
      (await call('POST', '/api/admin/media?name=x.svg', svg, { 'content-type': 'image/svg+xml' }))
        .status,
    ).toBe(422);
    expect(
      (
        await call(
          'POST',
          '/api/admin/media?name=x.png',
          Buffer.from('<?php system($_GET[1]); ?>'),
          { 'content-type': 'image/png' },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await call('POST', '/api/admin/media?name=x.png', Buffer.alloc(0), {
          'content-type': 'image/png',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await call(
          'POST',
          '/api/admin/media?name=x.png',
          png(10, 10, 1),
          { 'content-type': 'image/png' },
          false,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call('POST', '/api/admin/media?name=x.png', png(10, 10, 2), {
          'content-type': 'image/png',
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
  });

  it('only serves what is catalogued, and never anything outside the media directory', async () => {
    for (const p of [
      '/media/00000000-0000-7000-8000-000000000000/640.webp',
      '/media/not-an-id/640.webp',
      '/media/..%2f..%2fetc/passwd',
      '/media/00000000-0000-7000-8000-000000000000/..%2fx.webp',
    ])
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
  });

  it('the library page works in a browser: upload through the file input, alt text, accessibility', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/admin/login`);
    await page.getByLabel('Email').fill(ownerEmail!);
    await page.getByLabel('Password').fill(ownerPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${base}/admin`);
    await page.goto(`${base}/admin/media`, { waitUntil: 'networkidle' });
    const name = `ui-${Date.now()}.png`;
    await page.locator('input[type=file]').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: png(500, 300, Math.floor(Math.random() * 250)),
    });
    await page.getByText(name).first().waitFor({ timeout: 20_000 });
    const alt = page.getByLabel(`Alt text for ${name}`);
    await alt.fill('A gradient test card');
    await alt.blur();
    await page.locator('.toast', { hasText: 'Alt text saved' }).waitFor({ timeout: 10_000 });
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    await ctx.close();
  });
});
