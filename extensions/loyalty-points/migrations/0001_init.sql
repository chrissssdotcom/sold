-- Loyalty points. Everything is namespaced ext_loyalty_points_*: an extension never touches Base tables.
-- customer_id is plain text (not a foreign key) so the extension keeps working if customers are anonymised.

CREATE TABLE ext_loyalty_points_accounts (
  customer_id text PRIMARY KEY,
  points      bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per awarded order: makes awarding idempotent (redelivered events, retries) and auditable.
CREATE TABLE ext_loyalty_points_awards (
  order_id    text PRIMARY KEY,
  customer_id text NOT NULL,
  points      bigint NOT NULL CHECK (points >= 0),
  awarded_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX ext_loyalty_points_awards_customer_idx ON ext_loyalty_points_awards (customer_id);
