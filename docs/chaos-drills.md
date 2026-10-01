# Chaos drills: what was actually done

Scripts in `ops/drills/`. All run **locally** (they stop and start services on the host and refuse non-local targets), against the
**standalone production build** (`node apps/web/server.js`, `NODE_ENV=production`, extension DB isolation enforced), 2026-10-01.
Machine: 4 vCPU / 16 GB, with Postgres 16, Redis, the web instance and the load generator **all on the same box**. These show _behaviour
under failure_, not capacity. A cloud run (stage-shaped environment) is still owed: see "Not done".

| Drill                                                                                                                     | Script                                       | Result                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis killed mid-load (10 s → 25 s), browse mix, 10 workers                                                               | `chaos.sh redis`                             | **0 errors in 7,318 requests.** Throughput fell from ~240 to ~120 req/s and p95 from ~63 to ~170 ms while down (the cache layer falls back to rendering); recovered by itself, readiness 200 afterwards.                                                                                                                            |
| Checkout storm with Redis down: 300 buyers, 50 units of one SKU                                                           | `load.mjs checkout-storm` with Redis stopped | 50 placed, 250 refused cleanly, **0 oversold, 0 5xx** (identical outcome to Redis up). The Redis admission gate fails open; Postgres reservations are the authority.                                                                                                                                                                |
| PostgreSQL killed mid-load (10 s → 25 s)                                                                                  | `chaos.sh postgres`                          | Cached pages kept answering; API routes returned **503 + `Retry-After`** quickly (p95 stayed ~60 ms, no latency collapse); liveness stayed 200, readiness went 503; **full recovery within the next 5 s window with no web restart.** Overall 18% of requests were 503 in this mix, i.e. every dynamic call during the 15 s outage. |
| Worker `SIGKILL`ed mid-processing: 300 orders placed with no worker, worker killed after ~100 events published, restarted | `worker-kill.sh`                             | 200 events were still unpublished at the kill; the restarted worker drained them in **3 s**; **300 order confirmations queued, 300 sent, 0 recipients emailed twice.**                                                                                                                                                              |
| Backup → restore into a scratch database, compare                                                                         | `backup-restore.sh`                          | 10/10 tables and an order-level checksum identical, 27 foreign keys preserved (see `docs/runbooks/backup-restore.md`).                                                                                                                                                                                                              |

## What the drills found (and what was fixed)

- **The worker bundle could not boot.** Phase 7 pulled the SQL parser into `@sold/db`; its top-level `createRequire(import.meta.url)`
  is `undefined` in the worker's CommonJS bundle. Every unit test was green. Found only by running the bundle. Fixed (lazy require),
  guarded by `bundle-safety.test.ts` and a worker-boot step in CI.
- **Every cookie-authenticated write was refused in the container.** The CSRF check compared `Origin` with `request.url`'s host, but Next
  builds that URL from `HOSTNAME` (`0.0.0.0`). Found by running the e2e against the production build; dev never showed it. Fixed (compare
  with the `Host` header and `SOLD_PUBLIC_URL`).
- **Dependency outages surfaced as 500.** Now 503 + `Retry-After: 5` (`server/availability.ts`), so alerts and clients can tell "retry" from "bug".
- **CI's smoke job could not have passed**: the production server enforces per-extension roles but `db:migrate` ran without provisioning them. Fixed in `ci.yml` (never executed, see below).

## Not done (do not claim these)

- Any drill on managed infrastructure: Azure PostgreSQL failover / PITR, Container Apps replica loss, Cloudflare edge behaviour, a regional
  event. The Terraform has been `validate`d only, never applied.
- Soak (hours), stress-to-failure beyond one instance's saturation, and a >1 instance run behind a load balancer.
- Slow-dependency drills (Stripe latency, replica lag). Replica lag cannot be reproduced here: there is no replica.
- The waiting room and degradation rungs 1-3 and 5 have no behaviour behind their flags (see `docs/scaling.md`).
