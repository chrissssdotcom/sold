import { errorResponse, json } from '../../../../server/commerce-http';
import { getCommerce } from '../../../../server/commerce';
import { route } from '../../../../server/route';
import { getRuntime } from '../../../../server/runtime';

export const dynamic = 'force-dynamic';

// Public catalog reads come from the replica and are cacheable by the CDN (purged by tag when products change).
const PUBLIC = { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' } as const;

export const GET = route(async (request) => {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '24');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  try {
    const { catalog } = await getCommerce();
    const page = await catalog.listActive(getRuntime().db.replica, {
      limit: Number.isFinite(limit) ? limit : 24,
      ...(cursor ? { cursor } : {}),
    });
    return json(page, { headers: PUBLIC });
  } catch (error) {
    return errorResponse(error);
  }
});
