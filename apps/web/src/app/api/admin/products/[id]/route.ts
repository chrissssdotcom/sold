import { z } from 'zod';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { body, parseId } from '../../../../../server/admin/http';
import { getCommerce } from '../../../../../server/commerce';
import { requireCan } from '../../../../../server/admin-route';

export const dynamic = 'force-dynamic';
const segment = (req: Request) => new URL(req.url).pathname.split('/').pop();

export const GET = adminRoute('catalog:read', async (req, { db }) => {
  const { catalog } = await getCommerce();
  return json(await catalog.getById(db, parseId(segment(req))));
});

const patch = z.strictObject({ status: z.enum(['draft', 'active', 'archived']) });

export const PATCH = adminRoute('catalog:write', async (req, { db, audit, user }) => {
  const id = parseId(segment(req));
  const { status } = await body(req, patch);
  if (status === 'active') requireCan(user, 'catalog:publish');
  const { catalog } = await getCommerce();
  await catalog.setStatus(db, id, status);
  await audit('product.status', { type: 'product', id }, { status });
  return json({ ok: true });
});
