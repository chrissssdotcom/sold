import {
  CART_COOKIE,
  cartCookie,
  readCartCookie,
  signCartToken,
  verifyCartToken,
} from './cart-token';
import { cartKey, cookiesAreSecure, getCommerce } from './commerce';
import { NotFoundError } from '@sold/commerce';

const CART_COOKIE_SECONDS = 30 * 24 * 3600;

/** The cart id proved by the request's signed cookie, or null. A bare cart id in a URL or body is never trusted. */
export function cartIdFromRequest(request: Request): string | null {
  const token = readCartCookie(request.headers.get('cookie'), cookiesAreSecure());
  return verifyCartToken(cartKey(), token);
}

export function requireCartId(request: Request): string {
  const id = cartIdFromRequest(request);
  if (!id) throw new NotFoundError('Cart', 'current');
  return id;
}

export function withCartCookie(response: Response, cartId: string): Response {
  response.headers.append(
    'set-cookie',
    cartCookie(signCartToken(cartKey(), cartId), {
      secure: cookiesAreSecure(),
      maxAgeSeconds: CART_COOKIE_SECONDS,
    }),
  );
  return response;
}

/** Cart responses are private and per-shopper: never cacheable by a shared cache. */
export const PRIVATE = { 'cache-control': 'private, no-store' } as const;

export { CART_COOKIE, getCommerce };
