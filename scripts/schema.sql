-- Uchiyomi schema (no pgcrypto extension needed: gen_random_uuid() is in Postgres core).
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL DEFAULT 'me',
  password_hash text NOT NULL,
  auth_kind     text NOT NULL DEFAULT 'password',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL, device_id text, device_name text,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);
CREATE TABLE IF NOT EXISTS favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id)
);
CREATE TABLE IF NOT EXISTS collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, accent text, sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  series_id text NOT NULL, position int NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, series_id)
);
CREATE TABLE IF NOT EXISTS ratings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id text NOT NULL, stars int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, series_id)
);
CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id text NOT NULL, book_id text, body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_series ON notes(user_id, series_id);
CREATE TABLE IF NOT EXISTS reading_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id text NOT NULL, book_id text NOT NULL, page int NOT NULL,
  completed boolean NOT NULL DEFAULT false, device_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_recent ON reading_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_series ON reading_events(user_id, series_id);
CREATE OR REPLACE VIEW reading_stats AS
SELECT user_id,
       count(*) FILTER (WHERE completed) AS chapters_completed,
       count(DISTINCT series_id) AS series_touched,
       count(*) AS total_events,
       max(created_at) AS last_read_at
FROM reading_events GROUP BY user_id;
CREATE TABLE IF NOT EXISTS app_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS offline_downloads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id text NOT NULL, series_id text NOT NULL, device_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending', page_count int, bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY (user_id, book_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_downloads_device ON offline_downloads(user_id, device_id);
