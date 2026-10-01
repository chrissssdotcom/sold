# Handover

For the engineer or team who takes Sold from here. Read [`AGENTS.md`](../AGENTS.md) for conventions, then this page for the map, then the runbooks.

## What exists

| Area                                                                                           | Where                                                                              | Read                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Architecture, decisions                                                                        | `docs/adr/0001-0005`                                                               | ADR-0004 (extensions are trusted code) and ADR-0005 (CSP) are the two people most often surprised by |
| Commerce core (catalog, inventory, cart, pricing, promotions, tax, shipping, orders, checkout) | `packages/commerce`                                                                | `docs/commerce.md`                                                                                   |
| Payments, multi-currency                                                                       | `packages/payments`                                                                | `docs/payments.md` (Stripe only against a local fake)                                                |
| Storefront, page builder, themes                                                               | `packages/storefront`, `packages/content`, `themes/`                               | `docs/storefront.md`, `docs/theming.md`                                                              |
| Identity, RBAC, SSO, SCIM                                                                      | `packages/identity`                                                                | `docs/identity.md` (OIDC/SAML only against fakes)                                                    |
| Staff console and admin API                                                                    | `apps/web/src/app/admin`, `apps/web/src/app/api/admin`                             | `docs/admin.md`                                                                                      |
| Extensions (kernel, SDK, reviews, TikTok, loyalty)                                             | `packages/extension-sdk`, `packages/core/src/extensions`, `extensions/`            | `docs/extending.md`, `docs/social-growth.md`                                                         |
| Notifications                                                                                  | `packages/notify`                                                                  | `docs/notifications.md`                                                                              |
| Reporting, Grafana                                                                             | `packages/db/src/reporting-views.ts`, `ops/grafana`                                | `docs/reporting.md`                                                                                  |
| Public API, webhooks, API keys                                                                 | `packages/platform`, `apps/web/src/app/api/v1`                                     | `docs/api.md`                                                                                        |
| Media                                                                                          | `packages/media`                                                                   | `docs/media.md`                                                                                      |
| Jobs                                                                                           | `packages/jobs` (pg-boss default, `RedisQueue` optional, **not wired by default**) | `docs/scaling.md`                                                                                    |
| Environments, Terraform, CLI, release pipeline                                                 | `ops/terraform`, `packages/cli`, `.github/workflows`                               | `docs/runbooks/environments.md`, `docs/upgrading.md` (**never applied/run**)                         |

## Run it locally

`README.md` quickstart, or without Docker: Postgres 16 + Redis, `pnpm db:migrate && pnpm db:seed && pnpm --filter @sold/web seed:demo`,
`SOLD_OWNER_PASSWORD=… pnpm sold user:create-owner --email you@example.com`, `pnpm dev`. The worker is `pnpm --filter @sold/web worker`
(start it: orders send no email and outbox events do not publish without it).

**Run the production build before you believe anything.** `pnpm --filter @sold/web build`, then `node apps/web/.next/standalone/apps/web/server.js`
with `NODE_ENV=production`. It enforces behaviours the dev server does not (per-extension database roles: run
`NODE_ENV=production pnpm db:migrate` first; CSP nonces; the container's `HOSTNAME`). Four real bugs in this project hid until it was run that way.

## Operate it

- On-call: `docs/runbooks/operations.md` (levers: load shedding, flags), alerts in `ops/prometheus/alerts.yml` (thresholds are guesses).
- Backups and restore: `docs/runbooks/backup-restore.md`. Database: `docs/runbooks/database.md`. Environments and promotion: `docs/runbooks/environments.md`.
- Before a sale: `docs/sale-readiness.md` and `ops/drills/sale-readiness.sh`.
- Upgrades: `docs/upgrading.md`. Rehearse a rollback with `PREV_REF=<tag> ops/drills/n-minus-1.sh`.
- Security: `docs/threat-model.md`, ADR-0005, `route-coverage.test.ts` (new `/api/admin` or `/api/v1` routes must use the wrappers or CI fails).

## Customer creation and promotion (the documented flow)

1. `pnpm sold customer:new acme --dir ../sold-acme --base-version <x.y.z> --display-name "Acme Pty Ltd"` writes the instance overlay (config,
   environments, Terraform roots, drift workflow). **Run for real** here: it produced the 32-file scaffold. Applying it to a Base clone and
   pushing it, the customer bootstrap (`ops/terraform/bootstrap/customer`), `env:up`, and promotion `dev → stage → prod` through `release.yml` need a
   cloud subscription and GitHub, and **have not been run**. `docs/runbooks/environments.md` is the procedure; expect first-apply surprises
   (the runbook lists the known ones).
2. Day to day an instance changes only customer-owned paths (`extensions/`, `sold.config.ts`, `config/`, `environments/`); `sold drift:check` enforces it.

## Known gaps (the honest list)

Not built: search, loyalty programme UI, referrals, A/B exposure logging, abandoned-cart email (needs opt-in), object-storage media adapter,
bounce/complaint ingestion, audit hash chain, Service Bus queue adapter, waiting room, `degrade.*` rungs 1-3, DB circuit breaker, secret scanning in CI.

Never run against the real thing: Stripe, Postmark, TikTok, OIDC/SAML providers, Grafana, Docker images, Terraform apply, GitHub Actions
(`terraform validate` and `actionlint`-style checks only), any cloud load test, PITR/failover. Independent re-review of Phases 1-5 was started and not completed
(reviewers were rate-limited); the review findings that did arrive were fixed (see `docs/PROGRESS.md`).

Performance numbers are local single-instance figures (`docs/capacity-report.md`); they are not a sizing recommendation.

## First things to do with a cloud subscription

1. Bootstrap, `env:up` a `dev` environment, run `.github/workflows/ci.yml` (the smoke job has never executed) and fix what breaks.
2. Build both images (`Dockerfile`), run `ops/drills/sale-readiness.sh` against the deployed environment.
3. Load test a `stage`-shaped environment (scenarios 2, 3, 4, 5, 7; k6 versions of 2 and 3 are not written), then fill the table in `docs/scaling.md`.
4. Managed-PITR restore into a scratch server and a Postgres failover under load; record achieved RPO/RTO.
5. Real Stripe test mode, Postmark, and one SSO provider end to end.
