# Extending Sold

Sold is **Base + Extensions**. Base is the upstream product; everything an individual store needs on top lives in
`extensions/` and `sold.config.ts`, never in Base files. That is what makes Base upgrades boring: you pull a new Base
release and your customisations are untouched.

This guide walks through building a real feature, loyalty points, and then lists the rules. The finished extension is
[`extensions/loyalty-points`](../extensions/loyalty-points): it is the code the platform's own tests run against (kernel
integration tests, an end-to-end test on real PostgreSQL and pg-boss, and unit tests), and every code block below is
checked against it by `pnpm test`, so this page cannot drift from working code.

## What an extension can contribute

| Contribution            | Where                   | Notes                                                                                     |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| Database tables         | `migrations/*.sql`      | Named `ext_<name>_*`, forward-only, linted. Never alters Base tables                      |
| **Observers**           | `observers`             | React to facts (`order.placed`). Asynchronous, retried, can never slow a request          |
| **Interceptors**        | `interceptors`          | Take part in decisions (`cart.item.adding`). Synchronous, ordered, time-boxed, **no I/O** |
| Settings                | `settings`              | A Zod schema becomes an admin form; `secrets` are stored encrypted                        |
| Permissions             | `permissions`           | Appear in the admin role editor                                                           |
| Routes                  | `routes`                | API, webhook, storefront, admin. Mounted under `/x/<name>` and `/admin/x/<name>`          |
| Pages and admin screens | `pages`, `adminScreens` | Lazy components                                                                           |
| Page-builder blocks     | `blocks`                | Props schema, editor, thumbnail                                                           |
| UI slots                | `slots`                 | Named injection points (`product.detail.aside`, ...)                                      |
| Service providers       | `services`              | Replace a Base implementation (tax, shipping, rounding, ...)                              |
| Jobs and schedules      | `jobs`, `schedules`     | On queues named `ext.<name>.<queue>`                                                      |
| Reporting views         | `reportingViews`        | SQL views for the Grafana reporting schema                                                |
| Lifecycle               | `lifecycle`             | `onInstall`, `onEnable`, `onDisable`, `onUninstall`                                       |

## Build a feature in 30 minutes

### 1. Scaffold

```bash
pnpm sold ext:new loyalty-points --title "Award loyalty points on orders"
pnpm install
```

`ext:new` copies `extensions/_template` (a manifest, a migration, a unit test and a README), filling in the name, the
table prefix and the Base version range. Add `'loyalty-points'` to `extensions` in `sold.config.ts`, then:

```bash
pnpm db:migrate     # base migrations, then extension migrations and lifecycle hooks
pnpm dev
```

`pnpm sold ext:list` shows the resolved load order, or every reason it cannot boot.

### 2. Own your data

Migrations are forward-only SQL under `migrations/`. Every table, index, view and function is named `ext_loyalty_points_*`,
and an extension may **never** alter, write to or drop a Base table (the migration is rejected before it runs). To attach
data to a Base entity, use a side table that references it, or the entity's `metadata jsonb` column.

<!-- from: extensions/loyalty-points/migrations/0001_init.sql -->

```sql
CREATE TABLE ext_loyalty_points_accounts (
  customer_id text PRIMARY KEY,
  points      bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

Migrations also pass the online-migration rules Base itself follows (no table rewrites, `CREATE INDEX CONCURRENTLY` on
existing tables, expand/contract). See `docs/runbooks/database.md`.

### 3. Declare settings

A Zod schema is the whole settings UI. Every field needs a default (or to be optional) so a fresh install parses. Fields
listed in `secrets` are envelope-encrypted at rest, never shown again, and never written to logs or audit entries.

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
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
```

### 4. React to facts: observers

`order.placed` is a fact. Your observer runs later, off the request path, on the job queue, with retries and a dead-letter
queue. It can never delay or fail checkout. Because delivery is at-least-once, **make it idempotent**: here the award is
keyed by order id, so a redelivered event changes nothing.

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
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
```

Money is always `{ amount: bigint, currency }` in minor units, never a float; the example computes points from whole major
units using the currency's real exponent (JPY 0, AUD 2, KWD 3).

### 5. Take part in decisions: interceptors

An interceptor sits **inside** cart or checkout and may modify or veto. That makes it the most constrained thing you can
write, because a slow one slows every shopper:

- It gets **no I/O**: no database, no queue, no network. Settings come from a memory snapshot.
- It has a hard time budget (declared in `performance.budgetMs`, 1-50 ms). A late result is discarded even if it arrives.
- You declare what happens when it fails: `failPolicy: 'open'` lets the request continue, `'closed'` vetoes it. Choose
  deliberately: `'closed'` makes your extension a hard dependency of checkout.
- Repeated failures open a circuit breaker and the interceptor is bypassed (per its `failPolicy`) until it recovers.
- Anything it returns as `modify` is validated against a strict schema before it is applied.

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  performance: { hotPath: true, budgetMs: 10 },
```

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  interceptors: [
    {
      hook: 'cart.item.adding',
      name: 'max-quantity',
      failPolicy: 'open', // if we are slow or broken, let the shopper add to cart
      async handler(item, ctx) {
        const { maxQuantityPerLine } = await ctx.settings.get(); // memory snapshot: no database on the hot path
        if (item.quantity > maxQuantityPerLine) {
```

`performance.hotPath` must be declared honestly: an extension with a cart/checkout interceptor that says `hotPath: false`
is rejected at load time. Per-extension latency and outcome metrics are emitted for you
(`sold_extension_interceptor_calls_total`, `sold_extension_interceptor_duration_ms`).

### 6. Override a Base behaviour: service providers

Base declares named service interfaces; an extension registers an implementation by key.

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  services: [
    { service: 'pricing.rounding', key: 'charm-pricing', create: () => ({ round: charmRound }) },
  ],
```

**Override precedence: instance extension > first-party extension > Base default.** Two providers tied at the winning level
are an error at boot, not a coin flip: pick one in `sold.config.ts` (`services: { 'pricing.rounding': 'charm-pricing' }`).
An explicit selection always wins.

### 7. Expose an API

Routes are mounted under a reserved prefix, so they can never shadow a Base route. Every route is **either** `public: true`
**or** carries a `permission` (checked through the single `authorize()` primitive before your handler runs); declaring both
or neither is rejected. Webhooks must be public and verify their own signature. Responses default to
`Cache-Control: no-store`, so a personalised response cannot be cached by the CDN unless you deliberately say so.

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  routes: [
    {
      kind: 'api',
      method: 'GET',
      path: '/balance/:customerId',
      permission: 'loyalty-points.accounts.read',
```

Your handler has a hard time limit, a request-size limit, and errors become a structured 500 carrying the request ID (logged
with your extension name; the cause is never shown to the shopper).

### 8. Background work

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  jobs: [expireJob],
  schedules: [{ queue: 'expire', cron: '0 3 * * *', data: { olderThanDays: 365 } }],
```

Bulk work belongs in a job, never on a request. Job classes (`critical`, `default`, `bulk`) set priority, concurrency and
retry policy; the first thing shed under load is `bulk`.

## The rules

1. **Depend only on `@sold/extension-sdk`.** An ESLint rule rejects imports of any other Base package, dynamic
   `import()`, and reaching into `packages/` or `apps/` by path. If you need something Base does not expose, that is a
   request for a new extension point, not a reason to reach in.
2. **Name every database object `ext_<name>_*`** and never touch Base tables.
3. **Be idempotent.** Observers and jobs are delivered at least once.
4. **Declare `performance.hotPath` honestly** and keep interceptors free of I/O.
5. **Never put secrets in code or settings without `secrets`.** Stored credentials are envelope-encrypted.
6. **Permissions are namespaced** (`<name>.<thing>.<action>`) and declared in the manifest.
7. **An extension error never crashes a request.** Base isolates it, logs it with your name, and exposes per-extension
   metrics. Design for that: fail open or closed on purpose.

## Load order, compatibility, enabling and disabling

`requires: { base: '^0.1.0' }` is checked against the running Base version, and `requires: { extensions: { other: '^1.0.0' } }`
against other extensions. Load order is deterministic: dependencies first, ties broken by the order in `sold.config.ts`.
Anything wrong (incompatible Base, a missing or disabled dependency, a cycle, an unknown permission) **fails the boot with
every problem listed**, and a release that cannot boot never takes traffic (readiness stays `503`).

`extensions: ['name']` in `sold.config.ts` enables; `{ name: 'x', enabled: false }` disables. Enabling runs `onInstall` (first
time) and `onEnable`; disabling runs `onDisable` and **keeps your data**. Removing data is a separate, explicit
`onUninstall` with a purge (never automatic).

## Migrations and deploys

Extension migrations are a **release-pipeline step**, not something a serving process does: `pnpm db:migrate` (base
migrations, then `pnpm sold ext:migrate`) runs before the app rolls out. Web and worker processes only _verify_ that the
migrations were applied and refuse to start otherwise.

## Testing

`ext:new` gives you a unit test. Extension handlers are plain functions of `(payload, ctx)`, so unit tests pass a fake
context. For anything that touches the database, see `packages/core/src/extensions/kernel.int.test.ts` and
`apps/web/src/server/kernel.int.test.ts`: they run the real loyalty-points extension on PostgreSQL and pg-boss.

## Reference and upgrades

- `pnpm sold ext:docs` generates a reference of every configured extension from its manifest
  (`docs/instance/extensions.md`).
- The SDK is a versioned public API with its own changelog (`packages/extension-sdk/CHANGELOG.md`). Deprecations warn for at
  least one minor version before removal; removals happen only in a major version.
- `pnpm sold upgrade:check` reports, per extension, whether it is compatible with an upcoming Base release.
