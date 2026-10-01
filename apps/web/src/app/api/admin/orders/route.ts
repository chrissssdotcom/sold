import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { listQuery, queryOf } from '../../../../server/admin/http';
import * as q from '../../../../server/admin/queries';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('orders:read', async (req, { db }) =>
  json(await q.listOrders(db, listQuery.parse(queryOf(req)))),
);
