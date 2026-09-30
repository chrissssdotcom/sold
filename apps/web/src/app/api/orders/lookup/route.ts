import { NotFoundError } from '@sold/commerce';
import { verifyOrderToken } from '../../../../server/cart-token';
import { cartKey, getCommerce } from '../../../../server/commerce';
import { errorResponse, json } from '../../../../server/commerce-http';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

/** Order confirmation for the holder of the order token (shown right after checkout; no account needed). */
export const GET = route(async (request) => {
  try {
    const token = new URL(request.url).searchParams.get('token');
    const id = verifyOrderToken(cartKey(), token);
    if (!id) throw new NotFoundError('Order', 'token');
    const { orders } = await getCommerce();
    const o = await orders.get(getRuntime().db.primary, id);
    return json(
      {
        order: {
          number: o.number,
          status: o.status,
          email: o.email,
          currency: o.currency,
          subtotal: o.subtotal.toJSON(),
          discountTotal: o.discountTotal.toJSON(),
          shippingTotal: o.shippingTotal.toJSON(),
          taxTotal: o.taxTotal.toJSON(),
          total: o.total.toJSON(),
          placedAt: o.placedAt,
          lines: o.lines.map((l) => ({
            title: l.title,
            sku: l.sku,
            quantity: l.quantity,
            unitPrice: l.unitPrice.toJSON(),
            lineTotal: l.lineTotal.toJSON(),
          })),
        },
      },
      { headers: PRIVATE },
    );
  } catch (error) {
    return errorResponse(error);
  }
});
