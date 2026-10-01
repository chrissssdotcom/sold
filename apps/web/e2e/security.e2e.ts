import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;

const apiDir = join(__dirname, '..', 'src', 'app', 'api', 'admin');
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === 'route.ts' ? [p] : [];
  });
}
/** `admin/products/[id]/route.ts` -> `/api/admin/products/<placeholder>` */
const urlOf = (file: string) =>
  '/api/admin/' +
  relative(apiDir, file)
    .split(sep)
    .slice(0, -1)
    .map((s) => (s.startsWith('[') ? '00000000-0000-7000-8000-000000000000' : s))
    .join('/');

run('security', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath:
        process.env['SOLD_E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    });
  });
  afterAll(async () => browser?.close());

  it('every staff API route refuses anonymous callers on every method (never 2xx/5xx)', async () => {
    const bad: string[] = [];
    for (const file of routes(apiDir)) {
      const url = urlOf(file);
      if (url.startsWith('/api/admin/auth/')) continue; // session entry points, covered by identity e2e
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(base + url, {
          method,
          headers: { origin: base!, 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { body: '{}' }),
        });
        // 401 anonymous; 405 when the route has no such method. Anything else would be an unprotected handler.
        if (![401, 405].includes(res.status)) bad.push(`${method} ${url} -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('console and storefront render under CSP with zero violations', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if (/content security policy|refused to/i.test(m.text())) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/en-au`, { waitUntil: 'networkidle' });
    await page.goto(`${base}/admin/login`, { waitUntil: 'networkidle' });
    await page.getByLabel('Email').fill(ownerEmail!);
    await page.getByLabel('Password').fill(ownerPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(`${base}/admin`);
    for (const p of ['/admin', '/admin/products', '/admin/pages', '/admin/media', '/admin/theme'])
      await page.goto(`${base}${p}`, { waitUntil: 'networkidle' });
    expect(problems).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('console responses carry a per-request nonce; storefront responses do not', async () => {
    const a = (await fetch(`${base}/admin/login`)).headers.get('content-security-policy');
    const b = (await fetch(`${base}/admin/login`)).headers.get('content-security-policy');
    expect(a).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(a).not.toBe(b);
    expect((await fetch(`${base}/en-au`)).headers.get('content-security-policy')).not.toContain(
      'nonce-',
    );
  });
});
