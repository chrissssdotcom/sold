# Runbook: backup, restore and drills

## What must survive

| Data                                                           | Where                                | Recovery source                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders, payments, customers, catalogue, audit, flags, settings | PostgreSQL primary                   | Managed point-in-time recovery (PITR) + periodic logical dump                                                                                     |
| Uploaded media (originals and renditions)                      | `MEDIA_DIR` (local disk store today) | **Not covered yet:** only a local-disk adapter exists; back the volume up, or build the object-storage adapter first (see `docs/media.md`)        |
| Cart/session/cache state                                       | Redis                                | Disposable. Carts are signed cookies + DB; losing Redis loses only caches and rate-limit counters                                                 |
| Secrets, keys                                                  | Key Vault / environment              | Not in the database. `SOLD_EXTENSION_DB_SECRET` and the envelope-crypto key are required to read stored webhook secrets and extension credentials |

**Cluster-level roles are not in a dump** (`sold_grafana`, per-extension roles). After a restore into a new cluster run
`pnpm sold reporting:enable-login` and `pnpm sold ext:migrate` (re-creates extension roles and grants, re-syncs reporting views).

## Targets (design, not yet proven on cloud)

RPO ≤ 5 min (PITR), RTO ≤ 1 h for a regional-disaster-free failure (restore + redeploy). Neither has been measured on managed
infrastructure: no cloud subscription has been used (see `docs/PROGRESS.md`).

## The drill we can run anywhere: `ops/drills/backup-restore.sh`

```bash
SOURCE_URL=postgres://sold:sold@localhost:5432/sold ops/drills/backup-restore.sh
```

It `pg_dump`s the source (read-only), restores into a scratch database it creates and drops, then compares row counts of ten key
tables, an MD5 over every order's id/total/status, the migration journal checksum, and the number of foreign keys. It refuses
non-local hosts. Exit code is non-zero on any mismatch.

**Result on the development database (2026-10-01):** 10/10 tables identical (36 orders, 76 users, 247 audit rows, …), orders
checksum identical, 27 foreign keys preserved, dump 0.2 s / 248 KB, restore 0.6 s. That is a correctness check of the procedure, not a
timing for production-sized data.

## Real restore (managed PostgreSQL)

1. Declare the incident; stop taking orders you cannot keep. Shedding (`shed.*`, `SOLD_SHED_BELOW`) deliberately never covers
   checkout, so to stop orders mid-restore take the web app out of the load balancer (or serve the edge maintenance page). Shed everything
   else first with `SOLD_SHED_BELOW=cart` so the rest of the API is quiet.
2. Restore to a **new** server at the chosen timestamp (PITR). Never restore over the live server.
3. Point a staging copy of the app at it; run `pnpm db:migrate` (a no-op when the journal matches the release; it fails loudly if a file was modified or is missing) and the
   smoke checks: `/api/health/ready`, place a test order with the `local`-style fake gateway only in non-prod.
4. Reconcile payments: for the window between the restore point and the failure, ask the gateway for charges/refunds and
   compare with `payments`. The webhook ledger (`payment_events`) is idempotent, so replaying gateway events from the dashboard is safe.
5. Cut over (connection string/DNS), then re-run `reporting:enable-login` and `ext:migrate`.
6. Record RPO/RTO actually achieved in `docs/capacity-report.md`.

## Cadence

Run the drill script weekly in CI against the ephemeral database (it takes seconds) and a managed-PITR restore into a scratch
server quarterly. Alert if the newest backup is older than 26 h.
