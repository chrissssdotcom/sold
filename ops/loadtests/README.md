# Load tests (k6)

Scenarios are the pass/fail contract for scale (Section 8A.9). A performance regression fails the build.

| #   | Scenario                                                  | File                                    | State                                                                              |
| --- | --------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Baseline browse                                           | `baseline-browse.js`                    | written, smoke-level, wired into CI                                                |
| 2   | Flash-sale spike (1x -> 50x in 60 s, hold, recover)       | `node/load.mjs spike`                   | **run locally** (see `docs/capacity-report.md`); k6 version not written            |
| 3   | Checkout storm with hot-SKU contention                    | `node/load.mjs checkout-storm`          | **run locally**, exact no-oversell verdict; k6 version not written                 |
| 4   | Soak (multi-hour)                                         |                                         | NOT DONE: needs a cloud-shaped environment                                         |
| 5   | Stress to failure                                         |                                         | partly: one instance's saturation point is measured; multi-instance NOT DONE       |
| 6   | Webhook and queue burst                                   | `packages/jobs/bench`                   | queue drain measured (see `docs/scaling.md`); webhook fan-out NOT DONE             |
| 7   | Cache-cold start                                          |                                         | NOT DONE                                                                           |
| 8   | Dependency failure (Stripe slow, replica lag, Redis down) | `ops/drills/chaos.sh`, `worker-kill.sh` | Redis, Postgres and worker-kill done locally; Stripe-slow and replica-lag NOT DONE |

## The Node load generator (`node/load.mjs`)

k6 is not installed in the environment this phase was built in, so scenarios 2 and 3 exist as a dependency-free Node tool with the same
shapes. **It is closed-loop** (a virtual user sends its next request when the previous returns), so during a stall it under-reports tail
latency (coordinated omission): its numbers are good for comparing runs and for correctness verdicts, not for quoting p99s. Reports are JSON
with the machine, label and timestamp; label runs honestly (`--label`).

```bash
node ops/loadtests/node/load.mjs browse --workers 20 --seconds 30
node ops/loadtests/node/load.mjs spike --from 2 --to 100 --ramp 30 --hold 30 --recover 20
SOLD_E2E_OWNER_EMAIL=... SOLD_E2E_OWNER_PASSWORD=... \
  node ops/loadtests/node/load.mjs checkout-storm --buyers 300 --stock 50   # exits 1 if anything oversold or any 5xx
```

`checkout-storm` creates a fresh product per run through the admin API and **writes real orders**: never point it at production.

Run locally: `pnpm --filter @sold/web build && pnpm --filter @sold/web start`, then
`k6 run -e BASE_URL=http://localhost:3000 ops/loadtests/baseline-browse.js`.

Load and chaos tests never run against `ephemeral` environments; they run in a short-lived
`stage`-shaped environment (`pnpm sold env:up --profile stage --ttl 8h`).

Every new hot-path feature adds a scenario or extends one (scale gate f).
