import type { RouteContext, RouteDefinition } from '@sold/extension-sdk';
import type { Settings } from './settings';

/**
 * Mounted at /x/__NAME__/hello. HTTP routes live in `*.route.ts` files. `public: true` means anyone may call it;
 * use `permission` for everything else. Base filters what a route returns (no cookies, inert content types,
 * `Cache-Control: private, no-store` unless the route declares `cache`).
 */
export const hello: RouteDefinition<RouteContext<Settings>> = {
  kind: 'api',
  method: 'GET',
  path: '/hello',
  public: true,
  async handler(_request, ctx) {
    const { greeting } = await ctx.settings.get();
    return Response.json({ message: greeting });
  },
};
