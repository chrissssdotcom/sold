# Scaling: SLOs, capacity model, tier profiles

> **Status: design targets, not measured results.** Every number below is an initial assumption for the
> `event-scale` profile. None came from a customer. They are "met" only when the capacity report at the
> bottom shows a load-test result for them (Section 8A.1, gate for Phase 8 sign-off). Until then, treat
> them as hypotheses and do not quote them to a customer.

## Service level objectives (design targets, `event-scale`)

| Objective                                      | Target                                                             | Evidence required                       | Evidence today                                     |
| ---------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------- |
| Availability, storefront browsing and checkout | 99.95%                                                             | SLO burn-rate alerts + chaos drills     | none                                               |
| Cache-hit page TTFB at the edge                | p95 < 200 ms                                                       | edge analytics under the spike scenario | none                                               |
| Origin on a cache miss                         | p95 < 400 ms                                                       | k6 scenario 7 (cache-cold)              | k6 scenario 1 threshold defined, not yet run in CI |
| Cart and checkout APIs at peak                 | p95 < 500 ms, p99 < 1.5 s                                          | k6 scenarios 2 and 3                    | none                                               |
| Step increase                                  | 50x in 60 s, no errors on cached routes, no order loss             | k6 scenario 2                           | none                                               |
| Order throughput                               | >= 1,000 orders/min per instance, no oversell, documented headroom | k6 scenario 3 (5,000 buyers, 100 units) | none                                               |
| RPO / RTO                                      | <= 5 min / <= 1 h                                                  | restore and failover drills             | none                                               |

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

## Degradation ladder

Feature flags seeded by `pnpm db:seed`, all OFF by default, reversible without a deploy. Applied in order under load:

1. `degrade.disable-social-and-reviews`
2. `degrade.simplify-recommendations-facets`
3. `degrade.serve-stale-search`
4. `degrade.pause-non-essential-jobs` (the worker already honours this)
5. `degrade.waiting-room`

Load shedding order (lowest priority shed first, with `503` + `Retry-After`): reporting, admin, account, browse,
cart, checkout. Classification lives in `@sold/core/traffic` (`routeClassOf`, `shouldShed`); enforcement arrives with
the waiting-room extension (PENDING(phase-8)).

## Queue

`JobQueue` is an interface. pg-boss is the default adapter. Its throughput ceiling is unmeasured. Queue classes
(`critical`, `default`, `bulk`) carry separate concurrency, retry and age budgets (`queueClassPolicies`).
Alert on **oldest ready job age**, not depth. Switch-over thresholds to the Service Bus adapter will be recorded
here after the Phase 7 measurement (PENDING(phase-7)).

## Environment cost (design target)

An idle `ephemeral` environment should cost close to nothing (mainly storage); an active one should stay small.
Real idle and active cost per profile is PENDING(phase-0, needs a cloud subscription): record it here once measured.

## Capacity report

| Tier | Throughput measured  | Limiting component | Cost per headroom | Recommended sizing | Date |
| ---- | -------------------- | ------------------ | ----------------- | ------------------ | ---- |
| all  | **not yet measured** | n/a                | n/a               | n/a                | n/a  |
