# PROGRESS

Live status. Update at every green checkpoint.

## Status

| Phase | State |
|---|---|
| Pre-work: AGENTS.md, CLAUDE.md, ADR-0001, plan | done |
| Phase 0: Foundations | in progress |
| Phase 1: Extension SDK and Base kernel | not started |
| Phase 2: Commerce core | not started |
| Phase 3: Payments and multi-currency | not started |
| Phase 4: Storefront and page builder | not started |
| Phase 5: Identity and admin | not started |
| Phase 6: Social and growth | not started |
| Phase 7: Data and platform | not started |
| Phase 8: Hardening, scale proof, handover | not started |

## Phase plan

Each phase ends with a working demo, green CI, updated docs, and passes the scale gates.

### Phase 0: Foundations (plan)

Ordered so the repo is green after each step.

1. **Workspace skeleton.** pnpm workspace, Turborepo, root `tsconfig`, ESLint flat config, Prettier, Vitest, `packages/config`, Conventional Commits config, Changesets.
2. **Typed env + `sold.config.ts`.** Zod-validated env (`packages/core`) and instance config schema (profiles: `ephemeral | dev | stage | prod`; tiers: `standard | high-volume | event-scale`).
3. **Data layer.** `packages/db`: Drizzle setup, `primary`/`replica` handles, first migration, migration runner, seed skeleton, **migration linter** (rejects table rewrites, non-concurrent indexes on existing tables, `NOT NULL` without default, etc.) with unit tests.
4. **Web app.** `apps/web` Next.js: `/api/health/live`, `/api/health/ready`, `/api/version`, `/metrics` (protected), pino logging with request IDs, OpenTelemetry baseline, shared cache-handler interface with in-memory implementation and Redis implementation.
5. **Job queue seam.** `JobQueue` interface + pg-boss adapter skeleton; separate worker entrypoint.
6. **Containers.** Multi-stage Dockerfile with `web` and `worker` targets; `docker-compose.yml` (Postgres, PgBouncer, Redis, Mailpit, MinIO, Grafana provisioned).
7. **CI.** GitHub Actions: typecheck, lint, unit, integration, build, migration lint, audit + SBOM; first k6 baseline scenario.
8. **Scaling skeleton.** `docs/scaling.md` with SLOs, capacity model, tier profiles, and clearly flagged assumptions.
9. **Environments and release (Section 8C).** Terraform modules and `sold-environment` composite, `ephemeral`/`dev` profiles, `sold` CLI (`env:up|pause|resume|extend|list|cost|down --verify`), mandatory tagging + policy check, TTL auto-destroy workflow, signed build-once pipeline, `release.json` promotion skeleton. ADR-0002 and ADR-0003 written first, with vendor facts verified against current docs.

Exit criteria: `pnpm i && pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; `docker compose up` gives healthy Postgres/PgBouncer/Redis; `/api/health/ready` returns 200; `terraform validate` passes on all modules; `env:up`/`env:down --verify` demonstrated against a sandbox (or explicitly listed as pending credentials).

### Phase 1: Extension SDK and Base kernel
Manifest + Zod schema, registry, deterministic load order with semver `requires`, typed event bus (observers via queue, interceptors sync/ordered/timeboxed with bounded pool and hot-path guard), slots, settings (encrypted secrets), per-extension migration journal, service-provider registry with override precedence, ESLint boundary rule, `ext:new` scaffold, `ext:docs`, and a trivial extension exercising every contribution type. Zero-extension and all-extension boot tests.

### Phase 2: Commerce core
Money, catalog, inventory (atomic conditional decrement + `InventoryReservationStrategy` with Redis fast path), cart, pricing, promotions, tax, shipping, orders, state machines, transactional outbox, idempotent checkout, minimal order-persistence transaction. Concurrent-buyer test (5,000 buyers / 100 units, no oversell).

### Phase 3: Payments and multi-currency
`PaymentGateway` + contract suite, Stripe adapter, manual gateway, webhook inbox + processing, FX provider/history/staleness, derived and fixed per-currency pricing, two-currency end-to-end checkout.

### Phase 4: Storefront and page builder
Design system/tokens, blocks, builder (undo/redo, drafts, scheduling, versions), SEO, localisation, search (`SearchProvider`), accounts, cache-first delivery + pre-warm. Perf and a11y budgets.

### Phase 5: Identity and admin
RBAC + `authorize()`, OIDC, SAML, SCIM, audit log (hash-chained), break-glass, Keycloak integration tests, Entra ID docs.

### Phase 6: Social and growth
`tiktok-social` (all block types), consent manager, pixel + Events API, reviews extension, lifecycle automation, email templates + `EmailTransport` adapters.

### Phase 7: Data and platform
`reporting` schema, `sold_grafana` role, dashboards (incl. Scale & Capacity), Prometheus metrics, public API + OpenAPI + webhooks, media library, feature flags, A/B hooks, queue throughput measurement + alternative adapter.

### Phase 8: Hardening, scale proof, handover
Threat model, security review, full k6/chaos suite and capacity report, waiting room and degradation ladder rehearsal, DB failover/restore drills, sale-readiness dry run, N-1 → N upgrade test, customer creation and promotion through the documented flow, final docs.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-30 | `CLAUDE.md` is a one-line pointer (not a symlink) to `AGENTS.md` | Symlinks are fragile on Windows checkouts and some tooling |
| 2026-09-30 | CLI lives in `packages/cli`, exposed as `pnpm sold` | Section 3 layout lists no CLI package; a dedicated package keeps `core` framework-free |

## Environment notes / blockers

- 2026-09-30: The Bash tool returned repeated transient classifier errors at session start, so shell verification (toolchain versions, installs, test runs) is pending. Files written so far are documentation only and have not been executed. Nothing in this repo has been run yet.

## Open questions

- Which Azure subscription and Cloudflare account/zone will be used as the sandbox for the 8C acceptance demonstration (`env:up`, promotion, rollback)? Until provided, Terraform is validated with `terraform validate`/plan only and live provisioning is listed as pending.
- Confirm the customer Cloudflare plan tier (waiting room, cache-tag purge, Access seat limits are plan-dependent). Recorded in ADR-0002 once verified.
