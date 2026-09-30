import { errorResponse, json } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { getPaymentsFor } from '../../../../server/payments';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  try {
    const currency = new URL(request.url).searchParams.get('currency') ?? '';
    const payments = getPaymentsFor(getRuntime().env, await getCommerce());
    return json({ gateways: payments.listGateways(currency) }, { headers: PRIVATE });
  } catch (error) {
    return errorResponse(error);
  }
});
