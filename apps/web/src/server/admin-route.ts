import type { ResolvedUser } from '@sold/identity';
import { can, ForbiddenError, UnauthenticatedError, recordAudit } from '@sold/identity';
import type { PrimaryDb } from '@sold/db';
import { errorResponse } from './commerce-http';
import { assertSameOrigin } from './csrf';
import { clientIp, currentSession } from './identity';
import { route, type RouteContext } from './route';
import { getRuntime } from './runtime';

export interface AdminContext extends RouteContext {
  user: ResolvedUser;
  ip: string | null;
  db: PrimaryDb;
  /** Record what this user did. Pass a transaction to commit the record with the change. */
  audit(
    action: string,
    target: { type: string; id: string },
    detail?: Record<string, unknown>,
    tx?: Parameters<typeof recordAudit>[0],
  ): Promise<void>;
}

/**
 * A staff-only API route. Order of checks is deliberate: same-origin (CSRF) first, then authentication, then the one
 * authorisation primitive `can()`. Every error is a stable JSON shape; nothing about *why* a session failed is revealed.
 */
export function adminRoute(
  permission: string | null,
  handler: (request: Request, ctx: AdminContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return route(async (request, ctx) => {
    try {
      assertSameOrigin(request);
      const session = await currentSession(request.headers.get('cookie'), 'staff');
      if (!session) throw new UnauthenticatedError();
      if (permission && !can(session.user.permissions, permission))
        throw new ForbiddenError(permission);
      const db = getRuntime().db.primary;
      const ip = clientIp(request);
      const audit: AdminContext['audit'] = (action, target, detail, tx) =>
        recordAudit(tx ?? db, {
          actorId: session.user.id,
          actorLabel: session.user.email,
          action,
          targetType: target.type,
          targetId: target.id,
          ...(detail ? { detail } : {}),
          ip,
        });
      const response = await handler(request, { ...ctx, user: session.user, ip, db, audit });
      response.headers.set('cache-control', 'private, no-store');
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export { can };

/** For handlers whose permission depends on the request body (e.g. going live, cancelling). Same primitive, same error. */
export function requireCan(user: ResolvedUser, permission: string): void {
  if (!can(user.permissions, permission)) throw new ForbiddenError(permission);
}
