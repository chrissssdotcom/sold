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
`statement_timeout = 0` and a bounded `lock_timeout` (default 5 s), applied only after the runner lock is held.
Never hold a transaction open across a network call.

These defaults are sized for request-path queries and apply to EVERY role. Roles that legitimately run longer set
their own: the job queue passes `-c statement_timeout=60000 ...` on its connections, and the Grafana reporting role
gets `ALTER ROLE sold_grafana SET statement_timeout` in its Phase 7 migration. Terraform should create separate roles
(app, migrator, reporting) so each can carry its own limits; do not raise the database-wide default.

## Migrations

- Forward-only, checksummed, journaled per scope (`base`, `ext:<name>`) in `_sold_migrations`. A modified applied
  file, a missing applied file, or an out-of-order file aborts the run.
- A single session advisory lock serialises concurrent runners (rolling deploys).
- **Expand/contract.** Version N and N-1 must run against the same schema, so rollback is a redeploy.
  1. Expand: add nullable column / new table / new index (`CONCURRENTLY`). Ship code that writes both.
  2. Backfill in batches from a job. Never in the migration.
  3. Switch reads. Later release: contract (drop) with `-- sold:allow destructive: <reason>`.
- `pnpm db:lint-migrations` (CI) parses every migration with PostgreSQL's own parser (libpg-query, WASM) and applies the
  rules to the AST, so quoting, casing, multi-action `ALTER TABLE` and inline constraints are handled exactly.
  `describeRules()` lists them. In short it rejects: non-concurrent index builds, `NOT NULL` without default, volatile
  or unknown-volatility defaults, `serial` / identity / `GENERATED STORED` columns, inline `CHECK`/`REFERENCES` on
  `ADD COLUMN`, `ALTER COLUMN TYPE`, `SET NOT NULL`, unvalidated FK/CHECK, `ADD UNIQUE/PRIMARY KEY/EXCLUDE` without
  `USING INDEX`, FKs without explicit `ON DELETE`, drops/renames/truncates of existing objects, `ATTACH/DETACH PARTITION`,
  unbounded `UPDATE`/`DELETE`, `DO`/`EXECUTE` dynamic SQL, `LOCK`, `VACUUM FULL`, `CLUSTER`, non-concurrent `REINDEX` and
  `REFRESH MATERIALIZED VIEW`, and files that do not parse. Objects created earlier in the same migration are exempt.
  A rule is waived only by `-- sold:allow <rule>: <reason>` on the lines directly above the statement.
  Limits: it cannot see schema state, so it cannot know that an index target is a partitioned parent (where
  `CONCURRENTLY` fails at runtime), and it cannot analyse what a `DO` block does (hence `dynamic-sql`). The parser is
  PostgreSQL 17: syntax new in 18 is reported as a syntax error.
- Files containing `CREATE INDEX CONCURRENTLY` start with `-- sold:no-transaction` and separate statements with a
  `--> statement-breakpoint` line. A failed concurrent build leaves an INVALID index; with `IF NOT EXISTS` a naive
  rerun would skip it and journal a broken index (a UNIQUE one would silently enforce nothing). The runner therefore
  drops an invalid leftover before rebuilding and verifies `indisvalid` afterwards, failing the migration otherwise.
- A second runner waits (bounded, default 10 min) for the first; `lock_timeout` only applies to statements.

## Partitioned tables

`outbox_events` is RANGE-partitioned monthly on `created_at` (scale gate e: expected > 10M rows). The
`maintenance.partitions` job runs daily and on worker boot: it creates 3 months ahead and drops partitions older
than 3 months **only if they hold no unpublished events**.

- Dropping needs an ACCESS EXCLUSIVE lock on the parent, and every checkout insert queues behind a waiting request
  for it. `DETACH ... CONCURRENTLY` would avoid that but PostgreSQL forbids it while a DEFAULT partition exists, and
  the default partition is what stops a lagging job from failing checkout writes. So the drop uses a 150 ms
  `lock_timeout` with retries: writers stall for at most that; a busy moment defers retirement to the next run
  (`deferred` in the job log).
- **Alert conditions (the job logs an error):** `blocked` (unpublished events beyond retention: the relay is stuck),
  `defaultPartitionRows > 0` (maintenance fell behind; rows landed in the default partition and prevent creating
  their month's partition), `createError`. Recovery for stranded default rows: create the partition into a scratch
  table with the right bounds, `INSERT ... SELECT` the range from `outbox_events_default`, delete it from default,
  then `ATTACH PARTITION` (do this in a maintenance window: it scans the default partition under lock).
- Other high-volume tables (events, page views, audit log, webhook inbox, job history, email log) get the same
  treatment when introduced, with the decision recorded in their migration.

## Postgres tuning and autovacuum (initial guidance, validate under load)

- Hot, high-churn tables (`outbox_events`, inventory reservations, carts): per-table
  `autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_vacuum_cost_limit = 2000`, `fillfactor = 85` on update-heavy tables.
- Track table and index bloat; alert on dead tuples ratio and on autovacuum falling behind.
- `pg_stat_statements`: enabled locally by `ops/postgres/init` (compose preloads the library). In Azure it must be
  allow-listed and created per the platform docs (verify in ADR-0002); do not assume it is on. Review top queries weekly.
- Hot queries with an `EXPLAIN` test today: the outbox publisher poll (`packages/db`) and queue `health()`
  (`packages/jobs`). Catalog, cart and checkout queries arrive with Phase 2 and must add theirs (scale gate f).

## Backup and restore

PENDING(phase-8): PITR restore drill, RPO/RTO measurement, and the backup/restore runbook.
