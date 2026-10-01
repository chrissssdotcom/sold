import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Cookie consent and the TikTok pixel: nothing optional runs before a choice, rejecting keeps it off, accepting turns it on,
 * a Global Privacy Control signal is honoured, and the choice reaches the order. Needs the seeded catalogue.
 */
const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;
const PIXEL = 'TESTPIXEL01';

interface Reply {
  order: { id: string };
  shippingOptions: { methodId: string }[];
}

let browser: Browser;
let handle = '';
const cookieJar = new Map<string, string>();

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const cookie = [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : { origin: base! }),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    cookieJar.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/** A context that records (and blackholes) every request to TikTok. */
async function trackedContext(opts: Parameters<Browser['newContext']>[0] = {}) {
  const ctx = await browser.newContext(opts);
  const hits: string[] = [];
  await ctx.route(/tiktok\.com/, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  return { ctx, hits };
}
const consentCookie = async (ctx: BrowserContext) =>
  (await ctx.cookies()).find((c) => c.name === 'sold_consent');
const decode = (v: string | undefined) =>
  v ? (JSON.parse(decodeURIComponent(v)) as Record<string, unknown>) : null;
const settle = (page: Page) => page.waitForTimeout(1500);

run('cookie consent and the TikTok pixel', () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath:
        process.env['SOLD_E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    });
    expect(
      (await api('POST', '/api/admin/auth/login', { email: ownerEmail, password: ownerPassword }))
        .status,
    ).toBe(200);
    const products = await api('GET', '/api/catalog/products?limit=3');
    handle = (products.body['items'] as { handle: string }[])[0]!.handle;
  });
  afterAll(async () => browser?.close());

  it('settings: validated, secrets are write-only, and permissioned', async () => {
    expect(
      (
        await api('PUT', '/api/admin/extensions/tiktok-social/settings', {
          pixelCode: 'lowercase!',
        })
      ).status,
    ).toBe(422);
    expect(
      (await api('PUT', '/api/admin/extensions/tiktok-social/settings', { nope: 'x' })).status,
    ).toBe(422);
    expect((await api('PUT', '/api/admin/extensions/no-such-ext/settings', {})).status).toBe(404);
    const saved = await api('PUT', '/api/admin/extensions/tiktok-social/settings', {
      pixelCode: PIXEL,
      accessToken: 'super-secret-token-123',
      serverEvents: false,
    });
    expect(saved.status).toBe(200);
    const form = (await api('GET', '/api/admin/extensions/tiktok-social/settings')).body[
      'fields'
    ] as { key: string; secret: boolean; hasValue: boolean; value?: unknown }[];
    const token = form.find((f) => f.key === 'accessToken')!;
    expect(token).toMatchObject({ secret: true, hasValue: true });
    expect(token.value).toBeUndefined();
    expect(JSON.stringify(form)).not.toContain('super-secret-token-123');
    expect(form.find((f) => f.key === 'pixelCode')!.value).toBe(PIXEL);
    // The public config route exposes the pixel code and nothing else.
    const pub = await fetch(`${base}/x/tiktok-social/config`);
    expect(await pub.json()).toEqual({ pixelCode: PIXEL });
  });

  it('before any choice: banner shown, nothing sent to TikTok; reject keeps it that way and is remembered', async () => {
    const { ctx, hits } = await trackedContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/en-au/products/${handle}`, { waitUntil: 'networkidle' });
    const banner = page.getByRole('region', { name: 'Cookie preferences' });
    await banner.waitFor();
    await settle(page);
    expect(hits).toEqual([]);
    expect(await consentCookie(ctx)).toBeUndefined();

    await banner.getByRole('button', { name: 'Reject optional' }).click();
    await settle(page);
    expect(decode((await consentCookie(ctx))?.value)).toMatchObject({ a: 0, m: 0, s: 'user' });
    await page.reload({ waitUntil: 'networkidle' });
    await settle(page);
    expect(await banner.count()).toBe(0); // remembered
    expect(hits).toEqual([]);
    await ctx.close();
  });

  it('accepting turns the pixel on (and only then); the footer link reopens the banner', async () => {
    const { ctx, hits } = await trackedContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/en-au/products/${handle}`, { waitUntil: 'networkidle' });
    const banner = page.getByRole('region', { name: 'Cookie preferences' });
    await banner.waitFor();
    expect(hits).toEqual([]);
    await banner.getByRole('button', { name: 'Accept all' }).click();
    await expect
      .poll(() => hits.some((u) => u.includes(`sdkid=${PIXEL}`)), { timeout: 10_000 })
      .toBe(true);
    expect(decode((await consentCookie(ctx))?.value)).toMatchObject({ a: 1, m: 1 });
    await page.getByRole('button', { name: 'Cookie preferences' }).click();
    await page.getByRole('region', { name: 'Cookie preferences' }).waitFor();
    await ctx.close();
  });

  it('honours a Global Privacy Control signal: marketing stays off and the shopper is not nagged', async () => {
    const { ctx, hits } = await trackedContext({ extraHTTPHeaders: { 'Sec-GPC': '1' } });
    await ctx.addInitScript(() =>
      Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }),
    );
    const page = await ctx.newPage();
    await page.goto(`${base}/en-au/products/${handle}`, { waitUntil: 'networkidle' });
    await settle(page);
    expect(await page.getByRole('region', { name: 'Cookie preferences' }).count()).toBe(0);
    expect(decode((await consentCookie(ctx))?.value)).toMatchObject({ m: 0, s: 'gpc' });
    expect(hits).toEqual([]);
    await ctx.close();
  });

  it('the banner is accessible in light and dark', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { ctx } = await trackedContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(`${base}/en-au`, { waitUntil: 'networkidle' });
      await page.getByRole('region', { name: 'Cookie preferences' }).waitFor();
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
        .analyze();
      expect(r.violations.map((v) => `${scheme}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual(
        [],
      );
      await ctx.close();
    }
  });

  it('the choice is recorded on the order, from the cookie only (never from the request body)', async () => {
    const reg = await fetch(`${base}/api/catalog/products/${handle}`);
    const variantId = ((await reg.json()) as { variants: { id: string }[] }).variants[0]!.id;
    const address = {
      name: 'C',
      line1: '1 Test St',
      city: 'Sydney',
      region: 'NSW',
      postalCode: '2000',
      country: 'AU',
    };
    async function order(consentCookieValue: string | null, bodyConsent?: unknown) {
      const jar = new Map<string, string>();
      const call = async (
        method: string,
        path: string,
        body?: unknown,
        extra: Record<string, string> = {},
      ) => {
        const cookie = [
          ...jar,
          ...(consentCookieValue ? [['sold_consent', consentCookieValue] as const] : []),
        ]
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
        const res = await fetch(base + path, {
          method,
          headers: {
            ...(cookie ? { cookie } : {}),
            'content-type': 'application/json',
            origin: base!,
            ...extra,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        for (const c of res.headers.getSetCookie?.() ?? []) {
          const [pair] = c.split(';');
          const i = pair!.indexOf('=');
          jar.set(pair!.slice(0, i), pair!.slice(i + 1));
        }
        return { status: res.status, body: (await res.json()) as Reply };
      };
      expect((await call('POST', '/api/cart', { currency: 'AUD' })).status).toBeLessThan(300);
      expect((await call('POST', '/api/cart/items', { variantId, quantity: 1 })).status).toBe(200);
      const quote = await call('POST', '/api/checkout/quote', { shippingAddress: address });
      const placed = await call(
        'POST',
        '/api/checkout',
        {
          email: `consent-${Math.random().toString(36).slice(2, 8)}@example.test`,
          shippingAddress: address,
          shippingMethodId: quote.body['shippingOptions'][0].methodId,
          ...(bodyConsent ? { consent: bodyConsent } : {}),
        },
        { 'idempotency-key': crypto.randomUUID() },
      );
      return placed;
    }
    const yes = encodeURIComponent(
      JSON.stringify({ a: 1, m: 1, t: Math.floor(Date.now() / 1000), s: 'user' }),
    );
    const consented = await order(yes);
    expect(consented.status).toBe(201);
    expect(
      (await api('GET', `/api/admin/orders/${consented.body['order'].id}`)).body['consent'],
    ).toEqual({ analytics: true, marketing: true });

    const none = await order(null);
    expect(
      (await api('GET', `/api/admin/orders/${none.body['order'].id}`)).body['consent'],
    ).toEqual({ analytics: false, marketing: false });

    // A client cannot claim consent in the body: the request is refused outright (strict schema), and nothing is granted.
    const forged = await order(null, { analytics: true, marketing: true });
    expect(forged.status).toBe(422);
  });
});
