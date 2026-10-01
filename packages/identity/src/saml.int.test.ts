import { openMigrated } from '@sold/commerce/testing';
import { sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSamlResponse,
  generateIdpKeys,
  type AssertionOptions,
  type IdpKeys,
} from './fake-saml-idp';
import type { SsoError } from './oidc';
import { SamlClient, type SamlConfig } from './saml';
import { SessionService } from './session';
import { completeSsoLogin } from './sso';

let testDb: TestDatabase;
let db: Db;
let keys: IdpKeys;
let other: IdpKeys;
const sessions = new SessionService();
const sp = { issuer: 'https://shop.test/saml/metadata', callbackUrl: 'https://shop.test/saml/acs' };
const idpIssuer = 'https://idp.example/entity';

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url);
  keys = generateIdpKeys('trusted');
  other = generateIdpKeys('attacker');
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const cfg = (over: Partial<SamlConfig> = {}): SamlConfig => ({
  id: 'corp-saml',
  entryPoint: 'https://idp.example/sso',
  idpCert: keys.cert,
  ...sp,
  ...over,
});
const response = (requestId: string, over: Partial<AssertionOptions> = {}) =>
  buildSamlResponse({
    issuer: idpIssuer,
    audience: sp.issuer,
    recipient: sp.callbackUrl,
    inResponseTo: requestId,
    keys,
    attributes: { displayName: 'Sam Staff', groups: ['ops'] },
    ...over,
  });
const reason = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => null,
      (e: unknown) => e,
    )) as SsoError | null
  )?.reason ?? 'ok';

describe('SAML SP', () => {
  it('start produces a redirect to the IdP carrying our AuthnRequest id', async () => {
    const c = new SamlClient(cfg());
    const s = await c.start();
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe('https://idp.example/sso');
    expect(u.searchParams.get('SAMLRequest')).toBeTruthy();
    expect(s.saved.requestId).toMatch(/^_[0-9a-f]{40}$/);
    const inflated = (await import('node:zlib'))
      .inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64'))
      .toString();
    expect(inflated).toContain(`ID="${s.saved.requestId}"`);
    expect(inflated).toContain(sp.callbackUrl);
  });

  it('accepts a correctly signed, correctly addressed response and yields the identity', async () => {
    const c = new SamlClient(cfg());
    const s = await c.start();
    const id = await c.finish(
      { SAMLResponse: response(s.saved.requestId, { nameId: 'sam@example.com' }) },
      s.saved,
      db.primary,
    );
    expect(id).toMatchObject({
      provider: 'corp-saml',
      subject: 'sam@example.com',
      email: 'sam@example.com',
      emailVerified: true,
      name: 'Sam Staff',
      groups: ['ops'],
    });
    const out = await completeSsoLogin(
      db.primary,
      sessions,
      { autoProvision: true, defaultRoles: ['support'] },
      id,
    );
    expect(out.provisioned).toBe(true);
  });

  const attacks: [string, (rid: string) => Partial<AssertionOptions>, string][] = [
    ['unsigned assertion', () => ({ sign: false }), 'saml_invalid'],
    ['signed by a different key', () => ({ keys: other }), 'saml_invalid'],
    ['wrong audience', () => ({ audience: 'https://other-sp.example' }), 'saml_invalid'],
    ['wrong recipient', () => ({ recipient: 'https://evil.example/acs' }), 'recipient_mismatch'],
    [
      'assertion issued long ago',
      () => ({ issueInstant: new Date(Date.now() - 3_600_000) }),
      'assertion_age',
    ],
    [
      'expired',
      () => ({
        notOnOrAfter: new Date(Date.now() - 3_600_000),
        notBefore: new Date(Date.now() - 7_200_000),
      }),
      'saml_invalid',
    ],
    [
      'not yet valid',
      () => ({
        notBefore: new Date(Date.now() + 3_600_000),
        notOnOrAfter: new Date(Date.now() + 7_200_000),
      }),
      'saml_invalid',
    ],
  ];
  it.each(attacks)('rejects %s', async (_n, over, expected) => {
    const c = new SamlClient(cfg());
    const s = await c.start();
    expect(
      await reason(
        c.finish(
          { SAMLResponse: response(s.saved.requestId, over(s.saved.requestId)) },
          s.saved,
          db.primary,
        ),
      ),
    ).toBe(expected);
  });

  it('rejects a response meant for another login attempt (InResponseTo) and unsolicited IdP-initiated responses', async () => {
    const c = new SamlClient(cfg());
    const mine = await c.start();
    const theirs = await c.start();
    expect(
      await reason(
        c.finish({ SAMLResponse: response(theirs.saved.requestId) }, mine.saved, db.primary),
      ),
    ).toBe('in_response_to_mismatch');
    expect(await reason(c.finish({ SAMLResponse: response('') }, mine.saved, db.primary))).not.toBe(
      'ok',
    );
  });

  it('rejects a tampered assertion (signature no longer matches) and a replayed one', async () => {
    const c = new SamlClient(cfg());
    const s = await c.start();
    const good = response(s.saved.requestId, {
      nameId: 'victim@example.com',
      assertionId: '_replay-1',
    });
    const xml = Buffer.from(good, 'base64')
      .toString()
      .replace('victim@example.com', 'admin@example.com');
    expect(
      await reason(
        c.finish({ SAMLResponse: Buffer.from(xml).toString('base64') }, s.saved, db.primary),
      ),
    ).toBe('saml_invalid');
    await c.finish({ SAMLResponse: good }, s.saved, db.primary);
    expect(await reason(c.finish({ SAMLResponse: good }, s.saved, db.primary))).toBe('replay');
  });

  it('accepts either of two IdP certificates (rotation); garbage and oversized input fail cleanly', async () => {
    const c = new SamlClient(cfg({ idpCert: [other.cert, keys.cert] }));
    const s = await c.start();
    expect(
      (await c.finish({ SAMLResponse: response(s.saved.requestId) }, s.saved, db.primary)).provider,
    ).toBe('corp-saml');
    for (const bad of [
      null,
      '',
      'not base64!!',
      Buffer.from('<x/>').toString('base64'),
      'A'.repeat(300_000),
    ])
      expect(await reason(c.finish({ SAMLResponse: bad }, s.saved, db.primary))).not.toBe('ok');
  });

  it('the replay table is swept once entries expire', async () => {
    await db.primary.execute(sql`UPDATE sso_replay SET expires_at = now() - interval '1 second'`);
    expect(await SamlClient.sweep(db.primary)).toBeGreaterThanOrEqual(1);
  });
});
