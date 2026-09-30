-- Promotions and coupon codes on carts. `definition` is validated by the pricing engine's schema on read.

CREATE TABLE promotions (
  id                 uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  -- Stored lowercase; NULL for automatic promotions.
  code               text,
  name               text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  starts_at          timestamptz,
  ends_at            timestamptz,
  definition         jsonb NOT NULL,
  usage_limit        integer,
  per_customer_limit integer,
  usage_count        integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_code_lower_check CHECK (code IS NULL OR code = lower(code)),
  CONSTRAINT promotions_usage_check CHECK (usage_limit IS NULL OR usage_count <= usage_limit)
);
--> statement-breakpoint

CREATE UNIQUE INDEX promotions_code_key ON promotions (code) WHERE code IS NOT NULL;
--> statement-breakpoint

CREATE TRIGGER promotions_touch BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- Automatic promotions are loaded on every priced cart: keep that lookup index-only.
CREATE INDEX promotions_auto_idx ON promotions (id) WHERE active AND code IS NULL;
--> statement-breakpoint

CREATE TABLE promotion_redemptions (
  id           uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE RESTRICT,
  order_id     uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  customer_key text NOT NULL,
  amount       bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_redemptions_once_key UNIQUE (promotion_id, order_id)
);
--> statement-breakpoint

-- Per-customer limit check.
CREATE INDEX promotion_redemptions_customer_idx ON promotion_redemptions (promotion_id, customer_key);
--> statement-breakpoint

CREATE INDEX promotion_redemptions_order_idx ON promotion_redemptions (order_id);
--> statement-breakpoint

ALTER TABLE carts ADD COLUMN coupon_codes text[] NOT NULL DEFAULT '{}';
