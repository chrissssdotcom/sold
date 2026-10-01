import { json } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { apiRoute } from '../../../../server/api-v1';
import { productJson } from '../../../../server/api-v1-serialize';
import { getRuntime } from '../../../../server/runtime';

export const dynamic = 'force-dynamic';

/** Active products with variants and prices. `limit` (max 50), `cursor` from the previous page's `nextCursor`. */
export const GET = apiRoute('catalog:read', async (request) => {
  const sp = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? 25) || 25, 1), 50);
  const { catalog } = await getCommerce();
  const db = getRuntime().db.primary;
  const page = await catalog.listActive(db, {
    limit,
    ...(sp.get('cursor') ? { cursor: sp.get('cursor')! } : {}),
  });
  const items = await Promise.all(page.items.map((p) => catalog.getById(db, p.id)));
  return json({ items: items.map(productJson), nextCursor: page.nextCursor });
});
