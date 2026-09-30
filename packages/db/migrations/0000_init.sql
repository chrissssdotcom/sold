-- Base schema, part 0: primitives every later migration relies on.
-- All objects here are new, so none of the lock-impact rules apply.

-- UUIDv7 (time-ordered) primary keys. Native uuidv7() only exists from PostgreSQL 18.
CREATE FUNCTION sold_uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          placing substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;
--> statement-breakpoint

CREATE FUNCTION sold_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TRIGGER feature_flags_touch BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- Transactional outbox, RANGE-partitioned monthly on created_at.
CREATE TABLE outbox_events (
  id             uuid NOT NULL DEFAULT sold_uuid_v7(),
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  attempts       integer NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint

CREATE TABLE outbox_events_default PARTITION OF outbox_events DEFAULT;
--> statement-breakpoint

-- Partial index: the publisher only ever scans unpublished rows.
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (available_at) WHERE published_at IS NULL;
--> statement-breakpoint

-- Partition maintenance: create monthly partitions ahead, drop those past retention.
-- Called by a scheduled job (and by `pnpm db:migrate`), safe to run repeatedly.
CREATE FUNCTION sold_ensure_monthly_partitions(parent regclass, months_ahead integer DEFAULT 3)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  created integer := 0;
  month_start date;
  part_name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    month_start := (date_trunc('month', now()) + make_interval(months => i))::date;
    part_name := format('%s_%s', parent::text, to_char(month_start, 'YYYYMM'));
    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent::text, month_start, (month_start + interval '1 month')::date);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint

CREATE FUNCTION sold_drop_old_partitions(parent regclass, keep_months integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  dropped integer := 0;
  child record;
  cutoff date := (date_trunc('month', now()) - make_interval(months => keep_months))::date;
  part_month date;
BEGIN
  FOR child IN
    SELECT c.oid::regclass AS name, c.relname
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = parent AND c.relname ~ '_[0-9]{6}$'
  LOOP
    part_month := to_date(right(child.relname, 6), 'YYYYMM');
    IF part_month < cutoff THEN
      EXECUTE format('DROP TABLE %s', child.name);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;
--> statement-breakpoint

SELECT sold_ensure_monthly_partitions('outbox_events', 3);
--> statement-breakpoint

-- Safety-net timeouts at database level. Under PgBouncer transaction pooling, session-level SET
-- and startup parameters are unreliable, so these defaults apply to every connection.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET statement_timeout = ''5s''', current_database());
  EXECUTE format('ALTER DATABASE %I SET lock_timeout = ''2s''', current_database());
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = ''5s''', current_database());
END
$$;
