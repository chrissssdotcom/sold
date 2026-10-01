import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { openMigrated } from '@sold/commerce/testing';
import { schema, sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIdp, type FakeIdp } from './fake-idp';
import { OidcClient, SsoError, type OidcConfig } from './oidc';
import { seal, open } from './sealed';
import { SessionService } from './session';
import { completeSsoLogin } from './sso';

let testDb: TestDatabase;
let db: Db;
let idp: FakeIdp;
const sessions = new SessionService();

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url);
  idp = await startFakeIdp();
});
afterAll(async () => {
  await idp?.close();
  await db?.close();
  await testDb?.destroy();
});

const cfg = (over: Partial<OidcConfig> = {}): OidcConfig => ({
  id: 'testidp',
  issuer: idp.issuer,
  clientId: idp.clientId,
  clientSecret: idp.clientSecret,
  redirectUri: idp.redirectUri,
  ...over,
});
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Run the whole dance and return what `finish` produced (or the error it threw). */
async function flow(
  config: OidcConfig,
  claims: Record<string, unknown> = {},
  opts: { header?: Record<string, unknown>; stateOverride?: string; nonceOverride?: string } = {},
) {
  const client = new OidcClient(config);
  const start = await client.start();
  const code = idp.authorize({
    challenge: challengeOf(start.saved.verifier),
    nonce: opts.nonceOverride ?? start.saved.nonce,
    claims,
    ...(opts.header ? { header: opts.header } : {}),
  });
  return client.finish({ code, state: opts.stateOverride ?? start.saved.state }, start.saved);
}
const reason = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => null,
      (e: unknown) => e,
    )) as SsoError | null
  )?.reason ?? 'ok';

describe('OIDC client', () => {
  it('start builds a PKCE (S256) authorization request with state and nonce', async () => {
    const s = await new OidcClient(cfg()).start();
    const u = new URL(s.url);
    expect(u.origin).toBe(idp.issuer);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(challengeOf(s.saved.verifier));
    expect(u.searchParams.get('state')).toBe(s.saved.state);
    expect(u.searchParams.get('nonce')).toBe(s.saved.nonce);
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(s.saved.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('a valid flow yields the verified identity, and the verifier (not just the challenge) reached the token endpoint', async () => {
    const id = await flow(cfg(), { sub: 'abc', groups: ['ops', 7] });
    expect(id).toMatchObject({
      provider: 'testidp',
      subject: 'abc',
      email: 'staff@example.com',
      emailVerified: true,
      groups: ['ops'],
    });
    expect(idp.tokenRequests.at(-1)?.get('code_verifier')).toBeTruthy();
    expect(idp.tokenRequests.at(-1)?.get('code_challenge')).toBeNull();
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }, {}, 'id_token_invalid'],
    ['wrong issuer', { iss: 'https://evil.example' }, {}, 'id_token_invalid'],
    [
      'expired',
      { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 },
      {},
      'id_token_invalid',
    ],
    ['missing subject', { sub: undefined }, {}, 'id_token_invalid'],
  ])('rejects an ID token with %s', async (_n, claims, opts, expected) => {
    expect(await reason(flow(cfg(), claims as Record<string, unknown>, opts))).toBe(expected);
  });

  it('rejects nonce replay, a swapped state, and a provider error', async () => {
    expect(await reason(flow(cfg(), {}, { nonceOverride: 'attacker-nonce' }))).toBe(
      'nonce_mismatch',
    );
    expect(await reason(flow(cfg(), {}, { stateOverride: 'x'.repeat(32) }))).toBe('state_mismatch');
    const c = new OidcClient(cfg());
    const s = await c.start();
    expect(await reason(c.finish({ error: 'access_denied' }, s.saved))).toBe('provider_error');
    expect(await reason(c.finish({ code: 'c' }, s.saved))).toBe('missing_params');
  });

  it('refuses a token signed with HMAC using the client secret (algorithm confusion) and the `none` algorithm', async () => {
    const client = new OidcClient(cfg());
    const s = await client.start();
    const forged = await new SignJWT({
      sub: 'attacker',
      nonce: s.saved.nonce,
      email: 'staff@example.com',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(idp.issuer)
      .setAudience(idp.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(idp.clientSecret));
    const evil = new OidcClient({
      ...cfg(),
      fetch: async (url, init) => {
        if (String(url).endsWith('/token'))
          return new Response(JSON.stringify({ id_token: forged }), { status: 200 });
        return fetch(url, init);
      },
    });
    const s2 = await evil.start();
    expect(await reason(evil.finish({ code: 'x', state: s2.saved.state }, s2.saved))).toBe(
      'id_token_invalid',
    );
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'a', iss: idp.issuer, aud: idp.clientId, nonce: s.saved.nonce, exp: 9999999999, iat: 1 })).toString('base64url')}.`;
    const evil2 = new OidcClient({
      ...cfg(),
      fetch: async (url, init) =>
        String(url).endsWith('/token')
          ? new Response(JSON.stringify({ id_token: none }), { status: 200 })
          : fetch(url, init),
    });
    const s3 = await evil2.start();
    expect(await reason(evil2.finish({ code: 'x', state: s3.saved.state }, s3.saved))).toBe(
      'id_token_invalid',
    );
  });

  it('a code is single-use, and a wrong PKCE verifier is refused by the provider', async () => {
    const client = new OidcClient(cfg());
    const s = await client.start();
    const code = idp.authorize({ challenge: challengeOf(s.saved.verifier), nonce: s.saved.nonce });
    await client.finish({ code, state: s.saved.state }, s.saved);
    expect(await reason(client.finish({ code, state: s.saved.state }, s.saved))).toBe(
      'token_exchange_failed',
    );
    const s2 = await client.start();
    const code2 = idp.authorize({
      challenge: challengeOf('a-different-verifier-entirely-0123456789012345678901234'),
      nonce: s2.saved.nonce,
    });
    expect(await reason(client.finish({ code: code2, state: s2.saved.state }, s2.saved))).toBe(
      'token_exchange_failed',
    );
  });

  it('discovery must describe this issuer, and endpoints must be https (localhost excepted)', async () => {
    idp.tamper.discoveryIssuer = 'https://other.example';
    expect(await reason(new OidcClient(cfg()).start())).toBe('issuer_mismatch');
    idp.tamper.discoveryIssuer = undefined;
    expect(() => new OidcClient(cfg({ issuer: 'http://idp.example.com' }))).toThrow(/https/);
  });
});

describe('sealed state', () => {
  const key = Buffer.alloc(32, 3);
  it('round-trips, expires, and rejects tampering and other keys', () => {
    const t = seal(key, { a: 1 }, 60, 1_000_000);
    expect(open(key, t, 1_000_000)).toMatchObject({ a: 1 });
    expect(open(key, t, 1_000_000 + 61_000)).toBeNull();
    expect(open(Buffer.alloc(32, 4), t, 1_000_000)).toBeNull();
    const [body, mac] = t.split('.');
    expect(open(key, `${body}x.${mac}`, 1_000_000)).toBeNull();
    for (const bad of [null, '', 'x', '.', 'a.b', 'x'.repeat(5000)])
      expect(open(key, bad as string, 1_000_000)).toBeNull();
  });
});

describe('SSO sign-in rules', () => {
  const id = (over: Record<string, unknown> = {}) => ({
    provider: 'testidp',
    subject: `s-${Math.random().toString(36).slice(2)}`,
    email: `u${Math.random().toString(36).slice(2, 8)}@example.com`,
    emailVerified: true,
    name: 'N',
    groups: [] as string[],
    ...over,
  });

  it('provisions a staff user on first sign-in when allowed, links by (provider, subject), and signs in again by that link', async () => {
    const identity = id();
    const first = await completeSsoLogin(
      db.primary,
      sessions,
      { autoProvision: true, defaultRoles: ['support'] },
      identity,
    );
    expect(first.provisioned).toBe(true);
    const s = await sessions.resolve(db.primary, first.token);
    expect(s?.user.kind).toBe('staff');
    expect(s?.user.permissions).toContain('orders:read');
    // same subject, a different (changed) email: still the same account
    const again = await completeSsoLogin(
      db.primary,
      sessions,
      {},
      { ...identity, email: 'renamed@example.com' },
    );
    expect(again.userId).toBe(first.userId);
    expect(again.provisioned).toBe(false);
  });

  it('refuses unknown users by default, unverified emails, and disallowed domains', async () => {
    expect(await reason(completeSsoLogin(db.primary, sessions, {}, id()))).toBe('not_provisioned');
    expect(
      await reason(
        completeSsoLogin(
          db.primary,
          sessions,
          { autoProvision: true },
          id({ emailVerified: false }),
        ),
      ),
    ).toBe('email_unverified');
    expect(
      await reason(
        completeSsoLogin(db.primary, sessions, { autoProvision: true }, id({ email: null })),
      ),
    ).toBe('email_unverified');
    expect(
      await reason(
        completeSsoLogin(
          db.primary,
          sessions,
          { autoProvision: true, allowedEmailDomains: ['corp.example'] },
          id({ email: 'x@example.com' }),
        ),
      ),
    ).toBe('domain_not_allowed');
  });

  it('never links by email unless opted in, never to a customer account, never to a disabled user', async () => {
    const staff = (
      await db.primary
        .insert(schema.users)
        .values({ email: 'ceo@example.com', kind: 'staff' })
        .returning()
    )[0]!;
    const customer = (
      await db.primary
        .insert(schema.users)
        .values({ email: 'cust@example.com', kind: 'customer' })
        .returning()
    )[0]!;
    expect(
      await reason(completeSsoLogin(db.primary, sessions, {}, id({ email: staff.email }))),
    ).toBe('no_linked_account');
    expect(
      await reason(
        completeSsoLogin(
          db.primary,
          sessions,
          { autoLinkByEmail: true },
          id({ email: customer.email }),
        ),
      ),
    ).toBe('no_linked_account');
    const linked = await completeSsoLogin(
      db.primary,
      sessions,
      { autoLinkByEmail: true },
      id({ email: staff.email, subject: 'ceo-sub' }),
    );
    expect(linked.userId).toBe(staff.id);
    await db.primary.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${staff.id}`);
    expect(
      await reason(completeSsoLogin(db.primary, sessions, {}, id({ subject: 'ceo-sub' }))),
    ).toBe('account_unavailable');
  });

  it('group-managed roles follow the IdP at each sign-in and can never mint an owner', async () => {
    const cfgG = {
      autoProvision: true,
      groupRoleMap: { ops: ['order-manager'], cat: ['catalog-manager'], root: ['owner'] },
    };
    const identity = id({ groups: ['ops', 'root'] });
    const a = await completeSsoLogin(db.primary, sessions, cfgG, identity);
    let perms = (await sessions.resolve(db.primary, a.token))?.user.permissions ?? [];
    expect(perms).toContain('orders:*');
    expect(perms).not.toContain('*');
    const b = await completeSsoLogin(db.primary, sessions, cfgG, { ...identity, groups: ['cat'] });
    perms = (await sessions.resolve(db.primary, b.token))?.user.permissions ?? [];
    expect(perms).toContain('catalog:*');
    expect(perms).not.toContain('orders:*'); // removed from the IdP group, removed here
  });

  it('records provisioning in the audit log', async () => {
    const rows = (
      await db.primary.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM audit_log WHERE action IN ('user.provisioned','user.linked')`,
      )
    ).rows;
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(3);
  });
});
