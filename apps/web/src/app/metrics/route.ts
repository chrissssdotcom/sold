import { bearerMatches } from '@/server/auth';
import { getRuntime } from '@/server/runtime';
import { route } from '@/server/route';

export const dynamic = 'force-dynamic';

/** Prometheus scrape endpoint, protected by a bearer token (`METRICS_TOKEN`). Fails closed when unset. */
export const GET = route(async (request) => {
  const rt = getRuntime();
  if (!bearerMatches(request.headers.get('authorization'), rt.env.METRICS_TOKEN)) {
    return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  }
  return new Response(await rt.metrics.registry.metrics(), {
    headers: { 'content-type': rt.metrics.registry.contentType, 'cache-control': 'no-store' },
  });
});
