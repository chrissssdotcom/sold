-- Assertion IDs already accepted, so a captured SAML response cannot be replayed within its validity window.
CREATE TABLE sso_replay (
  provider     text NOT NULL,
  assertion_id text NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (provider, assertion_id)
);
--> statement-breakpoint

CREATE INDEX sso_replay_expires_idx ON sso_replay (expires_at);
