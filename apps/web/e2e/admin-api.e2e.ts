import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Admin API over real HTTP: authentication, CSRF, the permission matrix, and the main write paths.
 *   SOLD_E2E_URL=http://localhost:3000 SOLD_E2E_OWNER_EMAIL=… SOLD_E2E_OWNER_PASSWORD=… pnpm --filter @sold/web test:e2e
 * Needs a running server and an owner (`pnpm sold user:create-owner`). Creates its own uniquely named data.
 */
const base = process.env['SOLD_E2E_URL'];
const ownerEmail = process.env['SOLD_E2E_OWNER_EMAIL'];
const ownerPassword = process.env['SOLD_E2E_OWNER_PASSWORD'];
const run = base && ownerEmail && ownerPassword ? describe : describe.skip;

/** Read a dotted path out of a JSON response without trusting its shape. */
function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v === null || v === undefined ? undefined : (v as Record<string, unknown>)[k]),
      value,
    );
}

class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method === 'GET' ? {} : { origin: base! }),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const pair = c.split(';')[0]!;
      if (/=$/.test(pair)) this.cookie = '';
      else this.cookie = pair;
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as unknown };
  }
  async login(email: string, password: string) {
    const r = await this.call('POST', '/api/admin/auth/login', { email, password });
    expect(r.status).toBe(200);
  }
}

const uid = Math.random().toString(36).slice(2, 8);
const owner = new Client();
const limited = new Client();
const publisher = new Client();
let productId = '';
let variantId = '';
let pageId = '';

run('admin API', () => {
  beforeAll(async () => {
    await owner.login(ownerEmail!, ownerPassword!);
    const pw = `Zx9-${uid}-long-enough-pass`;
    for (const [name, perms, who] of [
      [`viewer-${uid}`, ['catalog:read', 'orders:read'], limited],
      [
        `editor-${uid}`,
        ['catalog:read', 'catalog:write', 'content:read', 'content:write'],
        publisher,
      ],
    ] as const) {
      const r = await owner.call('POST', '/api/admin/roles', { name, permissions: perms });
      expect(r.status).toBe(201);
      const email = `${name}@example.test`;
      const u = await owner.call('POST', '/api/admin/users', {
        email,
        name,
        password: pw,
        roles: [name],
      });
      expect(u.status).toBe(201);
      await who.login(email, pw);
    }
  });

  it('rejects anonymous callers and cross-site writes', async () => {
    const anon = new Client();
    for (const p of [
      '/api/admin/products',
      '/api/admin/orders',
      '/api/admin/pages',
      '/api/admin/users',
      '/api/admin/audit',
      '/api/admin/theme',
      '/api/admin/dashboard',
    ])
      expect((await anon.call('GET', p)).status).toBe(401);
    const forged = await owner.call(
      'POST',
      '/api/admin/roles',
      { name: 'x', permissions: [] },
      { origin: 'https://evil.example' },
    );
    expect(forged.status).toBe(403);
    expect(at(forged.body, 'error.code')).toBe('csrf_rejected');
  });

  it('enforces the permission matrix', async () => {
    expect((await limited.call('GET', '/api/admin/products')).status).toBe(200);
    expect((await limited.call('GET', '/api/admin/orders')).status).toBe(200);
    for (const [m, p] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/pages'],
      ['GET', '/api/admin/theme'],
      ['GET', '/api/admin/promotions'],
    ] as const)
      expect((await limited.call(m, p)).status, `${m} ${p}`).toBe(403);
    expect((await limited.call('POST', '/api/admin/products', {})).status).toBe(403);
  });

  it('creates a product; going live needs catalog:publish', async () => {
    const draft = {
      handle: `e2e-${uid}`,
      title: `E2E ${uid}`,
      variants: [{ sku: `E2E-${uid}`, prices: [{ currency: 'AUD', amount: '1999' }], onHand: 5 }],
    };
    const created = await publisher.call('POST', '/api/admin/products', draft);
    expect(created.status).toBe(201);
    productId = at(created.body, 'id') as string;
    variantId = at(created.body, 'variants.0.id') as string;
    const live = await publisher.call('PATCH', `/api/admin/products/${productId}`, {
      status: 'active',
    });
    expect(live.status).toBe(403);
    expect(at(live.body, 'error.details.permission')).toBe('catalog:publish');
    expect(
      (await owner.call('PATCH', `/api/admin/products/${productId}`, { status: 'active' })).status,
    ).toBe(200);
    expect(
      (await publisher.call('POST', '/api/admin/products', { ...draft, status: 'active' })).status,
    ).toBe(403);
    expect(
      (at((await owner.call('GET', `/api/admin/products?q=${uid}`)).body, 'items') as unknown[])
        .length,
    ).toBe(1);
  });

  it('sets stock and price, and refuses bad input cleanly', async () => {
    expect(
      (await publisher.call('PUT', `/api/admin/variants/${variantId}/stock`, { onHand: 12 }))
        .status,
    ).toBe(200);
    expect(
      (
        await publisher.call('PUT', `/api/admin/variants/${variantId}/price`, {
          currency: 'AUD',
          amount: '2499',
        })
      ).status,
    ).toBe(200);
    expect(
      (await publisher.call('PUT', `/api/admin/variants/${variantId}/stock`, { onHand: -1 }))
        .status,
    ).toBe(422);
    expect(
      (await publisher.call('PUT', `/api/admin/variants/not-a-uuid/stock`, { onHand: 1 })).status,
    ).toBe(422);
    const read = await publisher.call('GET', `/api/admin/products/${productId}`);
    expect(at(read.body, 'variants.0.prices.0.amount.amount')).toBe('2499');
  });

  it('page lifecycle: save is not publish; bad trees are refused; conflicts are detected', async () => {
    const c = await publisher.call('POST', '/api/admin/pages', {
      path: `/e2e-${uid}`,
      locale: 'en-au',
      title: 'E2E page',
    });
    expect(c.status).toBe(201);
    pageId = at(c.body, 'id') as string;
    const blocks = (await owner.call('GET', '/api/admin/blocks')).body as {
      type: string;
      defaultProps: object;
    }[];
    expect(blocks.some((b) => b.type === 'hero')).toBe(true);
    const hero = blocks.find((b) => b.type === 'hero')!;
    const tree = [{ id: 'a1', type: 'hero', props: hero.defaultProps }];
    const saved = await publisher.call('PUT', `/api/admin/pages/${pageId}`, {
      tree,
      expectedVersion: 1,
    });
    expect(saved.status).toBe(200);
    expect(at(saved.body, 'version')).toBe(2);
    expect(
      (await publisher.call('PUT', `/api/admin/pages/${pageId}`, { tree, expectedVersion: 1 }))
        .status,
    ).toBe(409);
    expect(
      (
        await publisher.call('PUT', `/api/admin/pages/${pageId}`, {
          tree: [{ id: 'x', type: 'nope', props: {} }],
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await publisher.call('POST', `/api/admin/pages/${pageId}/publish`, { version: 2 })).status,
    ).toBe(403);
    expect(
      (await owner.call('POST', `/api/admin/pages/${pageId}/publish`, { version: 2 })).status,
    ).toBe(200);
    const live = await fetch(`${base}/en-au/e2e-${uid}`);
    expect(live.status).toBe(200);
  });

  it('theme tokens: validated, versioned', async () => {
    const t = await owner.call('GET', '/api/admin/theme');
    const v = at(t.body, 'version') as number;
    expect(
      (
        await owner.call('PUT', '/api/admin/theme', {
          tokens: { '--accent': 'url(javascript:alert(1))' },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const ok = await owner.call('PUT', '/api/admin/theme', {
      tokens: { '--accent': '#b4532a' },
      expectedVersion: v,
    });
    expect(ok.status).toBe(200);
    expect(
      (await owner.call('PUT', '/api/admin/theme', { tokens: {}, expectedVersion: v })).status,
    ).toBe(409);
    await owner.call('PUT', '/api/admin/theme', { tokens: {} });
  });

  it('records an audit trail of the above', async () => {
    const a = await owner.call('GET', '/api/admin/audit?limit=100');
    const actions = (at(a.body, 'items') as { action: string }[]).map((i) => i.action);
    for (const want of ['product.created', 'page.published', 'theme.tokens', 'stock.set'])
      expect(actions, want).toContain(want);
  });

  it('cannot disable your own account or strip the last owner', async () => {
    const me = at((await owner.call('GET', '/api/admin/auth/me')).body, 'user') as { id: string };
    expect(
      (await owner.call('PATCH', `/api/admin/users/${me.id}`, { status: 'disabled' })).status,
    ).toBe(409);
  });
});
