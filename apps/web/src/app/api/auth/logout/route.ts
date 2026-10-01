import { errorResponse, json } from '../../../../server/commerce-http';
import { assertSameOrigin } from '../../../../server/csrf';
import { clearSessionCookie, getIdentity, sessionToken } from '../../../../server/identity';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

export const POST = route(async (request) => {
  try {
    assertSameOrigin(request, { requireJson: false });
    const token = sessionToken(request.headers.get('cookie'), 'customer');
    if (token) await getIdentity().sessions.revoke(getRuntime().db.primary, token);
    const res = json({ ok: true }, { headers: PRIVATE });
    res.headers.append('set-cookie', clearSessionCookie('customer'));
    return res;
  } catch (error) {
    return errorResponse(error);
  }
});
