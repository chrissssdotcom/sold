# PROGRESS

Live status. Update at every green checkpoint.

## Status

| Phase                                          | State                                                        |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Pre-work: AGENTS.md, CLAUDE.md, ADR-0001, plan | done                                                         |
| Phase 0: Foundations                           | **in progress** (see "Phase 0 evidence" and "Pending" below) |
| Phase 1: Extension SDK and Base kernel         | not started                                                  |
| Phase 2: Commerce core                         | not started                                                  |
| Phase 3: Payments and multi-currency           | not started                                                  |
| Phase 4: Storefront and page builder           | not started                                                  |
| Phase 5: Identity and admin                    | not started                                                  |
| Phase 6: Social and growth                     | not started                                                  |
| Phase 7: Data and platform                     | not started                                                  |
| Phase 8: Hardening, scale proof, handover      | not started                                                  |

Phases 1-8 are a large body of work. Nothing in them exists yet; this file does not claim otherwise.

## Phase 0 evidence (what was actually run, in this sandbox)

Local gate, run from the repo root: `pnpm format:check typecheck lint test db:lint-migrations build` all green, and
`pnpm test:integration` green against a local PostgreSQL 16 and `redis-server` (`SOLD_TEST_DATABASE_URL` set).

| Area                 | Verified by running                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config and env       | Zod schemas for `sold.config.ts` and process env (fail-fast, no secret values in errors), non-prod safety switches. Unit tests.                                                                                                                                                                                                |
| Migrations           | Custom runner applied to empty DBs: idempotent rerun, checksum immutability, forward-only ordering, rollback on failure, `CONCURRENTLY` outside a transaction, advisory-lock serialisation of 3 concurrent runners. Schema-vs-Drizzle equality test.                                                                           |
| Migration linter     | 11 unit tests; runs over real migrations in CI.                                                                                                                                                                                                                                                                                |
| Data layer           | Primary/replica handles (typed role), fallback without replica, statement timeout enforced on direct connections, DB-level timeouts set by migration, query counter for N+1 assertions. UUIDv7 function.                                                                                                                       |
| Outbox partitioning  | Monthly partitions created ahead, rows routed to them, retention drops only partitions with no unpublished events (verified it refuses otherwise), `EXPLAIN` shows the partial index used by the publisher poll.                                                                                                               |
| Web app              | Built (Turbopack) and run as the standalone server against real Postgres and Redis: `/api/health/live`, `/api/health/ready`, `/api/version`, `/metrics` (401 without token, Prometheus text with it), security headers, request IDs.                                                                                           |
| Shared cache handler | Verified inside real Next: an ISR entry appears in Redis under `sold:cache:<buildId>:`. Integration tests: entry written by one instance served by another, tag revalidation visible cross-instance, build isolation, Redis TTL expiry, fail-open plus circuit breaker when Redis is killed, `revalidateTag` failure surfaced. |
| Graceful shutdown    | Real process: SIGTERM turns readiness 503 (`draining: true`) then exits after the drain window. Primary DB unreachable: readiness 503, liveness 200, cached static page still served. Redis down: readiness `degraded` (200).                                                                                                  |
| Worker               | Real bundle run: probes, authenticated `/metrics` with queue depth and oldest-job-age gauges, partition job ran on boot, SIGTERM drain. `PgBossQueue` integration tests: enqueue/process, idempotent enqueue, retry then dead-letter, age reporting, concurrency cap per queue class.                                          |
| Extension boundary   | ESLint rules tested with the ESLint API: extensions cannot import Base internals; `packages/core` cannot import `next`/`react`.                                                                                                                                                                                                |
| CI definition        | `.github/workflows/ci.yml` parses as YAML and every command in it was run locally. **The workflow itself has never run on GitHub.**                                                                                                                                                                                            |

## Pending in Phase 0 (not done, or not verifiable here)

- **Docker images have never been built.** There is no Docker daemon in this sandbox. `Dockerfile` and `docker-compose.yml` are validated only with `docker compose config`. The `web` and `worker` build outputs were verified by running them directly with Node.
- **k6 has never been run.** The binary could not be downloaded (egress policy). `baseline-browse.js` is type-checked against `@types/k6` only. CI installs k6 via `grafana/setup-k6-action`.
- **Testcontainers path unexercised** (needs Docker). Integration tests used `SOLD_TEST_DATABASE_URL` and a spawned `redis-server`. No Keycloak (Phase 5).
- **PgBouncer** is configured in compose but was not run; transaction-pooling behaviour is designed for (DB-level timeouts, direct connections for migrations and pg-boss) but not exercised.
- **Grafana** dashboard JSON is validated against the metric names the code really exports; it has not been loaded into Grafana.
- **Azure and Cloudflare**: no credentials here. Terraform, the `sold` environment CLI and the release workflows are owned by the Platform workstream and are reported separately (see the Platform section below once merged). Nothing has been applied to any cloud.
- OpenTelemetry is wired but exports only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; adaptive sampling is PENDING(phase-7).
- CSP with nonces is not set yet (see open questions).
- Idle/active cost per profile (needs a subscription).

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

| Date       | Decision                                                                                                                                                  | Rationale                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | `CLAUDE.md` is a one-line pointer (not a symlink) to `AGENTS.md`                                                                                          | Symlinks are fragile on Windows checkouts and some tooling                                                                                                    |
| 2026-09-30 | CLI lives in `packages/cli`, exposed as `pnpm sold`                                                                                                       | Section 3 lists no CLI package; a dedicated package keeps `core` framework-free                                                                               |
| 2026-09-30 | TypeScript pinned to `~6.0` (not 7.x)                                                                                                                     | `typescript-eslint` 8.71 declares `typescript <6.1.0`; 7 would break typed linting. Revisit when supported                                                    |
| 2026-09-30 | Environment and tier are separate axes: `environment` (local/ephemeral/dev/stage/prod) vs `tier` (standard/high-volume/event-scale)                       | Spec lists them together as "profiles" but they vary independently                                                                                            |
| 2026-09-30 | Internal packages export TypeScript source (`exports: ./src/index.ts`); apps bundle them (Next `transpilePackages`, esbuild for worker and cache handler) | No per-package build step; fast feedback                                                                                                                      |
| 2026-09-30 | Custom migration runner instead of drizzle's migrator; drizzle-kit is an authoring aid                                                                    | Drizzle's migrator uses one transaction, which makes `CREATE INDEX CONCURRENTLY` impossible; per-scope journal gives per-extension journals                   |
| 2026-09-30 | UUIDv7 via a SQL function `sold_uuid_v7()`                                                                                                                | Native `uuidv7()` needs PostgreSQL 18; target is 16+                                                                                                          |
| 2026-09-30 | pg-boss and migrations use `DATABASE_MIGRATION_URL` (direct), the app uses the pooled URL                                                                 | Advisory locks and LISTEN/NOTIFY do not work under transaction pooling                                                                                        |
| 2026-09-30 | DB timeouts set at database level by migration, not only as startup parameters                                                                            | PgBouncer transaction pooling makes session-level settings unreliable                                                                                         |
| 2026-09-30 | `cacheHandler` (ISR/data cache) implemented now; `cacheComponents` / `cacheHandlers` (`use cache`) not enabled                                            | Spec 8A.2 is the ISR + tag model. Revisit in Phase 4                                                                                                          |
| 2026-09-30 | Cache handler bundle must not include pino; `supports-color` aliased to an empty module                                                                   | Turbopack panics ("must be a path to a root") when tracing the bundled handler with pino/`debug` optional requires. Root-caused by bisecting the import trace |
| 2026-09-30 | Redis policy `volatile-lru` locally                                                                                                                       | Cache entries have TTLs and may be evicted; counters (hot-SKU stock, rate limits) have none and must not be. Deployed Redis should follow suit                |
| 2026-09-30 | `agentRules: false` (Next) and `agentGuidance: false` (turbo)                                                                                             | Both tools inject "agent rules" into `AGENTS.md`/`CLAUDE.md` when they detect an agent. This repo curates its own `AGENTS.md`                                 |
| 2026-09-30 | Web env loaded with `dotenv-cli` (root `.env`)                                                                                                            | `@next/env` from `next.config.ts` is undone by Next's own env reload in dev                                                                                   |
| 2026-09-30 | `pnpm sbom` does not exist in pnpm 10.33; CI uses `anchore/sbom-action`                                                                                   | Checked                                                                                                                                                       |

## Open questions

- **CSP nonces versus CDN caching (needs a decision in Phase 4).** Section 8 requires CSP with nonces, but a per-request nonce makes HTML uncacheable, which contradicts 8A.2 (cache-hit pages must not touch the origin). Likely resolution: nonces for dynamic routes (admin, account, checkout), hash-based CSP (Next `experimental.sri`) for cacheable public pages. Will be recorded as an ADR when the storefront exists. Baseline hardening headers are already set.
- Which Azure subscription and Cloudflare account/zone will be the sandbox for the 8C acceptance demonstration (`env:up`, promotion, rollback)? Until provided, Terraform is validated statically only.
- Customer Cloudflare plan tier (waiting room, cache-tag purge and Access seat limits are plan-dependent); recorded in ADR-0002 once verified.
