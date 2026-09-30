import { z } from 'zod';
import { errorResponse, json, readJson } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE, requireCartId } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

export const POST = route(async (request) => {
  try {
    const { code } = z
      .strictObject({ code: z.string().min(1).max(64) })
      .parse(await readJson(request));
    const cartId = requireCartId(request);
    const { carts } = await getCommerce();
    return json(
      { cart: await carts.applyCoupon(getRuntime().db.primary, cartId, code) },
      { headers: PRIVATE },
    );
  } catch (error) {
    return errorResponse(error);
  }
});
