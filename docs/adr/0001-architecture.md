# ADR-0001: Architecture and technology decisions

- Status: Accepted
- Date: 2026-09-30
- Deciders: Sold engineering

## Context

Sold is a single-tenant e-commerce platform for high-volume consumer brands. One deployment serves one business, with one database and no `tenant_id`. It is built as **Base + Extensions**: customers carry bespoke features in `extensions/` and `sold.config.ts`, and pull Base upgrades without merge conflicts. Traffic is spiky (drops, sales, influencer campaigns), so scalability, load shedding and graceful degradation are first-class.

## Decisions

| Concern          | Decision                                                                                                | Why                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Framework        | Next.js (latest stable), App Router, RSC, Server Actions where appropriate, TypeScript `strict`         | Server-rendered public pages that cache well; one codebase for storefront, admin, API                                      |
| Runtime          | Node.js LTS                                                                                             | Stability, support window                                                                                                  |
| Monorepo         | pnpm workspaces + Turborepo                                                                             | Fast, strict dependency graph, remote-cacheable                                                                            |
| Database         | PostgreSQL 16+ only                                                                                     | Transactional integrity for money and inventory; one datastore to operate                                                  |
| ORM / migrations | Drizzle ORM + drizzle-kit, SQL migrations checked in                                                    | Typed SQL close to the metal; reviewable migrations; migration linter operates on SQL                                      |
| Validation       | Zod at every boundary                                                                                   | One schema drives types, validation, OpenAPI and settings forms                                                            |
| Jobs             | `JobQueue` interface; pg-boss default; Redis adapter built (Service Bus adapter not built)              | No extra infra by default; explicit escape hatch (thresholds in `docs/scaling.md`) because Postgres-as-queue has a ceiling |
| Edge             | Cloudflare (CDN, WAF, rate limit, bot, Turnstile, waiting room, email, R2)                              | See ADR-0002                                                                                                               |
| Cache            | Next.js cache + tags with a shared Redis-backed cache handler; in-memory only for local dev / ephemeral | ISR consistency across many instances                                                                                      |
| DB connections   | PgBouncer (transaction pooling); `primary` and `replica` handles from day one                           | Fixed connection budget; catalog/search/admin lists/reporting off the primary                                              |
| Hosting          | Azure Container Apps default (AKS optional), PostgreSQL Flexible Server, Azure Managed Redis, Key Vault | See ADR-0002                                                                                                               |
| IaC              | Terraform (OpenTofu-compatible), `azurerm` + `cloudflare` providers                                     | See ADR-0003                                                                                                               |
| Object storage   | S3-compatible interface; local disk (dev), MinIO (compose), R2 (prod)                                   | Vendor code in adapters only                                                                                               |
| Customer auth    | DB-backed sessions; passkeys, password, magic link                                                      | Revocable; no JWT session pitfalls                                                                                         |
| Admin auth       | Local break-glass + OIDC + SAML 2.0 + SCIM 2.0                                                          | Enterprise SSO; Entra ID first-class                                                                                       |
| Styling          | Tailwind + CSS variable tokens; Radix primitives                                                        | Themeable, accessible                                                                                                      |
| Testing          | Vitest, Playwright, Testcontainers                                                                      | Real Postgres in integration tests                                                                                         |
| Observability    | OpenTelemetry, pino JSON logs, Prometheus `/metrics`                                                    | Standard, vendor-neutral                                                                                                   |
| Local infra      | docker-compose: Postgres, PgBouncer, Redis, Mailpit, MinIO, Grafana                                     | `docker compose up` gives a working stack                                                                                  |
| CI               | GitHub Actions                                                                                          | typecheck, lint, unit, integration, e2e, build, migration lint, audit/SBOM                                                 |

### Structural rules

1. `packages/core` is framework-free (no `next`, no `react`) so it is testable without a web server.
2. `apps/web` is a thin delivery layer.
3. Dependency direction: `apps/web → core/ui/identity/payments → db`. Extensions depend only on `extension-sdk`.
4. Base's own optional features (`tiktok-social`, `reviews`, `waiting-room`) are built as extensions to prove the SDK.
5. Web and worker are separate deployables built from one codebase and one image (separate targets/entrypoints) so they scale independently.
6. The app tier is stateless. No correctness-critical state in process memory.

### Extension model (summary; detailed in the SDK docs)

An extension is a package with a typed `defineExtension({...})` manifest that may contribute: schema (`ext_<name>_` tables, own migration journal), events (observers async/retryable; interceptors sync/ordered/timeboxed), page-builder blocks, UI slots, routes, service providers, jobs/schedules, settings (Zod → admin form, secrets encrypted), permissions, and reporting views. Load order is deterministic (declared dependencies + `requires: { base }` semver). Extensions declare `performance: { hotPath, budgetMs }`; hot-path interceptors are bounded, time-limited, and forbidden from synchronous external calls. Precedence: instance extension > first-party extension > Base default.

### Money and data

- `Money = { amount: bigint, currency }`; no floats; `bigint` + `char(3)` + CHECK.
- Orders are immutable snapshots; explicit state machines; UUIDv7 keys; transactional outbox for events that must not be lost.
- Migrations are forward-only, online, expand/contract. High-volume tables (events, page views, audit log, outbox, webhook inbox, job history, email log) are time-partitioned with automated creation and retention.

## Alternatives considered

- **Multi-tenant SaaS with `tenant_id`.** Rejected: contract and blast-radius requirements favour per-customer deployments and bespoke code.
- **Prisma.** Rejected: weaker fit for hand-reviewed online migrations, partitioning and reporting views.
- **Dedicated queue (SQS/Kafka) from day one.** Deferred behind `JobQueue`; pg-boss measured in Phase 7/8, with Service Bus adapter and switch-over thresholds documented.
- **Micro-frontends / separate storefront and admin apps.** Rejected for now: one Next.js app with strict layering is simpler; revisit if bundle isolation demands it.

## Consequences

- Every vendor integration is an adapter behind an interface; swapping is a config and adapter change.
- Upgrade safety depends on the ownership rules (Base-owned vs customer-owned paths), enforced in CI (ADR-0003).
- Scale gates (AGENTS.md, Section 8A.11) apply to every phase.
- Vendor capabilities (Cloudflare plan features, Cloudflare email, Azure Managed Redis SKUs) are unverified assumptions until recorded in ADR-0002.

## Open items

- ADR-0002 (Azure + Cloudflare) and ADR-0003 (environments and upgrades) to be written with verified vendor facts before the affected adapters or Terraform modules are implemented.
