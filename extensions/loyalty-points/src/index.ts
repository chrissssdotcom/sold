import { defineExtension } from '@sold/extension-sdk';
import { awardPoints } from './award-points.observer';
import { balanceRoute } from './balance.route';
import { expireJob } from './expire.job';
import { maxQuantity } from './max-quantity.interceptor';
import { charmRound } from './points';
import { settings } from './settings';

/**
 * File-name convention (the lint keys off it; see docs/extending.md): `*.interceptor.ts` (pure, no I/O),
 * `*.observer.ts`, `*.job.ts` and `*.route.ts` (may use I/O), everything else (like this file) is strict: no I/O.
 */
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
  observers: [awardPoints],

  // 2. Interceptor: takes part in a decision, synchronously, with no I/O and a hard time budget.
  interceptors: [maxQuantity],

  // 3. Service provider: an overridable Base interface (pricing rounding).
  services: [
    { service: 'pricing.rounding', key: 'charm-pricing', create: () => ({ round: charmRound }) },
  ],

  // 4. Jobs and schedules.
  jobs: [expireJob],
  schedules: [{ queue: 'expire', cron: '0 3 * * *', data: { olderThanDays: 365 } }],

  // 5. Routes: mounted under /x/loyalty-points (api) and /admin/x/loyalty-points (admin).
  routes: [balanceRoute],

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
