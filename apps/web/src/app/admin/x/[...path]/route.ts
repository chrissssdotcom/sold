import { handleExtensionRequest } from '@/server/extension-http';
import { resolveActorFromRequest } from '@/server/actor';
import { getKernel } from '@/server/kernel';
import { getRuntime } from '@/server/runtime';
import { route } from '@/server/route';

export const dynamic = 'force-dynamic';

/** `/admin/x/<extension>/...`: admin API routes contributed by extensions. Never public (enforced by the SDK). */
const handler = route(async (request, { requestId }) => {
  const rt = getRuntime();
  const kernel = await getKernel();
  return handleExtensionRequest(
    {
      kernel,
      log: rt.log,
      timeoutMs: rt.env.SOLD_EXTENSION_ROUTE_TIMEOUT_MS,
      maxBodyBytes: rt.env.SOLD_EXTENSION_MAX_BODY_BYTES,
      resolveActor: (req) => resolveActorFromRequest(req, { staffOnly: true }),
      onResult: ({ extension, status, seconds }) => {
        rt.metrics.extensionRequests.inc({
          extension,
          status_class: `${Math.floor(status / 100)}xx`,
        });
        rt.metrics.extensionDuration.observe({ extension }, seconds);
      },
    },
    request,
    requestId,
  );
});

export {
  handler as GET,
  handler as HEAD,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
