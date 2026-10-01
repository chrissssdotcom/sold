import instanceConfig from '../../../../../../../sold.config';
import { getIdentity } from '../../../../server/identity';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';

export const dynamic = 'force-dynamic';

const MAX_BODY = 1024 * 1024;

/** SCIM 2.0 endpoint (bearer-token authenticated, never cookie-authenticated, so CSRF does not apply). Off unless enabled in config. */
const handler = route(async (request) => {
  if (!instanceConfig.identity.scim.enabled)
    return Response.json({ detail: 'SCIM is not enabled' }, { status: 404 });
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/scim\/v2/, '') || '/';
  let body: unknown;
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
    const text = await request.text();
    if (text.length > MAX_BODY) return Response.json({ detail: 'Body too large' }, { status: 413 });
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return new Response(
        JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
          status: '400',
          scimType: 'invalidSyntax',
          detail: 'Invalid JSON',
        }),
        { status: 400, headers: { 'content-type': 'application/scim+json' } },
      );
    }
  }
  const { scim } = getIdentity();
  const service = instanceConfig.identity.scim.managedRoles
    ? new (scim.constructor as new (o: { managedRoles?: string[] }) => typeof scim)({
        managedRoles: instanceConfig.identity.scim.managedRoles,
      })
    : scim;
  const r = await service.handle(getRuntime().db.primary, {
    method: request.method,
    path,
    query: url.searchParams,
    body,
    authorization: request.headers.get('authorization'),
    baseUrl: `${url.origin}/scim/v2`,
  });
  return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store' },
  });
});
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
