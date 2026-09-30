import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-browser storefront tests. They need a running server on a SEEDED database:
 *   pnpm --filter @sold/web seed:demo && pnpm --filter @sold/web dev
 *   SOLD_E2E_URL=http://localhost:3000 pnpm --filter @sold/web test:e2e
 * Skipped when SOLD_E2E_URL is unset. `SOLD_E2E_CHROMIUM` overrides the browser binary.
 */
const base = process.env['SOLD_E2E_URL'];
const run = base ? describe : describe.skip;
let browser: Browser;

beforeAll(async () => {
  if (!base) return;
  browser = await chromium.launch({
    executablePath:
      process.env['SOLD_E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
});
afterAll(async () => browser?.close());

run('storefront', () => {
  it('has no WCAG 2.2 AA violations on key pages, light and dark', async () => {
    const pages = [
      '/en-au',
      '/en-au/products',
      '/en-au/products/ember-candle',
      '/en-au/cart',
      '/en-au/checkout',
      '/en-au/about',
    ];
    const violations: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme });
      for (const path of pages) {
        const page = await ctx.newPage();
        await page.goto(base + path, { waitUntil: 'networkidle' });
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        violations.push(
          ...r.violations.map((v) => `${scheme} ${path}: ${v.id} (${v.nodes.length})`),
        );
        await page.close();
      }
      await ctx.close();
    }
    expect(violations).toEqual([]);
  }, 180_000);

  it('a shopper can add to bag, apply a coupon, check out and see the order', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/en-au/products/ember-candle`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add to bag' }).click();
    await page.waitForSelector('dialog[open]');
    await page.getByLabel('Discount code').fill('welcome10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByText('Welcome 10%').waitFor();
    await page.getByRole('link', { name: 'Checkout' }).click();
    await page.waitForURL('**/checkout');
    await page.getByLabel('Email').fill('e2e@example.com');
    await page.getByLabel('Full name').fill('E2E Shopper');
    await page.getByLabel('Address', { exact: true }).fill('1 George St');
    await page.getByLabel('City / suburb').fill('Sydney');
    await page.getByLabel('State / region').fill('NSW');
    await page.getByLabel('Postcode').fill('2000');
    await page.getByRole('radio', { name: /Standard/ }).waitFor();
    await page.getByRole('button', { name: /Place order/ }).click();
    await page.waitForURL('**/order/**', { timeout: 30_000 });
    await page.getByRole('heading', { name: 'Thank you!' }).waitFor({ state: 'visible' });
    await page.getByText(/Order #\d+/).waitFor({ state: 'visible' });
    // The bag is empty again after the order.
    await page.goto(`${base}/en-au/cart`, { waitUntil: 'networkidle' });
    await page.getByText('Your bag is empty').first().waitFor({ state: 'visible' });
    await ctx.close();
  }, 90_000);

  it('serves each market in its own currency, and a sold-out product cannot be bought', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/en-us/products/ember-candle`, { waitUntil: 'networkidle' });
    await page
      .getByText(/\$31\.99|\$30\.99|\$32\.99/)
      .first()
      .waitFor({ state: 'visible' });
    await page.goto(`${base}/en-au/products/still-vase`, { waitUntil: 'networkidle' });
    expect(await page.getByRole('button', { name: 'Sold out' }).isDisabled()).toBe(true);
    await ctx.close();
  }, 60_000);

  it('unknown paths and locales are 404, and the cart API refuses a forged cart id', async () => {
    const ctx = await browser.newContext();
    expect((await ctx.request.get(`${base}/en-au/nope`)).status()).toBe(404);
    expect((await ctx.request.get(`${base}/xx-yy/products`)).status()).toBe(404);
    const forged = await ctx.request.post(`${base}/api/cart/items`, {
      data: { variantId: '00000000-0000-7000-8000-000000000000', quantity: 1 },
      headers: { cookie: 'sold_cart=00000000-0000-7000-8000-000000000000.AAAA' },
    });
    expect(forged.status()).toBe(404);
    await ctx.close();
  });
});
