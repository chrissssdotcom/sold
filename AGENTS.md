# AGENTS.md — Sold

Read this first. It lets any agent or human pick the project up cold.
`CLAUDE.md` is a one-line pointer to this file.

## What Sold is

A **single-tenant** e-commerce platform: one deployment = one business = one database. There is **no `tenant_id` anywhere**. Isolation comes from separate deployments.

**Base + Extensions.** Sold Base is the upstream product (catalog, checkout, orders, page builder, admin, identity, extension framework). Customer instances are Base plus extensions, living only in `extensions/` and `sold.config.ts`. Customers pull Base upgrades without merge pain because they never edit Base files.

Targets: beautiful by default, fast (Core Web Vitals green), WCAG 2.2 AA, secure by default (OWASP ASVS L2), easy for humans and agents to extend, and **survives extreme traffic spikes** (flash sales, TikTok drops). Scale is contractual, not a late optimisation. Checkout is the crown jewel and is protected above everything else.

## Non-negotiable principles

1. **Single tenant.** No `tenant_id`. Ever.
2. **Extensions never edit Base.** Extensions depend only on `@sold/extension-sdk`. An ESLint rule bans imports of Base internals from `extensions/`. Extension errors are caught, logged with the extension name, and never crash a request.
3. **Money is `{ amount: bigint (minor units), currency: ISO-4217 }`.** No floats. DB: `bigint` + `char(3)` + CHECK constraints. JPY (0dp) and KWD (3dp) are tested.
4. **Orders are immutable snapshots.** Prices, tax, discounts, FX rate, addresses, titles are copied at purchase time.
5. **Explicit state machines** (order, payment, fulfilment, return) with transition tables; every legal and illegal transition is tested.
6. **Zod at every boundary** (HTTP, actions, config, webhooks, manifests). Typed env validated at boot.
7. **One `authorize()` primitive** for all permission checks. No ad-hoc checks. Every admin mutation emits an audit event.
8. **Vendor code lives only in adapters and under `ops/`.** Interfaces: `PaymentGateway`, `JobQueue`, `EmailTransport`, `SearchProvider`, `TaxCalculator`, `ShippingProvider`, storage, `ChallengeProvider`, waiting room.
9. **Build once, promote the same artifact.** Environments differ by config/profile, never by code path.
10. **Nobody changes prod by hand.**

## Dependency direction

```
apps/web -> core / ui / identity / payments -> db
extensions/* -> extension-sdk only
```

`packages/core` never imports `next` or `react`. `apps/web` is a thin delivery layer: validate input, call `core`, shape output.

## Scale gates (Section 8A.11 — a phase is NOT complete if it violates these)

- (a) No per-request N+1 queries.
- (b) No synchronous third-party call on the cart/checkout path.
- (c) No unbounded query or list without pagination/limits.
- (d) No correctness-critical state in process memory.
- (e) Every new table expected to exceed 10M rows has a partitioning/retention decision recorded.
- (f) Every new hot-path feature has a k6 scenario or an update to an existing one.

Also: never hold a DB transaction open across a network call; the order-critical path is only validate cart → reserve stock → create payment → confirm → persist order + outbox in one short transaction; everything else is queued and idempotent; every outbound call has a timeout, retry budget and circuit breaker; migrations are online, forward-only, expand/contract, and pass the migration linter.

## Layout

```
apps/web/            Next.js: storefront + /admin + /api
packages/core        domain logic (pure TS + DB, no framework)
packages/db          Drizzle schema, migrations, seeds, reporting views
packages/extension-sdk  public extension API (semver'd)
packages/ui          design system, blocks, tokens
packages/payments    gateway interface + adapters
packages/identity    OIDC, SAML, SCIM, RBAC
packages/config      shared tsconfig / eslint / tailwind presets
packages/testing     fixtures, factories, harness
packages/cli         the `sold` CLI (env:*, ext:*, upgrade:*, customer:new, cache:warm)
extensions/          first-party + customer extensions (each a package); _template scaffold
ops/                 grafana, docker, k8s (optional AKS), terraform, loadtests
docs/                adr, runbooks, extending, upgrading, scaling, PROGRESS.md
```

## Commands

Run from the repo root. Node LTS, pnpm (via corepack).

| Task              | Command                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| Install           | `pnpm i`                                                                      |
| Dev (everything)  | `pnpm dev` (after `docker compose up -d`)                                     |
| Lint              | `pnpm lint`                                                                   |
| Typecheck         | `pnpm typecheck`                                                              |
| Unit tests        | `pnpm test`                                                                   |
| Integration tests | `pnpm test:integration` (needs Docker for Testcontainers)                     |
| E2E               | `pnpm test:e2e`                                                               |
| Migrate           | `pnpm db:migrate`                                                             |
| Seed              | `pnpm db:seed`                                                                |
| Build             | `pnpm build`                                                                  |
| Migration lint    | `pnpm db:lint-migrations`                                                     |
| Format check      | `pnpm format:check`                                                           |
| CLI               | `pnpm sold <command>` (e.g. `ext:new`, `ext:docs`, `env:up`, `upgrade:check`) |

Definition-of-done gate for any task: typecheck + lint + tests green, migrations verified on an empty DB, permissions + audit events, docs updated, no secrets/TODO-without-issue/dead code/unjustified `any`, **and you have actually run it**.

## Conventions

- TypeScript `strict`, ESM, no `any` without a justifying comment.
- Conventional Commits. Changesets for versioning. SemVer for Base and each extension independently.
- UUIDv7 primary keys; `created_at`/`updated_at` everywhere; soft delete only where business rules require it; deliberate `ON DELETE`.
- Migrations: forward-only, expand/contract, `CREATE INDEX CONCURRENTLY` on hot tables, no long locks or table rewrites, backfills in batched jobs.
- Extension tables are prefixed `ext_<name>_`; extensions never alter Base tables (use `metadata jsonb` or side tables).
- Logs: pino structured JSON with request ID; PII redacted.
- Tests: unit for pure domain; integration against real Postgres (Testcontainers); contract suites for every gateway/tax/shipping/search implementation; Playwright for e2e/visual/axe. Prioritise money, auth, state transitions.
- Override precedence: `instance extension > first-party extension > Base default`.
- Ownership: Base-owned paths are listed in `.sold/base-manifest.json`; customer-owned are `extensions/`, `sold.config.ts`, `config/<env>.ts`, `ops/terraform/environments/<customer>/`, `docs/instance/`.
- Non-prod safety switches (Stripe test mode, capture email transport, sink webhooks, noindex, no real PII) are config, enforced by profile.

## Working method

- Plan per phase, keep `docs/PROGRESS.md` current (done / next / open questions / deviations).
- Interfaces (TS + Zod) land before implementations.
- Small green commits. Never leave the repo broken.
- Decide, don't stall; record decisions in `docs/PROGRESS.md` or an ADR. Stop and ask only for hard-to-reverse choices (paid third-party services, public API changes after release).
- Vendor capability claims (Azure SKUs, Cloudflare plan features, Cloudflare email limits) must be **verified against current official docs** and recorded in ADR-0002/0003 before the affected adapter is built.
- Guardrails: never run destructive commands against non-local databases; never commit credentials; never disable tests or lint rules to get green; never weaken a security control for convenience.

## Where things are decided

- `docs/adr/0001-architecture.md` — stack and structure
- `docs/adr/0002-azure-cloudflare.md` — hosting/edge/email decisions and verification outcomes
- `docs/adr/0003-environments-and-upgrades.md` — env ladder, Terraform, upgrade + promotion flow
- `docs/PROGRESS.md` — live status
- `docs/scaling.md` — SLOs, capacity model, tier profiles, measured capacity
