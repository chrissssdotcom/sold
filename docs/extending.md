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

`ext:new` copies `extensions/_template` (a manifest, its settings, an observer, a route, a migration, a unit test and a
README), filling in the name, the table prefix and the Base version range. Add `'loyalty-points'` to `extensions` in `sold.config.ts`, then:

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

<!-- from: extensions/loyalty-points/src/settings.ts -->

```ts
export const settings = z.object({
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

<!-- from: extensions/loyalty-points/src/award-points.observer.ts -->

```ts
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
```

Money is always `{ amount: bigint, currency }` in minor units, never a float; the example computes points from whole major
units using the currency's real exponent (JPY 0, AUD 2, KWD 3).

### 5. Take part in decisions: interceptors

An interceptor sits **inside** cart or checkout and may modify or veto. That makes it the most constrained thing you can
write, because a slow one slows every shopper. The contract:

- It gets **no I/O**: no database, no queue, no network. Settings come from a memory snapshot.
- It has a time budget (declared in `performance.budgetMs`, 1-50 ms) that starts when your handler starts, not while it
  waits for a slot. A late result is discarded even if it arrives.
- You declare what happens when it fails: `failPolicy: 'open'` lets the request continue, `'closed'` vetoes it. Choose
  deliberately: `'closed'` makes your extension a hard dependency of checkout.
- Repeated failures (errors, timeouts, invalid `modify` results, a result that throws when read) open a circuit breaker and
  the interceptor is bypassed (per its `failPolicy`) until it recovers. Our own pool being full never counts against you.
- Each extension has its own bounded concurrency pool, so a slow neighbour cannot starve you (and you cannot starve it).
- Anything it returns as `modify` is validated against a strict schema before it is applied. A `veto` message is shown to
  shoppers, so control and bidirectional characters and `<` `>` are stripped and it is cut to 200 characters.

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  performance: { hotPath: true, budgetMs: 10 },
```

<!-- from: extensions/loyalty-points/src/max-quantity.interceptor.ts -->

```ts
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

#### What the hot-path contract is, and is not

Extensions are **trusted, in-process code** (see [ADR-0004](adr/0004-extension-trust-model.md)); the hot-path contract is a
best-effort **guardrail against accidents**, not a sandbox. Base does what a single Node process can do:

| Mechanism                                                       | Effect                                                                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No I/O clients on the interceptor context                       | The intended path: there is nothing to call                                                                                                                                                     |
| Lint (`*.interceptor.ts` and every non-observer/job/route file) | Network, `fs`, process and `pg`/`ioredis`/`undici` imports and the globals `fetch`, `XMLHttpRequest`, `WebSocket` are errors (see "Boundaries")                                                 |
| Runtime guard, **prevents**                                     | A new connection, `fetch()`, UDP, DNS lookups, spawning processes or workers and `Atomics.wait` throw `HotPathViolation` while an interceptor runs                                              |
| Runtime guard, **detects**                                      | A write on an already-open socket (a pooled keep-alive connection, a warm `pg`/`undici` pool) and pollution of `Object.prototype`/`Array.prototype` fail the call and count against the breaker |
| Time budget                                                     | Cuts off async work that overruns. **It cannot preempt a synchronous loop**: JavaScript has no way to                                                                                           |
| Blocked-loop detection                                          | A handler that holds the event loop longer than its budget is recorded in `sold_extension_blocked_ms`; past 5x its budget its breaker opens at once. Detection after the fact, not prevention   |
| Process guard                                                   | A floating promise or throwing timer started by extension code is attributed to it, logged and counted (`sold_extension_unhandled_failures_total`); the worker no longer exits for it           |

What it will **not** stop: a `fetch` captured before the guard was installed, `fs` access, CPU loops, another thread, native
addons. If you need isolation from code you do not trust, extensions are the wrong mechanism; see the ADR.

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
or neither is rejected. Webhooks must be public and verify their own signature.

<!-- from: extensions/loyalty-points/src/balance.route.ts -->

```ts
  kind: 'api',
  method: 'GET',
  path: '/balance/:customerId',
  permission: 'loyalty-points.accounts.read',
```

Base stands between your handler and the browser:

- **Limits.** The request body is capped by the bytes actually read (a chunked upload counts too), and the handler has a
  deadline that also covers a streamed response body. When it passes, the request's signal aborts and the stream is cut.
  Cancellation is cooperative: honour `ctx.signal` (and pass `request.signal` to `fetch`), because JavaScript cannot stop a
  handler that ignores it.
- **Errors** become a structured 500 carrying the request ID. They are logged with your extension name as the error class
  and a scrubbed message (credentials and tokens redacted); the cause is never shown to the shopper.
- **Response filtering.** `Set-Cookie`, `Location`, `Content-Security-Policy`(-Report-Only), `Strict-Transport-Security`,
  `Clear-Site-Data`, `Refresh`, `Link`, CORS and hop-by-hop headers are removed. `X-Content-Type-Options: nosniff` is always
  set. `Cache-Control` is `private, no-store` unless the route declares `cache: { maxAgeSeconds, scope? }` (`scope: 'public'`
  only on a public `GET`). Only `application/json`, `text/plain`, `text/csv`, `application/octet-stream`, `application/pdf`
  and `image/*` are served; anything else is a 500.
- **Opt-ins**, declared on the route: `redirects: true` allows a 3xx with a `Location` to a path or http(s) URL;
  `html: true` allows `text/html`, served with `Content-Security-Policy: sandbox` (no scripts).
- `HEAD` is answered from a `GET` route, without the body.

### 8. Background work

<!-- from: extensions/loyalty-points/src/index.ts -->

```ts
  jobs: [expireJob],
  schedules: [{ queue: 'expire', cron: '0 3 * * *', data: { olderThanDays: 365 } }],
```

Bulk work belongs in a job, never on a request. Job classes (`critical`, `default`, `bulk`) set priority, concurrency and
retry policy; the first thing shed under load is `bulk`.

## The rules

1. **Depend only on `@sold/extension-sdk`.** The ESLint boundary is an allowlist (see "Boundaries" below): anything not on
   it is an error, including `require`, computed `import()` and reaching outside your package by path. If you need
   something Base does not expose, that is a request for a new extension point, not a reason to reach in.
2. **Name every database object `ext_<name>_*`** and never touch Base tables.
3. **Be idempotent.** Observers and jobs are delivered at least once.
4. **Declare `performance.hotPath` honestly** and keep interceptors free of I/O (in `*.interceptor.ts` files).
5. **Never put secrets in code or settings without `secrets`.** Stored credentials are envelope-encrypted.
6. **Permissions are namespaced** (`<name>.<thing>.<action>`) and declared in the manifest.
7. **An extension error never crashes a request.** Base isolates it, logs it with your name, and exposes per-extension
   metrics. Design for that: fail open or closed on purpose.

## Boundaries: file names and imports

The lint rule (`packages/config/extension-boundary.js`) is an **allowlist** and it keys off file names, so name files by what
they are:

| File                                       | May import                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `*.interceptor.ts` (cart/checkout hooks)   | `@sold/extension-sdk`, your own files, `zod`, `semver`, `react`, `node:crypto/util/buffer/events/stream/url/path/assert/timers/perf_hooks` |
| `index.ts`, settings, blocks, helpers, ... | the same: everything that is not one of the files below is strict, so helpers cannot smuggle I/O into an interceptor                       |
| `*.observer.ts`, `*.job.ts`, `*.route.ts`  | the above, plus `node:http/https/http2/net/tls/dgram/dns/fs/os/zlib` and the packages in **your** `package.json` `dependencies`            |
| `*.test.ts`, `*.spec.ts`                   | the I/O set, `vitest` and your `devDependencies`                                                                                           |

Never allowed anywhere, even if listed in `dependencies`: `@sold/*` other than the SDK, `pg`, `ioredis`, `redis`, `undici`,
`postgres`, `drizzle-orm`, `next`, `node:child_process`, `node:worker_threads`, `node:vm`, `node:module`. Also banned:
`require`, `createRequire`, `import()` with a computed argument, `import.meta.resolve`, `eval`, `new Function`, relative imports
that leave your package (including through `node_modules`), and process-level hooks (`process.on`, `process.exit`, ...). The
rules cover `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs`.

To extend: add a library to your package's `dependencies` (it is then importable from your I/O files); if a library is pure
and interceptors need it too, add it to `purePackages` in `packages/config/extension-boundary.js` in a reviewed Base change.
Use `ctx.db` rather than a database driver: it applies Base's pools, timeouts and budgets. Like the runtime guard, the lint
is a guardrail, not a sandbox (see ADR-0004).

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

## UI contributions: what is wired and how

| Contribution               | Where it shows up                                                                                                      | Status                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `blocks`                   | Page builder, as `<extension>/<type>`; rendered by the page renderer next to Base blocks                               | wired                                                                     |
| `slots`                    | `product.detail.aside` (product page), `storefront.footer` (every storefront page), `account.dashboard` (account page) | wired; the other slots in `SlotMap` are declared but **not rendered yet** |
| `adminScreens`             | Console nav (under the screen's `nav.section`) and `/admin/ext/<extension>/<path>`, hosted inside the console shell    | wired; permission checked on the server                                   |
| `routes` (`kind: 'admin'`) | `/admin/x/<extension>/...` (staff only)                                                                                | wired                                                                     |
| `routes` (`api`/`webhook`) | `/x/<extension>/...`                                                                                                   | wired                                                                     |
| `pages`                    | `/x/<extension>` storefront pages                                                                                      | **not wired yet**                                                         |

Rules that make this safe:

- **Route audience.** Exactly one of `permission` (staff holding that permission, via the same `can()` as the admin API), `customer: true` (any signed-in customer; the
  handler scopes to `ctx.actor.id`; staff are refused), or `public: true`. Cookie-authenticated writes pass Base's same-origin check; a cross-site POST is treated as signed out.
  `base.*` permissions map onto RBAC (`base.orders.read` is satisfied by `orders:read`); extension permissions (`<ext>.<thing>.<action>`) are exact grants and can be
  given to roles in the console.
- **Slots are isolated.** Each contribution is lazy-loaded and wrapped in an error boundary: if it throws, that slot renders nothing and the page survives.
- **Browser code lives in `*.client.tsx`.** It has the same strict import rules as everything else; the one extra capability is global `fetch` (same-origin calls to the
  extension's own routes). Other network globals stay banned. Server I/O still belongs in `*.route.ts`, `*.observer.ts`, `*.job.ts`.
- **Extension blocks cannot touch the database** (their renderers are strict files). They get validated props and `ctx`; load data client-side from the extension's own
  public route, as `reviews` does.
- Extensions can **read** Base's `orders`, `order_lines`, `products`, `product_variants`, `variant_prices`, `carts`, `cart_lines` (the documented allowlist). They cannot read
  users, sessions, payments or audit data.

The `reviews` extension (`extensions/reviews`) is the worked example of all of the above: route audiences, a slot, a block, an admin screen, a migration and a verified-buyer
rule against Base's order tables.
