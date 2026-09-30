-- Payments, refunds, webhook ledger and FX rate history. All objects are new.

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  order_id     uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
  gateway      text NOT NULL,
  -- The gateway's own id (e.g. a PaymentIntent). NULL until the gateway has answered.
  gateway_ref  text,
  status       text NOT NULL DEFAULT 'pending',
  currency     char(3) NOT NULL,
  -- Amount the customer is asked to pay, in minor units of `currency`.
  amount       bigint NOT NULL,
  captured     bigint NOT NULL DEFAULT 0,
  refunded     bigint NOT NULL DEFAULT 0,
  failure_code text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_status_check CHECK (status IN
    ('pending', 'requires_action', 'authorized', 'captured', 'partially_refunded', 'refunded', 'failed', 'voided')),
  CONSTRAINT payments_amount_check CHECK (amount > 0),
  -- The database refuses to record more captured than authorised or more refunded than captured.
  CONSTRAINT payments_captured_check CHECK (captured >= 0 AND captured <= amount),
  CONSTRAINT payments_refunded_check CHECK (refunded >= 0 AND refunded <= captured)
);
--> statement-breakpoint

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

CREATE UNIQUE INDEX payments_gateway_ref_key ON payments (gateway, gateway_ref) WHERE gateway_ref IS NOT NULL;
--> statement-breakpoint

CREATE INDEX payments_order_idx ON payments (order_id);
--> statement-breakpoint

-- Every webhook delivery, exactly once per (gateway, event id): the dedupe key AND the audit log.
CREATE TABLE payment_events (
  gateway      text NOT NULL,
  event_id     text NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text,
  PRIMARY KEY (gateway, event_id)
);
--> statement-breakpoint

-- Reprocessing sweep: events that arrived but were not applied.
CREATE INDEX payment_events_unprocessed_idx ON payment_events (received_at) WHERE processed_at IS NULL;
--> statement-breakpoint

CREATE TABLE refunds (
  id              uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  payment_id      uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  amount          bigint NOT NULL,
  currency        char(3) NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  gateway_ref     text,
  reason          text NOT NULL DEFAULT '',
  actor           text NOT NULL,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_amount_check CHECK (amount > 0),
  CONSTRAINT refunds_status_check CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT refunds_idempotency_key_key UNIQUE (idempotency_key)
);
--> statement-breakpoint

CREATE TRIGGER refunds_touch BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

CREATE INDEX refunds_payment_idx ON refunds (payment_id);
--> statement-breakpoint

-- Append-only FX history: a rate is never updated, so any past conversion can be reproduced. Rates are exact
-- rationals (numerator/denominator), never floats.
CREATE TABLE fx_rates (
  base        char(3) NOT NULL,
  quote       char(3) NOT NULL,
  rate_num    bigint NOT NULL,
  rate_den    bigint NOT NULL,
  source      text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote, fetched_at),
  CONSTRAINT fx_rates_positive_check CHECK (rate_num > 0 AND rate_den > 0),
  CONSTRAINT fx_rates_distinct_check CHECK (base <> quote)
);
