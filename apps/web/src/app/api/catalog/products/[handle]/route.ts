import { errorResponse, json } from '../../../../../server/commerce-http';
import { getCommerce } from '../../../../../server/commerce';
import { route } from '../../../../../server/route';
import { getRuntime } from '../../../../../server/runtime';

export const dynamic = 'force-dynamic';

const PUBLIC = { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' } as const;

export const GET = route(async (request) => {
  const handle = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
  try {
    const { catalog } = await getCommerce();
    const product = await catalog.getActiveByHandle(getRuntime().db.replica, handle);
    return json(product, { headers: PUBLIC });
  } catch (error) {
    return errorResponse(error);
  }
});
