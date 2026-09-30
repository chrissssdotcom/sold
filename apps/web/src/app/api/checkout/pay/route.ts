import { z } from 'zod';
import { errorResponse, json, readJson } from '../../../../server/commerce-http';
import { verifyOrderToken } from '../../../../server/cart-token';
import { cartKey, getCommerce } from '../../../../server/commerce';
import { getPaymentsFor } from '../../../../server/payments';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE } from '../../../../server/storefront';
import { NotFoundError } from '@sold/commerce';

export const dynamic = 'force-dynamic';

const body = z.strictObject({
  orderToken: z.string().max(128),
  gatewayId: z.string().min(1).max(40),
  returnUrl: z.url().max(500).optional(),
});

export const POST = route(async (request) => {
  try {
    const input = body.parse(await readJson(request));
    const orderId = verifyOrderToken(cartKey(), input.orderToken);
    if (!orderId) throw new NotFoundError('Order', 'token');
    const rt = getRuntime();
    const payments = getPaymentsFor(rt.env, await getCommerce());
    const started = await payments.start(rt.db.primary, {
      orderId,
      gatewayId: input.gatewayId,
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    });
    return json({ payment: started }, { headers: PRIVATE });
  } catch (error) {
    return errorResponse(error);
  }
});
