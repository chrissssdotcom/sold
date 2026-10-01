import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { parseId } from '../../../../../server/admin/http';
import { getCommerce } from '../../../../../server/commerce';
import * as q from '../../../../../server/admin/queries';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('orders:read', async (req, { db }) => {
  const id = parseId(new URL(req.url).pathname.split('/').pop());
  const { orders } = await getCommerce();
  const [order, payments] = await Promise.all([orders.get(db, id), q.orderPayments(db, id)]);
  return json({ order, payments });
});
