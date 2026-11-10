/** Additive external-reader schema; migrate.ts installs this after the owned-library tables. */
export const EXTERNAL_READER_DDL = `
ALTER TABLE reading_events ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'web';
CREATE UNIQUE INDEX IF NOT EXISTS external_completion_once ON reading_events(user_id, book_id)
  WHERE origin IN ('komga', 'koreader');
CREATE TABLE IF NOT EXISTS external_sync_baselines (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin text NOT NULL, scope_key text NOT NULL, cursor double precision NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, origin, scope_key)
);
CREATE TABLE IF NOT EXISTS koreader_hashes (
  book_id text PRIMARY KEY REFERENCES lib_books(id) ON DELETE CASCADE,
  signature text NOT NULL, digest text NOT NULL, scan_mtime bigint, checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE koreader_hashes ADD COLUMN IF NOT EXISTS scan_mtime bigint;
CREATE INDEX IF NOT EXISTS koreader_hash_lookup ON koreader_hashes(digest);
CREATE TABLE IF NOT EXISTS koreader_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document text NOT NULL, book_id text REFERENCES lib_books(id) ON DELETE CASCADE,
  progress text NOT NULL, percentage double precision NOT NULL,
  device text NOT NULL, device_id text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, document)
);
CREATE TABLE IF NOT EXISTS opds_estimated_bookmarks (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
  page int NOT NULL CHECK(page > 0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, book_id)
);
`;
