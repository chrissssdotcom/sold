import { getRuntime } from '@/server/runtime';
import { route } from '@/server/route';

export const dynamic = 'force-dynamic';

/** `<base-version>+<customer>.<instance-build>` (Section 8C.6): ties any incident to an exact release. */
export const GET = route(() => {
  const { env } = getRuntime();
  return Response.json(
    { version: env.SOLD_VERSION, buildId: env.SOLD_BUILD_ID, environment: env.SOLD_ENVIRONMENT },
    { headers: { 'cache-control': 'no-store' } },
  );
});
