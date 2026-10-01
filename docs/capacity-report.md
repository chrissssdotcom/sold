# Capacity report

**Read this first.** Everything below was measured on **one 4 vCPU / 16 GB sandbox that also ran PostgreSQL 16, Redis and the load
generator**, against **one instance** of the standalone production build (`node apps/web/server.js`, `NODE_ENV=production`), on 2026-10-01.
The generator is **closed-loop**, so it under-reports tail latency during stalls. These are _relative, single-machine_ figures. They are
**not** a capacity promise for any Azure tier, and no cloud environment has ever been load tested. Use them to understand the shape of
the system and to compare future runs, not to size a customer.

Reproduce: `node ops/loadtests/node/load.mjs …` (see `ops/loadtests/README.md`). Raw outputs are the JSON the tool prints.

## Results

### Browse (home page, product page, product list API, product detail API; equal mix, demo catalog of ~9 products)

| Concurrent users | Requests/s | p50    | p95    | p99    | Errors |
| ---------------- | ---------- | ------ | ------ | ------ | ------ |
| 1                | 140        | 6.8 ms | 11 ms  | 16 ms  | 0      |
| 4                | 226        | 17 ms  | 28 ms  | 37 ms  | 0      |
| 10               | 233        | 41 ms  | 67 ms  | 83 ms  | 0      |
| 20               | 240-257    | 79 ms  | 113 ms | 133 ms | 0      |
| 40               | 252        | 152 ms | 245 ms | 284 ms | 0      |

**One instance saturates at roughly 250 requests/s** (one Node process, CPU-bound: ~4 ms of CPU per request, cached pages included).
Beyond that, latency grows linearly with concurrency and throughput stays flat: it queues, it does not fail. Cached HTML pages and the
dynamic JSON APIs cost about the same here (5-8 ms at idle), which says the page path is dominated by per-request work in the app
(proxy, cache-handler round trip to Redis, 60 KB response), not by rendering. **Implication:** capacity is horizontal and linear in
instances until PostgreSQL or Redis binds; the edge cache is what absorbs a real sale's page traffic. Neither the multi-instance scaling
nor the edge has been measured.

### Spike: 2 → 100 workers (50x) in 20 s, hold 20 s, drop back (scenario 2 shape)

| Phase       | Requests | Requests/s | p50      | p95    | p99      | Errors |
| ----------- | -------- | ---------- | -------- | ------ | -------- | ------ |
| Ramp        | 4,680    | 234        | 153 ms   | 607 ms | 991 ms   | 0      |
| Hold at 100 | 5,444    | 272        | 232 ms   | 948 ms | 1,156 ms | 0      |
| Recovery    | 3,148    | 210        | **9 ms** | 21 ms  | 483 ms   | 0      |

Zero errors across ~13,000 requests and immediate recovery once the load dropped. Latency at 100 users is queueing on a saturated single
instance, which is expected; the design target (p95 < 500 ms for cart/checkout at peak) is **not** met by one instance at 100 concurrent
users and is not meant to be: it assumes scale-out and an edge cache.

### Checkout (cart → add → quote → place order; real orders written to Postgres)

| Scenario                   | Buyers | Orders placed  | Orders/min (whole funnel) | Checkout p50 | Checkout p95 | 5xx |
| -------------------------- | ------ | -------------- | ------------------------- | ------------ | ------------ | --- |
| Ample stock                | 10     | 10             | ~1,200                    | 173 ms       | 274 ms       | 0   |
| Ample stock                | 100    | 100            | ~1,700                    | 906 ms       | 1,035 ms     | 0   |
| Ample stock                | 600    | 600            | ~2,100                    | 4.1 s        | 5.2 s        | 0   |
| **Hot SKU**: 50 units      | 300    | **exactly 50** | n/a                       | 2.0 s        | 2.1 s        | 0   |
| Hot SKU, **Redis stopped** | 300    | **exactly 50** | n/a                       | 2.0 s        | 2.0 s        | 0   |

- **No overselling, ever, in these runs:** each hot-SKU run sells exactly the stock (the tool's verdict is exact on a fresh SKU) and refuses the rest with a clean 4xx. The authority is the Postgres reservation; the Redis admission gate is an optimisation and fails open.
- The design target "≥ 1,000 orders/min per instance" is **met locally** (≈2,100 whole-funnel orders/min at saturation) _on a box shared with its own database and load generator_. The target "checkout p95 < 500 ms" is met only at low concurrency (~10-30 simultaneous buyers per instance); at 100+ concurrent buyers a single instance queues.
- Checkout p50/p95 at 300-600 concurrent buyers are queueing delays on one instance, not the service time of a single request (173 ms at 10 buyers is closer to that, and includes the DB transaction).
- Not tested: 5,000 buyers / 100 units (scenario 3 as specified), multiple instances, a database on separate hardware, payment-gateway latency (Stripe was never real), a real network.

### Failure behaviour

See [`chaos-drills.md`](chaos-drills.md): Redis down (0 errors, throughput roughly halves), Postgres down (cached pages served, APIs 503 fast, auto-recovery), worker SIGKILL (nothing lost, no duplicate email), restore drill.

### Queue (from `docs/scaling.md`)

pg-boss drain is poll-bound (~40 jobs/s at batch 1 and 500 ms polling, ~1,200/s at batch 25); `RedisQueue` ~11-12k/s. Handlers did nothing; relative only.

## What would change the picture

- A real network, TLS, and a CDN in front (page hits would stop reaching the origin).
- PostgreSQL on its own CPU: here it competes with Node for 4 cores, so the 250 req/s ceiling and the checkout latencies are probably pessimistic for the app tier and optimistic for nothing.
- More than one web instance: untested; the cache handler and cart are designed to be stateless across instances (two-instance cache test exists), but throughput scaling is unmeasured.
- Real catalog size (demo has 9 products), real page weights, real payment gateway time.

## Sizing recommendation

**None.** There is no honest basis for one yet. Required before quoting any tier: scenarios 2, 3 (as specified), 4, 5 and 7 run against a `stage`-shaped
environment, three runs each, with PostgreSQL and the generator on separate machines, recorded here with the environment's cost.
