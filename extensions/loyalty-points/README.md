# loyalty-points

The worked example from `docs/extending.md`. It awards points when an order is placed, limits cart quantity, and
overrides pricing rounding, and it touches every contribution type: migrations, settings (with an encrypted secret),
permissions, an observer, an interceptor, a service provider, a job with a schedule, a route and a reporting view.

It depends only on `@sold/extension-sdk`. Its tables are `ext_loyalty_points_*`.

File layout follows the convention the lint rule enforces: `max-quantity.interceptor.ts` (pure, no I/O),
`award-points.observer.ts`, `expire.job.ts` and `balance.route.ts` (may use I/O through `ctx`), `settings.ts` and
`index.ts` (strict, no I/O).
