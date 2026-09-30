import { sql, type ExtensionContext, type ObserverDefinition } from '@sold/extension-sdk';
import type { Settings } from './settings';

/**
 * React to a fact, asynchronously and with retries. Observers live in `*.observer.ts` files and may use I/O
 * through `ctx`. Idempotent by order id, so redelivery is harmless.
 */
export const recordOrder: ObserverDefinition<'order.placed', ExtensionContext<Settings>> = {
  event: 'order.placed',
  name: 'record-order',
  async handler(order, ctx) {
    await ctx.db.primary.execute(sql`INSERT INTO __PREFIX__events (order_id) VALUES (${order.orderId}) ON CONFLICT (order_id) DO NOTHING`);
  },
};
