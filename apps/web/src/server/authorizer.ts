import { ForbiddenError, type Authorizer } from '@sold/core/extensions';
import { can } from '@sold/identity';

/**
 * Extension routes go through the same `can()` primitive as the admin API. Only staff carry permissions; customers and
 * anonymous callers can reach `public` routes (which skip authorisation) and nothing else. API keys and system actors
 * are not granted anything until they have their own issuance and audit story.
 */
export const rbacAuthorizer: Authorizer = {
  async authorize(subject, permission) {
    if (subject?.kind === 'admin' && can(subject.permissions ?? [], permission)) return;
    throw new ForbiddenError(permission);
  },
};
