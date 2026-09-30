-- Storefront pages built with the page builder. A page is a path + locale; its content lives in immutable
-- versions (a block tree), and `published_version_id` says which one visitors see. Drafts never affect the live site.

CREATE TABLE pages (
  id                   uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  -- Path within the locale, e.g. '/' or '/about'. Lowercase, no trailing slash except the root.
  path                 text NOT NULL,
  locale               text NOT NULL,
  title                text NOT NULL,
  status               text NOT NULL DEFAULT 'draft',
  published_version_id uuid,
  seo                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pages_path_locale_key UNIQUE (locale, path),
  CONSTRAINT pages_status_check CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT pages_path_check CHECK (path ~ '^/([a-z0-9-]+(/[a-z0-9-]+)*)?$'),
  CONSTRAINT pages_published_check CHECK (status <> 'published' OR published_version_id IS NOT NULL)
);
--> statement-breakpoint

CREATE TRIGGER pages_touch BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION sold_touch_updated_at();
--> statement-breakpoint

CREATE TABLE page_versions (
  id         uuid PRIMARY KEY DEFAULT sold_uuid_v7(),
  page_id    uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  -- The block tree: [{ id, type, props, children? }]. Validated against the block registry before it is written.
  tree       jsonb NOT NULL,
  note       text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page_versions_page_version_key UNIQUE (page_id, version),
  CONSTRAINT page_versions_version_check CHECK (version >= 1)
);
--> statement-breakpoint

ALTER TABLE pages ADD CONSTRAINT pages_published_version_fkey
  FOREIGN KEY (published_version_id) REFERENCES page_versions (id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

ALTER TABLE pages VALIDATE CONSTRAINT pages_published_version_fkey;
--> statement-breakpoint

-- Theme: design tokens per environment (colours, type, radii, spacing) plus a preset name.
CREATE TABLE theme_settings (
  id         boolean PRIMARY KEY DEFAULT true,
  preset     text NOT NULL DEFAULT 'default',
  tokens     jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'system',
  -- Single-row table.
  CONSTRAINT theme_settings_singleton CHECK (id)
);
