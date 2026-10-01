# Scaling: SLOs, capacity model, tier profiles

> **Status: design targets, not measured results.** Every number below is an initial assumption for the
> `event-scale` profile. None came from a customer. They are "met" only when the capacity report at the
> bottom shows a load-test result for them (Section 8A.1, gate for Phase 8 sign-off). Until then, treat
> them as hypotheses and do not quote them to a customer.

## Service level objectives (design targets, `event-scale`)

| Objective                                      | Target                                                             | Evidence required                       | Evidence today                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Availability, storefront browsing and checkout | 99.95%                                                             | SLO burn-rate alerts + chaos drills     | none                                                                                         |
| Cache-hit page TTFB at the edge                | p95 < 200 ms                                                       | edge analytics under the spike scenario | none                                                                                         |
| Origin on a cache miss                         | p95 < 400 ms                                                       | k6 scenario 7 (cache-cold)              | k6 scenario 1 threshold defined, not yet run in CI                                           |
| Cart and checkout APIs at peak                 | p95 < 500 ms, p99 < 1.5 s                                          | k6 scenarios 2 and 3                    | none                                                                                         |
| Step increase                                  | 50x in 60 s, no errors on cached routes, no order loss             | k6 scenario 2                           | local only: 2 → 100 workers, 0 errors in ~13k requests (`capacity-report.md`)                |
| Order throughput                               | >= 1,000 orders/min per instance, no oversell, documented headroom | k6 scenario 3 (5,000 buyers, 100 units) | local only, see `capacity-report.md` (no oversell holds; throughput below)                   |
| RPO / RTO                                      | <= 5 min / <= 1 h                                                  | restore and failover drills             | procedure verified on a local DB only (`runbooks/backup-restore.md`); no PITR/failover drill |

## Capacity model

Traffic is modelled as three classes with very different costs. This is why the design is cache-first.

1. **Cacheable browse** (home, collection, product, content): served by the CDN and the shared ISR cache.
   A hit must not touch Postgres. Origin cost is only misses and regeneration.
2. **Dynamic browse and cart** (cart, live stock islands, search): small cacheable-where-possible JSON APIs.
3. **Checkout**: the only class that must write. Its critical path is validate cart, reserve stock, create
   payment, confirm, then **one short transaction** persisting order plus outbox row. Everything else is queued.

Sizing rule of thumb (to be replaced by measurements): peak origin RPS ~= peak edge RPS x (1 - edge hit ratio)

- dynamic API RPS. Checkout capacity is bounded by primary Postgres write throughput and by the hot-SKU
  reservation path, not by web replicas.

### Database connection budget

Postgres `max_connections` is a fixed budget; PgBouncer (transaction pooling) multiplexes clients onto it.

```
server_connections_available = max_connections
                             - 10   (superuser + monitoring + Grafana reporting)
                             - 5    (migrations)
                             - worker_queue_pools   (pg-boss connects DIRECTLY: workers x 5)
app_server_connections       = pool_size per database/user pair in PgBouncer  (default_pool_size)
per_replica_client_pool      = DB_POOL_MAX  (client side, cheap: they are PgBouncer clients)
```

- App pools are PgBouncer clients, so `DB_POOL_MAX x replicas` may exceed `default_pool_size`; PgBouncer queues.
  Watch `sold_db_pool_connections{state="waiting"}` and PgBouncer `cl_waiting`. Sustained waiting means shed
  load or add capacity, never simply raise the pool.
- Migrations and pg-boss must use `DATABASE_MIGRATION_URL` (direct): they need session state.
- Timeouts (statement 5 s, lock 2 s, idle-in-transaction 5 s) are set at database level by migration
  `0000_init` so they hold under transaction pooling.
- Read replicas: catalog reads, search, admin lists and all reporting use the `replica` handle. Read-your-writes
  paths (post-checkout confirmation) use `primary`.

## Tier profiles

Profiles are **data**: the source of truth for SKUs and counts is `ops/terraform/profiles/*.tfvars` and the
`tier` field of `sold.config.ts`. This table states intent only.

|                            | `standard`                    | `high-volume`     | `event-scale`                                   |
| -------------------------- | ----------------------------- | ----------------- | ----------------------------------------------- |
| Intended peak              | steady small store            | regular campaigns | product drops, influencer/TikTok surges         |
| Web replicas (min-max)     | 2-6                           | 3-20              | pre-scaled 6+, up to 100 (KEDA on request rate) |
| Worker replicas            | 1-2                           | 2-6               | 4-20 (KEDA on queue age)                        |
| Postgres                   | zone-redundant HA, no replica | HA + 1 replica    | HA + 2 replicas, larger SKU                     |
| Redis                      | shared cache + counters       | same              | same, larger, hot-SKU counters                  |
| Waiting room               | off                           | flag              | enabled per event                               |
| Load test before each sale | smoke                         | full              | full + chaos                                    |

`SOLD_SCALE_MODE=prescale` raises minimum replicas ahead of scheduled events (runbook: `docs/runbooks/sale-readiness.md`,
PENDING(phase-8)).

## Known limits and gaps (found by independent review; not yet closed)

- **Drain sizing.** `SOLD_DRAIN_SECONDS` (default 10) is how long the web app stays up reporting `503` after SIGTERM so
  load balancers stop routing. It only works if `probe interval x failure threshold < SOLD_DRAIN_SECONDS`, and the
  orchestrator's termination grace period must exceed drain + longest in-flight request (compose uses 30 s web, 45 s
  worker). There is no in-flight request tracking: after the drain window the process exits.
- **pg-boss idle load.** Each worker polls every declared queue, and `localConcurrency` multiplies pollers. One review
  measurement showed ~17 transactions/s from a single idle worker with 3 queues (the `critical` class polls every 2 s).
  Multiply by worker replicas and queues before sizing the primary; this is the first thing to measure in Phase 7.
- **Next per-route cache-control is per process.** A route not prerendered at build re-renders once on its first hit on
  each new instance (Next keeps `revalidate` in process memory). Pre-warm (Phase 4) mitigates for hot pages.
- **Tag stale windows.** `revalidateTag(tag, { expire })` is treated as immediate expiry by the shared cache handler;
  stale-while-revalidate on tag invalidation is not implemented (Phase 4).
- **No DB circuit breaker and an unbounded pool wait queue** in `@sold/db`. Under primary loss requests wait on the pool
  until their own timeouts. Phase 8 drill (`chaos-drills.md`): with the database **stopped** (connection refused) requests failed fast and
  cleanly as 503s, so the missing breaker did not hurt there. A **blackholed** database (packets dropped, connect hangs) was not tested and
  is the case the breaker and a bounded pool wait would matter for. Still open.
- **Very large cache entries** (multi-MB) cost event-loop time to serialise; the store scales its timeout with size but
  does not compress or stream.
- **Tag times live in one Redis hash** (`sold:cache:tags`) that is not TTL'd (so `volatile-lru` never evicts it). It needs a
  periodic cleanup of tags older than the max entry TTL (Phase 4).

## Degradation ladder

Feature flags seeded by `pnpm db:seed`, all OFF by default, reversible without a deploy. **What is actually enforced today:**

| Rung | Flag                                      | Behaviour behind it                                                                         |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `degrade.disable-social-and-reviews`      | **none yet**: seeded and documented only                                                    |
| 2    | `degrade.simplify-recommendations-facets` | **none yet** (there are no recommendations or facets to simplify)                           |
| 3    | `degrade.serve-stale-search`              | **none yet** (there is no search)                                                           |
| 4    | `degrade.pause-non-essential-jobs`        | **enforced** in the worker                                                                  |
| 5    | `degrade.waiting-room`                    | **none in-app**; the Cloudflare waiting room is in the Terraform edge module, never applied |

**Load shedding is enforced** (`apps/web/src/server/route.ts`, `shedding.ts`). Turn on `shed.reporting`, `shed.admin`, `shed.account`,
`shed.browse` or `shed.cart` (Admin > Flags, or `SOLD_SHED_BELOW=<class>` on the web app, which needs no database): that class and every
lower-priority class answer `503` with `Retry-After: 30`. Priority, shed first: reporting < admin < account < browse < cart < **checkout**.
**Checkout, health and metrics are never shed**, and `/api/admin/flags` plus `/api/admin/auth` stay reachable so an operator can always switch
it off (flags are cached ~5 s per instance and fail static if the database is down). `@sold/core/traffic` classifies routes
(`routeClassOf`, `shedBelowFrom`, `shouldShed`), unit-tested; `e2e/shedding.e2e.ts` exercises it live. Limits: it covers API routes
wrapped by `route()`; cacheable storefront HTML is served from cache and is not shed in-app. Nothing flips these automatically: it is an
operator (or future alert-driven) action, as the runbook describes.

## Queue

`JobQueue` is an interface. pg-boss is the default adapter. Its throughput ceiling is unmeasured. Queue classes
(`critical`, `default`, `bulk`) carry separate concurrency, retry and age budgets (`queueClassPolicies`).
Alert on **oldest ready job age**, not depth. Switch-over thresholds to the Service Bus adapter will be recorded
here after the Phase 7 measurement (PENDING(phase-7)).

## Environment cost (design target)

An idle `ephemeral` environment should cost close to nothing (mainly storage); an active one should stay small.
Real idle and active cost per profile is PENDING(phase-0, needs a cloud subscription): record it here once measured.

## Capacity report

Measured numbers, their conditions and what they do **not** show are in [`capacity-report.md`](capacity-report.md). In short: one local
machine, one web instance, everything sharing 4 vCPUs. **No cloud tier has been load tested**, so the per-tier table of sizing
recommendations is still empty on purpose.

| Tier | Throughput measured                                                                        | Limiting component | Cost per headroom | Recommended sizing | Date |
| ---- | ------------------------------------------------------------------------------------------ | ------------------ | ----------------- | ------------------ | ---- |
| all  | **not measured on any cloud tier** (local single-instance figures in `capacity-report.md`) | n/a                | n/a               | n/a                | n/a  |

## Job queue: measured behaviour and the Redis adapter (Phase 7)

`packages/jobs/bench/throughput.ts` (`pnpm --filter @sold/jobs bench`) enqueues 3,000 no-op jobs and drains them. **One 4-core / 16 GB sandbox with Postgres, Redis and the benchmark all sharing it, handler does nothing: a sanity
measurement and a relative comparison, not a capacity figure.** Class `critical` (concurrency 20); repeated runs agree within a few percent.

| Adapter                          | Enqueue  | Drain (queue → handler) | Notes                                    |
| -------------------------------- | -------- | ----------------------- | ---------------------------------------- |
| Redis (`RedisQueue`), poll 50 ms | ~9-12k/s | ~11-12k/s               | refills a slot the moment a job finishes |
| pg-boss, batch 1, poll 500 ms    | ~2.4k/s  | **~40/s**               | = concurrency 20 / poll 0.5 s            |
| pg-boss, batch 10                | ~2.6k/s  | ~430/s                  | effective concurrency becomes 200        |
| pg-boss, batch 25                | ~2.6k/s  | ~1,200/s                | effective concurrency becomes 500        |

What this teaches (and what changed because of it):

1. **pg-boss's drain rate for fast jobs is poll-bound, not CPU-bound**: each worker slot waits one polling interval between fetches, so rate ≈ `concurrency × batchSize / poll`. With the production default poll of 2 s a `critical` queue of instant jobs drains at
   ~10 jobs/s. Real jobs that take 100 ms+ are bounded by their own duration, but a burst of tiny jobs (many extension observers per order) can build a backlog even though nothing is "slow". The age-based alerts (`maxAgeSeconds`) are what catch it.
   `PgBossQueue` now takes `batchSize` (default 1, unchanged behaviour); raising it trades the per-queue concurrency limit (it becomes `concurrency × batchSize`), so use it only for queues of small idempotent jobs.
2. **The Redis adapter is ~30x faster at draining tiny jobs and ~4x at enqueueing**, at the cost of durability: Redis's persistence, not the order database's. With no AOF a Redis crash can lose recently enqueued jobs; use AOF `everysec` or keep pg-boss when losing seconds of jobs is not acceptable.
   Things that already don't use the queue (the outbox relay, email and webhook delivery) are unaffected: they run their own loops.
3. **Switch criteria** (replacing the earlier assumptions): move a queue to Redis when the _oldest-job age_ alert fires on a queue whose handlers are fast, or when pg-boss's own tables show up in `pg_stat_statements` as a top consumer. Not before.

`RedisQueue` is at-least-once like pg-boss: retries with exponential backoff and jitter, dead-letter after the retry limit, idempotent enqueue (7-day memory), delayed jobs, lease expiry (a crashed worker's job is retried and the lost attempt counts), graceful stop, cron schedules
that fire once across a fleet. Verified by 11 contract tests against a real Redis (including two workers never double-claiming, a hung worker's job being recovered by another, and a slow test that two workers on one cron fire it once). Not verified: behaviour under Redis failover or
cluster mode (it uses multi-key Lua scripts on one hash slot per queue only if you use a single node or hash tags); not wired into the web or worker entrypoints (they still construct `PgBossQueue`); a Service Bus adapter does not exist.
