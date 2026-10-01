-- Reporting: a read-only, PII-free surface for Grafana and analysts.
--
--   * Views live in the `reporting` schema and run with the privileges of their owner, so the reporting role needs
--     NO access to Base tables at all (verified by test). It can only SELECT from `reporting.*`.
--   * No view exposes an email, name, address, IP, token or any free text a customer typed. Customers appear as counts.
--   * Money is shown as decimal major units (using the currency's exponent) next to the exact minor-unit column.
--   * Views are plain (not materialised): correct and simple. Point Grafana at a replica (Section 8A.4); if a view gets slow
--     at your volume, materialise that one and refresh it from the worker (docs/reporting.md).
--
-- The login password is NOT set here: migrations never contain secrets. Operators run `ALTER ROLE sold_grafana LOGIN PASSWORD ...`
-- (docker compose does this for local development; Terraform for deployed environments).

CREATE SCHEMA IF NOT EXISTS reporting;
--> statement-breakpoint

-- sold:allow dynamic-sql: creates the reporting role only if it does not exist yet; constant text, no interpolation
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sold_grafana') THEN
    CREATE ROLE sold_grafana NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE FUNCTION reporting.currency_exponent(currency text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE upper(trim(currency))
    WHEN 'JPY' THEN 0 WHEN 'KRW' THEN 0 WHEN 'VND' THEN 0 WHEN 'CLP' THEN 0 WHEN 'ISK' THEN 0 WHEN 'UGX' THEN 0
    WHEN 'BHD' THEN 3 WHEN 'KWD' THEN 3 WHEN 'OMR' THEN 3 WHEN 'JOD' THEN 3 WHEN 'TND' THEN 3
    ELSE 2 END
$$;
--> statement-breakpoint

CREATE FUNCTION reporting.major(amount bigint, currency text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round(amount::numeric / power(10::numeric, reporting.currency_exponent(currency)), reporting.currency_exponent(currency))
$$;
--> statement-breakpoint

-- Revenue-bearing orders by UTC day and currency.
CREATE VIEW reporting.daily_sales AS
SELECT
  (o.placed_at AT TIME ZONE 'UTC')::date AS day,
  trim(o.currency) AS currency,
  count(*) AS orders,
  COALESCE(sum(u.units), 0) AS units,
  reporting.major(sum(o.subtotal)::bigint, o.currency) AS subtotal,
  reporting.major(sum(o.discount_total)::bigint, o.currency) AS discounts,
  reporting.major(sum(o.shipping_total)::bigint, o.currency) AS shipping,
  reporting.major(sum(o.tax_total)::bigint, o.currency) AS tax,
  reporting.major(sum(o.total)::bigint, o.currency) AS total,
  sum(o.total)::bigint AS total_minor
FROM orders o
LEFT JOIN LATERAL (SELECT sum(l.quantity) AS units FROM order_lines l WHERE l.order_id = o.id) u ON true
WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
GROUP BY 1, 2, o.currency;
--> statement-breakpoint

-- What happened to the orders placed each day (current status of each).
CREATE VIEW reporting.order_funnel AS
SELECT
  (placed_at AT TIME ZONE 'UTC')::date AS day,
  count(*) AS placed,
  count(*) FILTER (WHERE status IN ('paid', 'processing', 'shipped', 'delivered')) AS paid,
  count(*) FILTER (WHERE status = 'pending_payment') AS awaiting_payment,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  count(*) FILTER (WHERE status = 'refunded') AS refunded
FROM orders
GROUP BY 1;
--> statement-breakpoint

CREATE VIEW reporting.top_products_30d AS
SELECT
  p.id AS product_id,
  p.handle,
  p.title,
  trim(o.currency) AS currency,
  sum(l.quantity) AS units,
  reporting.major(sum(l.line_total)::bigint, o.currency) AS revenue
FROM order_lines l
JOIN orders o ON o.id = l.order_id
JOIN product_variants v ON v.id = l.variant_id
JOIN products p ON p.id = v.product_id
WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered') AND o.placed_at > now() - interval '30 days'
GROUP BY p.id, p.handle, p.title, o.currency;
--> statement-breakpoint

CREATE VIEW reporting.inventory_health AS
SELECT
  v.sku,
  p.handle,
  p.title AS product,
  i.on_hand,
  i.reserved,
  i.on_hand - i.reserved AS available,
  i.allow_backorder,
  (i.on_hand - i.reserved) <= 5 AS low_stock
FROM inventory_levels i
JOIN product_variants v ON v.id = i.variant_id
JOIN products p ON p.id = v.product_id
WHERE p.status = 'active';
--> statement-breakpoint

CREATE VIEW reporting.payments_by_gateway AS
SELECT
  gateway,
  status,
  trim(currency) AS currency,
  count(*) AS payments,
  reporting.major(sum(amount)::bigint, currency) AS amount,
  reporting.major(sum(captured)::bigint, currency) AS captured,
  reporting.major(sum(refunded)::bigint, currency) AS refunded
FROM payments
GROUP BY gateway, status, currency;
--> statement-breakpoint

CREATE VIEW reporting.refunds_daily AS
SELECT
  (r.created_at AT TIME ZONE 'UTC')::date AS day,
  trim(p.currency) AS currency,
  r.status,
  count(*) AS refunds,
  reporting.major(sum(r.amount)::bigint, p.currency) AS amount
FROM refunds r
JOIN payments p ON p.id = r.payment_id
GROUP BY 1, p.currency, r.status;
--> statement-breakpoint

-- Customers as counts only: never who they are.
CREATE VIEW reporting.new_customers_daily AS
SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS customers
FROM users
WHERE kind = 'customer'
GROUP BY 1;
--> statement-breakpoint

CREATE VIEW reporting.email_queue AS
SELECT
  status,
  count(*) AS messages,
  COALESCE(extract(epoch FROM now() - min(created_at))::bigint, 0) AS oldest_seconds
FROM notifications
GROUP BY status;
--> statement-breakpoint

-- Permissions: schema usage and SELECT on what is in it. Nothing else, ever.
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA reporting TO sold_grafana;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO sold_grafana;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO sold_grafana;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO sold_grafana;
--> statement-breakpoint

-- Dashboards may legitimately run longer than request-path queries, but never unbounded, and never write.
ALTER ROLE sold_grafana SET statement_timeout = '30s';
--> statement-breakpoint
ALTER ROLE sold_grafana SET default_transaction_read_only = on;
--> statement-breakpoint
ALTER ROLE sold_grafana SET idle_in_transaction_session_timeout = '10s';
