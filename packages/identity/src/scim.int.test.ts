import { openMigrated } from '@sold/commerce/testing';
import { schema, sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from './auth';
import { createScimToken, revokeScimToken, ScimService, type ScimResponse } from './scim';
import { SessionService } from './session';

let testDb: TestDatabase;
let db: Db;
let token: string;
let tokenId: string;
const scim = new ScimService();
const sessions = new SessionService();
const auth = new AuthService(sessions);
const base = 'https://shop.test/scim/v2';
let n = 0;
const uname = () => `scim${++n}-${Math.random().toString(36).slice(2, 6)}@corp.example`;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url);
  const t = await createScimToken(db.primary, 'okta', { id: null, label: 'test' });
  token = t.token;
  tokenId = t.id;
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  authorization: string | null = `Bearer ${token}`,
): Promise<ScimResponse> =>
  scim.handle(db.primary, {
    method,
    path,
    body,
    ...(query ? { query: new URLSearchParams(query) } : {}),
    authorization,
    baseUrl: base,
  });
const user = (userName = uname(), extra: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName,
  displayName: 'Pat Person',
  active: true,
  ...extra,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const b = (r: ScimResponse) => r.body as Record<string, any>;

describe('authentication', () => {
  it.each([
    [null],
    ['Bearer nope'],
    ['Basic abc'],
    ['Bearer scim_'],
    [`Bearer ${'scim_x'.repeat(30)}`],
  ])('rejects %s', async (header) => {
    const r = await call('GET', '/Users', undefined, undefined, header);
    expect(r.status).toBe(401);
    expect(b(r).schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  it('only the hash is stored; a revoked token stops working', async () => {
    const stored = await db.primary.execute<{ token_hash: string }>(
      sql`SELECT token_hash FROM scim_tokens`,
    );
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    const t2 = await createScimToken(db.primary, 'azure', { id: null, label: 'test' });
    expect((await call('GET', '/Users', undefined, undefined, `Bearer ${t2.token}`)).status).toBe(
      200,
    );
    await revokeScimToken(db.primary, t2.id, { id: null, label: 'test' });
    expect((await call('GET', '/Users', undefined, undefined, `Bearer ${t2.token}`)).status).toBe(
      401,
    );
    expect(tokenId).toBeDefined();
  });
});

describe('users', () => {
  it('create, get, list+filter, with SCIM-shaped resources; SCIM creates staff only', async () => {
    const name = uname();
    const created = await call('POST', '/Users', user(name, { externalId: 'ext-1' }));
    expect(created.status).toBe(201);
    expect(b(created)).toMatchObject({
      userName: name,
      active: true,
      externalId: 'ext-1',
      emails: [{ value: name, primary: true }],
    });
    const id = b(created).id;
    const [row] = await db.primary
      .select()
      .from(schema.users)
      .where(sql`id = ${id}`);
    expect(row?.kind).toBe('staff');
    expect(b(await call('GET', `/Users/${id}`)).userName).toBe(name);
    const found = b(
      await call('GET', '/Users', undefined, { filter: `userName eq "${name.toUpperCase()}"` }),
    );
    expect(found.totalResults).toBe(1);
    expect(found.Resources[0].id).toBe(id);
    expect(
      b(await call('GET', '/Users', undefined, { filter: 'externalId eq "ext-1"' })).totalResults,
    ).toBe(1);
    expect(
      b(await call('GET', '/Users', undefined, { filter: 'userName eq "nobody@corp.example"' }))
        .totalResults,
    ).toBe(0);
  });

  it('duplicates conflict (409 uniqueness); bad input is 400; unsupported filters are 400; a customer is invisible to SCIM', async () => {
    const name = uname();
    await call('POST', '/Users', user(name));
    const dup = await call('POST', '/Users', user(name));
    expect(dup.status).toBe(409);
    expect(b(dup).scimType).toBe('uniqueness');
    expect((await call('POST', '/Users', { userName: 'not-an-email' })).status).toBe(400);
    const f = await call('GET', '/Users', undefined, { filter: 'userName co "x"' });
    expect(f.status).toBe(400);
    expect(b(f).scimType).toBe('invalidFilter');
    const customer = await auth.registerCustomer(db.primary, {
      email: uname(),
      password: 'a long enough passphrase',
    });
    expect((await call('GET', `/Users/${customer.id}`)).status).toBe(404);
    expect(
      (
        await call('PATCH', `/Users/${customer.id}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        })
      ).status,
    ).toBe(404);
    expect(
      b(await call('GET', '/Users', undefined, { filter: `userName eq "${customer.email}"` }))
        .totalResults,
    ).toBe(0);
  });

  it('paginates deterministically and caps the page size', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/Users', user());
    const p1 = b(await call('GET', '/Users', undefined, { startIndex: '1', count: '2' }));
    const p2 = b(await call('GET', '/Users', undefined, { startIndex: '3', count: '2' }));
    expect(p1.itemsPerPage).toBe(2);
    expect(new Set([...p1.Resources, ...p2.Resources].map((r: { id: string }) => r.id)).size).toBe(
      4,
    );
    expect(
      b(await call('GET', '/Users', undefined, { count: '100000' })).itemsPerPage,
    ).toBeLessThanOrEqual(100);
    expect(b(await call('GET', '/Users', undefined, { count: '0' })).Resources).toEqual([]);
  });

  it('PATCH works in both Okta (no path) and Azure AD (string booleans) styles; deactivating signs the user out at once', async () => {
    const name = uname();
    const id = b(await call('POST', '/Users', user(name))).id;
    await db.primary
      .insert(schema.sessions)
      .values({ userId: id, tokenHash: 'h'.repeat(64), expiresAt: new Date(Date.now() + 60_000) });
    const op = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
    const azure = await call('PATCH', `/Users/${id}`, {
      schemas: [op],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(b(azure).active).toBe(false);
    expect(
      (await db.primary.execute(sql`SELECT 1 FROM sessions WHERE user_id = ${id}`)).rows,
    ).toHaveLength(0);
    const okta = await call('PATCH', `/Users/${id}`, {
      schemas: [op],
      Operations: [{ op: 'replace', value: { active: true, displayName: 'New Name' } }],
    });
    expect(b(okta)).toMatchObject({ active: true, displayName: 'New Name' });
    const email = uname();
    expect(
      b(
        await call('PATCH', `/Users/${id}`, {
          schemas: [op],
          Operations: [{ op: 'replace', path: 'userName', value: email }],
        }),
      ).userName,
    ).toBe(email);
    expect(
      (
        await call('PATCH', `/Users/${id}`, {
          schemas: [op],
          Operations: [{ op: 'replace', path: 'active', value: 'maybe' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/Users/${id}`, {
          schemas: [op],
          Operations: [{ op: 'bogus', path: 'active', value: true }],
        })
      ).status,
    ).toBe(400);
    expect((await call('PATCH', `/Users/${id}`, { Operations: [] })).status).toBe(400);
  });

  it('PUT replaces; DELETE deactivates (the row and its audit trail remain); 404 for unknown ids', async () => {
    const id = b(await call('POST', '/Users', user())).id;
    const email = uname();
    expect(
      b(await call('PUT', `/Users/${id}`, user(email, { displayName: 'Replaced' }))).displayName,
    ).toBe('Replaced');
    expect((await call('DELETE', `/Users/${id}`)).status).toBe(204);
    expect(b(await call('GET', `/Users/${id}`)).active).toBe(false);
    for (const bad of ['not-a-uuid', '00000000-0000-7000-8000-000000000000'])
      expect((await call('GET', `/Users/${bad}`)).status).toBe(404);
    expect((await call('GET', '/Nope')).status).toBe(404);
  });

  it('every change is audited with the SCIM actor', async () => {
    const rows = await db.primary.execute<{ actor_label: string }>(
      sql`SELECT DISTINCT actor_label FROM audit_log WHERE detail->>'via' = 'scim'`,
    );
    expect(rows.rows.map((r) => r.actor_label)).toEqual(['scim:okta']);
  });
});

describe('groups are roles', () => {
  it('lists manageable roles (never owner) and changes membership; role permissions then apply live', async () => {
    const list = b(await call('GET', '/Groups'));
    expect(list.Resources.map((g: { id: string }) => g.id)).not.toContain('owner');
    expect(list.Resources.map((g: { id: string }) => g.id)).toContain('order-manager');
    const id = b(await call('POST', '/Users', user())).id;
    const op = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
    const added = await call('PATCH', '/Groups/order-manager', {
      schemas: [op],
      Operations: [{ op: 'add', path: 'members', value: [{ value: id }] }],
    });
    expect(b(added).members.map((m: { value: string }) => m.value)).toContain(id);
    await db.primary
      .insert(schema.sessions)
      .values({ userId: id, tokenHash: 'g'.repeat(64), expiresAt: new Date(Date.now() + 60_000) });
    const perms = await db.primary.execute<{ p: string[] }>(
      sql`SELECT array_agg(DISTINCT p) AS p FROM user_roles ur JOIN roles r ON r.name = ur.role_name, unnest(r.permissions) p WHERE ur.user_id = ${id}`,
    );
    expect(perms.rows[0]?.p).toContain('orders:*');
    const removed = await call('PATCH', '/Groups/order-manager', {
      schemas: [op],
      Operations: [{ op: 'remove', path: `members[value eq "${id}"]` }],
    });
    expect(b(removed).members.map((m: { value: string }) => m.value)).not.toContain(id);
  });

  it('refuses owner, unknown groups, group creation/deletion, customers as members', async () => {
    const op = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
    const id = b(await call('POST', '/Users', user())).id;
    expect(
      (
        await call('PATCH', '/Groups/owner', {
          schemas: [op],
          Operations: [{ op: 'add', path: 'members', value: [{ value: id }] }],
        })
      ).status,
    ).toBe(404);
    expect((await call('GET', '/Groups/owner')).status).toBe(404);
    expect((await call('GET', '/Groups/nope')).status).toBe(404);
    expect((await call('POST', '/Groups', { displayName: 'x' })).status).toBe(403);
    expect((await call('DELETE', '/Groups/admin')).status).toBe(403);
    const customer = await auth.registerCustomer(db.primary, {
      email: uname(),
      password: 'a long enough passphrase',
    });
    expect(
      (
        await call('PATCH', '/Groups/support', {
          schemas: [op],
          Operations: [{ op: 'add', path: 'members', value: [{ value: customer.id }] }],
        })
      ).status,
    ).toBe(400);
  });

  it('discovery endpoints answer', async () => {
    expect(b(await call('GET', '/ServiceProviderConfig')).patch.supported).toBe(true);
    expect(b(await call('GET', '/ResourceTypes')).totalResults).toBe(2);
  });
});
