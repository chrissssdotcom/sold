import { evaluateReadiness } from '@/server/health';
import { getRuntime } from '@/server/runtime';
import { route } from '@/server/route';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const rt = getRuntime();
  const result = await evaluateReadiness({
    isDraining: () => rt.draining.value,
    checkPrimary: async () => {
      await rt.db.pools.primary.query('SELECT 1');
    },
    ...(rt.db.hasReplica
      ? { checkReplica: async () => void (await rt.db.pools.replica.query('SELECT 1')) }
      : {}),
    ...(rt.redis
      ? {
          checkRedis: async () => {
            if (rt.redis?.status === 'wait') await rt.redis.connect();
            await rt.redis?.ping();
          },
        }
      : {}),
  });
  return Response.json(result, {
    status: result.status === 'unavailable' ? 503 : 200,
    headers: { 'cache-control': 'no-store' },
  });
});
