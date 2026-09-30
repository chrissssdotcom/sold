import { z } from 'zod';
import { errorResponse, json, readJson } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE, requireCartId } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

const add = z.strictObject({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(99),
  expectedVersion: z.number().int().min(1).optional(),
});

export const POST = route(async (request) => {
  try {
    const body = add.parse(await readJson(request));
    const cartId = requireCartId(request);
    const { carts } = await getCommerce();
    const cart = await carts.addItem(
      getRuntime().db.primary,
      cartId,
      body.variantId,
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
