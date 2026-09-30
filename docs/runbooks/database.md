# Runbook: database

## Topology

```
web replicas ──(transaction pooling)──> PgBouncer ──> PostgreSQL primary ──> read replica(s)
worker (pg-boss), migrations ───────────(direct, session)──────────────────> PostgreSQL primary
Grafana / reporting ────────────────────────────────────────────────────────> replica only
```

Locally, `docker-compose.yml` mirrors this. In Azure, PostgreSQL Flexible Server's built-in PgBouncer plays the
PgBouncer role (verify port and settings against current docs before applying Terraform; see ADR-0002).

## Handles

`@sold/db` exposes `primary` and `replica`. The role is part of the type, so a function that needs
read-your-writes cannot be handed a replica. Without `DATABASE_REPLICA_URL` the replica handle is the primary pool.
Replica lag: post-checkout confirmation always reads the primary; catalog reads tolerate lag. Alert when lag exceeds
the staleness the catalog can tolerate (initial assumption: 30 s).

## Timeouts

Set at database level by `0000_init` (statement 5 s, lock 2 s, idle-in-transaction 5 s) so they survive
transaction pooling. Direct connections also send them as startup parameters. Migrations override with
`statement_timeout = 0` and a bounded `lock_timeout` (default 5 s).
Never hold a transaction open across a network call.

## Migrations

- Forward-only, checksummed, journaled per scope (`base`, `ext:<name>`) in `_sold_migrations`. A modified applied
  file, a missing applied file, or an out-of-order file aborts the run.
- A single session advisory lock serialises concurrent runners (rolling deploys).
- **Expand/contract.** Version N and N-1 must run against the same schema, so rollback is a redeploy.
  1. Expand: add nullable column / new table / new index (`CONCURRENTLY`). Ship code that writes both.
  2. Backfill in batches from a job. Never in the migration.
  3. Switch reads. Later release: contract (drop) with `-- sold:allow destructive: <reason>`.
- `pnpm db:lint-migrations` (CI) rejects: non-concurrent index builds, `NOT NULL` without default, volatile defaults,
  `ALTER COLUMN TYPE`, `SET NOT NULL`, unvalidated FK/CHECK, `ADD UNIQUE/PRIMARY KEY` without `USING INDEX`,
  FKs without explicit `ON DELETE`, drops/renames/truncates, `LOCK`, `VACUUM FULL`, `CLUSTER`, non-concurrent `REINDEX`.
  Brand-new tables created in the same migration are exempt.
- Files containing `CREATE INDEX CONCURRENTLY` start with `-- sold:no-transaction` and separate statements with
  `--> statement-breakpoint`. Statements must be idempotent (`IF NOT EXISTS`), because a failure midway leaves an
  invalid index and the file is rerun.

## Partitioned tables

`outbox_events` is RANGE-partitioned monthly on `created_at` (scale gate e: expected > 10M rows). The `maintenance.partitions`
job runs daily and on worker boot: it creates 3 months ahead and drops partitions older than 3 months **only if they
hold no unpublished events**. If unpublished events exist beyond the window it logs an error and drops nothing: page
the on-call, find why the relay is stuck. Other high-volume tables (events, page views, audit log, webhook inbox, job
history, email log) get the same treatment when they are introduced, with the decision recorded in their migration.

## Postgres tuning and autovacuum (initial guidance, validate under load)

- Hot, high-churn tables (`outbox_events`, inventory reservations, carts): per-table
  `autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_vacuum_cost_limit = 2000`, `fillfactor = 85` on update-heavy tables.
- Track table and index bloat; alert on dead tuples ratio and on autovacuum falling behind.
- `pg_stat_statements` enabled in every environment. Review top queries by total time weekly.
- Every hot query has an `EXPLAIN` test proving index use (see `migrate.int.test.ts` for the outbox poll).

## Backup and restore

PENDING(phase-8): PITR restore drill, RPO/RTO measurement, and the backup/restore runbook.
