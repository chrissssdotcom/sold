import { describe, expect, it } from 'vitest';

/**
 * Customer accounts over HTTP: register, a signed-in checkout is linked to the account, a guest checkout is not,
 * and one customer cannot see another's orders.
 *   SOLD_E2E_URL=http://localhost:3000 pnpm --filter @sold/web test:e2e   (needs the seeded demo catalogue)
 */
const base = process.env['SOLD_E2E_URL'];
const run = base ? describe : describe.skip;

class Browserish {
  jar = new Map<string, string>();
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.jar.size ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method === 'GET' ? {} : { origin: base! }),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (value === '' || /max-age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as unknown };
  }
}

function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v === null || v === undefined ? undefined : (v as Record<string, unknown>)[k]),
      value,
    );
}

const address = {
  name: 'Test Buyer',
  line1: '1 Test St',
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
};

async function placeOrder(b: Browserish, email: string): Promise<string> {
  expect((await b.call('POST', '/api/cart', { currency: 'AUD' })).status).toBeLessThan(300);
  const products = (await b.call('GET', '/api/catalog/products?limit=5')).body;
  const first = at(products, 'items.0.handle') as string;
  const detail = (await b.call('GET', `/api/catalog/products/${first}`)).body;
  const vid = at(detail, 'variants.0.id') as string;
  expect((await b.call('POST', '/api/cart/items', { variantId: vid, quantity: 1 })).status).toBe(
    200,
  );
  const quote = await b.call('POST', '/api/checkout/quote', { shippingAddress: address });
  expect(quote.status).toBe(200);
  const method = at(quote.body, 'shippingOptions.0.methodId') as string;
  const placed = await b.call(
    'POST',
    '/api/checkout',
    { email, shippingAddress: address, shippingMethodId: method },
    { 'idempotency-key': crypto.randomUUID() },
  );
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return at(placed.body, 'order.id') as string;
}

run('customer accounts', () => {
  const uid = Math.random().toString(36).slice(2, 8);
  const password = `Correct-horse-${uid}-battery`;

  it('registers, signs in, and sees orders placed while signed in (not guest orders)', async () => {
    const alice = new Browserish();
    const email = `alice-${uid}@example.test`;
    const reg = await alice.call('POST', '/api/auth/register', { email, password, name: 'Alice' });
    expect(reg.status).toBe(201);
    expect(
      ((await alice.call('GET', '/api/auth/me')).body as { user: { email: string } }).user.email,
    ).toBe(email);

    const orderId = await placeOrder(alice, email);
    const mine = (await alice.call('GET', '/api/account/orders')).body;
    expect((at(mine, 'orders') as { id: string }[]).map((o) => o.id)).toContain(orderId);

    // A guest buying with the same email is NOT linked to the account.
    const guest = new Browserish();
    const guestOrder = await placeOrder(guest, email);
    const after = (await alice.call('GET', '/api/account/orders')).body;
    expect((at(after, 'orders') as { id: string }[]).map((o) => o.id)).not.toContain(guestOrder);
  });

  it("one customer cannot see another's orders; anonymous gets 401", async () => {
    const bob = new Browserish();
    await bob.call('POST', '/api/auth/register', {
      email: `bob-${uid}@example.test`,
      password,
      name: 'Bob',
    });
    expect(
      (at((await bob.call('GET', '/api/account/orders')).body, 'orders') as unknown[]).length,
    ).toBe(0);
    expect((await new Browserish().call('GET', '/api/account/orders')).status).toBe(401);
  });

  it('a customer session is not a staff session', async () => {
    const carol = new Browserish();
    await carol.call('POST', '/api/auth/register', {
      email: `carol-${uid}@example.test`,
      password,
    });
    expect((await carol.call('GET', '/api/admin/products')).status).toBe(401);
    expect(
      (
        await carol.call('POST', '/api/admin/auth/login', {
          email: `carol-${uid}@example.test`,
          password,
        })
      ).status,
    ).toBe(401);
  });

  it('account pages render and gate on sign-in', async () => {
    const anon = await fetch(`${base}/en-au/account`, { redirect: 'manual' });
    expect(anon.status).toBeGreaterThanOrEqual(300);
    expect(anon.headers.get('location')).toContain('/en-au/account/login');
    expect((await fetch(`${base}/en-au/account/login`)).status).toBe(200);
    expect((await fetch(`${base}/en-au/account/register`)).status).toBe(200);
  });
});
