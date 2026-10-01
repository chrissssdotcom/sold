# Runbook: operations and on-call

Alerts live in `ops/prometheus/alerts.yml` (thresholds are starting points, untuned: no production traffic exists yet). Dashboards:
`ops/grafana/dashboards/{sales-operations,scale-capacity}.json`. Every alert's `runbook` annotation points at a heading below.

**First five minutes, any incident:** (1) is checkout affected? (2) `GET /api/health/ready` on a web instance; (3) look at the last
deploy (`/api/version` shows version and build id) and roll back if it correlates (below); (4) shed non-essential load if
saturated; (5) write what you see in the incident channel.

## Levers (all reversible, none needs a deploy)

| Lever                  | How                                                                                                                                                                                                                                | Effect                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load shedding          | Admin > Flags: `shed.reporting`, `shed.admin`, `shed.account`, `shed.browse`, `shed.cart` (turning one on sheds that class **and everything of lower priority**); or `SOLD_SHED_BELOW=<class>` on the web app (no database needed) | 503 + `Retry-After: 30`. **Checkout and health/metrics are never shed.** `/api/admin/flags` and `/api/admin/auth` stay reachable so you can switch it off. Flags are cached ~5 s per instance. |
| Degradation rungs      | Flags `degrade.*`                                                                                                                                                                                                                  | Only `degrade.pause-non-essential-jobs` is enforced today (worker). The other four are seeded and documented but **not wired** to behaviour.                                                   |
| Extension off          | `sold.config.ts` + redeploy (extensions are code) or disable its settings (TikTok: clear pixel code, server events off)                                                                                                            | Contributions disappear on next start                                                                                                                                                          |
| Maintenance for orders | Remove web from the load balancer / edge maintenance page                                                                                                                                                                          | The only way to stop checkout, by design                                                                                                                                                       |

Class priority (shed lowest first): reporting < admin < account < browse < cart < **checkout**. Shedding applies to API routes wrapped by
`route()`; cacheable storefront HTML is served from the edge cache and is not shed in-app (the edge waiting room handles that, Terraform
module `cloudflare-edge`, never applied).

## Elevated 5xx

1. Which class? `sum by (route_class, status_class) (rate(sold_http_requests_total[5m]))`.
2. Logs are JSON with `requestId`; find one 500 and read its `err`. Errors never leak internals to clients; the stack is only in logs.
3. Correlate with the deploy. If it started with a release: roll back (below). Expand/contract migrations guarantee N-1 runs on N's schema.
4. If a dependency is the cause, see Redis / database sections.

## Checkout errors

`sold_checkout_total{outcome=…}` shows `placed`, `replayed`, or the stable error code that refused it. Rising `insufficient_stock` during
a sale is normal. Rising `payment_*` = gateway trouble: check the gateway status page; orders stay `pending_payment` and the expiry sweep
releases stock. Dashboard card **Payments need attention** counts events that could not be matched; resolve in Admin > Orders. Never
refund by editing rows; use the refund action (it is idempotent against the gateway).

## Database pool saturated

`sold_db_pool_connections{state="waiting"} > 0`. Check for a long query (`pg_stat_activity`), a missing replica (reads fall back to the
primary), or genuine load. Shed `shed.browse`; add web replicas only if the connection budget in `docs/scaling.md` allows (each replica
uses `DB_POOL_MAX`). Raising statement timeouts is not a fix.

## Redis down

Effects (all verified in the chaos drill, `docs/chaos-drills.md`): the shared page cache falls back to rendering; the inventory admission
gate **fails open** (`sold_inventory_gate_events_total{event="redis_error"}`) and Postgres row locks still prevent overselling, only slower
under contention; rate limits revert to per-instance. Jobs run on Postgres (pg-boss) unless `RedisQueue` was wired (it is not by default).
Restore Redis; no manual repair is needed. Cart state is not in Redis.

## Queue backlog

`sold_queue_oldest_job_age_seconds` (age of the oldest ready job, not depth). Critical queue > 60 s: the outbox relay or sweeps stalled:
check the worker is running (`up{job="sold-worker"}`), logs for handler errors, and `pg_stat_activity` for locks. pg-boss drain is
poll-bound (see `docs/scaling.md`: ~40 jobs/s at batch 1, ~1,200/s at batch 25 on the benchmark box). A killed worker loses nothing:
leased jobs are re-delivered after the lease expires (tested). Duplicate delivery is possible, consumers are idempotent.

## A service is down

Web: containers restart on liveness failure only (liveness does not touch dependencies, so a database outage never restarts healthy
pods); readiness drains traffic. Worker: stateless, restart it. The database is the only stateful component: see
`docs/runbooks/database.md` and `docs/runbooks/backup-restore.md`.

## A misbehaving extension

`sold_extension_unhandled_failures_total`, `sold_extension_blocked_ms`. Extensions are trusted in-process code (ADR-0004): detection and
circuit breakers exist, preemption does not (a synchronous infinite loop cannot be interrupted). Remove it from `sold.config.ts` and
redeploy; Base keeps working without it by design.

## Rolling back a release

Releases are immutable images stamped in `environments/<env>/release.json`. Roll back by re-deploying the previous digest through the
promotion workflow (`docs/runbooks/environments.md`). Do not roll back the database; migrations are forward-only and N-1 code is
required to run on N's schema.

## Load shedding

Use it before the system falls over, not after. Typical sale ladder: `shed.reporting` → `shed.admin` → `shed.account` → `shed.browse`.
Turn rungs back off in reverse. Each flip is audited (`flag.set`). Remember analytics/reporting readers stop working at `shed.reporting`.

## Routine

Daily: dashboard card "Emails failed/stuck" and "Payments need attention" at zero. Weekly: backup drill output. Monthly: `pnpm audit`,
dependency updates, key-rotation review. Before a planned sale: `docs/sale-readiness.md`.
