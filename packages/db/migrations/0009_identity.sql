-- Identity: users (customers and staff), sessions, roles, SSO links, login throttling, SCIM tokens, audit log.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  -- Always stored lowercased by the application; the CHECK keeps that true even for direct writes.
  email             text NOT NULL,
  name              text NOT NULL DEFAULT '',
  kind              text NOT NULL DEFAULT 'customer',
  status            text NOT NULL DEFAULT 'active',
  password_hash     text,
  email_verified_at timestamptz,
  -- SCIM `externalId` (the identity provider's id for this user).
  external_id       text,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_lower_check CHECK (email = lower(email)),
  CONSTRAINT users_kind_check CHECK (kind IN ('customer', 'staff')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);
--> statement-breakpoint

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

CREATE UNIQUE INDEX users_external_id_key ON users (external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the opaque cookie token. The token itself is never stored: a database leak cannot be replayed.
  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
);
--> statement-breakpoint

CREATE INDEX sessions_user_idx ON sessions (user_id);
--> statement-breakpoint

-- Expiry sweep.
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
--> statement-breakpoint

CREATE TABLE roles (
  name        text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  permissions text[] NOT NULL DEFAULT '{}',
  built_in    boolean NOT NULL DEFAULT false,
  CONSTRAINT roles_name_check CHECK (name ~ '^[a-z][a-z0-9-]{1,40}$')
);
--> statement-breakpoint

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_name  text NOT NULL REFERENCES roles (name) ON DELETE CASCADE,
  granted_by text NOT NULL DEFAULT 'system',
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_name)
);
--> statement-breakpoint

CREATE INDEX user_roles_role_idx ON user_roles (role_name);
--> statement-breakpoint

-- Federated identities (OIDC/SAML): (provider, subject) is the stable key, never the email.
CREATE TABLE identity_links (
  provider   text NOT NULL,
  subject    text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
--> statement-breakpoint

CREATE INDEX identity_links_user_idx ON identity_links (user_id);
--> statement-breakpoint

-- Brute-force protection keyed by an opaque hash (account and source address), durable across instances.
CREATE TABLE auth_throttle (
  key          text PRIMARY KEY,
  failures     integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
--> statement-breakpoint

CREATE TABLE scim_tokens (
  id           uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  name         text NOT NULL,
  token_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT scim_tokens_hash_key UNIQUE (token_hash)
);
--> statement-breakpoint

-- Append-only record of who did what. Updates and deletes are refused by the database, not by convention.
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_label text NOT NULL,
  action      text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id   text NOT NULL DEFAULT '',
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text
);
--> statement-breakpoint

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
--> statement-breakpoint

CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, at DESC);
--> statement-breakpoint

CREATE FUNCTION sold_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$;
--> statement-breakpoint

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION sold_audit_immutable();
--> statement-breakpoint

-- The built-in roles. Permissions are `<area>:<action>`; `*` means everything (owner only).
INSERT INTO roles (name, description, permissions, built_in) VALUES
  ('owner', 'Full access, including users and roles', ARRAY['*'], true),
  ('admin', 'Everything except managing users and roles', ARRAY['catalog:*','orders:*','payments:*','content:*','promotions:*','theme:*','customers:read','reports:read','settings:*','extensions:read','audit:read'], true),
  ('catalog-manager', 'Products, prices and stock', ARRAY['catalog:*','promotions:read','content:read'], true),
  ('order-manager', 'Orders, refunds and fulfilment', ARRAY['orders:*','payments:refund','payments:read','customers:read','catalog:read'], true),
  ('content-editor', 'Pages and theme', ARRAY['content:*','theme:*','catalog:read'], true),
  ('support', 'Read-only customer service view', ARRAY['orders:read','customers:read','catalog:read','payments:read'], true);
