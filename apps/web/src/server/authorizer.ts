import { ForbiddenError, type Authorizer } from '@sold/core/extensions';
import { can } from '@sold/identity';

/**
 * Extension routes go through the same `can()` primitive as the admin API. Only staff carry permissions; customers and
 * anonymous callers can reach `public` routes (which skip authorisation) and nothing else. API keys and system actors
 * are not granted anything until they have their own issuance and audit story.
 */
/**
 * Extensions may declare Base permissions as `base.<area>.<action>`. They map onto the RBAC vocabulary here, once, so
 * a role granting `orders:read` satisfies `base.orders.read`. Anything unmapped is checked as an exact key.
 */
const BASE_TO_RBAC: Record<string, string> = {
  'base.catalog.read': 'catalog:read',
  'base.catalog.write': 'catalog:write',
  'base.orders.read': 'orders:read',
  'base.orders.write': 'orders:write',
  'base.customers.read': 'customers:read',
  'base.customers.write': 'customers:write',
  'base.pages.write': 'content:write',
  'base.settings.write': 'settings:write',
  'base.extensions.manage': 'extensions:write',
  'base.reports.read': 'reports:read',
  'base.audit.read': 'audit:read',
};

/** The RBAC permission that satisfies a manifest-declared one (`base.orders.read` -> `orders:read`; extension keys map to themselves). */
export const permissionFor = (permission: string): string => BASE_TO_RBAC[permission] ?? permission;

export const rbacAuthorizer: Authorizer = {
  async authorize(subject, permission) {
    if (subject?.kind === 'admin' && can(subject.permissions ?? [], permissionFor(permission)))
      return;
    throw new ForbiddenError(permission);
  },
};
