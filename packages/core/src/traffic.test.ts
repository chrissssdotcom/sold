import { describe, expect, it } from 'vitest';
import { routeClassOf, shouldShed } from './traffic';

describe('routeClassOf', () => {
  it.each([
    ['/checkout', 'checkout'],
    ['/api/checkout/session', 'checkout'],
    ['/en-au/checkout/pay', 'checkout'],
    ['/api/cart/items', 'cart'],
    ['/products/hoodie', 'browse'],
    ['/', 'browse'],
    ['/account/orders', 'account'],
    ['/admin/pages', 'admin'],
    ['/scim/v2/Users', 'reporting'],
    ['/api/health/ready', 'internal'],
    ['/metrics', 'internal'],
    ['/checkoutfoo', 'browse'],
  ] as const)('%s -> %s', (path, cls) => expect(routeClassOf(path)).toBe(cls));
});

describe('shouldShed', () => {
  it('sheds the given class and everything lower, never checkout above it or probes', () => {
    expect(shouldShed('admin', 'account')).toBe(true);
    expect(shouldShed('account', 'account')).toBe(true);
    expect(shouldShed('browse', 'account')).toBe(false);
    expect(shouldShed('checkout', 'browse')).toBe(false);
    expect(shouldShed('internal', 'checkout')).toBe(false);
    expect(shouldShed('checkout', null)).toBe(false);
  });
});
