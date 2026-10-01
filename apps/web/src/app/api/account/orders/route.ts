import { errorResponse, json } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { currentSession } from '../../../../server/identity';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';
import { PRIVATE } from '../../../../server/storefront';

export const dynamic = 'force-dynamic';

export const GET = route(async (request) => {
  try {
    const session = await currentSession(request.headers.get('cookie'), 'customer');
    if (!session)
      return json(
        { error: { code: 'unauthenticated', message: 'Sign in to continue' } },
        { status: 401, headers: PRIVATE },
      );
    const { orders } = await getCommerce();
    const list = await orders.listForCustomer(getRuntime().db.primary, session.user.id, {
      limit: 50,
    });
    return json(
      { orders: list.map((o) => ({ ...o, total: o.total.toJSON() })) },
      { headers: PRIVATE },
    );
  } catch (error) {
    return errorResponse(error);
  }
});
