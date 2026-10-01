import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The admin console in a real browser: sign in, every screen is accessible (light and dark), and the page builder
 * edits, saves, previews and publishes.
 *   SOLD_E2E_URL=… SOLD_E2E_OWNER_EMAIL=… SOLD_E2E_OWNER_PASSWORD=… pnpm --filter @sold/web test:e2e
 */
const base = process.env['SOLD_E2E_URL'];
const email = process.env['SOLD_E2E_OWNER_EMAIL'];
const password = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && email && password ? describe : describe.skip;
const shots = process.env['SOLD_E2E_SHOTS'];
// Server work (scrypt, a first dev compile) legitimately takes longer than expect.poll's 1 s default.
const SLOW = { timeout: 15_000 };

let browser: Browser;
beforeAll(async () => {
  if (!base) return;
  browser = await chromium.launch({
    executablePath:
      process.env['SOLD_E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
});
afterAll(async () => browser?.close());

async function signIn(scheme: 'light' | 'dark'): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    colorScheme: scheme,
    viewport: { width: 1360, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/admin/login`);
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${base}/admin`);
  return { ctx, page };
}

run('admin console', () => {
  it('redirects anonymous visitors to the sign-in page', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await page.goto(`${base}/admin/orders`);
    expect(page.url()).toBe(`${base}/admin/login`);
    expect(res?.status()).toBe(200);
    await ctx.close();
  });

  it('rejects a wrong password with a plain message', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/admin/login`);
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect

      .poll(() => page.locator('.alert').textContent(), SLOW)
      .toContain('Incorrect email or password');
    await ctx.close();
  });

  it('has no WCAG 2.2 AA violations on any screen, light and dark', async () => {
    const violations: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      const { ctx, page } = await signIn(scheme);
      const paths = [
        '/admin',
        '/admin/products',
        '/admin/products/new',
        '/admin/orders',
        '/admin/pages',
        '/admin/promotions',
        '/admin/theme',
        '/admin/users',
        '/admin/flags',
        '/admin/developers',
        '/admin/extensions',
        '/admin/audit',
      ];
      for (const path of paths) {
        await page.goto(base + path, { waitUntil: 'networkidle' });
        if (shots)
          await page.screenshot({ path: `${shots}/${scheme}${path.replace(/\//g, '_')}.png` });
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        for (const v of r.violations)
          violations.push(
            `${scheme} ${path}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`,
          );
      }
      await ctx.close();
    }
    expect(violations).toEqual([]);
  });

  it('page builder: add a block, edit it, save, preview, publish, then serve it live', async () => {
    const { ctx, page } = await signIn('light');
    const path = `/ui-${Math.random().toString(36).slice(2, 7)}`;
    await page.goto(`${base}/admin/pages`);
    await page.getByLabel('Title').fill('UI test page');
    await page.getByLabel('Path').fill(path);
    await page.getByRole('button', { name: 'Create and edit' }).click();
    await page.waitForURL(/\/admin\/pages\/[0-9a-f-]{36}$/);

    // Regression guard: the storefront theme's global CSS must never reach the console (it once restyled the editor).
    const fonts = await page.evaluate(
      () => getComputedStyle(document.querySelector('h1')!).fontFamily,
    );
    expect(fonts).not.toContain('Fraunces');
    await page.getByRole('button', { name: /^Text/ }).click();
    await page.getByLabel('Heading').fill('Hello from the builder');
    await page.getByLabel('Body').fill('First paragraph.\n\nSecond paragraph.');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect
      .poll(() => page.getByRole('status').textContent(), SLOW)
      .toContain('Saved as version 2');

    const frame = page.frameLocator('iframe[title="Page preview"]');
    await expect
      .poll(async () => (await frame.locator('h1').first().textContent()) ?? '', {
        timeout: 15_000,
      })
      .toContain('Hello from the builder');

    if (shots) await page.screenshot({ path: `${shots}/builder.png` });
    await page.getByRole('button', { name: /^Publish v2/ }).click();
    await expect
      .poll(() => page.getByRole('status').textContent(), SLOW)
      .toContain('Version 2 is live');
    const live = await ctx.request.get(`${base}/en-au${path}`);
    expect(live.status()).toBe(200);
    expect(await live.text()).toContain('Hello from the builder');

    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .exclude('iframe')
      .analyze();
    expect(a11y.violations.map((v) => v.id)).toEqual([]);
    await ctx.close();
  });

  it('a signed-out browser cannot read a draft preview', async () => {
    const res = await fetch(`${base}/en-au/preview/00000000-0000-7000-8000-000000000000`);
    expect(res.status).toBe(404);
  });
});
