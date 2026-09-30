import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Anonymous carts are addressed by an unguessable, signed token held in an HttpOnly cookie. The cart id alone is
 * never enough: a UUID that leaks in a log or a URL must not let anyone else read or change the cart. The token is
 * `<cartId>.<hmac>`; verification is constant-time and fails closed on any malformed input.
 */
export function deriveCartKey(rootKeyBase64: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(rootKeyBase64, 'base64'),
      Buffer.alloc(0),
      'sold:cart-token:v1',
      32,
    ),
  );
}

export function signCartToken(key: Buffer, cartId: string): string {
  const mac = createHmac('sha256', key).update(`cart:${cartId}`).digest('base64url');
  return `${cartId}.${mac}`;
}

/** Returns the cart id if the token is authentic, else null. */
export function verifyCartToken(key: Buffer, token: string | null | undefined): string | null {
  if (!token || token.length > 128) return null;
  const dot = token.indexOf('.');
  if (dot !== 36) return null;
  const cartId = token.slice(0, dot);
  if (!UUID.test(cartId)) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(createHmac('sha256', key).update(`cart:${cartId}`).digest('base64url'));
  return given.length === want.length && timingSafeEqual(given, want) ? cartId : null;
}

export const CART_COOKIE = 'sold_cart';

export function cartCookie(
  token: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  // `__Host-` needs Secure + Path=/ and no Domain; only usable over https, so plain http local dev uses a plain name.
  const name = opts.secure ? `__Host-${CART_COOKIE}` : CART_COOKIE;
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opts.maxAgeSeconds}${opts.secure ? '; Secure' : ''}`;
}

export function readCartCookie(header: string | null, secure: boolean): string | null {
  if (!header) return null;
  const name = secure ? `__Host-${CART_COOKIE}` : CART_COOKIE;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
