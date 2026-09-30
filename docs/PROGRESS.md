# PROGRESS

Live status. Update at every green checkpoint.

## Status

| Phase                                          | State                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Pre-work: AGENTS.md, CLAUDE.md, ADR-0001, plan | done                                                                          |
| Phase 0: Foundations                           | **built; not signed off** (see "Pending in Phase 0": no Docker, k6, or cloud) |
| Phase 1: Extension SDK and Base kernel         | **built; under independent review** (see "Phase 1 evidence")                  |
| Phase 2: Commerce core                         | not started                                                                   |
| Phase 3: Payments and multi-currency           | not started                                                                   |
| Phase 4: Storefront and page builder           | not started                                                                   |
| Phase 5: Identity and admin                    | not started                                                                   |
| Phase 6: Social and growth                     | not started                                                                   |
| Phase 7: Data and platform                     | not started                                                                   |
| Phase 8: Hardening, scale proof, handover      | not started                                                                   |

Phases 2-8 are most of the product. Nothing in them exists; this file does not claim otherwise. Every "verified" claim
below names what was run.

## Independent review

Both phases were reviewed by a separate agent that did not write the code and was told to break it.

**Phase 0 review** (report on file in the session) found, and this branch fixed, with a regression test for each:

| Finding                                                                                                                                                       | Resolution                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical:** shared ISR cache handler never invalidated real pages (page tags live in `x-next-cache-tags`, not `ctx.tags`; my tests used synthetic contexts) | Rewritten against Next's real contract. New two-instance end-to-end test on a real Next app. **Verified the test fails on the old handler and passes on the new one.**                                    |
| Clock skew lost invalidations                                                                                                                                 | Timestamps come from the Redis clock (measured offset); render-start ordering; skew test with injected skewed clocks                                                                                      |
| `X-Robots-Tag` baked in at build time (broke build-once/promote)                                                                                              | Set at request time in `proxy.ts`; verified one build: prod sends no header, stage does                                                                                                                   |
| A failed `CREATE INDEX CONCURRENTLY` left an INVALID index the runner journaled as success                                                                    | Runner drops invalid leftovers and verifies `indisvalid`                                                                                                                                                  |
| Second runner died after `lock_timeout` while the first was slow                                                                                              | Runner lock is acquired (bounded, polling) before `lock_timeout` is set                                                                                                                                   |
| Partition retention `DROP` stalled checkout writes; default-partition rows broke creation                                                                     | App-side retention with a 150 ms lock timeout and retries; default-partition rows are detected and reported. (`DETACH CONCURRENTLY` was tried first and is impossible with a DEFAULT partition; recorded) |
| `PgBossQueue.health()` scanned the whole job table                                                                                                            | Index-only query on pg-boss's `job_common_i11`; `EXPLAIN` test over 300k rows                                                                                                                             |
| Queue policy edits never reached existing queues; pg-boss ran under the 5 s DB statement timeout                                                              | `updateQueue` when it exists; queue sets its own session timeouts; tests run against a migrated DB                                                                                                        |
| Log redaction was shallow                                                                                                                                     | Deep, key-normalised redaction plus credential scrubbing in strings and errors                                                                                                                            |
| Extension boundary allowed `@sold/jobs`, `import()`, `require()`, path reach-ins                                                                              | Hardened and tested                                                                                                                                                                                       |
| Migration linter (regex) let 40+ unsafe statements through and rejected the recipe it recommends                                                              | Rewritten on PostgreSQL's real parser (libpg-query WASM), 89-case adversarial corpus                                                                                                                      |
| Readiness could load the DB and be starved by traffic                                                                                                         | Dedicated probe pool, 1 s coalesced cache, draining always live                                                                                                                                           |
| Doc overclaims (`pg_stat_statements`, "every hot query has EXPLAIN")                                                                                          | Corrected; known gaps listed in `docs/scaling.md`                                                                                                                                                         |

Not fixed (recorded in `docs/scaling.md` as known gaps): no DB circuit breaker or pool-wait bound; drain sizing is
documented not enforced; Next keeps per-route cache-control per process; tag stale windows are treated as immediate expiry.

**Phase 1 review:** requested; findings will be recorded here with their resolutions.

## Phase 0 evidence (what was actually run, in this sandbox)

Local gate from the repo root: `pnpm format:check typecheck lint test db:lint-migrations build` green, and
`pnpm test:integration` green against a local PostgreSQL 16 and `redis-server` (`SOLD_TEST_DATABASE_URL` set).
Also run: a clean-checkout install and build (simulating the image build stage) and the build output executed from a
relocated directory in `NODE_ENV=production` with a stage-like environment.

| Area               | Verified by running                                                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config and env     | Zod schemas for `sold.config.ts` and process env (fail-fast, no secret values in errors), non-prod safety switches, build-id rule. Unit tests                                                                                                                         |
| Migrations         | Custom runner: idempotent rerun, checksum immutability, forward-only ordering, rollback, `CONCURRENTLY` outside a transaction, invalid-index recovery, bounded runner-lock wait, string literals containing the breakpoint marker; schema-vs-Drizzle equality         |
| Migration linter   | AST-based, 120 db unit tests including the adversarial corpus; runs over real migrations in CI                                                                                                                                                                        |
| Data layer         | Typed primary/replica handles, replica fallback, timeouts (direct and DB-level), query counter, UUIDv7, feature flags with negative caching                                                                                                                           |
| Outbox             | Monthly partitions, retention never drops unpublished events, writer latency bounded during retention, default-partition detection, `EXPLAIN` on the publisher poll                                                                                                   |
| Web app            | Standalone server on real Postgres/Redis: probes, `/metrics` auth, headers, request IDs, runtime robots header, graceful drain (SIGTERM), primary-down and Redis-down behaviour                                                                                       |
| Shared cache       | Real Next, two instances, one Redis: `revalidatePath`, `revalidateTag`, cross-instance regeneration, unrelated pages stay cached, Redis-down still serves                                                                                                             |
| Worker             | Real bundle: probes, metrics with queue-age gauges, partition job, extension consumers, SIGTERM drain. pg-boss adapter: idempotent enqueue, retry then dead-letter, age, concurrency, policy update, index-only health                                                |
| Extension boundary | ESLint rules tested through the ESLint API (packages, `import()`, `require()`, path reach-ins)                                                                                                                                                                        |
| Terraform          | Independently re-run: `terraform init` (local provider mirror) and `validate` succeed for the `demo` dev and ephemeral roots against real azurerm 5.7.0 and cloudflare 5.26.0 schemas; the platform agent also ran `terraform test` (mock providers) and `actionlint` |

## Phase 1 evidence

| Area                       | Verified by running                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK manifest               | `defineExtension` validation (hot-path honesty, duplicate names, route access rules, permission namespacing, settings must parse empty, reporting views): 15 unit tests                                                                                                                                                            |
| Load order                 | Deterministic ordering, semver `requires`, missing/disabled/incompatible dependencies, cycles with the path, all problems reported at once                                                                                                                                                                                         |
| Interceptors               | Ordering, validated `modify`, veto sanitising, frozen payload, error isolation, fail-open/closed, hard timeout with late results discarded, circuit breaker and half-open single trial, bounded pool (deterministic saturation test), **hot-path guard blocks `fetch` and raw sockets and never reaches the server**               |
| Observers                  | Idempotency keys, non-blocking publish that never throws, decode of `bigint`/`Date` payloads, retries, dropped deliveries for removed observers                                                                                                                                                                                    |
| Services                   | Override precedence, config selection, tie refusal, lazy cached creation                                                                                                                                                                                                                                                           |
| Settings and crypto        | AES-256-GCM envelope encryption (context-bound, tamper-evident, key rotation), secrets never in rows/audit/forms                                                                                                                                                                                                                   |
| Kernel on real PostgreSQL  | Extension migrations under their own journal scope, lifecycle transitions, failed `onInstall` retry, vanished extension, encrypted settings in real rows, `uninstall --purge`, **unsafe extension migration rejected with nothing applied**, zero-extension and multi-extension boots                                              |
| End to end on real pg-boss | `order.placed` published, consumed by the worker-wired kernel, observer writes to Postgres exactly once despite duplicate publish; namespaced queues and schedule exist; interceptor veto; protected route fails closed                                                                                                            |
| Live processes             | Web + worker against Postgres/Redis: readiness includes the extension kernel, `401` on protected routes without an actor, `404/405`, traversal `404`, per-extension metrics. **Running the worker found a real bug** (illegal pg-boss schedule key) that unit tests missed; the in-memory queue now enforces the same naming rules |
| Scaffold                   | A freshly generated extension loads, its migration lints clean, its own unit test passes and it type-checks                                                                                                                                                                                                                        |
| Docs                       | `docs/extending.md` code blocks are verified against the real loyalty-points source by a test                                                                                                                                                                                                                                      |

## Pending in Phase 0 (not done, or not verifiable here)

- **Docker images have never been built.** No Docker daemon here. `Dockerfile` and `docker-compose.yml` are validated with
  `docker compose config`, and the build's install/build/run steps were simulated from a clean checkout. CI now has a
  `docker` job that builds both targets; it has never run.
- **k6 has never been run** (binary download blocked). The scenario is type-checked against `@types/k6` only.
- **GitHub Actions workflows have never run.** Their commands were run locally; `actionlint` passes on the platform workflows.
- **Testcontainers path unexercised.** No Keycloak (Phase 5).
- **PgBouncer** is configured in compose but was not run.
- **Grafana** dashboard JSON is validated against the metric names the code exports; not loaded into Grafana.
- **Azure and Cloudflare: nothing was planned or applied anywhere.** No credentials exist here. See ADR-0002 for which vendor
  facts were verified from primary sources and which are marked `search` or `UNVERIFIED`; re-read before any apply.
- The environment lifecycle, upgrade flow and promotion pipeline are implemented and unit-tested against fakes and real
  temporary git repositories; the acceptance criteria that need a real subscription (an `env:up`/`env:down --verify` run,
  a second customer provisioned, dev-to-prod promotion and rollback) are **not** met.
- OpenTelemetry exports only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; adaptive sampling is PENDING(phase-7).
- CSP with nonces is not set (see open questions). Idle/active cost per profile needs a subscription.
- The migration linter cannot know schema state (e.g. `CONCURRENTLY` on a partitioned parent) and its parser is PostgreSQL 17.

## Platform workstream (Terraform, CLI, pipeline)

Built by a delegated agent and independently re-validated where possible. Deviations from the spec are recorded in
ADR-0002/0003: azurerm is v5 (not v4); Cache-Tag purge works on every Cloudflare plan while Waiting Room needs Business or
Enterprise; Cloudflare Email Sending is Beta so SMTP is the default `EmailTransport`; Container Apps managed certificates
cannot renew behind Cloudflare so an Origin CA certificate is used; Cloudflare allows one ruleset per phase per zone so
edge rules live in a customer-level module; `release.json` gained optional worker/migrate image digests. There is **no
`migrate` Dockerfile target yet**, so previews have no way to migrate until one exists (PENDING).

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

## Phase 1 review round 2 (independent adversarial review of the extension framework)

An independent reviewer reproduced critical and high findings against real PostgreSQL. Two fix agents were then cut off
by an API rate limit; their work was checkpointed in the tree. **Honest status:**

- Verified by me after the cut-off: whole repo typechecks, lints, unit tests (core 265, db 222, sdk 17, cli 228, config 19, web 69) and
  integration suites (db 55, core 17, web 18, commerce 58, payments 26, content 6) all pass against local PostgreSQL 16 + Redis.
- Landed (evidence: code plus tests in the tree): per-extension DB roles and pools wired through `createKernel`
  (`extension-roles.ts`, `extension-db.ts`, integration test with non-superuser role), allowlist extension-migration linter with
  non-waivable rules and adversarial cases, quoted-identifier purge with owned-object tracking, secret-key rotation env
  (`SOLD_SECRET_KEY_PREVIOUS`), isolation env switches, process-level guard for extension failures, HTTP safety layer
  (`extension-safety.ts`), ESLint extension-boundary allowlist (`packages/config/extension-boundary.js`), template and
  loyalty-points restructured into `*.observer.ts` / `*.interceptor.ts` / `*.route.ts` / `*.job.ts`.
- ADR-0004 states the trust model plainly: extensions are trusted in-process code, not sandboxed.
- **Not yet re-audited against the reviewer's scripts** (they were not re-run by an independent party): the full finding list
  (interceptor-runner fairness and result-read hardening, settings snapshot refresh/freeze/size cap, `installing` lifecycle state,
  chunked-body and response-header handling, `ext:new` escaping, reserved-word names). Some of these have tests in the tree;
  treat all as "implemented, pending independent re-review" until a second review round signs them off. Extension jobs still
  ignore pg-boss `job.signal` (known gap).

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
| 2026-09-30 | Web and worker never run migrations; the kernel receives its migrator by injection and only the CLI supplies it                                           | Keeps the migration linter and its WASM parser out of runtime bundles; makes migrations an explicit release-pipeline step                                     |
| 2026-09-30 | Extension registry is generated at build time (`sold ext:sync`) and imported statically                                                                   | Bundlers cannot follow dynamic `import(name)`; generated file is a build artifact, customer-owned config drives it                                            |
| 2026-09-30 | Extension route responses default to `Cache-Control: no-store`                                                                                            | A personalised extension response must never be stored by the CDN by accident                                                                                 |
| 2026-09-30 | Retention drop uses a short `lock_timeout` with retries instead of `DETACH CONCURRENTLY`                                                                  | PostgreSQL forbids concurrent detach while a DEFAULT partition exists; the default partition protects checkout writes                                         |
| 2026-09-30 | `0000_init.sql` was annotated (`sold:allow dynamic-sql`) after being applied locally                                                                      | Pre-release only: no deployed database exists. Migrations are otherwise immutable                                                                             |
| 2026-09-30 | Demo `sold.config.ts` enables `loyalty-points`                                                                                                            | So `pnpm dev` exercises the whole extension path; remove it to run with zero extensions                                                                       |

## Open questions

- **CSP nonces versus CDN caching (needs a decision in Phase 4).** Section 8 requires CSP with nonces, but a per-request nonce makes HTML uncacheable, which contradicts 8A.2 (cache-hit pages must not touch the origin). Likely resolution: nonces for dynamic routes (admin, account, checkout), hash-based CSP (Next `experimental.sri`) for cacheable public pages. Will be recorded as an ADR when the storefront exists. Baseline hardening headers are already set.
- Which Azure subscription and Cloudflare account/zone will be the sandbox for the 8C acceptance demonstration (`env:up`, promotion, rollback)? Until provided, Terraform is validated statically only.
- Customer Cloudflare plan tier (waiting room, cache-tag purge and Access seat limits are plan-dependent); recorded in ADR-0002 once verified.
