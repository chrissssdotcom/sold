import { z } from 'zod';
import { errorResponse, json, readJson } from '../../../../../server/commerce-http';
import { assertSameOrigin } from '../../../../../server/csrf';
import { clientIp, getIdentity, sessionCookie } from '../../../../../server/identity';
import { route } from '../../../../../server/route';
import { getRuntime } from '../../../../../server/runtime';
import { PRIVATE } from '../../../../../server/storefront';

export const dynamic = 'force-dynamic';

const body = z.strictObject({ email: z.string().max(254), password: z.string().max(200) });

/** Staff sign-in with a password (SSO has its own routes). Staff sessions are short, idle out fast and use SameSite=Strict. */
export const POST = route(async (request) => {
  try {
    assertSameOrigin(request);
    const input = body.parse(await readJson(request));
    const { user, token, expiresAt } = await getIdentity().auth.login(
      getRuntime().db.primary,
      input,
      { kind: 'staff', ip: clientIp(request), userAgent: request.headers.get('user-agent') },
    );
    const res = json(
      { user: { id: user.id, email: user.email, name: user.name } },
      { headers: PRIVATE },
    );
    res.headers.append('set-cookie', sessionCookie('staff', token, expiresAt));
    return res;
  } catch (error) {
    return errorResponse(error);
  }
});
