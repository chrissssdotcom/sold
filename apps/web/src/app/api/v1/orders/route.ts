import { json } from '../../../../server/commerce-http';
import { apiRoute, pageParams } from '../../../../server/api-v1';
import { listOrders } from '../../../../server/admin/queries';
import { getRuntime } from '../../../../server/runtime';

export const dynamic = 'force-dynamic';

/** Newest first. `status` filter, `limit` (max 50), `before` = the previous page's `nextCursor`. */
export const GET = apiRoute('orders:read', async (request) => {
  const { limit, before, status } = pageParams(request);
  const page = await listOrders(getRuntime().db.primary, {
    limit,
    ...(before ? { before } : {}),
    ...(status ? { status } : {}),
  });
  return json({
    items: page.items.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      email: o.email,
      placedAt: o.placedAt.toISOString(),
      total: { amount: o.total, currency: o.currency.trim() },
    })),
    nextCursor: page.nextCursor,
  });
});
