import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, tamper-proof state for flows that cross a redirect (OIDC state/nonce/PKCE verifier): the payload is signed
 * with HMAC-SHA256 and carries its own expiry. It is NOT encrypted: never put a secret in it that the browser must not see.
 */
export function seal(
  key: Buffer,
  payload: Record<string, unknown>,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }),
  ).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function open<T extends Record<string, unknown>>(
  key: Buffer,
  token: string | null | undefined,
  now = Date.now(),
): T | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
      exp?: number;
    };
    return typeof parsed.exp === 'number' && parsed.exp * 1000 > now ? parsed : null;
  } catch {
    return null;
  }
}
