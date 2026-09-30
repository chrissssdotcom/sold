-- Commerce core, part 2: carts, orders, idempotency. All objects are new.

CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  customer_id uuid,
  currency    char(3) NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  -- Optimistic concurrency for concurrent tabs/devices.
  version     integer NOT NULL DEFAULT 1,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carts_status_check CHECK (status IN ('open', 'converted', 'abandoned'))
);
--> statement-breakpoint

CREATE TRIGGER carts_touch BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- A signed-in customer's open cart lookup.
CREATE INDEX carts_customer_open_idx ON carts (customer_id) WHERE customer_id IS NOT NULL AND status = 'open';
--> statement-breakpoint

CREATE INDEX carts_expiry_idx ON carts (expires_at) WHERE status = 'open';
--> statement-breakpoint

CREATE TABLE cart_lines (
  id         uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  cart_id    uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  quantity   integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_lines_quantity_check CHECK (quantity > 0),
  CONSTRAINT cart_lines_cart_variant_key UNIQUE (cart_id, variant_id)
);
--> statement-breakpoint

CREATE INDEX cart_lines_variant_idx ON cart_lines (variant_id);
--> statement-breakpoint

CREATE SEQUENCE order_number_seq START WITH 1000;
--> statement-breakpoint

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  number           bigint NOT NULL DEFAULT nextval('order_number_seq'),
  cart_id          uuid REFERENCES carts (id) ON DELETE RESTRICT,
  customer_id      uuid,
  email            text NOT NULL,
  status           text NOT NULL DEFAULT 'pending_payment',
  currency         char(3) NOT NULL,
  subtotal         bigint NOT NULL,
  discount_total   bigint NOT NULL DEFAULT 0,
  shipping_total   bigint NOT NULL DEFAULT 0,
  tax_total        bigint NOT NULL DEFAULT 0,
  total            bigint NOT NULL,
  -- Prices and tax are computed once, at placement, and snapshotted here.
  pricing          jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_address jsonb NOT NULL,
  billing_address  jsonb NOT NULL,
  shipping_method  text,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_number_key UNIQUE (number),
  -- A cart converts to at most one order: the database backs checkout idempotency.
  CONSTRAINT orders_cart_key UNIQUE (cart_id),
  CONSTRAINT orders_status_check CHECK (status IN
    ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  CONSTRAINT orders_totals_check CHECK (
    subtotal >= 0 AND discount_total >= 0 AND shipping_total >= 0 AND tax_total >= 0 AND total >= 0)
);
--> statement-breakpoint

CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC) WHERE customer_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX orders_status_placed_idx ON orders (status, placed_at DESC);
--> statement-breakpoint

CREATE TABLE order_lines (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  variant_id  uuid REFERENCES product_variants (id) ON DELETE SET NULL,
  sku         text NOT NULL,
  title       text NOT NULL,
  quantity    integer NOT NULL,
  unit_price  bigint NOT NULL,
  discount    bigint NOT NULL DEFAULT 0,
  tax         bigint NOT NULL DEFAULT 0,
  line_total  bigint NOT NULL,
  CONSTRAINT order_lines_quantity_check CHECK (quantity > 0),
  CONSTRAINT order_lines_amounts_check CHECK (unit_price >= 0 AND discount >= 0 AND tax >= 0 AND line_total >= 0)
);
--> statement-breakpoint

CREATE INDEX order_lines_order_idx ON order_lines (order_id);
--> statement-breakpoint

CREATE INDEX order_lines_variant_idx ON order_lines (variant_id) WHERE variant_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE order_status_history (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  order_id    uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);
--> statement-breakpoint

-- Exactly-once semantics for retried requests (checkout, admin actions, webhooks).
CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       text NOT NULL DEFAULT 'in_progress',
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (scope, key),
  CONSTRAINT idempotency_keys_status_check CHECK (status IN ('in_progress', 'completed'))
);
--> statement-breakpoint

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
