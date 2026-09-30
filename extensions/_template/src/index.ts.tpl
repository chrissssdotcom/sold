import { defineExtension, sql, z } from '@sold/extension-sdk';

/** Settings become an admin form automatically. Add `secrets: ['field']` to store a field encrypted. */
const settings = z.object({
  greeting: z.string().min(1).max(80).default('Hello from __NAME__').meta({ title: 'Greeting' }),
});

export default defineExtension({
  name: '__NAME__',
  version: '0.1.0',
  description: '__TITLE__',
  requires: { base: '__BASE_RANGE__' },
  // No interceptors on cart or checkout, so this is not a hot-path extension.
  performance: { hotPath: false },
  migrations: { dir: 'migrations' },
  settings: { schema: settings },
  permissions: [{ key: '__NAME__.events.read', description: 'View __NAME__ events' }],

  // React to a fact, asynchronously and with retries. Idempotent by order id, so redelivery is harmless.
  observers: [
    {
      event: 'order.placed',
      name: 'record-order',
      async handler(order, ctx) {
        await ctx.db.primary.execute(sql`INSERT INTO __PREFIX__events (order_id) VALUES (${order.orderId}) ON CONFLICT (order_id) DO NOTHING`);
      },
    },
  ],

  // Mounted at /x/__NAME__/hello. `public: true` means anyone may call it; use `permission` for everything else.
  routes: [
    {
      kind: 'api',
      method: 'GET',
      path: '/hello',
      public: true,
      async handler(_request, ctx) {
        const { greeting } = await ctx.settings.get();
        return Response.json({ message: greeting });
      },
    },
  ],
});
