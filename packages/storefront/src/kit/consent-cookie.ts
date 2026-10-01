/**
 * Cookie-consent record. Pure (no DOM), so the server can read exactly what the browser wrote.
 *
 * The cookie is `sold_consent=<url-encoded JSON>`: `{ a: 0|1, m: 0|1, t: <epoch seconds>, s: 'user'|'gpc' }`
 * (analytics, marketing, decided-at, source). Absent or malformed means "no decision": nothing optional is allowed.
 */
export const CONSENT_COOKIE = 'sold_consent';
/** Re-ask after six months. */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export interface Consent {
  /** Measurement that does not advertise (page-view analytics). */
  analytics: boolean;
  /** Advertising pixels, remarketing, server-side conversion events. */
  marketing: boolean;
  /** Epoch seconds the choice was made; null while undecided. */
  decidedAt: number | null;
  source: 'user' | 'gpc' | 'default';
}

export const NO_CONSENT: Consent = {
  analytics: false,
  marketing: false,
  decidedAt: null,
  source: 'default',
};

export function serializeConsent(c: Consent): string {
  return encodeURIComponent(
    JSON.stringify({ a: c.analytics ? 1 : 0, m: c.marketing ? 1 : 0, t: c.decidedAt, s: c.source }),
  );
}

/** Parse the cookie VALUE. Anything unexpected is "no consent": failing closed is the lawful default. */
export function parseConsent(value: string | null | undefined): Consent {
  if (!value || value.length > 200) return NO_CONSENT;
  try {
    const o = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
    const t = typeof o['t'] === 'number' && Number.isFinite(o['t']) ? o['t'] : null;
    if (t === null) return NO_CONSENT;
    const age = Date.now() / 1000 - t;
    if (age > CONSENT_MAX_AGE_SECONDS) return NO_CONSENT; // expired: ask again
    const s = o['s'] === 'gpc' ? 'gpc' : 'user';
    return {
      analytics: o['a'] === 1,
      // A Global Privacy Control signal is an opt-out of sale/sharing: it can never be recorded as marketing consent.
      marketing: o['m'] === 1 && s !== 'gpc',
      decidedAt: t,
      source: s,
    };
  } catch {
    return NO_CONSENT;
  }
}

/** Read the consent cookie out of a `Cookie` request header. */
export function consentFromCookieHeader(header: string | null | undefined): Consent {
  if (!header) return NO_CONSENT;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === CONSENT_COOKIE)
      return parseConsent(part.slice(i + 1).trim());
  }
  return NO_CONSENT;
}

export function consentCookieString(c: Consent, secure: boolean): string {
  return `${CONSENT_COOKIE}=${serializeConsent(c)}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}
