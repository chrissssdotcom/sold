import { sql, type ExtensionContext, type ObserverDefinition } from '@sold/extension-sdk';
import { pointsFor } from './points';
import type { Settings } from './settings';

/**
 * Observers live in `*.observer.ts` files: they react to a fact, asynchronously, with retries, and may use I/O
 * (through `ctx`). Idempotent by order id, so redelivery is harmless.
 */
export const awardPoints: ObserverDefinition<'order.placed', ExtensionContext<Settings>> = {
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
};
