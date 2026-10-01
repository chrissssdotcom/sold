import { z } from 'zod';
import { getCommerce } from '../../../../server/commerce';
import { errorResponse, json, readJson } from '../../../../server/commerce-http';
import { assertSameOrigin } from '../../../../server/csrf';
import { clientIp, getIdentity, sessionCookie } from '../../../../server/identity';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE, cartIdFromRequest, withCartCookie } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

const body = z.strictObject({ email: z.string().max(254), password: z.string().max(200) });

export const POST = route(async (request) => {
  try {
    assertSameOrigin(request);
    const input = body.parse(await readJson(request));
    const { db } = getRuntime();
    const { user, token, expiresAt } = await getIdentity().auth.login(db.primary, input, {
      kind: 'customer',
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
    });
    let res = json(
      { user: { id: user.id, email: user.email, name: user.name } },
      { headers: PRIVATE },
    );
    // Bring the anonymous bag along: it merges into any open cart this customer already has.
    const guest = cartIdFromRequest(request);
    if (guest) {
      const { carts } = await getCommerce();
      const cart = await carts.claim(db.primary, guest, user.id).catch(() => null);
      if (cart) res = withCartCookie(res, cart.id);
    }
    res.headers.append('set-cookie', sessionCookie('customer', token, expiresAt));
    return res;
  } catch (error) {
    return errorResponse(error);
  }
});
