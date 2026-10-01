-- Durable outbound email. A row is the unit of work AND the record of what was sent.
--   dedupe_key : one logical email -> one row, however many times its trigger event is redelivered
--   status     : queued -> sending (leased) -> sent | failed (gave up) | suppressed (address opted out / bounced)
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  dedupe_key   text NOT NULL,
  template     text NOT NULL,
  to_email     text NOT NULL,
  locale       text NOT NULL DEFAULT 'en-au',
  data         jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts     integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  last_error   text,
  provider_id  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_dedupe_key_key UNIQUE (dedupe_key)
);
--> statement-breakpoint

-- The delivery worker polls due rows; sent/failed rows are never in this index.
CREATE INDEX notifications_due_idx ON notifications (available_at) WHERE status IN ('queued', 'sending');
--> statement-breakpoint

-- Addresses we must not mail (unsubscribe, hard bounce, complaint). Transactional mail to a suppressed address is dropped too:
-- sending to a bounced address damages sender reputation for every other customer.
CREATE TABLE email_suppressions (
  email      text PRIMARY KEY CHECK (email = lower(email)),
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
