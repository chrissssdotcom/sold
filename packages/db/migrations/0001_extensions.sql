-- Extension framework state: which extensions are installed/enabled, and their settings.
-- All objects are new, so the lock-impact rules do not apply.

CREATE TABLE extension_registry (
  name             text PRIMARY KEY,
  version          text NOT NULL,
  state            text NOT NULL CHECK (state IN ('enabled', 'disabled')),
  installed_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_enabled_at  timestamptz,
  last_disabled_at timestamptz
);
--> statement-breakpoint

CREATE TRIGGER extension_registry_touch BEFORE UPDATE ON extension_registry
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

-- Settings. Non-secret values are plain jsonb; secrets are envelope-encrypted (see packages/core crypto).
-- Exactly one of value/ciphertext is set. Removing an extension's registry row removes its settings.
CREATE TABLE extension_settings (
  extension  text NOT NULL REFERENCES extension_registry (name) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb,
  ciphertext text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (extension, key),
  CONSTRAINT extension_settings_one_of CHECK ((value IS NULL) <> (ciphertext IS NULL))
);
