import { z } from 'zod';
import { errorResponse, json, readJson } from '../../../server/commerce-http';
import { getCommerce } from '../../../server/commerce';
import { route } from '../../../server/route';
import { getRuntime } from '../../../server/runtime';
import { PRIVATE, cartIdFromRequest, withCartCookie } from '../../../server/storefront';

export const dynamic = 'force-dynamic';

const create = z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/) });

/** Current cart with an estimate (list prices and promotions; shipping and tax need an address at checkout). */
export const GET = route(async (request) => {
  const cartId = cartIdFromRequest(request);
  if (!cartId) return json({ cart: null }, { headers: PRIVATE });
  try {
    const { carts, quotes } = await getCommerce();
    const { db } = getRuntime();
    const cart = await carts.get(db.primary, cartId);
    // A cart that became an order is history: the shopper starts a fresh bag.
    if (cart.status !== 'open') return json({ cart: null }, { headers: PRIVATE });
    if (cart.lines.length === 0)
      return json({ cart, items: [], estimate: null }, { headers: PRIVATE });
    const quote = await quotes.quote(db.primary, {
      cartId,
      destination: { line1: '-', city: '-', region: '', postalCode: '-', country: 'ZZ' },
    });
    return json(
      {
        cart,
        items: quote.lines.map((l) => {
          const priced = quote.pricing.lines.find((p) => p.lineId === l.lineId);
          return {
            variantId: l.variantId,
            handle: l.handle,
            title: l.title,
            sku: l.sku,
            image: l.image,
            quantity: l.quantity,
            unitPrice: l.unitPrice.toJSON(),
            lineTotal: (priced?.net ?? l.unitPrice.times(l.quantity)).toJSON(),
            discount: (priced?.discount ?? l.unitPrice.times(0)).toJSON(),
          };
        }),
        estimate: {
          currency: quote.currency,
          discounts: quote.pricing.discounts.map((d) => ({
            name: d.name,
            code: d.code,
            amount: d.amount.toJSON(),
          })),
          rejectedCoupons: quote.pricing.rejectedCoupons,
          subtotal: quote.subtotal.toJSON(),
          discountTotal: quote.discountTotal.toJSON(),
          net: quote.pricing.net.toJSON(),
          freeShipping: quote.pricing.freeShipping,
        },
      },
      { headers: PRIVATE },
    );
  } catch (error) {
    return errorResponse(error);
  }
});

export const POST = route(async (request) => {
  try {
    const body = create.parse(await readJson(request));
    const existing = cartIdFromRequest(request);
    const { carts } = await getCommerce();
    const { db } = getRuntime();
    // Idempotent: a shopper with a valid cart keeps it.
    const cart = existing ? await carts.get(db.primary, existing).catch(() => null) : null;
    const current =
      cart && cart.status === 'open'
        ? cart
        : await carts.create(db.primary, { currency: body.currency });
    return withCartCookie(
      json({ cart: current }, { status: cart ? 200 : 201, headers: PRIVATE }),
      current.id,
    );
  } catch (error) {
    return errorResponse(error);
  }
});
