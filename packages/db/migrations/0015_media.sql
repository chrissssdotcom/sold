-- Media library. The bytes live in object storage (or a local directory in development); this table is the catalogue.
-- `sha256` is of the uploaded bytes: uploading the same file twice yields the same asset.
CREATE TABLE media_assets (
  id            uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  sha256        text NOT NULL,
  original_name text NOT NULL CHECK (char_length(original_name) <= 200),
  mime          text NOT NULL,
  bytes         integer NOT NULL CHECK (bytes > 0),
  width         integer NOT NULL CHECK (width > 0),
  height        integer NOT NULL CHECK (height > 0),
  alt           text NOT NULL DEFAULT '' CHECK (char_length(alt) <= 300),
  -- Generated renditions: [{ "file": "640.webp", "width": 640, "mime": "image/webp", "bytes": 12345 }, ...]
  variants      jsonb NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_assets_sha256_key UNIQUE (sha256)
);
--> statement-breakpoint

CREATE INDEX media_assets_created_idx ON media_assets (created_at DESC, id DESC);
