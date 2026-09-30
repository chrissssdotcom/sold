# Load tests (k6)

Scenarios are the pass/fail contract for scale (Section 8A.9). A performance regression fails the build.

| #   | Scenario                                                  | File                 | State                               |
| --- | --------------------------------------------------------- | -------------------- | ----------------------------------- |
| 1   | Baseline browse                                           | `baseline-browse.js` | written, smoke-level, wired into CI |
| 2   | Flash-sale spike (1x -> 50x in 60 s, hold, recover)       |                      | PENDING(phase-8)                    |
| 3   | Checkout storm with hot-SKU contention                    |                      | PENDING(phase-2/8): needs checkout  |
| 4   | Soak (multi-hour)                                         |                      | PENDING(phase-8)                    |
| 5   | Stress to failure                                         |                      | PENDING(phase-8)                    |
| 6   | Webhook and queue burst                                   |                      | PENDING(phase-3/7)                  |
| 7   | Cache-cold start                                          |                      | PENDING(phase-4)                    |
| 8   | Dependency failure (Stripe slow, replica lag, Redis down) |                      | PENDING(phase-8)                    |

Run locally: `pnpm --filter @sold/web build && pnpm --filter @sold/web start`, then
`k6 run -e BASE_URL=http://localhost:3000 ops/loadtests/baseline-browse.js`.

Load and chaos tests never run against `ephemeral` environments; they run in a short-lived
`stage`-shaped environment (`pnpm sold env:up --profile stage --ttl 8h`).

Every new hot-path feature adds a scenario or extends one (scale gate f).
