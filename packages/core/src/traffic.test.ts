import { describe, expect, it } from 'vitest';
import {
  routeClassOf,
  shedBelowFrom,
  shedBelowFromEnv,
  shouldShed,
  strictestShed,
} from './traffic';

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

describe('shedding decisions', () => {
  it('no flags -> nothing shed; the highest-priority class turned on wins', () => {
    expect(shedBelowFrom(new Set())).toBeNull();
    expect(shedBelowFrom(new Set(['shed.reporting']))).toBe('reporting');
    expect(shedBelowFrom(new Set(['shed.reporting', 'shed.account']))).toBe('account');
    expect(shedBelowFrom(new Set(['shed.cart', 'shed.admin']))).toBe('cart');
  });
  it('checkout can never be shed, by flag or environment', () => {
    expect(shedBelowFrom(new Set(['shed.checkout']))).toBeNull();
    expect(shedBelowFromEnv('checkout')).toBeNull();
    expect(shedBelowFromEnv('internal')).toBeNull();
    expect(shedBelowFromEnv('browse')).toBe('browse');
    expect(shedBelowFromEnv('junk')).toBeNull();
    for (const below of ['reporting', 'admin', 'account', 'browse', 'cart'] as const) {
      expect(shouldShed('checkout', below)).toBe(false);
      expect(shouldShed('internal', below)).toBe(false);
    }
  });
  it('shedding at browse sheds browse and everything below, not cart', () => {
    expect(shouldShed('browse', 'browse')).toBe(true);
    expect(shouldShed('account', 'browse')).toBe(true);
    expect(shouldShed('cart', 'browse')).toBe(false);
  });
  it('strictest picks the one that protects more', () => {
    expect(strictestShed(null, 'admin')).toBe('admin');
    expect(strictestShed('browse', 'admin')).toBe('browse');
    expect(strictestShed(null, null)).toBeNull();
  });
});
