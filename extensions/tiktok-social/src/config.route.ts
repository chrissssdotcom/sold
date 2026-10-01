import type { RouteContext, RouteDefinition } from '@sold/extension-sdk';
import type { Settings } from './settings';

/** What the browser needs: the public pixel code, nothing else. The access token never leaves the server. */
export const publicConfig: RouteDefinition<RouteContext<Settings>> = {
  kind: 'api',
  method: 'GET',
  path: '/config',
  public: true,
  cache: { maxAgeSeconds: 300, scope: 'public' },
  async handler(_request, ctx) {
    const cfg = await ctx.settings.get();
    return Response.json({ pixelCode: cfg.pixelCode ?? null });
  },
};
