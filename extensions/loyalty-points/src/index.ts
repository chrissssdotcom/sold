import { defineExtension, defineJob, z, sql, type ExtensionContext } from '@sold/extension-sdk';
import { charmRound, pointsFor } from './points';

/** Settings become an admin form automatically; `apiToken` is stored encrypted and never shown again. */
const settings = z.object({
  pointsPerDollar: z.number().int().min(1).max(100).default(1).meta({ title: 'Points per dollar' }),
  maxQuantityPerLine: z.number().int().min(1).max(1000).default(10).meta({
    title: 'Max quantity per cart line',
    description: 'Drop rule enforced while adding to the cart.',
  }),
  crmApiToken: z
    .string()
    .min(8)
    .optional()
    .meta({ title: 'CRM API token', description: 'Optional. Stored encrypted.' }),
});

const expireJob = defineJob({
  queue: 'expire',
  class: 'bulk',
  dataSchema: z.object({ olderThanDays: z.number().int().positive().default(365) }),
  handler: async ({ data }, ctx: ExtensionContext) => {
    // Reads its own tables only. Bulk work belongs in a job, never on a request.
    ctx.log.info({ olderThanDays: data.olderThanDays }, 'expiry sweep (no-op in the example)');
  },
});

export default defineExtension({
  name: 'loyalty-points',
  version: '1.0.0',
  description: 'Award loyalty points on orders.',
  requires: { base: '^0.1.0' },
  // Honest declaration: we have a cart interceptor, so this extension is on the hot path (max 10 ms per call).
  performance: { hotPath: true, budgetMs: 10 },
  migrations: { dir: 'migrations' },
  settings: { schema: settings, secrets: ['crmApiToken'] },
  permissions: [
    { key: 'loyalty-points.accounts.read', description: 'View loyalty balances' },
    { key: 'loyalty-points.accounts.adjust', description: 'Manually adjust loyalty balances' },
  ],

  // 1. Observer: reacts to a fact, asynchronously, with retries. Idempotent by order id.
  observers: [
    {
      event: 'order.placed',
      name: 'award-points',
      async handler(order, ctx) {
        if (!order.customerId) return; // guests earn nothing
        const cfg = await ctx.settings.get();
        const points = pointsFor(order.total, cfg.pointsPerDollar);
        if (points === 0n) return;
        await ctx.db.primary.transaction(async (tx) => {
          const inserted = await tx.execute(sql`
            INSERT INTO ext_loyalty_points_awards (order_id, customer_id, points)
            VALUES (${order.orderId}, ${order.customerId}, ${points.toString()}::bigint)
            ON CONFLICT (order_id) DO NOTHING RETURNING order_id`);
          if (inserted.rowCount === 0) return; // already awarded: a retry or redelivery
          await tx.execute(sql`
            INSERT INTO ext_loyalty_points_accounts (customer_id, points)
            VALUES (${order.customerId}, ${points.toString()}::bigint)
            ON CONFLICT (customer_id) DO UPDATE
              SET points = ext_loyalty_points_accounts.points + EXCLUDED.points, updated_at = now()`);
        });
      },
    },
  ],

  // 2. Interceptor: takes part in a decision, synchronously, with no I/O and a hard time budget.
  interceptors: [
    {
      hook: 'cart.item.adding',
      name: 'max-quantity',
      failPolicy: 'open', // if we are slow or broken, let the shopper add to cart
      async handler(item, ctx) {
        const { maxQuantityPerLine } = await ctx.settings.get(); // memory snapshot: no database on the hot path
        if (item.quantity > maxQuantityPerLine) {
          return {
            veto: {
              code: 'max_quantity_exceeded',
              message: `You can add at most ${maxQuantityPerLine} of this item.`,
            },
          };
        }
      },
    },
  ],

  // 3. Service provider: an overridable Base interface (pricing rounding).
  services: [
    { service: 'pricing.rounding', key: 'charm-pricing', create: () => ({ round: charmRound }) },
  ],

  // 4. Jobs and schedules.
  jobs: [expireJob],
  schedules: [{ queue: 'expire', cron: '0 3 * * *', data: { olderThanDays: 365 } }],

  // 5. Routes: mounted under /x/loyalty-points (api) and /admin/x/loyalty-points (admin).
  routes: [
    {
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
    },
  ],

  // 6. Reporting view (added to the Grafana reporting schema in Phase 7).
  reportingViews: [
    {
      name: 'balances',
      description: 'Points balance per customer.',
      sql: 'SELECT customer_id, points FROM ext_loyalty_points_accounts',
    },
  ],

  // 7. Lifecycle.
  lifecycle: {
    async onEnable(ctx) {
      ctx.log.info('loyalty-points enabled');
    },
  },
});
