import { sql, type RouteContext, type RouteDefinition } from '@sold/extension-sdk';
import type { Settings } from './settings';

/**
 * HTTP routes live in `*.route.ts` files, mounted under /x/loyalty-points (api) and /admin/x/loyalty-points (admin).
 * Base filters the response (no cookies, inert content types, `Cache-Control: private, no-store`); see docs/extending.md.
 */
export const balanceRoute: RouteDefinition<RouteContext<Settings>> = {
  kind: 'api',
  method: 'GET',
  path: '/balance/:customerId',
  permission: 'loyalty-points.accounts.read',
  async handler(_request, ctx) {
    const rows = await ctx.db.replica.execute(
      sql`SELECT points::text AS points FROM ext_loyalty_points_accounts WHERE customer_id = ${ctx.params.customerId}`,
    );
    return Response.json({
      customerId: ctx.params.customerId,
      points: (rows.rows[0] as { points?: string } | undefined)?.points ?? '0',
    });
  },
};
