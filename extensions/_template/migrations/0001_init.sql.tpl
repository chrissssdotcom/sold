-- Everything is namespaced __PREFIX__*: an extension never touches Base tables.
-- Migrations are forward-only and linted (online-safe, namespaced) before they run.

CREATE TABLE __PREFIX__events (
  order_id text PRIMARY KEY,
  seen_at  timestamptz NOT NULL DEFAULT now()
);
