import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cartCookie,
  deriveCartKey,
  readCartCookie,
  signCartToken,
  verifyCartToken,
} from './cart-token';

const root = Buffer.alloc(32, 7).toString('base64');
const key = deriveCartKey(root);

describe('cart token', () => {
  it('round-trips', () => {
    const id = randomUUID();
    expect(verifyCartToken(key, signCartToken(key, id))).toBe(id);
  });

  it('rejects tampering, another key, truncation and junk', () => {
    const id = randomUUID();
    const token = signCartToken(key, id);
    expect(verifyCartToken(key, `${randomUUID()}.${token.split('.')[1]}`)).toBeNull();
    expect(
      verifyCartToken(deriveCartKey(Buffer.alloc(32, 8).toString('base64')), token),
    ).toBeNull();
    expect(verifyCartToken(key, token.slice(0, -1))).toBeNull();
    for (const junk of [
      '',
      'x',
      `${id}.`,
      `${id}`,
      '.'.repeat(40),
      'a'.repeat(500),
      null,
      undefined,
    ])
      expect(verifyCartToken(key, junk as string | null)).toBeNull();
  });

  it('the bare cart id is not a credential', () => {
    expect(verifyCartToken(key, randomUUID())).toBeNull();
  });

  it('cookie helpers use __Host- only when secure, and are HttpOnly + SameSite', () => {
    const c = cartCookie('tok', { secure: true, maxAgeSeconds: 60 });
    expect(c).toMatch(
      /^__Host-sold_cart=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60; Secure$/,
    );
    expect(cartCookie('tok', { secure: false, maxAgeSeconds: 60 })).not.toMatch(/Secure|__Host/);
    expect(readCartCookie('a=b; __Host-sold_cart=tok; c=d', true)).toBe('tok');
    expect(readCartCookie('sold_cart=tok', true)).toBeNull(); // a non-__Host cookie is never trusted over https
    expect(readCartCookie(null, false)).toBeNull();
  });
});
