import { ForbiddenError } from '@sold/core/extensions';
import { describe, expect, it } from 'vitest';
import { rbacAuthorizer } from './authorizer';

const admin = (permissions: string[]) => ({ id: 'u', kind: 'admin' as const, permissions });
const allowed = (s: Parameters<typeof rbacAuthorizer.authorize>[0], p: string) =>
  rbacAuthorizer.authorize(s, p).then(
    () => true,
    (e: unknown) => (e instanceof ForbiddenError ? false : Promise.reject(e)),
  );

describe('rbacAuthorizer', () => {
  it('maps base.* permissions onto the RBAC vocabulary', async () => {
    expect(await allowed(admin(['orders:read']), 'base.orders.read')).toBe(true);
    expect(await allowed(admin(['orders:read']), 'base.orders.write')).toBe(false);
    expect(await allowed(admin(['content:*']), 'base.pages.write')).toBe(true);
    expect(await allowed(admin(['catalog:*']), 'base.orders.read')).toBe(false);
    expect(await allowed(admin(['*']), 'base.audit.read')).toBe(true);
  });
  it('checks extension keys exactly', async () => {
    expect(await allowed(admin(['reviews.moderate']), 'reviews.moderate')).toBe(true);
    expect(await allowed(admin(['orders:*']), 'reviews.moderate')).toBe(false);
  });
  it('only staff carry permissions: customers, api keys, system and anonymous are refused', async () => {
    for (const kind of ['customer', 'api-key', 'system'] as const)
      expect(await allowed({ id: 'x', kind, permissions: ['*'] }, 'reviews.moderate')).toBe(false);
    expect(await allowed(null, 'reviews.moderate')).toBe(false);
  });
  it('an unmapped base.* key is not silently satisfied', async () => {
    expect(await allowed(admin(['orders:*', 'catalog:*']), 'base.nonsense.read')).toBe(false);
  });
});
