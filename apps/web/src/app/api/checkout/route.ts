import { z } from 'zod';
import { addressSchema, CommerceError } from '@sold/commerce';
import { errorResponse, json, readJson } from '../../../server/commerce-http';
import { getCommerce } from '../../../server/commerce';
import { getCommerceMetrics } from '../../../server/commerce-metrics';
import { currentSession } from '../../../server/identity';
import { route } from '../../../server/route';
import { getRuntime } from '../../../server/runtime';
import { PRIVATE, requireCartId } from '../../../server/storefront';
import { consentFromCookieHeader } from '@sold/storefront/consent';
import { signOrderToken } from '../../../server/cart-token';
import { cartKey } from '../../../server/commerce';

export const dynamic = 'force-dynamic';

// The cart comes from the signed cookie, never from the body.
const body = z.strictObject({
  email: z.email().max(254),
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  shippingMethodId: z.string().min(1).max(64),
});

export const POST = route(async (request) => {
  const metrics = getCommerceMetrics();
  const started = performance.now();
  try {
    const input = body.parse(await readJson(request));
    const cartId = requireCartId(request);
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey)
      throw new CommerceError(
        'idempotency_key_required',
        'An Idempotency-Key header is required',
        400,
      );
    // A signed-in customer's order is linked to their account; a guest's is not (the order token still lets them view it).
    const session = await currentSession(request.headers.get('cookie'), 'customer');
    const cookieConsent = consentFromCookieHeader(request.headers.get('cookie'));
    const { checkout } = await getCommerce();
    const { order, replayed } = await checkout.place(
      getRuntime().db.primary,
      {
        ...input,
        cartId,
        customerId: session?.user.id ?? null,
        // From the cookie the browser holds, never from the request body: a client cannot claim consent it did not give.
        consent: {
          analytics: cookieConsent.analytics,
          marketing: cookieConsent.marketing,
        },
      },
      idempotencyKey,
    );
    metrics.checkout.inc({ outcome: replayed ? 'replayed' : 'placed' });
    return json(
      {
        order: {
          id: order.orderId,
          number: order.number,
          status: order.status,
          total: order.total.toJSON(),
          payBy: order.payBy,
        },
        orderToken: signOrderToken(cartKey(), order.orderId),
        replayed,
      },
      { status: replayed ? 200 : 201, headers: PRIVATE },
    );
  } catch (error) {
    metrics.checkout.inc({ outcome: CommerceError.is(error) ? error.code : 'error' });
    return errorResponse(error);
  } finally {
    metrics.checkoutDuration.observe((performance.now() - started) / 1000);
  }
});
