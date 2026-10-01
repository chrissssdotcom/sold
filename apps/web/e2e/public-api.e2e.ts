import { describe, expect, it, beforeAll } from 'vitest';

/** The public API over HTTP: key auth, scopes, no cookie auth, and the OpenAPI document matching what the server really returns. */
const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;

type Json = Record<string, unknown>;
const adminJar = new Map<string, string>();
async function admin(method: string, path: string, body?: unknown) {
  const cookie = [...adminJar].map(([k, v]) => `${k}=${v}`).join('; ');
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
    adminJar.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
  const t = await res.text();
  return { status: res.status, body: (t ? JSON.parse(t) : {}) as Json };
}
async function api(method: string, path: string, key: string | null, body?: unknown) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, headers: res.headers, body: (t ? JSON.parse(t) : {}) as Json };
}

/** Just enough JSON Schema (type, properties, required, items, enum, $ref, nullable unions) to check responses against the published spec. */
function check(value: unknown, schema: Json, doc: Json, at = '$'): string[] {
  if (typeof schema['$ref'] === 'string') {
    const name = String(schema['$ref']).split('/').pop()!;
    return check(
      value,
      ((doc['components'] as Json)['schemas'] as Record<string, Json>)[name]!,
      doc,
      at,
    );
  }
  const type = schema['type'];
  const types = Array.isArray(type) ? (type as string[]) : type ? [type as string] : [];
  const actual =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value;
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer')))
    return [`${at}: expected ${types.join('|')}, got ${actual}`];
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value))
    return [`${at}: not in enum`];
  const errors: string[] = [];
  if (actual === 'object' && schema['properties']) {
    for (const r of (schema['required'] as string[] | undefined) ?? [])
      if (!(r in (value as Json))) errors.push(`${at}.${r}: missing`);
    for (const [k, s] of Object.entries(schema['properties'] as Record<string, Json>))
      if (k in (value as Json)) errors.push(...check((value as Json)[k], s, doc, `${at}.${k}`));
  }
  if (actual === 'array' && schema['items'])
    (value as unknown[]).forEach((v, i) =>
      errors.push(...check(v, schema['items'] as Json, doc, `${at}[${i}]`)),
    );
  return errors;
}

run('public API', () => {
  let readKey = '';
  let writeKey = '';
  let writeKeyId = '';
  let spec: Json;
  let productId = '';
  let variantId = '';
  let orderId = '';

  beforeAll(async () => {
    expect(
      (await admin('POST', '/api/admin/auth/login', { email: ownerEmail, password: ownerPassword }))
        .status,
    ).toBe(200);
    const r = await admin('POST', '/api/admin/api-keys', {
      name: `e2e-read-${Date.now()}`,
      scopes: ['catalog:read', 'orders:read'],
    });
    expect(r.status).toBe(201);
    readKey = r.body['token'] as string;
    const w = await admin('POST', '/api/admin/api-keys', {
      name: `e2e-write-${Date.now()}`,
      scopes: ['catalog:write'],
    });
    writeKey = w.body['token'] as string;
    writeKeyId = (w.body['key'] as Json)['id'] as string;
    spec = (await (await fetch(`${base}/api/v1/openapi.json`)).json()) as Json;
  });

  it('publishes an OpenAPI 3.1 document without needing a key', () => {
    expect(spec['openapi']).toBe('3.1.0');
    expect(Object.keys(spec['paths'] as Json).length).toBeGreaterThanOrEqual(5);
  });

  it('rejects missing, malformed and cookie-only authentication identically', async () => {
    for (const key of [
      null,
      'garbage',
      'sk_00000000_' + 'A'.repeat(43),
      readKey.slice(0, -1) + 'X',
    ]) {
      const r = await api('GET', '/products', key);
      expect(r.status, String(key)).toBe(401);
      expect((r.body['error'] as Json)['code']).toBe('unauthenticated');
    }
    // A signed-in staff browser (cookies) is NOT an API credential: no cross-site request can ride it.
    const cookie = [...adminJar].map(([k, v]) => `${k}=${v}`).join('; ');
    expect((await fetch(`${base}/api/v1/products`, { headers: { cookie } })).status).toBe(401);
  });

  it('every documented GET answers with a body that matches its documented schema', async () => {
    const products = await api('GET', '/products?limit=3', readKey);
    expect(products.status).toBe(200);
    expect(products.headers.get('x-ratelimit-limit')).toBe('600');
    const items = products.body['items'] as { id: string; variants: { id: string }[] }[];
    expect(items.length).toBeGreaterThan(0);
    productId = items[0]!.id;
    variantId = items[0]!.variants[0]!.id;
    const op = (spec['paths'] as Record<string, Record<string, Json>>)['/products']!['get']!;
    const okSchema = (((op['responses'] as Json)['200'] as Json)['content'] as Json)[
      'application/json'
    ] as Json;
    expect(check(products.body, okSchema['schema'] as Json, spec)).toEqual([]);

    const one = await api('GET', `/products/${productId}`, readKey);
    expect(one.status).toBe(200);
    expect(check(one.body, { $ref: '#/components/schemas/Product' }, spec)).toEqual([]);

    const orders = await api('GET', '/orders?limit=3', readKey);
    expect(orders.status).toBe(200);
    const olist = orders.body['items'] as { id: string }[];
    expect(olist.length).toBeGreaterThan(0);
    orderId = olist[0]!.id;
    for (const o of olist)
      expect(check(o, { $ref: '#/components/schemas/OrderSummary' }, spec)).toEqual([]);
    const order = await api('GET', `/orders/${orderId}`, readKey);
    expect(order.status).toBe(200);
    expect(check(order.body, { $ref: '#/components/schemas/Order' }, spec)).toEqual([]);

    // Cursor pagination walks without repeats.
    const p1 = await api('GET', '/orders?limit=2', readKey);
    const cursor = p1.body['nextCursor'] as string | null;
    if (cursor) {
      const p2 = await api('GET', `/orders?limit=2&before=${cursor}`, readKey);
      const ids1 = (p1.body['items'] as { id: string }[]).map((x) => x.id);
      expect((p2.body['items'] as { id: string }[]).some((x) => ids1.includes(x.id))).toBe(false);
    }
  });

  it('answers errors in the documented shape: 404, 422, 403', async () => {
    const missing = await api('GET', '/products/00000000-0000-7000-8000-000000000000', readKey);
    expect(missing.status).toBe(404);
    expect(check(missing.body, { $ref: '#/components/schemas/Error' }, spec)).toEqual([]);
    expect((await api('GET', '/products/not-a-uuid', readKey)).status).toBe(422);
    const forbidden = await api('PUT', `/variants/${variantId}/stock`, readKey, { onHand: 1 });
    expect(forbidden.status).toBe(403);
    expect((await api('GET', '/orders', writeKey)).status).toBe(403); // write-only key cannot read orders
  });

  it('a write key can set stock; bad bodies are refused; a revoked key stops working at once', async () => {
    expect(
      (await api('PUT', `/variants/${variantId}/stock`, writeKey, { onHand: 37 })).status,
    ).toBe(200);
    expect(
      (await api('PUT', `/variants/${variantId}/stock`, writeKey, { onHand: -1 })).status,
    ).toBe(422);
    expect(
      (await api('PUT', `/variants/${variantId}/stock`, writeKey, { onHand: 1, evil: true }))
        .status,
    ).toBe(422);
    expect((await admin('DELETE', `/api/admin/api-keys/${writeKeyId}`)).status).toBe(200);
    expect(
      (await api('PUT', `/variants/${variantId}/stock`, writeKey, { onHand: 38 })).status,
    ).toBe(401);
  });

  it('key creation validates scopes and never lists secrets', async () => {
    expect((await admin('POST', '/api/admin/api-keys', { name: 'x', scopes: ['*'] })).status).toBe(
      422,
    );
    expect(
      (await admin('POST', '/api/admin/api-keys', { name: 'x', scopes: ['orders:*'] })).status,
    ).toBe(422);
    expect(
      (await admin('POST', '/api/admin/api-keys', { name: 'x', scopes: ['made:up'] })).status,
    ).toBe(422);
    const list = JSON.stringify((await admin('GET', '/api/admin/api-keys')).body);
    expect(list).not.toContain(readKey.split('_')[2]);
    expect(list).not.toContain('secret');
  });

  it('webhook endpoints: validated, secret shown once, listable and deletable', async () => {
    expect(
      (
        await admin('POST', '/api/admin/webhooks', {
          url: 'ftp://x.example.com',
          events: ['order.placed'],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin('POST', '/api/admin/webhooks', {
          url: 'https://x.example.com',
          events: ['nope'],
        })
      ).status,
    ).toBe(422);
    const made = await admin('POST', '/api/admin/webhooks', {
      url: 'http://127.0.0.1:9/hook',
      events: ['order.placed'],
      description: 'e2e',
    });
    expect(made.status).toBe(201);
    expect(String(made.body['secret'])).toMatch(/^whsec_/);
    const listed = JSON.stringify((await admin('GET', '/api/admin/webhooks')).body);
    expect(listed).toContain(made.body['id'] as string);
    expect(listed).not.toContain(made.body['secret'] as string);
    expect((await admin('DELETE', `/api/admin/webhooks/${made.body['id']}`)).status).toBe(200);
  });
});
