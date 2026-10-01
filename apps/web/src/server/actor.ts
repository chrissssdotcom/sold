import type { Actor } from '@sold/extension-sdk';
import { assertSameOrigin, CsrfError } from './csrf';
import { currentSession } from './identity';

/**
 * Who is calling an extension route, from the session cookies. `staffOnly` is for `/admin/x`: a customer session is
 * never an admin actor. Cookie-authenticated, state-changing requests must also pass the same-origin check, so an
 * extension's POST route is as CSRF-safe as Base's own (a failed check resolves to "not signed in").
 */
export async function resolveActorFromRequest(
  request: Request,
  opts: { staffOnly?: boolean } = {},
): Promise<Actor | null> {
  const cookie = request.headers.get('cookie');
  const staff = await currentSession(cookie, 'staff');
  const customer = staff || opts.staffOnly ? null : await currentSession(cookie, 'customer');
  const session = staff ?? customer;
  if (!session) return null;
  try {
    assertSameOrigin(request, { requireJson: false });
  } catch (error) {
    if (error instanceof CsrfError) return null;
    throw error;
  }
  return {
    id: session.user.id,
    kind: staff ? 'admin' : 'customer',
    ...(staff ? { permissions: session.user.permissions } : {}),
  };
}
