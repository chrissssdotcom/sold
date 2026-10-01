-- Public API keys and outbound webhooks.

-- A key is `sk_<prefix>_<secret>`. Only the SHA-256 of the secret is stored, so a database read cannot be replayed as a key; the
-- prefix is public (shown in the console, used to look the key up).
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prefix       text NOT NULL,
  secret_hash  text NOT NULL,
  scopes       text[] NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT api_keys_prefix_key UNIQUE (prefix)
);
--> statement-breakpoint

-- Destinations for signed event deliveries. `secret_enc` is the signing secret, envelope-encrypted (it must be recoverable to sign).
CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  url         text NOT NULL CHECK (char_length(url) <= 500),
  events      text[] NOT NULL,
  secret_enc  text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per (endpoint, event): the unit of work and the delivery log. Retried with backoff; `delivered`, `failed` (gave up) or `dead` (endpoint removed).
CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  last_status   integer,
  last_error    text,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_once UNIQUE (endpoint_id, event_id)
);
--> statement-breakpoint

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (available_at) WHERE status IN ('pending', 'delivering');
--> statement-breakpoint
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
