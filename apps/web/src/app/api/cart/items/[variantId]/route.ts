import { z } from 'zod';
import { errorResponse, json, readJson } from '../../../../../server/commerce-http';
import { getCommerce } from '../../../../../server/commerce';
import { route } from '../../../../../server/route';
import { getRuntime } from '../../../../../server/runtime';
import { PRIVATE, requireCartId } from '../../../../../server/storefront';

export const dynamic = 'force-dynamic';

const patch = z.strictObject({
  quantity: z.number().int().min(0).max(99),
  expectedVersion: z.number().int().min(1).optional(),
});
const variantIdOf = (request: Request) =>
  z.uuid().parse(new URL(request.url).pathname.split('/').pop());

export const PATCH = route(async (request) => {
  try {
    const variantId = variantIdOf(request);
    const body = patch.parse(await readJson(request));
    const cartId = requireCartId(request);
    const { carts } = await getCommerce();
    const cart = await carts.setQuantity(
      getRuntime().db.primary,
      cartId,
      variantId,
      body.quantity,
      {
        ...(body.expectedVersion ? { expectedVersion: body.expectedVersion } : {}),
      },
    );
    return json({ cart }, { headers: PRIVATE });
  } catch (error) {
    return errorResponse(error);
  }
});

export const DELETE = route(async (request) => {
  try {
    const variantId = variantIdOf(request);
    const cartId = requireCartId(request);
    const { carts } = await getCommerce();
    const cart = await carts.setQuantity(getRuntime().db.primary, cartId, variantId, 0);
    return json({ cart }, { headers: PRIVATE });
  } catch (error) {
    return errorResponse(error);
  }
});
