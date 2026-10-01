import { json } from '../../../../../server/commerce-http';
import { getCommerce } from '../../../../../server/commerce';
import { apiRoute, lastSegment } from '../../../../../server/api-v1';
import { productJson } from '../../../../../server/api-v1-serialize';
import { parseId } from '../../../../../server/admin/http';
import { getRuntime } from '../../../../../server/runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('catalog:read', async (request) => {
  const { catalog } = await getCommerce();
  return json(
    productJson(await catalog.getById(getRuntime().db.primary, parseId(lastSegment(request)))),
  );
});
