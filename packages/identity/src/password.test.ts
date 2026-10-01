import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from './password';
import { can, isKnownPermission, permissionPattern } from './rbac';
import { hashToken, newToken } from './tokens';

const fast = { N: 2 ** 12, r: 8, p: 1 };

describe('passwords', () => {
  it('round-trips, salts every hash, and rejects the wrong password', async () => {
    const a = await hashPassword('correct horse battery', fast);
    const b = await hashPassword('correct horse battery', fast);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('normalises unicode so visually identical passwords match', async () => {
    const h = await hashPassword('café-au-lait-2', fast);
    expect(await verifyPassword('café-au-lait-2', h)).toBe(true);
  });

  it('a malformed or hostile stored hash verifies false and never throws or spends unbounded work', async () => {
    for (const bad of [
      '',
      'x',
      'scrypt$1$1$1$aa$bb',
      'scrypt$4294967296$8$1$aa$bb',
      'scrypt$32768$999$999$aa$bb',
      'bcrypt$whatever',
      '$'.repeat(50),
    ])
      expect(await verifyPassword('pw', bad)).toBe(false);
  });

  it('needsRehash flags weaker parameters and unparseable hashes only', async () => {
    const weak = await hashPassword('pw-long-enough', fast);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, fast)).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });

  it('policy: length over composition; blocks common, repeated and email-derived passwords', () => {
    expect(checkPasswordPolicy('short').ok).toBe(false);
    expect(checkPasswordPolicy('x'.repeat(129)).ok).toBe(false);
    expect(checkPasswordPolicy('password123').ok).toBe(false);
    expect(checkPasswordPolicy('aaaaaaaaaaaa').ok).toBe(false);
    expect(checkPasswordPolicy('samshopper-2026!', { email: 'samshopper@example.com' }).ok).toBe(
      false,
    );
    expect(checkPasswordPolicy('long but memorable phrase').ok).toBe(true);
  });
});

describe('tokens', () => {
  it('are 256-bit, unique, and stored only as a hash', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toBe(hashToken(t));
  });
});

describe('rbac: extension permissions', () => {
  const key = 'loyalty-points.accounts.read';
  it('are exact grants; owner (*) holds them; area wildcards do not reach them', () => {
    expect(can([key], key)).toBe(true);
    expect(can(['*'], key)).toBe(true);
    expect(can(['orders:*', 'catalog:*'], key)).toBe(false);
    expect(can([key], 'loyalty-points.accounts.adjust')).toBe(false);
    expect(can(['loyalty-points.accounts.*'], key)).toBe(false); // no wildcards on extension keys
  });
  it('can only be granted to a role when an installed extension registered the key', () => {
    expect(isKnownPermission(key, [key])).toBe(true);
    expect(isKnownPermission(key, [])).toBe(false);
    expect(isKnownPermission('evil.made.up', [key])).toBe(false);
  });
});

describe('rbac', () => {
  it('matches exact, area wildcard and global wildcard; nothing else', () => {
    expect(can(['orders:read'], 'orders:read')).toBe(true);
    expect(can(['orders:read'], 'orders:write')).toBe(false);
    expect(can(['orders:*'], 'orders:cancel')).toBe(true);
    expect(can(['orders:*'], 'payments:refund')).toBe(false);
    expect(can(['*'], 'users:roles')).toBe(true);
    expect(can([], 'orders:read')).toBe(false);
  });

  it('a malformed or wildcard check is always denied (a check names one specific permission)', () => {
    for (const needed of [
      '*',
      'orders',
      'orders:',
      ':read',
      'Orders:Read',
      'orders:*',
      '',
      'orders:read:extra',
    ])
      expect(can(['*', 'orders:*'], needed), needed).toBe(false);
  });

  it('an area wildcard never leaks across area-name prefixes', () => {
    expect(can(['order:*'], 'orders:read')).toBe(false);
    expect(can(['orders:*'], 'orders-admin:read')).toBe(false);
  });

  it('permission syntax and known-permission validation', () => {
    expect(permissionPattern.test('catalog:write')).toBe(true);
    expect(permissionPattern.test('catalog write')).toBe(false);
    expect(isKnownPermission('catalog:publish')).toBe(true);
    expect(isKnownPermission('catalog:destroy')).toBe(false);
    expect(isKnownPermission('loyalty:adjust')).toBe(false);
    expect(isKnownPermission('loyalty:adjust', ['loyalty:adjust'])).toBe(true);
  });
});
