# Sold

A single-tenant, extensible e-commerce platform built for traffic spikes. One deployment serves one business:
there is no `tenant_id` anywhere. **Sold Base** is the upstream product; each customer instance is Base plus
extensions kept in `extensions/` and `sold.config.ts`, so Base upgrades never conflict with customisations.

Read [`AGENTS.md`](AGENTS.md) first (principles, commands, conventions), then
[`docs/adr/`](docs/adr) and [`docs/PROGRESS.md`](docs/PROGRESS.md) for what exists and what does not.

> **Status: Phase 0 (foundations).** The storefront, checkout, payments and extension framework are not built yet.
> See `docs/PROGRESS.md` for an honest account of what is implemented, verified and pending.

## Quickstart

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d           # Postgres, PgBouncer, Redis, Mailpit, MinIO, Prometheus, Grafana
pnpm db:migrate && pnpm db:seed
pnpm dev                       # web on http://localhost:3000 (Grafana on :3030, Mailpit on :8025)
```

Without Docker, point `DATABASE_URL` and `DATABASE_MIGRATION_URL` at any PostgreSQL 16 and skip Redis
(the cache handler falls back to in-memory outside stage/prod).

| Task                                                                                     | Command                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Typecheck / lint / unit                                                                  | `pnpm typecheck` / `pnpm lint` / `pnpm test` |
| Integration (needs Postgres; set `SOLD_TEST_DATABASE_URL`, or Docker for Testcontainers) | `pnpm test:integration`                      |
| Migration safety lint                                                                    | `pnpm db:lint-migrations`                    |
| Worker                                                                                   | `pnpm --filter @sold/web worker`             |
| Load test smoke                                                                          | `k6 run ops/loadtests/baseline-browse.js`    |

## Architecture

```
                    Cloudflare (CDN, WAF, Turnstile, R2, email)
                                   │
                    ┌──────────────┴──────────────┐
                    │   web (Next.js, stateless)   │   worker (jobs, stateless)
                    └───────┬───────────────┬──────┴───────┐
                            │               │              │
                        PgBouncer        Redis        (direct, session)
                            │      (ISR cache, rate      │
                            ▼       limits, counters)    ▼
                     PostgreSQL primary ───────────► read replica(s) ◄── Grafana
```

- `apps/web`: storefront, `/admin`, `/api` (thin delivery layer).
- `packages/core`: domain logic, config, env, resilience, job interfaces (no framework imports).
- `packages/db`: Drizzle schema, online-safe migration runner and linter, feature flags.
- `packages/jobs`: pg-boss `JobQueue` adapter.
- `extensions/*`: first-party and customer extensions (SDK arrives in Phase 1).
- `ops/`: Terraform, Grafana, Prometheus, k6.

Adding a feature in 30 minutes (the extension walkthrough) arrives with the SDK in Phase 1.
