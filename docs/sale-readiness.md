# Sale readiness

A flash sale is the event this platform is designed for (`docs/scaling.md`). Do this the week before and again the morning of.

## Automated: `ops/drills/sale-readiness.sh`

```bash
BASE_URL=https://shop.example DATABASE_URL=<read-only url> EXPECT_ENV=prod ops/drills/sale-readiness.sh
```

Read-only (GETs and SELECTs). Checks: readiness, release build id (not `dev`), indexability matches the environment, HSTS, CSP present
without `unsafe-eval`, no `degrade.*`/`shed.*` flag left on, outbox drained, no failed/stuck email, no payment events needing attention, no
stale `pending_payment` orders, no negative stock, and lists variants with ≤ 5 available. Exit 1 on any FAIL.

## Manual (a script cannot see these)

- [ ] Load test of **this tier** passed recently (`ops/loadtests/`, `docs/capacity-report.md`); the sale's expected peak is below the measured, _cloud-measured_ ceiling (the numbers in the report so far are from one local machine and are not a promise).
- [ ] Hot SKUs: stock loaded and verified in Admin; `allowBackorder` false unless intended.
- [ ] Payment gateway: account limits, webhook endpoint registered for this environment, a real test charge + refund done on this environment.
- [ ] Email domain authenticated (SPF/DKIM/DMARC); a real test order email viewed in two clients.
- [ ] Edge: WAF and rate-limit rules applied, cache rules for storefront HTML, waiting room ready (Cloudflare module is Terraform-described and **never applied**).
- [ ] Newest backup < 26 h; a restore drill in the last 90 days (`docs/runbooks/backup-restore.md`).
- [ ] On-call rota set; the person who may flip shedding flags can sign in to Admin > Flags right now; they have read `docs/runbooks/operations.md#levers-all-reversible-none-needs-a-deploy`.
- [ ] Deploy freeze announced (`SOLD_DEPLOY_FREEZE`); rollback target digest noted.
- [ ] Alerts firing to a real channel (send a test); dashboards open.

## The day

Watch checkout 5xx and p95, DB pool waiting, oldest critical job age. Escalate shedding in order: reporting → admin → account → browse; never touch
checkout. Turn rungs off in reverse once the queue and pool recover. Afterwards run the script again and record the peak in the capacity report.
