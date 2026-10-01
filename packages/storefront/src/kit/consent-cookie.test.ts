import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  NO_CONSENT,
  consentCookieString,
  consentFromCookieHeader,
  parseConsent,
  serializeConsent,
  type Consent,
} from './consent-cookie';

const now = () => Math.floor(Date.now() / 1000);
const user = (a: boolean, m: boolean, t = now()): Consent => ({
  analytics: a,
  marketing: m,
  decidedAt: t,
  source: 'user',
});

describe('consent cookie', () => {
  it('round-trips a decision', () => {
    for (const [a, m] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const c = user(a, m);
      expect(parseConsent(serializeConsent(c))).toEqual(c);
    }
  });

  it('absent, malformed, oversize or tampered values mean NO consent (fail closed)', () => {
    for (const v of [
      undefined,
      null,
      '',
      'garbage',
      '%7B',
      encodeURIComponent('{"a":1,"m":1}'),
      encodeURIComponent('[1,2]'),
      'x'.repeat(500),
    ])
      expect(parseConsent(v as never), String(v)).toEqual(NO_CONSENT);
  });

  it('only a literal 1 grants; truthy look-alikes do not', () => {
    const v = (o: object) => encodeURIComponent(JSON.stringify({ t: now(), s: 'user', ...o }));
    expect(parseConsent(v({ a: true, m: 'yes' })).marketing).toBe(false);
    expect(parseConsent(v({ a: 2, m: '1' })).analytics).toBe(false);
  });

  it('expires after six months', () => {
    const old = user(true, true, now() - CONSENT_MAX_AGE_SECONDS - 60);
    expect(parseConsent(serializeConsent(old))).toEqual(NO_CONSENT);
    expect(
      parseConsent(serializeConsent(user(true, true, now() - CONSENT_MAX_AGE_SECONDS + 3600)))
        .marketing,
    ).toBe(true);
  });

  it('a Global Privacy Control record can never carry marketing consent, even if forged into the cookie', () => {
    const forged = encodeURIComponent(JSON.stringify({ a: 1, m: 1, t: now(), s: 'gpc' }));
    expect(parseConsent(forged).marketing).toBe(false);
  });

  it('reads the cookie out of a request header among others', () => {
    const header = `a=1; ${CONSENT_COOKIE}=${serializeConsent(user(false, true))}; b=2`;
    expect(consentFromCookieHeader(header).marketing).toBe(true);
    expect(consentFromCookieHeader('a=1')).toEqual(NO_CONSENT);
    expect(consentFromCookieHeader(null)).toEqual(NO_CONSENT);
  });

  it('writes a first-party, lax, six-month cookie; Secure on https only', () => {
    expect(consentCookieString(user(true, false), true)).toMatch(
      /Path=\/; Max-Age=15552000; SameSite=Lax; Secure$/,
    );
    expect(consentCookieString(user(true, false), false)).not.toContain('Secure');
    vi.useRealTimers();
  });
});
