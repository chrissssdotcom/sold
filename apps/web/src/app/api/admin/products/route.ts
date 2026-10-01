import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { body, listQuery, queryOf } from '../../../../server/admin/http';
import { getCommerce } from '../../../../server/commerce';
import * as q from '../../../../server/admin/queries';
import { productInput } from '@sold/commerce';
import { requireCan } from '../../../../server/admin-route';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('catalog:read', async (req, { db }) =>
  json(await q.listProducts(db, listQuery.parse(queryOf(req)))),
);

export const POST = adminRoute('catalog:write', async (req, { db, audit, user }) => {
  const input = await body(req, productInput);
  const { catalog } = await getCommerce();
  // Going live is its own permission: creating a draft must not be a way around `catalog:publish`.
  if (input.status === 'active') requireCan(user, 'catalog:publish');
  const product = await catalog.create(db, input);
  await audit('product.created', { type: 'product', id: product.id }, { handle: product.handle });
  return json(product, { status: 201 });
});
