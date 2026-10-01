-- Server-side conversion events already delivered. Observers are at-least-once; this makes our side idempotent
-- (TikTok also de-duplicates on event_id, so a crash between send and record is harmless).
CREATE TABLE ext_tiktok_social_sent (
  event_id text PRIMARY KEY,
  event    text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now()
);
