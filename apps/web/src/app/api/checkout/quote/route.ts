import { z } from 'zod';
import { addressSchema } from '@sold/commerce';
import { errorResponse, json, readJson } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE, requireCartId } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

const body = z.strictObject({
  shippingAddress: addressSchema,
  shippingMethodId: z.string().min(1).max(64).optional(),
});

/** Shipping options, tax and the final total for an address: what the shopper reviews before confirming. */
export const POST = route(async (request) => {
  try {
    const input = body.parse(await readJson(request));
    const cartId = requireCartId(request);
    const { quotes } = await getCommerce();
    const q = await quotes.quote(getRuntime().db.primary, {
      cartId,
      destination: input.shippingAddress,
      ...(input.shippingMethodId ? { shippingMethodId: input.shippingMethodId } : {}),
    });
    return json(
      {
        currency: q.currency,
        cartVersion: q.cartVersion,
        lines: q.pricing.lines,
        discounts: q.pricing.discounts.map((d) => ({
          name: d.name,
          code: d.code,
          amount: d.amount.toJSON(),
        })),
        rejectedCoupons: q.pricing.rejectedCoupons,
        shippingOptions: q.shippingOptions.map((o) => ({ ...o, amount: o.amount.toJSON() })),
        selectedShipping: q.shipping?.methodId ?? null,
        pricesIncludeTax: q.pricesIncludeTax,
        subtotal: q.subtotal.toJSON(),
        discountTotal: q.discountTotal.toJSON(),
        shippingTotal: q.shippingTotal.toJSON(),
        taxTotal: q.taxTotal.toJSON(),
        total: q.total.toJSON(),
      },
      { headers: PRIVATE },
    );
  } catch (error) {
    return errorResponse(error);
  }
});
