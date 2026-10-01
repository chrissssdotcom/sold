import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;

const jar = new Map<string, string>();
async function call(method: string, path: string, body?: unknown, auth = true) {
  const cookie = auth ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : { origin: base! }),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    jar.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
  await res.arrayBuffer();
  return res;
}
const setFlag = (key: string, enabled: boolean) =>
  call('PUT', '/api/admin/flags', { key, enabled, description: 'e2e' });
/** Flags are cached ~5 s per instance; wait for the new state to be observed. */
async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('state not reached in time');
}

run('load shedding', () => {
  beforeAll(async () => {
    const r = await call('POST', '/api/admin/auth/login', {
      email: ownerEmail,
      password: ownerPassword,
    });
    expect(r.status).toBe(200);
  });
  afterAll(async () => {
    await setFlag('shed.browse', false); // never leave the instance shedding
  });

  it('sheds browse and below with 503 + Retry-After, keeps checkout, cart, probes and the way back', async () => {
    expect((await call('GET', '/api/catalog/products?limit=1', undefined, false)).status).toBe(200);
    expect((await setFlag('shed.browse', true)).status).toBe(200);

    await until(
      async () =>
        (await call('GET', '/api/catalog/products?limit=1', undefined, false)).status === 503,
    );
    const shed = await call('GET', '/api/catalog/products?limit=1', undefined, false);
    expect(shed.headers.get('retry-after')).toBe('30');
    expect(shed.headers.get('cache-control')).toBe('no-store');

    // Below browse: account and admin are shed too.
    expect((await call('GET', '/api/account/orders', undefined, false)).status).toBe(503);
    expect((await call('GET', '/api/admin/dashboard')).status).toBe(503);
    // Above browse: cart and checkout keep working. Probes always answer.
    expect((await call('POST', '/api/cart', { currency: 'AUD' }, false)).status).toBeLessThan(300);
    expect((await call('GET', '/api/health/live', undefined, false)).status).toBe(200);
    // The flags API and sign-in are exempt, so an operator can always switch shedding off.
    const flags = await call('GET', '/api/admin/flags');
    expect(flags.status).toBe(200);

    expect((await setFlag('shed.browse', false)).status).toBe(200);
    await until(
      async () =>
        (await call('GET', '/api/catalog/products?limit=1', undefined, false)).status === 200,
    );
  }, 90_000);

  it('checkout is never shed, even with the most aggressive flag on', async () => {
    expect((await setFlag('shed.cart', true)).status).toBe(200);
    await until(
      async () => (await call('POST', '/api/cart', { currency: 'AUD' }, false)).status === 503,
    );
    const quote = await call('POST', '/api/checkout/quote', { shippingAddress: {} }, false);
    expect(quote.status).not.toBe(503); // a validation/cart error is fine; shedding is not
    expect((await setFlag('shed.cart', false)).status).toBe(200);
    await until(
      async () => (await call('POST', '/api/cart', { currency: 'AUD' }, false)).status < 300,
    );
  }, 90_000);
});
