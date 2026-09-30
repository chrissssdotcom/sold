-- Commerce core, part 1: catalog and inventory. All objects are new (no lock-impact concerns).
-- Money is bigint minor units + an ISO-4217 code, never a float (AGENTS.md).

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  handle      text NOT NULL,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'draft',
  tags        text[] NOT NULL DEFAULT '{}',
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_handle_key UNIQUE (handle),
  CONSTRAINT products_status_check CHECK (status IN ('draft', 'active', 'archived'))
);
--> statement-breakpoint

CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- Storefront listing: active products, newest first.
CREATE INDEX products_active_created_idx ON products (created_at DESC) WHERE status = 'active';
--> statement-breakpoint

CREATE TABLE product_variants (
  id           uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  product_id   uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku          text NOT NULL,
  title        text NOT NULL DEFAULT '',
  options      jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight_grams integer NOT NULL DEFAULT 0,
  position     integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_sku_key UNIQUE (sku),
  CONSTRAINT product_variants_weight_check CHECK (weight_grams >= 0),
  CONSTRAINT product_variants_status_check CHECK (status IN ('active', 'archived'))
);
--> statement-breakpoint

CREATE TRIGGER product_variants_touch BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- Foreign-key column index (product page loads its variants).
CREATE INDEX product_variants_product_idx ON product_variants (product_id, position);
--> statement-breakpoint

-- Price per variant per currency, in minor units of that currency.
CREATE TABLE variant_prices (
  variant_id  uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  currency    char(3) NOT NULL,
  amount      bigint NOT NULL,
  compare_at  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, currency),
  CONSTRAINT variant_prices_amount_check CHECK (amount >= 0),
  CONSTRAINT variant_prices_compare_check CHECK (compare_at IS NULL OR compare_at >= 0)
);
--> statement-breakpoint

-- One row per variant. available = on_hand - reserved; the CHECKs make overselling impossible even if
-- application code is wrong: the database refuses the write.
CREATE TABLE inventory_levels (
  variant_id uuid PRIMARY KEY REFERENCES product_variants (id) ON DELETE CASCADE,
  on_hand    integer NOT NULL DEFAULT 0,
  reserved   integer NOT NULL DEFAULT 0,
  -- Sell without stock (pre-orders). Off by default.
  allow_backorder boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_levels_on_hand_check CHECK (on_hand >= 0),
  CONSTRAINT inventory_levels_reserved_check CHECK (reserved >= 0),
  CONSTRAINT inventory_levels_bounds_check CHECK (allow_backorder OR reserved <= on_hand)
);
--> statement-breakpoint

CREATE TRIGGER inventory_levels_touch BEFORE UPDATE ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- Time-boxed holds. `owner_ref` is the cart or checkout that holds the stock.
CREATE TABLE inventory_reservations (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  variant_id  uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  owner_ref   text NOT NULL,
  quantity    integer NOT NULL,
  status      text NOT NULL DEFAULT 'held',
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz,
  CONSTRAINT inventory_reservations_quantity_check CHECK (quantity > 0),
  CONSTRAINT inventory_reservations_status_check CHECK (status IN ('held', 'committed', 'released', 'expired'))
);
--> statement-breakpoint

-- Idempotent reserve: one live hold per (owner, variant).
CREATE UNIQUE INDEX inventory_reservations_live_key
  ON inventory_reservations (owner_ref, variant_id) WHERE status = 'held';
--> statement-breakpoint

-- Expiry sweep scans only live holds, oldest first.
CREATE INDEX inventory_reservations_expiry_idx
  ON inventory_reservations (expires_at) WHERE status = 'held';
--> statement-breakpoint

-- Foreign-key column index.
CREATE INDEX inventory_reservations_variant_idx ON inventory_reservations (variant_id);
