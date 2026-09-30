import { errorResponse, json } from '../../../../../server/commerce-http';
import { getCommerce } from '../../../../../server/commerce';
import { route } from '../../../../../server/route';
import { getRuntime } from '../../../../../server/runtime';
import { PRIVATE, requireCartId } from '../../../../../server/storefront';

export const dynamic = 'force-dynamic';

export const DELETE = route(async (request) => {
  try {
    const code = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
    const cartId = requireCartId(request);
    const { carts } = await getCommerce();
    return json(
      { cart: await carts.removeCoupon(getRuntime().db.primary, cartId, code) },
      { headers: PRIVATE },
    );
  } catch (error) {
    return errorResponse(error);
  }
});
