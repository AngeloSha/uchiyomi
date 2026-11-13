/**
 * reading_events.origin values that are external completions, as an SQL list: each counts a chapter once
 * (external_completion_once), and every statement that relies on that index names the same list. v0.108.0 (#377):
 * 'opds', a chapter paged through to the end over OPDS page streaming (lib/externalReading.ts rememberOpdsEstimate).
 */
export const EXTERNAL_ORIGINS = `'komga', 'koreader', 'opds'`;

/** Additive external-reader schema; migrate.ts installs this after the owned-library tables. */
export const EXTERNAL_READER_DDL = `
ALTER TABLE reading_events ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'web';
-- An index's predicate cannot be changed in place, so one built before 'opds' was in it (v0.107.0) is dropped here and
-- built again below, once: after that its definition names 'opds' and this finds nothing to do.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'external_completion_once'
                AND indexdef NOT LIKE '%opds%') THEN
    DROP INDEX external_completion_once;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS external_completion_once ON reading_events(user_id, book_id)
  WHERE origin IN (${EXTERNAL_ORIGINS});
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
-- v0.108.0 (#377): the sitting a chapter is being streamed in -- when it began, and how many of its page fetches moved
-- the furthest page on -- which decides whether reaching the last page counts as reading it.
ALTER TABLE opds_estimated_bookmarks ADD COLUMN IF NOT EXISTS session_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opds_estimated_bookmarks ADD COLUMN IF NOT EXISTS forward int NOT NULL DEFAULT 0;
-- v0.108.0 (#377): a completion guessed from OPDS page streaming, not seen. The read-chapter cleanup deletes no file on a
-- guess (lib/chapterCleanup.ts dueSql), and the next real read of the chapter clears it.
ALTER TABLE read_progress ADD COLUMN IF NOT EXISTS inferred boolean NOT NULL DEFAULT false;
`;
