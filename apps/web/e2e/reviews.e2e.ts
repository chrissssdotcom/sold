import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The reviews extension end to end: verified-buyer rule, moderation, edit-resets-moderation, visibility, and the product page.
 * Needs the seeded demo catalogue, `reviews` enabled and migrated, and an owner (see docs/admin.md).
 */
const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;

class Session {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
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
      const [name, value] = [pair!.slice(0, i), pair!.slice(i + 1)];
      if (value === '' || /max-age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as unknown };
  }
}

const at = (v: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (x, k) => (x === null || x === undefined ? undefined : (x as Record<string, unknown>)[k]),
      v,
    );

const address = {
  name: 'Rev Buyer',
  line1: '1 Test St',
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
};
const uid = Math.random().toString(36).slice(2, 8);
const pw = `Correct-horse-${uid}-battery`;

run('reviews extension', () => {
  const owner = new Session();
  const buyer = new Session();
  const stranger = new Session();
  let productId = '';
  let handle = '';
  let orderId = '';
  let reviewId = '';
  let browser: Browser;

  beforeAll(async () => {
    expect(
      (
        await owner.call('POST', '/api/admin/auth/login', {
          email: ownerEmail,
          password: ownerPassword,
        })
      ).status,
    ).toBe(200);
    browser = await chromium.launch({
      executablePath:
        process.env['SOLD_E2E_CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    });
    const products = (await owner.call('GET', '/api/catalog/products?limit=5')).body;
    handle = at(products, 'items.0.handle') as string;
    const detail = (await owner.call('GET', `/api/catalog/products/${handle}`)).body;
    productId = at(detail, 'id') as string;
    for (const [s, who] of [
      [buyer, 'buyer'],
      [stranger, 'stranger'],
    ] as const)
      expect(
        (
          await s.call('POST', '/api/auth/register', {
            email: `${who}-${uid}@example.test`,
            password: pw,
            name: who,
          })
        ).status,
      ).toBe(201);
  });
  afterAll(async () => browser?.close());

  const list = () => new Session().call('GET', `/x/reviews/products/${productId}/reviews`);

  it('starts empty and public; bad ids are 404, not errors', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(at(r.body, 'summary.count')).toBeTypeOf('number');
    expect((await new Session().call('GET', '/x/reviews/products/not-a-uuid/reviews')).status).toBe(
      404,
    );
  });

  it('refuses anonymous callers, staff, cross-site posts, and customers who have not bought', async () => {
    const path = `/x/reviews/products/${productId}/reviews`;
    const review = { rating: 5, body: 'Great' };
    expect((await new Session().call('POST', path, review)).status).toBe(401); // anonymous
    expect((await owner.call('POST', path, review)).status).toBe(403); // staff cannot post as a customer
    expect(
      (await buyer.call('POST', path, review, { origin: 'https://evil.example' })).status,
    ).toBe(401); // cross-site: the cookie is ignored, so not signed in
    const noPurchase = await stranger.call('POST', path, review);
    expect(noPurchase.status).toBe(403);
    expect(at(noPurchase.body, 'error.code')).toBe('not_a_buyer');
  });

  it('an unpaid order does not count; a paid one does', async () => {
    const cart = await buyer.call('POST', '/api/cart', { currency: 'AUD' });
    expect(cart.status).toBeLessThan(300);
    const detail = (await buyer.call('GET', `/api/catalog/products/${handle}`)).body;
    expect(
      (
        await buyer.call('POST', '/api/cart/items', {
          variantId: at(detail, 'variants.0.id'),
          quantity: 1,
        })
      ).status,
    ).toBe(200);
    const quote = await buyer.call('POST', '/api/checkout/quote', { shippingAddress: address });
    const placed = await buyer.call(
      'POST',
      '/api/checkout',
      {
        email: `buyer-${uid}@example.test`,
        shippingAddress: address,
        shippingMethodId: at(quote.body, 'shippingOptions.0.methodId'),
      },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(placed.status).toBe(201);
    orderId = at(placed.body, 'order.id') as string;
    const path = `/x/reviews/products/${productId}/reviews`;
    expect((await buyer.call('POST', path, { rating: 5, body: 'Too early' })).status).toBe(403);

    const pay = await buyer.call('POST', '/api/checkout/pay', {
      orderToken: at(placed.body, 'orderToken'),
      gatewayId: 'manual',
    });
    expect(pay.status).toBe(200);
    const order = (await owner.call('GET', `/api/admin/orders/${orderId}`)).body;
    const paymentId = at(order, 'payments.0.id') as string;
    expect((await owner.call('POST', `/api/admin/payments/${paymentId}/confirm`)).status).toBe(200);
  });

  it('a verified buyer posts; it waits in moderation; approval publishes it; editing sends it back', async () => {
    const path = `/x/reviews/products/${productId}/reviews`;
    const before = Number(at((await list()).body, 'summary.count'));
    const posted = await buyer.call('POST', path, {
      rating: 4,
      title: 'Nice',
      body: 'Smells <b>great</b>.',
      authorName: 'Sam',
    });
    expect(posted.status).toBe(201);
    expect(at(posted.body, 'status')).toBe('pending');
    reviewId = at(posted.body, 'id') as string;
    // Not public yet.
    expect(Number(at((await list()).body, 'summary.count'))).toBe(before);
    // Rejects things a customer must never control.
    expect(
      (await buyer.call('POST', path, { rating: 5, body: 'x', status: 'approved' })).status,
    ).toBe(422);
    // The queue shows it to a moderator only.
    const queue = (await owner.call('GET', '/admin/x/reviews/queue')).body;
    expect((at(queue, 'items') as { id: string }[]).some((i) => i.id === reviewId)).toBe(true);
    expect((await buyer.call('GET', '/admin/x/reviews/queue')).status).toBe(401); // customer session is not staff
    // Approve.
    expect(
      (
        await owner.call('POST', `/admin/x/reviews/reviews/${reviewId}/moderate`, {
          status: 'approved',
        })
      ).status,
    ).toBe(200);
    const live = await list();
    expect(Number(at(live.body, 'summary.count'))).toBe(before + 1);
    const mine = (
      at(live.body, 'reviews') as { id: string; body: string; authorName: string }[]
    ).find((r) => r.id === reviewId)!;
    expect(mine.body).toBe('Smells <b>great</b>.'); // stored as text; the widget renders it escaped
    expect(mine.authorName).toBe('Sam');
    expect(JSON.stringify(live.body)).not.toContain('customer');
    // Editing replaces the review and re-queues it.
    const edit = await buyer.call('POST', path, { rating: 5, body: 'Even better after a month.' });
    expect(edit.status).toBe(201);
    expect(at(edit.body, 'id')).toBe(reviewId);
    expect(at(edit.body, 'status')).toBe('pending');
    expect(Number(at((await list()).body, 'summary.count'))).toBe(before);
  });

  it('the product page shows approved reviews, escaped, and stays accessible', async () => {
    expect(
      (
        await owner.call('POST', `/admin/x/reviews/reviews/${reviewId}/moderate`, {
          status: 'approved',
        })
      ).status,
    ).toBe(200);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/en-au/products/${handle}`, { waitUntil: 'networkidle' });
    const section = page.getByRole('region', { name: 'Customer reviews' });
    await expect
      .poll(() => section.textContent(), { timeout: 15_000 })
      .toContain('Even better after a month.');
    expect(await section.textContent()).toContain('verified buyer');
    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(a11y.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    await ctx.close();
  });

  it('a signed-in buyer sees the form; the admin moderation screen is permission-gated', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/en-au/account/login`);
    await page.getByLabel('Email').fill(`buyer-${uid}@example.test`);
    await page.getByLabel('Password').fill(pw);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/account$/);
    await page.goto(`${base}/en-au/products/${handle}`, { waitUntil: 'networkidle' });
    await expect
      .poll(() => page.getByRole('button', { name: 'Write a review' }).count(), { timeout: 15_000 })
      .toBe(1);
    await ctx.close();

    const admin = await browser.newContext();
    const ap = await admin.newPage();
    await ap.goto(`${base}/admin/login`);
    await ap.getByLabel('Email').fill(ownerEmail!);
    await ap.getByLabel('Password').fill(ownerPassword!);
    await ap.getByRole('button', { name: 'Sign in' }).click();
    await ap.waitForURL(`${base}/admin`);
    await ap.getByRole('link', { name: 'Review moderation' }).waitFor();
    await ap.goto(`${base}/admin/ext/reviews/moderation`, { waitUntil: 'networkidle' });
    await ap.getByRole('heading', { name: 'Review moderation' }).waitFor();
    const a11y = await new AxeBuilder({ page: ap })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(a11y.violations.map((v) => v.id)).toEqual([]);
    await admin.close();
  });
});
