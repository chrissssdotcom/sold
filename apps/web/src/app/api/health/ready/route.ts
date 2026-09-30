import { cachedReadiness } from '@/server/health';
import { checkKernel } from '@/server/kernel';
import { getRuntime } from '@/server/runtime';
import { route } from '@/server/route';

export const dynamic = 'force-dynamic';

let check: ReturnType<typeof cachedReadiness> | undefined;

export const GET = route(async () => {
  const rt = getRuntime();
  check ??= cachedReadiness({
    isDraining: () => rt.draining.value,
    // Dedicated probe connection: never contends with request traffic.
    checkPrimary: async () => {
      await rt.db.pools.probe.query('SELECT 1');
    },
    checkExtensions: checkKernel,
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
  const result = await check();
  return Response.json(result, {
    status: result.status === 'unavailable' ? 503 : 200,
    headers: { 'cache-control': 'no-store' },
  });
});
