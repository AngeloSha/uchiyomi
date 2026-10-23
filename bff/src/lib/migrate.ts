import type { PoolClient } from 'pg';
import { pool, one } from './db';
import { env } from '../env';
import { MANGADEX_LANGS } from './lang';
import { typeFromGenres, SERIES_TYPE_FROM } from './seriesTypeSignals';
import { cleanGenres } from './genres';
import { REFILE_FAILURES_SQL } from './chapterFailures';
import { ssoOnly } from './authMode';

// NOTE: gen_random_uuid() is in Postgres core (v13+); no pgcrypto extension needed.
// (The supabase/postgres image's event triggers reject CREATE EXTENSION under a custom role.)
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL DEFAULT 'me',
  password_hash text NOT NULL,
  auth_kind     text NOT NULL DEFAULT 'password',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  device_id   text,
  device_name text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id)
);
-- v0.97.0: the place a person gave a favourite in their own order (lib/favorites.ts), NULL until they move one. Every list
-- of their favourites reads position first, then created_at, so nothing moves for anyone until they reorder.
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS position int;

CREATE TABLE IF NOT EXISTS collections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  accent     text,
  sort_order int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  series_id     text NOT NULL,
  position      int  NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, series_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id  text NOT NULL,
  stars      int  NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id  text NOT NULL,
  book_id    text,
  body       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_series ON notes(user_id, series_id);

CREATE TABLE IF NOT EXISTS reading_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id  text NOT NULL,
  book_id    text NOT NULL,
  page       int  NOT NULL,
  completed  boolean NOT NULL DEFAULT false,
  device_id  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_recent ON reading_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_series ON reading_events(user_id, series_id);

-- A finished chapter counts ONCE (#264): count(*) counted completed EVENTS, and one read-through writes two -- the
-- page before the last is already the end (reachedEnd, lib/progressRules.ts) and the last page sends its own -- so the
-- profile's chapters and the badges built on them ran ahead of the household board, which always counted distinct.
CREATE OR REPLACE VIEW reading_stats AS
SELECT user_id,
       count(DISTINCT book_id) FILTER (WHERE completed) AS chapters_completed,
       count(DISTINCT series_id)                        AS series_touched,
       count(*)                                         AS total_events,
       max(created_at)                                  AS last_read_at
FROM reading_events GROUP BY user_id;

CREATE TABLE IF NOT EXISTS app_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS offline_downloads (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id      text NOT NULL,
  series_id    text NOT NULL,
  device_id    text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  page_count   int,
  bytes        bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, book_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_downloads_device ON offline_downloads(user_id, device_id);

-- multi-user: usernames + roles
ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users(username) WHERE username IS NOT NULL;

-- per-user reading progress (independent tracking; content stays shared via Komga)
CREATE TABLE IF NOT EXISTS read_progress (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    text NOT NULL,
  series_id  text NOT NULL,
  page       int NOT NULL DEFAULT 0,
  completed  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_rp_series ON read_progress(user_id, series_id);
CREATE INDEX IF NOT EXISTS idx_rp_recent ON read_progress(user_id, updated_at DESC) WHERE completed = false;

-- cover-art ambient theming
CREATE TABLE IF NOT EXISTS series_colors (
  series_id  text PRIMARY KEY,
  color      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- real per-series art pulled from the internet (AniList): wide banner + high-res cover.
-- a row (even with null banner/cover) records that we already looked it up.
CREATE TABLE IF NOT EXISTS series_art (
  series_id  text PRIMARY KEY,
  banner     text,
  cover      text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Owned library (replaces Komga's file catalog). Populated by the CBZ scanner (lib/library.ts).
CREATE TABLE IF NOT EXISTS lib_series (
  id            text PRIMARY KEY,
  source        text NOT NULL,
  title         text NOT NULL,
  summary       text,
  author        text,
  status        text,
  genres        text[] NOT NULL DEFAULT '{}',
  web           text,
  folder        text UNIQUE NOT NULL,
  books_count   int NOT NULL DEFAULT 0,
  cover_book_id text,
  scanned_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lib_books (
  id         text PRIMARY KEY,
  series_id  text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  source     text NOT NULL,
  file       text UNIQUE NOT NULL,
  number     real NOT NULL DEFAULT 0,
  title      text,
  pages      int NOT NULL DEFAULT 0,
  mtime      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lib_books_series_idx ON lib_books (series_id, number);
CREATE INDEX IF NOT EXISTS lib_series_genres_idx ON lib_series USING gin (genres);
-- added later: first-seen time (for "new" rail) + newest chapter mtime (for "updated" rail)
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS created_at   timestamptz NOT NULL DEFAULT now();
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS latest_mtime bigint      NOT NULL DEFAULT 0;
-- which root dir a book lives in (Suwayomi read dir vs the owned download dir)
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS root text NOT NULL DEFAULT '/library';
-- cached per-page pixel dimensions [{name,width,height}] (the reader needs these to lay pages out)
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS page_dims jsonb;
-- chapter release date on the source (stamped at download/update time; NULL for library-only books)
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS published_at timestamptz;
-- whether the scheduled updater pulls new chapters for this series (user choice at add time)
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS auto_update boolean NOT NULL DEFAULT true;
-- source routing for the updater: the adapter id + that adapter's stable series id/url, stamped at add time.
-- (lib_series.source holds the display folder name, e.g. "Aqua Manga"; these hold the machine-routable values
-- so the updater calls getSource(source_id).listChapters(source_series_id) directly — no name/url reverse-parsing.)
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS source_id        text;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS source_series_id text;
-- What the source said when the updater last asked, so "how far behind is this series" is a query rather
-- than 192 listChapters calls. source_missing is the exact count the updater computed (chapters the source
-- lists that we do not hold). source_checked_at is stamped whenever the source was ASKED, answered or not,
-- and never when it was skipped for a cooldown, so the sweep can visit least-recently-checked first.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS source_chapters   int;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS source_missing    int;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS source_checked_at timestamptz;
-- The lowest chapter number the updater is asked to care about; NULL means no floor. Set when a series is
-- added as "latest N": the updater otherwise counts every listed chapter we lack as missing, oldest first,
-- so a series added as the latest 25 of 200 would have the sweep backfill 1..175 five per night with every
-- new release queued behind them. Chapters below the floor are left to the fill scan, on purpose.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS chapter_floor     numeric;

-- Release preferences (lib/releases.ts): which scanlation group to take when a source lists a chapter
-- several times, which never to take, and how long to wait for the preferred one. The global set lives on
-- server_settings; this is one series' own, NULL when it has none. A per-series priority replaces the
-- global list, a per-series block adds to it.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS scanlator_prefs   jsonb;
-- Who released the copy that is on disk and which adapter it came from, stamped when the file LANDS and
-- never by the scanner, like published_at. NULL for a book that was scanned in from elsewhere. The stamp
-- is what lets the series page say "group B holds chapters 40-52" and what a later "replace with the
-- preferred group" could compare against.
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS scanlator text;
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS source_id text;

-- Extra sources the updater merges into one chapter list for a series, beyond the primary pair stored on
-- lib_series (source_id, source_series_id). One row per (series, adapter); the adapter's own series id is
-- what listChapters is called with. coverage is the share of the primary's chapter numbers the follower
-- also listed when it was added, kept so the picker can show it; checked_at and chapters are what the
-- updater last saw there, mirroring source_checked_at / source_chapters on the primary.
-- A soft-deleted or merged series keeps its rows: they are inert while the series is hidden and cost
-- nothing, and the hard delete cascades them away with everything else.
CREATE TABLE IF NOT EXISTS series_sources (
  series_id        text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  source_id        text NOT NULL,
  source_series_id text NOT NULL,
  title            text,
  coverage         real,
  added_by         uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  checked_at       timestamptz,
  chapters         int,
  PRIMARY KEY (series_id, source_id)
);

-- What every followed source listed for a series the last time it was asked (the sweep, Check now, or
-- POST /api/admin/update/:id): one row per chapter NUMBER, whether or not the chapter is on disk. Written
-- whole by lib/seriesListing.ts on every answered updateSeries and left standing when no source answered,
-- because a stale listing beats an empty one -- the same rule the latest-page cache follows.
-- Why it exists: until v0.32.0 the chapters a source had and this server lacked were visible nowhere but
-- the sweep's own arithmetic. A chapter held for a preferred group, one that had failed three times, one
-- released only by a blocked group, one below the Latest-N floor -- each was a quiet "0 added" on the
-- series page. This table is what the series page reads to draw those as ghost rows with a reason, what a
-- manual fetch is AUTHORISED against (a number never listed cannot be asked for, the same footing as the
-- fill plan), and what the known-group picker counts.
-- chosen is the full SourceChapter the release rules picked for the number (jsonb, so a manual fetch can
-- hand it straight to the downloader); groups is every group that released ANY copy, deduped the way
-- lib/releases.ts compares names; status is available, held (withheld for a preferred group this run) or
-- blocked (every copy dropped because only blocked groups released it -- the row keeps the first copy so
-- the page can still say who). number is real to match lib_books.number exactly, so the anti-join that
-- turns a listing row into a ghost never misses on a float. The column is named chosen and not copy on
-- purpose: COPY is a Postgres keyword.
CREATE TABLE IF NOT EXISTS series_listing (
  series_id    text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  number       real NOT NULL,
  title        text,
  published_at timestamptz,
  scanlator    text,
  groups       text[] NOT NULL DEFAULT '{}',
  source_id    text NOT NULL,
  chosen       jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'available',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, number)
);
-- Every copy of the number the sources listed, not only the chosen one: v0.33.0's "who scanlates this"
-- panel and the chapter-versions list need each copy's group, language, page count and date, and a
-- specific-version fetch (picks on POST /api/sources/fetch and the admin refetch) is AUTHORISED against
-- exactly these entries, the way a plain fetch is authorised against the row. Each entry is
-- { sourceId, source, groups, scanlator, lang, pages, publishedAt }, ordered the way the release rules
-- rank them, chosen copy first, so a client that reads copies[0] reads what the sweep would take.
-- Size: a long MangaDex title lists about three copies for each of about a thousand numbers at about
-- two hundred bytes each -- under a megabyte per series, rewritten whole at every check like the rest
-- of the row. Rows written before v0.33.0 carry the empty default until the series' next check.
ALTER TABLE series_listing ADD COLUMN IF NOT EXISTS copies jsonb NOT NULL DEFAULT '[]';

-- The visible status can be blocked while a preference hides every stored copy. Keep the state underneath that
-- temporary block so lifting it restores held/covered faithfully instead of making every chapter available. A row
-- written before v0.55.8 cannot prove which natural state a blocked chapter had, so it fails closed as held until the
-- next source refresh rebuilds it. Non-blocked rows already carry their natural state in status.
ALTER TABLE series_listing ADD COLUMN IF NOT EXISTS unblocked_status text;
UPDATE series_listing
   SET unblocked_status = CASE
     WHEN status IN ('available', 'held', 'covered') THEN status
     ELSE 'held'
   END
 WHERE unblocked_status IS NULL
    OR unblocked_status NOT IN ('available', 'held', 'covered');
ALTER TABLE series_listing ALTER COLUMN unblocked_status SET DEFAULT 'available';
ALTER TABLE series_listing ALTER COLUMN unblocked_status SET NOT NULL;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'series_listing'::regclass
       AND conname = 'series_listing_unblocked_status_check'
  ) THEN
    ALTER TABLE series_listing
      ADD CONSTRAINT series_listing_unblocked_status_check
      CHECK (unblocked_status IN ('available', 'held', 'covered'));
  END IF;
END
$migration$;

-- Content identity, so a chapter can be recognised after it moves. Derived from the archive's central
-- directory (entry names + CRC-32 + uncompressed sizes), which is cheap to read and survives recompression.
-- Nothing reads these yet; a background job fills them in, and fp_at is set even on failure so an unreadable
-- file is attempted once rather than retried on every pass.
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS fp_kind     text;         -- zip | rar | dir | error
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS fp_at       timestamptz;  -- when it was last attempted
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS size        bigint;
CREATE INDEX IF NOT EXISTS lib_books_fp_idx ON lib_books (fingerprint) WHERE fingerprint IS NOT NULL;

-- The chapter's file was deleted to reclaim space, by the opt-in read-chapter cleanup (lib/chapterCleanup.ts).
--
-- ⚠️ THE ROW IS A TOMBSTONE AND MUST STAY. Two things depend on it and both break if it is deleted instead:
--   1. read_progress.book_id is ON DELETE RESTRICT, so erasing the row would mean erasing what people read
--      of it -- the one loss with no undo, and one that syncs outward to AniList.
--   2. the updater's "what do we already have" set is a plain SELECT over lib_books, so a deleted row is a
--      missing chapter: the next sweep would download exactly what the cleanup just deleted, forever.
-- pruned_at is therefore "we had this, it was read, we let the bytes go, and we are not fetching it again".
-- persistScan clears it if the file ever comes back, so a manual re-copy or re-download undoes the mark.
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS pruned_at   timestamptz;
CREATE INDEX IF NOT EXISTS lib_books_pruned_idx ON lib_books (pruned_at) WHERE pruned_at IS NOT NULL;
-- WHY the bytes are gone, meaningful only while pruned_at is set (persistScan clears the mark and leaves
-- this stale, harmlessly: every reader tests pruned_at first).
--   NULL       the read-chapter cleanup, or a row marked before v0.37.0
--   'deleted'  the admin's Delete files removed it (lib/libraryAdmin.ts deleteSeriesFiles)
--   'missing'  the admin's "Verify chapter files" task found no file behind the row (lib/verifyFiles.ts):
--              a database-only restore, since chapter files are never in a backup
--   'rescan_missing' Rescan found a read-library entry absent; unlike deliberate deletion it may be fetched again
-- ⚠️ The updater's have-set reads this. A cleanup or Delete-files tombstone still counts as HELD -- "we let
-- the bytes go on purpose, do not fetch it again" is the whole point of those marks -- while a 'missing'
-- one does not, so the next sweep fetches it again. That is what makes a restore recover its chapters
-- without turning the cleanup into a fetch-delete loop (heldBooks in lib/chapterCleanup.ts).
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS pruned_reason text;

-- breadcrumb for a series that gets rematched to a new folder, so a wrong match can be reversed
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS folder_prev text;

-- Deleting a series HIDES it rather than erasing it. The id survives, so favourites, ratings, notes and --
-- above all -- reading history stay attached to something real, and the delete is undoable. The scanner
-- must not revive a hidden folder, or the next scan brings the series back under a brand-new id.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;
-- Merging points the absorbed series at its survivor instead of deleting it, for the same reason: its
-- folder still exists on disk, so without this the next scan would recreate it and pull the books back out.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS merged_into text;
CREATE INDEX IF NOT EXISTS lib_series_live_idx ON lib_series (id) WHERE deleted_at IS NULL AND merged_into IS NULL;


-- A book is unique per (root, file), not per file: the same relative path legitimately exists under both the
-- read library and the download dir. Strictly weaker than the old constraint, so it cannot fail to apply.
ALTER TABLE lib_books DROP CONSTRAINT IF EXISTS lib_books_file_key;
CREATE UNIQUE INDEX IF NOT EXISTS lib_books_root_file_idx ON lib_books (root, file);

-- per-user "new chapters since last seen" (Updates feed + NEW badges)
CREATE TABLE IF NOT EXISTS series_seen (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id        text NOT NULL,
  seen_books_count int NOT NULL DEFAULT 0,
  seen_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id)
);

-- per-account avatar {emoji, color}
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar jsonb NOT NULL DEFAULT '{}';

-- account security: disable/suspend, brute-force lockout, TOTP 2FA, granular permissions
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled            boolean     NOT NULL DEFAULT false;
-- v0.69.1: a place kept while Incognito reading was on (lib/progress.ts). Other members' private places are not
-- "read by the household" (Hidden gems, lib/ownedCatalog.ts). Cleared once the chapter is read in the open.
ALTER TABLE read_progress ADD COLUMN IF NOT EXISTS incognito     boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins       int         NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until        timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret         text;                       -- base32; pending until totp_enabled
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled        boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes      text[]      NOT NULL DEFAULT '{}'; -- sha256 of one-time codes
-- v0.77.1: the 30-second step of the last two-factor code accepted (RFC 6238 section 5.2). A code signs in once: after
-- it only a later step is taken (lib/auth.ts spendTotpStep). NULL before the first code, and again for a new secret.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step      bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS perms               jsonb       NOT NULL DEFAULT '{}'; -- {canDownload?}
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();

-- richer session/device info for the sessions UI
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_seen  timestamptz NOT NULL DEFAULT now();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip         text;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent text;
-- Which token replaced this one, set only when a refresh superseded it (a rotation, or a recovery of a lost
-- one). It is what separates "this device already moved on" from "this session was ended", and only the
-- former is forgiven by planRefresh (lib/auth.ts). A logout, an admin revoke and sign-out-everywhere all
-- leave it null, so they still take effect the instant they are written.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by uuid;

-- audit / activity feed (logins, admin actions, downloads, blocks)
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  username   text,
  event      text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  ip         text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

-- v0.55.8: Rescan used to label a vanished read-library file as if Delete files had removed it. That made it a held
-- tombstone forever, so restoring only the database could never fetch it again. A row outside the owned download root
-- is changed to rescan_missing, except where an audit proves deliberate removal. A chapter-delete audit's bookIds
-- alone do not prove that a particular request succeeded, because the audit includes skipped requests too, so it
-- proves one book only when every requested id was applied and the audit follows this tombstone's stamp (an older
-- successful deletion of the same stable id cannot prove what happened after it was restored). Whole-series Delete
-- files now records the exact affected
-- ids under the same rule. Older versions recorded only a file count; retain those only when the numeric count exactly
-- matches every tombstone stamped in the five minutes immediately before the audit. That bounded compatibility case
-- proves the normal on-disk deletion without allowing an old or mismatched series audit to bless ambiguous rows.
-- This intentionally runs on every boot: an older image
-- used after rollback can write the ambiguous value again, and the update is idempotent.
UPDATE lib_books b
   SET pruned_reason = 'rescan_missing'
 WHERE b.pruned_reason = 'deleted'
   AND b.root IS DISTINCT FROM '${(process.env.DL_ROOT || '/library-dl').replaceAll("'", "''")}'
   AND NOT EXISTS (
     SELECT 1 FROM audit_log a
      WHERE a.detail->>'id' = b.series_id
        AND (
          (a.event = 'series.chapters_delete'
           AND a.at >= b.pruned_at
           AND jsonb_typeof(a.detail->'bookIds') = 'array'
           AND a.detail->'bookIds' ? b.id
           AND CASE WHEN COALESCE(a.detail->>'applied', '') ~ '^[0-9]+$'
                    THEN (a.detail->>'applied')::int = jsonb_array_length(a.detail->'bookIds')
                    ELSE false END)
          OR
          (a.event = 'series.delete_files'
           AND a.at >= b.pruned_at
           AND (
             (jsonb_typeof(a.detail->'bookIds') = 'array'
              AND a.detail->'bookIds' ? b.id
              AND CASE WHEN COALESCE(a.detail->>'applied', '') ~ '^[0-9]+$'
                       THEN (a.detail->>'applied')::int = jsonb_array_length(a.detail->'bookIds')
                       ELSE false END)
             OR
             (COALESCE(a.detail->>'files', '') ~ '^[1-9][0-9]*$'
              AND b.pruned_at >= a.at - interval '5 minutes'
              AND (a.detail->>'files')::int = (
                SELECT count(*)::int
                  FROM lib_books proved
                 WHERE proved.series_id = b.series_id
                   AND proved.pruned_reason = 'deleted'
                   AND proved.pruned_at >= a.at - interval '5 minutes'
                   AND proved.pruned_at <= a.at
              ))
           ))
        )
   );

-- per-source health: block / rate-limit detection (status: ok | rate_limited | blocked | down)
CREATE TABLE IF NOT EXISTS source_health (
  source_id     text PRIMARY KEY,
  status        text NOT NULL DEFAULT 'ok',
  consecutive   int  NOT NULL DEFAULT 0,
  last_error    text,
  last_fail_at  timestamptz,
  last_ok_at    timestamptz,
  blocked_until timestamptz,
  disabled      boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- How often this source answered "what is new" with an empty page. Deliberately NOT part of the status
-- column: an empty answer must never clear a cooldown (see routes/sources.ts) and must never create
-- one either, because a genuinely quiet source would then earn a ban for having nothing new. These two
-- columns are evidence that only the diagnosis layer reads.
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS empty_streak  int NOT NULL DEFAULT 0;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS last_empty_at timestamptz;
-- When the watchdog last looked at this source, and what it concluded. Separate from status/last_error,
-- which describe what happened during ordinary use: these describe a deliberate check, and a check that
-- ran and found nothing wrong is itself worth recording.
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS check_code text;
-- Times WE gave up waiting, as opposed to the site failing. Kept apart from the consecutive counter on
-- purpose: a source slower than our own budget must never feed the blocked/down backoff, because that
-- backoff then stops it being asked at all and a perfectly working source disappears.
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS slow_streak  int NOT NULL DEFAULT 0;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS last_slow_at timestamptz;

-- One row per chapter the updater or a fill could not save, bumped on every further attempt and deleted by
-- persistScan the moment the chapter appears. Per CHAPTER, not per attempt: the question it answers is
-- "what is still failing, and how many times has it been tried". Per-source failure lives on source_health.
CREATE TABLE IF NOT EXISTS chapter_failures (
  series_id text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  number    real NOT NULL,
  source_id text NOT NULL,
  status    text NOT NULL,
  reason    text,
  attempts  int  NOT NULL DEFAULT 1,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, number)
);
CREATE INDEX IF NOT EXISTS idx_chapter_failures_source ON chapter_failures(source_id, at DESC);

-- server-wide settings (single row, id=1)
CREATE TABLE IF NOT EXISTS server_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  server_name        text    NOT NULL DEFAULT 'Uchiyomi',
  allow_registration boolean NOT NULL DEFAULT false,
  updater_hours      int     NOT NULL DEFAULT 6,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO server_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- nightly backup task: hour of day to run (local time) and the last run's outcome, persisted so the admin
-- Tasks view still reports it after a restart (the in-memory runtime state resets).
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS backup_hour        int NOT NULL DEFAULT 3;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS backup_last_run    timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS backup_last_result jsonb;
-- When the updater last COMPLETED a sweep, so a restart schedules the remainder of the interval instead of
-- a whole new one. Before this every deploy pushed the next sweep out by the full interval.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS updater_last_run timestamptz;

-- Scheduled extension check (lib/extensionMonitor.ts). The engine recomputes "an update is available" only
-- when its repositories are re-read, which until now happened only when an admin pressed Refresh -- so the
-- nightly auto-updater compared against a catalogue that never changed and found nothing to do, for weeks.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS extension_hours       int     NOT NULL DEFAULT 6;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS extension_auto_update boolean NOT NULL DEFAULT true;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS extension_last_run    timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS extension_last_result jsonb;
-- The repository URLs, kept here as well as on the extension server. Its volume is the one people delete
-- when it misbehaves, and its settings went with it silently -- they are not in our backup either.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS extension_repos       jsonb   NOT NULL DEFAULT '[]';
-- Languages the operator does not read, as a standing instruction rather than a one-off: installing an
-- extension switches on every source it provides, which for a multi-language extension is thirty sources in
-- languages nobody here reads (issue #38), each one a fan-out target for cross-source search. Applied on
-- install and retroactively by the bulk toggle. Codes are stored as the engine reports them (en, ru, zh-Hans).
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS hidden_langs          jsonb   NOT NULL DEFAULT '[]';
-- The server-wide release preferences: priority and blocked group names, and the patience in days before
-- a chapter is taken from a group lower down the list (lib/releases.ts). Two days is roughly how far behind
-- the second group on a popular title runs. Read tolerantly by lib/scanlatorPrefs.ts, so a hand-edited row
-- cannot stop the sweep.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS scanlator_prefs       jsonb   NOT NULL DEFAULT '{"priority":[],"blocked":[],"patienceDays":2}';

-- Update check: reads a public GitHub releases URL and sends nothing about this install, which is why it
-- may default to on. See lib/githubRelease.ts.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS update_check          boolean NOT NULL DEFAULT true;
-- The opt-in install count, which is a DIFFERENT thing pointing at a DIFFERENT server, and defaults to off.
-- The secret stays here and is never sent: the payload carries sha256(secret + month), so two pings in one
-- month can be counted as one install and two pings in different months cannot be linked at all. It is
-- generated on opt-in and discarded on opt-out, so a server that never consents never even holds one.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS install_ping          boolean NOT NULL DEFAULT false;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS install_ping_secret   text;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS install_ping_last     timestamptz;

-- The opt-in read-chapter cleanup (lib/chapterCleanup.ts): delete the file of a chapter everyone who started
-- it has finished, once it has been finished for cleanup_read_days. OFF by default and it must stay that
-- way -- it is the only scheduled job in the product that destroys data, and an install that upgrades into
-- it silently would lose files nobody asked it to lose.
--
-- Zero days is a supported value and means "at the next run", not "disabled": that is what cleanup_read is
-- for. The two are separate columns precisely so turning it off does not have to overwrite the number.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS cleanup_read          boolean NOT NULL DEFAULT false;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS cleanup_read_days     int     NOT NULL DEFAULT 30;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS cleanup_read_last_run timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS cleanup_read_last_result jsonb;

-- The on-demand "Verify chapter files" task (lib/verifyFiles.ts): the last run and what it found, persisted
-- like the cleanup's so the Tasks panel still shows it after a restart. It runs detached from its route --
-- a walk over a network share is minutes -- so the panel line is the only place the admin sees its result,
-- and a deploy right after a restore must not turn that into "not run yet".
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS verify_last_run    timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS verify_last_result jsonb;

-- v0.40.0: chapters that survive a missing page, and the automatic search for a source that has it.
--
-- missing_pages: the 1-based page numbers that are PLACEHOLDERS in the file on disk, NULL when the chapter
-- is complete. A chapter that lost one page in a hundred used to be refused outright and re-tried every
-- night for weeks (153 ledger rows of "N-1 of N pages" on one install); now the downloader writes it with
-- a flat placeholder at the missing index, marks it here, and the sweep's completion pass (lib/partial.ts)
-- fetches only the missing pages until the column is NULL again. Stamped by setBookMeta when the chapter
-- lands and cleared by the completion pass; the scanner never touches it, because the scanner reads the
-- file and the file does not know which of its pages are real.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS missing_pages int[];
-- When the sweep last searched OTHER sources for a chapter this series' followed sources could not serve
-- (lib/sourceHunt.ts). Stamped BEFORE the search, so a crash mid-hunt never re-hunts the same series every
-- sweep; the hunt itself is one search per candidate source, capped, and once a day per series is the cap
-- that keeps it from being a load the sites notice.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS source_hunt_at timestamptz;
-- The switch for that hunt. ON by default: it only ever runs after every followed source has failed a
-- chapter, follows at most two sources per series, and never attaches an adult source to a clean series.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS auto_follow_on_failure boolean NOT NULL DEFAULT true;

-- v0.41.0: the nightly library repair (lib/repair.ts), which fixes what the Health page could only report.
--
-- pages_checked_at: when the repair last read this chapter file to count its pages. A column of its own
-- because the pages column alone cannot say "counted": a corrupt, imageless or missing archive counts 0,
-- so a step selecting on a zero page count alone would re-open those same files every night forever and
-- never reach the rest of the library (30,625 of 43,253 rows were uncounted on this install, because a
-- page count is stamped only when somebody opens the chapter). Stamped even when the answer is 0, so the
-- queue drains. Since v0.72.0 cleared by a scan that finds the file's mtime moved (lib/library.ts persistScan): the
-- stamp is about the bytes it counted, and a replaced file is counted again.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS pages_checked_at timestamptz;
-- short_confirmed_at: this one-or-two-page chapter has been PROVEN to be what the sources hold, so the
-- Health page stops reporting it. A proof is "every followed copy answered two pages or fewer, none of
-- them threw or was skipped, and the search for another source found none"; a cooldown or a timeout is
-- silence, not an answer, and never confirms. Written by the repair and by the admin chip; cleared
-- AUTOMATICALLY in exactly two places, both of which mean the bytes changed: restampBook (lib/partial.ts)
-- and persistScan when the mtime moves (lib/library.ts); and withdrawn BY HAND from
-- POST /api/admin/books/:id/confirm-short with { confirmed: false }, the Health page's "Not fine" chip,
-- which is a person saying the proof was wrong. Nothing else may clear it, or a confirmation would be
-- undone by a rescan that found the same file.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS short_confirmed_at timestamptz;
-- The count step's queue in the order it drains, newest chapter file first. Partial, so it indexes only
-- the rows still to count and disappears as the job finishes -- on a library where most chapters have
-- been counted, a full index on mtime would be almost entirely rows this query never wants.
CREATE INDEX IF NOT EXISTS lib_books_uncounted_idx ON lib_books (mtime DESC)
  WHERE pages = 0 AND pages_checked_at IS NULL AND pruned_at IS NULL;
-- v0.72.0: the files that count found no page in -- Health's Chapter files card (lib/healthFiles.ts), on every run of
-- the report. Partial for the same reason: it holds only those rows, none at all on a healthy library. A file whose
-- mtime moves is counted again (lib/library.ts persistScan clears pages_checked_at).
CREATE INDEX IF NOT EXISTS lib_books_unreadable_idx ON lib_books (series_id)
  WHERE pages = 0 AND pages_checked_at IS NOT NULL AND pruned_at IS NULL;
-- gaps_checked_at / gaps_result: when the repair last looked for a source that could fill this series'
-- holes, and what it found. Stamped BEFORE the search, exactly like source_hunt_at above, so a crash
-- mid-search never re-searches the same series every night. The result is what lets the Health page say
-- "no source lists 12-15, checked on Tuesday" instead of repeating a finding nothing can act on.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS gaps_checked_at timestamptz;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS gaps_result jsonb;
-- The repair's nightly switch and its last run, persisted like the cleanup's and the verify's so the Tasks
-- panel still shows the last result after a restart. ON by default, which the read-chapter cleanup above
-- is deliberately not: every step this job takes is reversible or provable, and it never removes a file,
-- writes a tombstone, merges two series or renumbers a chapter -- those stay one-click actions an admin
-- confirms.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS repair_enabled     boolean NOT NULL DEFAULT true;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS repair_last_run    timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS repair_last_result jsonb;
-- Ghost chapters on the Komga surface (lib/komgaGhosts.ts, routes/komgaCompat.ts): list the chapters this
-- server does NOT hold -- the ones the sources listed and the sweep never fetched (series_listing), and the
-- ones the read-cleanup deleted the file of (lib_books.pruned_at) -- alongside the ones it does.
--
-- It exists for the TRACKERS. Mihon derives a series' chapter total from what this API lists, so a library
-- that prunes what it has read told AniList a thousand-chapter manhwa had one chapter, and a follow-only
-- series looked complete at zero. The rows cannot be opened (no pages, no images) and are labelled as such.
--
-- OFF by default, and not because it is dangerous: it changes what an already-paired phone sees. Chapter
-- counts and tracker totals moving on their own after an upgrade is the kind of surprise an admin has to be
-- able to consent to, and a library that downloads everything it lists gains nothing from it.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS komga_ghost_chapters boolean NOT NULL DEFAULT false;

-- What the repositories offered and what was installed, as of the last check. This is what makes "new
-- upstream", "dropped upstream" and "installed outside Uchiyomi" answerable at all, and what lets a wiped
-- extension server get its extensions back rather than just its repository list.
-- Rows are never deleted: last_seen older than a run is how "no repository offers this any more" is spelled.
CREATE TABLE IF NOT EXISTS extension_catalog (
  pkg_name          text PRIMARY KEY,
  name              text NOT NULL,
  lang              text,
  repo              text,
  version_name      text,
  installed         boolean NOT NULL DEFAULT false,
  obsolete          boolean NOT NULL DEFAULT false,
  nsfw              boolean NOT NULL DEFAULT false,
  installed_version text,
  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_seen         timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- external progress trackers (AniList today; provider leaves room for MAL/Kitsu without a migration)
-- access_token is encrypted at rest: AniList issues scopeless tokens with near-full account access.
CREATE TABLE IF NOT EXISTS user_trackers (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  access_token text NOT NULL,
  account_name text,
  expires_at   timestamptz,
  enabled      boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
-- which external entry a library series maps to. Resolved once from the same AniList match used for art.
CREATE TABLE IF NOT EXISTS series_trackers (
  series_id   text NOT NULL,
  provider    text NOT NULL,
  external_id text NOT NULL,
  title       text,
  linked_by   uuid REFERENCES users(id) ON DELETE SET NULL,  -- null = matched automatically
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, provider)
);

-- Recommendations from the connected trackers (lib/trackerRecs.ts). Both tables exist to spare the services:
-- the person's list is read at most twice a day and what readers recommend after a title is asked once per
-- title for the whole server, for two weeks, however many people hold it.
CREATE TABLE IF NOT EXISTS tracker_list_cache (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  entries    jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS tracker_rec_cache (
  provider   text NOT NULL,
  seed_id    text NOT NULL,
  recs       jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, seed_id)
);

-- admin-editable per-series metadata + art overrides
-- cover/banner: 'upload' = a file under <CONFIG_DIR>/series-art; an http(s) URL = pasted; null = use automatic art
CREATE TABLE IF NOT EXISTS libraries (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  path       text NOT NULL DEFAULT '',
  sort_order int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Libraries are DECLARED, never inferred from the filesystem.
--
-- The obvious rule, "each top-level folder under the library root is a library", is wrong on a real install.
-- The top level holds SOURCE names written by the downloader (Aqua Manga (EN), Mangafreak (EN), ...), and
-- lib_series.source is literally that first path segment, so inferring would rename someone's single library
-- into three libraries named after its scrapers, on upgrade, with nobody asking for it.
--
-- So library zero covers the whole root, which is exactly what every existing install already is, and an
-- admin may then declare that a subdirectory is a library of its own. The id is the literal 'lib' that
-- ownedCatalog has always minted and stamped into every series DTO, so GET /api/libraries and every DTO
-- keep the bytes they return today.
CREATE UNIQUE INDEX IF NOT EXISTS uq_libraries_path ON libraries (path);
INSERT INTO libraries (id, name, path) VALUES ('lib', 'Library', '') ON CONFLICT (id) DO NOTHING;

ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS library_id text NOT NULL DEFAULT 'lib';

-- Strictly weaker than the constraint it replaces, so it cannot fail to apply on any existing install: with
-- every row at library_id='lib', (library_id, folder) is unique exactly when folder was.
--
-- Not load-bearing today. folder stays relative to the ROOT, so two libraries are disjoint subtrees of it
-- and Manga/Berserk and Comics/Berserk are already different strings. It becomes load-bearing the day a
-- library is a separate mount. lib_books went through this same widening for the same reason.
ALTER TABLE lib_series DROP CONSTRAINT IF EXISTS lib_series_folder_key;
CREATE UNIQUE INDEX IF NOT EXISTS lib_series_library_folder_idx ON lib_series (library_id, folder);

CREATE TABLE IF NOT EXISTS user_libraries (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id text NOT NULL,
  PRIMARY KEY (user_id, library_id)
);
-- Which libraries an account may see. NO ROWS MEANS EVERY LIBRARY, not none.
--
-- The alternative, seeding a row per user per library on migration, has a far worse failure mode: a seed
-- that half-runs locks people out of everything, whereas this one's failure mode is "sees exactly what they
-- saw yesterday". It is also why an empty list must never come from an "or empty array" fallback: an
-- empty list is a real admin choice meaning "nothing", and conflating the two turns a lookup failure into a
-- silent lockout.

CREATE TABLE IF NOT EXISTS book_overrides (
  book_id    text PRIMARY KEY REFERENCES lib_books(id) ON DELETE CASCADE,
  number     real,
  title      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Chapter number and title are DERIVED, not stored. Title is the filename minus its extension, and number
-- is read from the filename by the row's name_rule (lib/naming.ts numberByRule). Rule 1 is numFromName(),
-- which takes the FIRST number it finds. So "Vol 2 Ch 5.cbz" is chapter 2: it sorts between 1 and 3 in the
-- reader, and 2 is what gets reported to AniList. There is no filename parser that is right for every
-- collection, so the escape hatch is a manual, per-chapter override.
--
-- Deliberately manual. Re-parsing every filename with a smarter rule would silently renumber hundreds of
-- chapters at once, and a renumbered COMPLETED chapter changes what a tracker is told (see
-- tracker_progress above for why that direction is dangerous). Which is why the smarter rule that did come
-- (v0.55.2, rule 2, "Vol 2 Ch 5.cbz" is 5) reads only the files the scanner meets from then on: every row
-- keeps the rule it was first scanned with (lib_books.name_rule, in the v0.55.2 block below).
--
-- Keyed on book id, which is minted per (root, file), so deleting a file and re-adding it elsewhere loses
-- the override -- exactly as series_overrides loses a series' art. The FK is inline and VALID from birth
-- rather than NOT VALID like its neighbours, because a table created empty cannot have orphans.

CREATE TABLE IF NOT EXISTS tracker_progress (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id text NOT NULL,
  provider  text NOT NULL,
  chapters  int  NOT NULL,
  pushed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id, provider)
);
-- pushed_at NULL = a floor seeded from the tracker's own entry at import time (v0.36.0), nothing sent yet:
-- pushOne skips quietly below such a floor instead of recording a refusal.
ALTER TABLE tracker_progress ALTER COLUMN pushed_at DROP NOT NULL;
-- The high-water mark we have already told a tracker about, per user and series.
--
-- AniList accepts a LOWER progress and rewrites the entry, and there is no undo from here. So anything that
-- reduces MAX(number) FILTER (completed) silently rewinds someone's real account: merging two series,
-- renumbering a chapter, a bulk mark-unread. seriesProgressFor already refuses to go backwards *within* one
-- reading session, but nothing stopped the underlying number from dropping.
--
-- Progress therefore only ever moves forward unless a human explicitly asks for a resync. The FK is declared
-- inline and VALID from birth rather than NOT VALID like its neighbours, because a table created empty
-- cannot have orphans to quarantine.

CREATE TABLE IF NOT EXISTS series_overrides (
  series_id  text PRIMARY KEY,
  title      text,
  summary    text,
  cover      text,
  banner     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Author, status and genres are re-read from ComicInfo and overwritten on EVERY scan by persistScan's
-- ON CONFLICT (library_id, folder) DO UPDATE. There is nowhere in lib_series a manual edit survives, so the
-- override table is the only durable home for one. Title and summary already proved the pattern.
--
-- NULL means "no override, use what was scanned". For genres that is deliberately distinct from '{}',
-- which means "the admin cleared them on purpose" -- COALESCE gives us that distinction for free.
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS author text;
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS genres text[];

-- per-user token for OPDS clients (used as the HTTP Basic password); one token per user, regenerate overwrites
CREATE TABLE IF NOT EXISTS opds_tokens (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz
);
-- OPDS tokens used to be valid forever. They are the one credential that lives in a third-party reader's
-- settings on someone's phone, so a leak stayed useful until the owner happened to notice and regenerate.
-- Existing tokens get a year from NOW rather than from when they were issued, so upgrading does not sign
-- anyone's e-reader out on the spot.
-- A library can carry an age rating that its series inherit. Rating 210 series one at a time is not a thing
-- anyone does, so without this the age limits shipped alongside are impractical on a real library.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS age_rating int;
-- Per-library privacy boundary for implicit AniList enrichment (#168). Existing and rollback-created libraries keep
-- the historical behaviour; switching it off never clears art, tracker links, direction or type already learned.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS anilist_lookup boolean NOT NULL DEFAULT true;

-- Reading defaults for the whole library (mode, theme, spread, direction); null = none, the reader's own apply.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS reader_prefs jsonb;

-- Why a series is in the library it is in. The scanner already keeps an existing series where it is, so a
-- hand-move survives a rescan by accident; this records that it was DELIBERATE, so creating or re-pathing a
-- library never steals it back and the UI can say "pinned here" rather than "here because of the folder".
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS library_pinned boolean NOT NULL DEFAULT false;

-- Page bookmarks. Keyed like read_progress, and like it these outlive the file: deleting a series' chapter
-- files keeps every progress row on purpose, and a bookmark is the same kind of record -- a note about
-- having read something, not a pointer to bytes.
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    text NOT NULL,
  series_id  text NOT NULL,
  page       int  NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id, page)
);
CREATE INDEX IF NOT EXISTS bookmarks_series_idx ON bookmarks (user_id, series_id);

-- Age ratings, stored as a minimum age so a cap can be a comparison. NULL means unrated, which is a third
-- state and NOT the same as 0: an unrated series stays visible to everyone, because the alternative hides
-- most of an existing library the moment someone sets a cap.
ALTER TABLE lib_series       ADD COLUMN IF NOT EXISTS age_rating int;
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS age_rating int;
-- NULL means no cap, matching how user_libraries having no rows means "every library".
ALTER TABLE users            ADD COLUMN IF NOT EXISTS max_age_rating int;
CREATE INDEX IF NOT EXISTS lib_series_age_idx ON lib_series (age_rating) WHERE age_rating IS NOT NULL;

ALTER TABLE opds_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE opds_tokens SET expires_at = now() + interval '1 year' WHERE expires_at IS NULL;
-- Whether this reader may list 18+ libraries. Per credential, not per account: the phone in a pocket and the
-- e-reader on the shelf are different audiences for the same person. Off by default, because an OPDS
-- client cannot ask for the reveal the way the web app does. The age cap is a permission and is unaffected.
ALTER TABLE opds_tokens ADD COLUMN IF NOT EXISTS show_adult boolean NOT NULL DEFAULT false;

-- Suwayomi-provided sources (one per source in an installed Mihon/Tachiyomi extension) that the operator
-- has switched on. Suwayomi may expose hundreds of them; only the enabled ones are registered as Uchiyomi
-- sources, because cross-source search fans out to every registered source.
CREATE TABLE IF NOT EXISTS suwayomi_sources (
  source_id text PRIMARY KEY,
  name      text NOT NULL,
  lang      text,
  enabled   boolean NOT NULL DEFAULT true,
  added_at  timestamptz NOT NULL DEFAULT now()
);
-- Whether the extension declares itself adult. Suwayomi has always told us -- isNsfw is selected in
-- SOURCES_Q -- and it was thrown away three times over: no column, no field on the adapter, nothing in the
-- API. Without it there is no way to keep an age-capped account out of an adult source, and on a real
-- install that is not a corner case: 36 of 44 enabled sources on the one this was written for are adult.
ALTER TABLE suwayomi_sources ADD COLUMN IF NOT EXISTS nsfw boolean NOT NULL DEFAULT false;
-- Which installed extension (APK package) the source came out of, and that extension's own name. One
-- package can expose dozens of sources -- 3Hentai is one extension and twenty-nine language variants --
-- and the Providers page folds them into one card by pkg_name. NULL when the engine did not say; the API
-- then falls back to the display name with its language suffix stripped.
ALTER TABLE suwayomi_sources ADD COLUMN IF NOT EXISTS pkg_name text;
ALTER TABLE suwayomi_sources ADD COLUMN IF NOT EXISTS ext_name text;


-- OIDC identity linked to a local account. Kept alongside the password columns rather than replacing them,
-- so a person can have both and local login keeps working if the identity provider is down.
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_issuer text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_oidc ON users (oidc_issuer, oidc_sub)
  WHERE oidc_sub IS NOT NULL;

-- long-lived personal tokens for scripts and integrations. Unlike the OPDS token these reach /api/*,
-- so they carry explicit scopes: read is GET-only, write allows mutations, admin is required on top of an
-- admin account before a token may touch /api/admin/*. Only the hash is stored; the raw value is shown once.
CREATE TABLE IF NOT EXISTS api_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes     text[] NOT NULL DEFAULT '{read}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);
-- Whether the Komga-compatible API (/api/v1, /api/v2 -- Mihon's Komga extension) lists 18+ libraries to
-- this token. Mirrors opds_tokens.show_adult for the same reason: that client cannot press the web app's
-- reveal button, so the preference lives on the credential, off by default. The age cap is a permission and
-- is unaffected; a capped account never sees the shelf whatever this says.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS show_adult boolean NOT NULL DEFAULT false;

-- web-push subscriptions for new-chapter notifications (one row per browser/device endpoint)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  device_id  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint)
);

-- Perceptual hash per page, for finding the pages that are not the story: a scanlator credit page is the
-- same image in every chapter, so a hash that recurs across chapters of one series is furniture.
--   hash      null means "looked at it and could not read it" -- distinct from no row, which means
--             "not looked at yet". The job needs to tell those apart or it retries a broken page forever.
--   override  null = follow the heuristic, true = always skip, false = never skip. A person's decision
--             outranks the count in BOTH directions and is never recomputed away.
--   book_id   CASCADEs, unlike read_progress beside it, and the difference is the point: progress is
--             something a person earned and RESTRICT makes losing it impossible by accident, while a page
--             hash is derived data that is worthless without its chapter and can be recomputed at any time.
--             Without the cascade these rows outlive every deleted chapter, forever, in a table that has one
--             row per PAGE of the library.
CREATE TABLE IF NOT EXISTS page_hashes (
  book_id    text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
  page       int  NOT NULL,
  hash       text,
  override   boolean,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, page)
);
CREATE INDEX IF NOT EXISTS page_hashes_hash_idx ON page_hashes (hash);

-- Bulk import (backup / MangaDex list / pasted titles) → match review → add. Unlike importJob/artJob/
-- relinkJob (in-memory singletons in admin.ts), this survives a restart on purpose: matching is a
-- cross-source search pass that can run for minutes, and a human then has to look at every uncertain row,
-- which can take much longer than that. Losing either the resolve pass or the reviewer's picks to a
-- container restart or an accidentally-closed tab would mean redoing potentially hundreds of manual calls.
--   state  resolving = matching titles against sources, review = waiting on the admin, importing = adding
--          picked series, done = finished, cancelled = discarded before/without running.
CREATE TABLE IF NOT EXISTS import_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin      text NOT NULL, -- 'backup' | 'mangadex' | 'paste' | 'tracker'
  state       text NOT NULL DEFAULT 'resolving',
  total       int  NOT NULL DEFAULT 0,
  resolved    int  NOT NULL DEFAULT 0,
  added       int  NOT NULL DEFAULT 0,
  already     int  NOT NULL DEFAULT 0,
  failed      int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_batches_user_idx ON import_batches (user_id, created_at DESC);

-- One row per title in the batch.
--   decision        unresolved = still matching / no match found, auto = accepted the best cross-source
--                    match as-is, manual = the admin picked a specific source/series in the review sheet,
--                    skip = leave this one out (includes the "already in your library" default).
--   confidence       same_source = matched on the extension the backup entry itself came from (Mihon's
--                    source id resolved to an installed adapter), exact/contains/fuzzy = pickBestScored's
--                    title-only tiers, null = unresolved or skipped.
--   match_*          the CURRENT effective pick — what /run will add. Equals auto_* while decision='auto',
--                    the review sheet's choice while decision='manual', meaningless while 'unresolved'/'skip'.
--   auto_*           the resolve pass's own suggestion, frozen once written and never overwritten by a
--                    manual pick. Kept so "use the auto match" in the review sheet can restore it after a
--                    person has overridden it, without re-running the cross-source search.
--   status           set once /run has processed the row: 'added' | 'already' | 'not_found' | 'error' | a
--                    source's own failure message. Null until then.
CREATE TABLE IF NOT EXISTS import_candidates (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                  uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  ord                       int  NOT NULL,
  backup_title              text NOT NULL,
  -- Both renderings of Mihon's source id are kept (see BackupEntry in lib/tachibk.ts) so a resumed batch
  -- can redo the same signed/unsigned lookup against suwayomi_sources without re-parsing the original file.
  backup_source_id_unsigned text,
  backup_source_id_signed   text,
  backup_url                text,
  in_library                boolean NOT NULL DEFAULT false,
  decision                  text NOT NULL DEFAULT 'unresolved',
  confidence                text,
  match_source              text,
  match_source_id           text,
  match_title               text,
  match_cover               text,
  auto_source               text,
  auto_source_id            text,
  auto_title                text,
  auto_cover                text,
  auto_confidence           text,
  status                    text,
  UNIQUE (batch_id, ord)
);
-- The UNIQUE above already is a (batch_id, ord) btree; the PR that added the table also created this
-- second, identical index. DROP rather than delete the line: installs that booted on that build have the
-- index, and IF EXISTS keeps this idempotent for everyone else.
DROP INDEX IF EXISTS import_candidates_batch_idx;

-- Tracker intake (v0.36.0): a batch read from someone's AniList / MyAnimeList / Kitsu list. The batch keeps
-- which service ('anilist' | 'myanimelist' | 'kitsu', NULL for the other intakes), and each row keeps what
-- the list said about the entry, because both later steps need it without re-reading the list:
--   external_id  the id on that service -- what /run (and the intake itself, for a title the library
--                already holds) writes to series_trackers so progress sync works from the first chapter.
--   alt_titles   the other spellings (romaji, synonyms) the resolve pass searches when the English title
--                finds nothing; matched_via names the one that found the match, NULL when the search title
--                did, so the review row can say "matched under its other name".
--   progress     how far the person got on the tracker. Seeded into tracker_progress with every link:
--                without it the first chapter finished here pushes chapter 1 over an entry at chapter 150.
ALTER TABLE import_batches    ADD COLUMN IF NOT EXISTS tracker     text;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS tracker     text;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS alt_titles  text[] NOT NULL DEFAULT '{}';
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS matched_via text;
ALTER TABLE import_candidates ADD COLUMN IF NOT EXISTS progress    int;
-- What the intake had to say about the read, kept on the batch so the note survives the tab that started
-- it: the POST's answer was the only carrier of "12 novels skipped" / "only the first 500 kept", and a reload
-- or an Open-imports tap mid-batch showed a done line with no trace of either.
--   skipped_novels  light novels dropped from a tracker read (0 for the other intakes).
--   truncated       the intake kept 500 of a longer list (any origin), or a tracker read stopped at its cap.
ALTER TABLE import_batches    ADD COLUMN IF NOT EXISTS skipped_novels int     NOT NULL DEFAULT 0;
ALTER TABLE import_batches    ADD COLUMN IF NOT EXISTS truncated      boolean NOT NULL DEFAULT false;

-- Read marks on chapters this server does NOT hold (v0.43.0, issue 69): a series_listing number with no
-- lib_books row, ticked read from the series page or by a Mihon sync (lib/listingProgress.ts). A row IS the
-- assertion "this reader has read this number"; there is no completed column, because a chapter with no
-- pages cannot be half-read, and un-marking is a DELETE, the rule the library's bulk mark-unread follows.
--
-- WHY NOT read_progress. Its key is (user_id, book_id) and book_id is ON DELETE RESTRICT precisely so reading
-- history cannot be erased by a chapter row going away (the FK note below). A nullable book_id would mean
-- dropping that key for two partial unique indexes and weakening the one guarantee this project has no undo
-- for. AND NOT a fabricated lib_books row: the updater's have-set is a plain SELECT over lib_books, so a row
-- with no file is a chapter the sweep would never fetch -- the feature would silently stop the download it
-- sits beside. books_count, cover_book_id, Verify and the gap check read those rows the same way.
--
-- number is real to match series_listing.number and lib_books.number exactly; every comparison binds ::real,
-- or 12.1 arrives as 12.100000381469727 on one side only (the note on markReadUpTo in lib/komgaProgress.ts).
-- completed_at is WHEN THE PERSON MARKED IT, and persistScan carries it into read_progress.updated_at when the
-- chapter lands -- clamped to just before the file's mtime. Stamping now() there would make the read-chapter
-- cleanup delete a file minutes after fetching it (the which-copy-did-they-read rule in dueSql,
-- lib/chapterCleanup.ts), and the tombstone would make that permanent. source is 'web' or 'komga': whether a
-- person ticked it here or a paired phone's sync wrote it. ⚠️ Not a support field -- it is the difference
-- between an act and an echo. Mihon PUTs on every bind, and that PUT marks the ghosts under the run this
-- server just reported, so only a 'web' row says the READER did anything (lib/komgaProgress readProgressDetail).
--
-- The keys are declared here rather than in the NOT VALID list below: this table is new, so there are no
-- orphans to quarantine first. Deleting a series (Forget) or a user takes the marks with it; merging carries
-- them to the survivor first (lib/libraryAdmin.ts).
CREATE TABLE IF NOT EXISTS listing_progress (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id    text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  number       real NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'web',
  PRIMARY KEY (user_id, series_id, number)
);
CREATE INDEX IF NOT EXISTS idx_listing_progress_series ON listing_progress (series_id);

-- Where a notification goes besides a browser (v0.43.0, issue 70): a webhook, Home Assistant, ntfy, Discord.
-- Admin-only and admin-written, which is why lib/notify/guard.ts ALLOWS a private address here that
-- lib/ssrfGuard.ts refuses for the cover proxy -- a self-hosted Home Assistant lives on the LAN.
--
-- config holds nothing that could be used to post to the target: a masked display form, the Home Assistant
-- service name, whether a token is set. secret is secretbox-sealed under the NOTIFY key (not the tracker one)
-- and holds every address and every token, because for Discord and ntfy the address IS the credential and a
-- generic webhook often carries its secret in the path. It is text because a sealed value is a
-- self-describing text string (v1:iv:tag:ciphertext), the same as user_trackers.access_token.
--
-- user_id aims a target at one person: the digest then carries only that person's favourites. CASCADE, not
-- SET NULL -- a personal target whose person is deleted must not quietly become a server-wide one.
-- consecutive_failures switches a target off at 10 (lib/notify/index.ts), once, with one admin notice.
CREATE TABLE IF NOT EXISTS notify_targets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL,
  name                 text NOT NULL,
  config               jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret               text,
  user_id              uuid REFERENCES users(id) ON DELETE CASCADE,
  events               text[] NOT NULL DEFAULT ARRAY['new_chapters','health']::text[],
  template             text,
  enabled              boolean NOT NULL DEFAULT true,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_ok_at           timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- include_adult: name series from 18+ libraries in this target's digest. Off by default, the way an OPDS link's
-- and an API token's show_adult are: the web app's Show 18+ is a per-browser session cookie the server never
-- sees, so a target carries its own choice. A SURFACING choice only -- a target aimed at a person still never
-- names a series outside that person's libraries or above their age cap (lib/notify/index.ts sendDigest).
ALTER TABLE notify_targets ADD COLUMN IF NOT EXISTS include_adult boolean NOT NULL DEFAULT false;

-- Ledger for run-once DATA migrations. The DDL string above stays the home for everything idempotent
-- (CREATE / ALTER ... IF NOT EXISTS, which can safely run on every boot). Anything that would corrupt data
-- by running twice goes through runOnce() instead, which stamps this table IN THE SAME TRANSACTION as its
-- own work -- so "applied but not recorded" and "recorded but not applied" are both unrepresentable.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  ms         integer
);

-- ── Referential integrity ─────────────────────────────────────────────────────────────────────────────
-- Twelve tables have always held a series or book id as bare text with no foreign key, so nothing told you
-- when one of them forgot to clean up. It shows: series_art was 47% orphaned before this landed.
--
-- Added NOT VALID, which takes a brief lock and skips the scan; a runOnce step validates them afterwards,
-- once the existing orphans have been quarantined. Two tables deliberately get NO constraint, see below.
CREATE TABLE IF NOT EXISTS orphan_refs (
  id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at  timestamptz NOT NULL DEFAULT now(),
  tbl text  NOT NULL,
  col text  NOT NULL,
  row jsonb NOT NULL
);

DO $$
DECLARE
  spec text[];
  specs text[][] := ARRAY[
    ARRAY['favorites',        'series_id', 'lib_series', 'CASCADE'],
    ARRAY['collection_items', 'series_id', 'lib_series', 'CASCADE'],
    ARRAY['ratings',          'series_id', 'lib_series', 'CASCADE'],
    ARRAY['series_colors',    'series_id', 'lib_series', 'CASCADE'],
    ARRAY['series_art',       'series_id', 'lib_series', 'CASCADE'],
    ARRAY['series_seen',      'series_id', 'lib_series', 'CASCADE'],
    ARRAY['series_trackers',  'series_id', 'lib_series', 'CASCADE'],
    ARRAY['series_overrides', 'series_id', 'lib_series', 'CASCADE'],
    ARRAY['notes',            'series_id', 'lib_series', 'CASCADE'],
    ARRAY['read_progress',    'series_id', 'lib_series', 'CASCADE'],
    -- NOT cascade. Deleting a chapter row must never silently delete what someone read of it: that is the
    -- one loss this project has no way to undo, and it syncs outward to AniList before anyone notices.
    -- RESTRICT keeps the reference honest while making any future chapter cleanup fail loudly, so whoever
    -- writes it has to decide what happens to the history first.
    ARRAY['read_progress',    'book_id',   'lib_books',  'RESTRICT'],
    -- a note about a series outlives any one chapter of it
    ARRAY['notes',            'book_id',   'lib_books',  'SET NULL'],
    -- the cover pointer should blank rather than dangle
    ARRAY['lib_series',       'cover_book_id', 'lib_books', 'SET NULL'],
    ARRAY['lib_series',       'merged_into',   'lib_series', 'SET NULL'],
    -- RESTRICT, not CASCADE. read_progress.series_id cascades from lib_series, so a library delete that
    -- cascaded to its series would destroy reading progress two hops away, as a side effect of an admin
    -- tidying their shelves. Deleting a library reassigns its series first, deliberately.
    ARRAY['lib_series',       'library_id',    'libraries',  'RESTRICT']
  ];
  nm text;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    nm := 'fk_' || spec[1] || '_' || spec[2];
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = nm) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s NOT VALID',
        spec[1], nm, spec[2], spec[3], spec[4]);
    END IF;
  END LOOP;
END $$;
-- Deliberately NOT constrained: reading_events is an append-only record of things that actually happened and
-- feeds stats, streaks, Wrapped and the leaderboard -- cascading it would rewrite someone's history because a
-- file moved. offline_downloads describes bytes on a user's phone, which the server cannot reconcile anyway.

-- v0.46.0: what the 18+ switch hides, beyond libraries rated 18+.
--
-- Library ratings alone could not express "keep ecchi off the shelf": that meant moving series into an
-- 18+ library, which is a filing decision made to get a display outcome, and it fought the scanner every
-- time a folder was rescanned. These two lists say it directly -- genres to treat as adult, and sources
-- to treat as adult on top of whatever their extension declares -- and they change nothing about where a
-- series is filed or who may open it. Empty by default, so an existing install behaves exactly as before.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS adult_genres  jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS adult_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
-- "Hide everything tagged Mature, except this one." Without it the genre list is all-or-nothing, and one
-- wrongly-tagged classic is enough to make somebody turn the whole filter off.
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS adult_exempt boolean;

-- v0.46.0: a chapter's own name, as its source gave it (lib/library.ts chapterName). Its OWN column, never
-- lib_books.title: title is the filename's -- "One Piece v02 c012 [Digital]" on a library built by hand -- and
-- writing names into it showed filenames as names and dropped the number from everything printing it alone.
-- (No backticks in this string: it is a template literal.)
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS chapter_name text;

-- v0.47.0: which sources a series is preferred to come from, most preferred first (lib/sourcePrefs.ts), from
-- #93. Server-wide, and per series, where it replaces the server's rather than merging with it. It only
-- chooses among copies of a chapter not held yet; nothing already on disk is replaced because of it. An empty
-- order and a NULL series order both mean "the follow order", which is how every series chose until now.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS source_prefs jsonb NOT NULL DEFAULT '{"priority": []}'::jsonb;
ALTER TABLE lib_series      ADD COLUMN IF NOT EXISTS source_prefs jsonb;

-- v0.47.0: group upgrades, the nightly repair's sixth step (lib/repair.ts stepGroups, #81). OFF by default:
-- it replaces files on disk. picked_at marks a chapter somebody chose a copy for by hand, which an upgrade
-- never overrides; upgrade_tried_at spaces out a chapter whose upgrade failed.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS group_upgrade boolean NOT NULL DEFAULT false;
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS picked_at timestamptz;
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS upgrade_tried_at timestamptz;

-- v0.47.0: chapter names borrowed from another source (lib/borrowNames.ts, #85), the repair's seventh step. Off
-- by default for the server; a series' own switch is NULL to follow it. name_donor remembers the source whose
-- numbering matched, or when a search found none. chapter_name_source names the donor of a borrowed name --
-- NULL is the chapter's own -- so a borrowed name is always replaceable by an own one and removable in bulk.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS borrow_names boolean NOT NULL DEFAULT false;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS borrow_names boolean;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS name_donor jsonb;
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS chapter_name_source text;

-- v0.73.0: the details the server fills in for a series that has none of its own (lib/autoDetails.ts, #257 and #245
-- from @Squeaks72), the repair's ninth step. A layer of its own, BELOW the scan: a series shows its own description,
-- genres or author whenever its files or its source gave one (lib_series), an admin's edit beats both
-- (series_overrides), and this is read only where both are empty (lib/autoDetailsSql.ts). A scan never writes it and
-- an edit never does, so it never shadows better data, and switching fill_details off deletes it whole. *_from names
-- where each came from: 'anilist' or a source id. cover is the cover it put in series_art for a series with no chapters
-- yet, kept so switching off can take exactly that back. sources_at and anilist_at are when each was last asked, so a
-- series nobody can describe waits a month before it is asked again. Off by default; additive: v0.72.x ignores it all.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS fill_details boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS series_auto_details (
  series_id    text PRIMARY KEY REFERENCES lib_series(id) ON DELETE CASCADE,
  summary      text,
  summary_from text,
  genres       text[],
  genres_from  text,
  author       text,
  author_from  text,
  cover        text,
  cover_from   text,
  sources_at   timestamptz,
  anilist_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- v0.48.0: which way a series reads (lib/readingDirection.ts, #102). Until now every series answered WEBTOON,
-- so the reader's "Series default" direction could never turn a page right to left. reading_direction is one
-- of Komga's four values, NULL meaning nobody knows, which still reads as WEBTOON. reading_direction_from names
-- the evidence -- 'comicinfo', 'source' or 'anilist', most trusted first -- so a weaker signal never overwrites
-- a stronger one. The admin's choice is an override like the others, and beats all three.
ALTER TABLE lib_series       ADD COLUMN IF NOT EXISTS reading_direction text;
ALTER TABLE lib_series       ADD COLUMN IF NOT EXISTS reading_direction_from text;
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS reading_direction text;

-- v0.48.0: when a refresh token's holder presented it and got the next one (#108): proof that the device's
-- cookie jar received it. Null on the live token, on one that was lost in transit, and on one a recovery
-- superseded before its holder used it. planRefresh (lib/auth.ts) recovers a lost refresh answer only when no
-- later token in the session was ever used. Rows from before this column are all null, which makes them
-- ineligible to recover anything -- the old behaviour, so the upgrade needs no backfill.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;

-- v0.48.0: the last Health report, boiled down to what the header needs (lib/healthSummary.ts, #101). The
-- header must never run the ten checks -- they read what every series holds -- so it reads this instead,
-- written whenever the Health page runs and every six hours by the server itself.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS health_summary jsonb;

-- v0.48.3: Health findings an admin chose to ignore (lib/healthIgnore.ts). One row per finding: the check and
-- a key the check builds (series:ID, source:ID, folder:PATH, pair:ID+ID). members is everything the finding was
-- about when it was ignored -- the runs of missing chapters of a gap, the files of a folder -- and the finding
-- stays quiet only while what it is about now is part of that. seen_at is the last time the finding was still
-- there: a row not seen for a week is dropped, so a finding that went away and came back is a new one.
CREATE TABLE IF NOT EXISTS health_ignored (
  check_id text NOT NULL,
  item_key text NOT NULL,
  members  text[] NOT NULL DEFAULT '{}',
  title    text,
  by_user  uuid REFERENCES users(id) ON DELETE SET NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (check_id, item_key)
);

-- v0.49.0: finished downloads survive a restart (lib/activityLog.ts). One row per chapter that finished, written
-- after the fact and read once at boot for the last day, so Came in today and the failed-chapter half of Needs
-- attention are not empty the morning after an update. by_user is text with no reference: the sweep and the
-- repair start downloads with no account. origin includes archive. Pruned after seven days.
CREATE TABLE IF NOT EXISTS download_log (
  id          bigserial PRIMARY KEY,
  folder      text NOT NULL,
  title       text NOT NULL,
  number      real NOT NULL,
  source      text NOT NULL,
  origin      text NOT NULL,
  by_user     text,
  status      text NOT NULL,
  pages       int,
  reason      text,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS download_log_finished ON download_log (finished_at DESC);

-- v0.49.0: every library repair run, nightly or pressed on Health (lib/repairRuns.ts). The Tasks line and the
-- nightly schedule keep reading server_settings.repair_last_run, which only a full run writes now. only_steps,
-- not only: ONLY is reserved. The history is pruned in repairRuns.ts, never in repair.ts.
CREATE TABLE IF NOT EXISTS repair_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  origin      text NOT NULL,
  kind        text NOT NULL,
  only_steps  text[],
  target      jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_user     uuid REFERENCES users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'running',
  ms          int,
  step_ms     jsonb,
  result      jsonb,
  notes       jsonb
);
CREATE INDEX IF NOT EXISTS idx_repair_runs_started ON repair_runs (started_at DESC);
-- Why a short chapter was left as it is, and when. first_at is when a chapter first failed; readers use
-- COALESCE(first_at, at), so rows from before this column and rows a rollback writes need no backfill.
ALTER TABLE lib_books        ADD COLUMN IF NOT EXISTS short_result jsonb;
ALTER TABLE chapter_failures ADD COLUMN IF NOT EXISTS first_at timestamptz;

-- v0.49.0 (#115): what a deliberate live check found, per stage. Test and the daily check write only these;
-- they never touch status, consecutive, blocked_until, last_error or checked_at, so a diagnostic never
-- changes a cooldown and never moves the desktop watchdog schedule. stages holds search, chapters, pages and
-- images, each with okAt, failAt, error, kind and streak: only a success at the SAME stage closes a failure.
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_at     timestamptz;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_by     text;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_state  text;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_code   text;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_stage  text;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_detail text;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS live_checks jsonb;
ALTER TABLE source_health ADD COLUMN IF NOT EXISTS stages      jsonb NOT NULL DEFAULT '{}'::jsonb;

-- v0.49.0 (#116): series whose source numbers many posts the same are numbered by posting order. numbering is
-- NULL (automatic), source or posting_order; numbering_by is auto or manual, and a manual choice is never
-- flipped back. renumber_plan is the journal of a rename in flight, resumed on the next check.
-- source_chapter_id is the source chapter a landed file came from, so the next remap is exact.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS numbering            text;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS numbering_by         text;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS numbering_source     text;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS numbering_pending    text;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS numbering_note       jsonb;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS numbering_changed_at timestamptz;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS renumber_plan        jsonb;
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS source_chapter_id    text;
-- The stable posting-order assignment: a deleted post keeps its number as a hole (gone_at), an inserted one gets
-- a midpoint. Not unique on number: copies of one post from two groups share it. Pseudo-posts extra:BOOKID
-- reserve the slots of parked books.
CREATE TABLE IF NOT EXISTS series_post_numbers (
  series_id     text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  source_id     text NOT NULL,
  post_id       text NOT NULL,
  url           text,
  number        real NOT NULL,
  source_number real,
  title         text,
  published_at  timestamptz,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  gone_at       timestamptz,
  PRIMARY KEY (series_id, source_id, post_id)
);
CREATE INDEX IF NOT EXISTS series_post_numbers_num ON series_post_numbers (series_id, source_id, number);

-- v0.49.0 (#117): the slow archive. One row per series, never per chapter: what is missing is worked out on
-- each pick. The archive owns listed numbers strictly below boundary; chapter_floor is left alone and the sweep
-- reads GREATEST of the two while a row is queued or paused. A renumber (#116) remaps boundary and
-- floor_at_start. A stopped archive is a deleted row. boundary and floor_at_start are real, the type of the
-- listing numbers they are compared with: against numeric, Postgres compares a real as float8, so a floor of
-- 45.3 would count listed chapter 45.3 as strictly below itself and the archive and the sweep would both
-- claim it.
CREATE TABLE IF NOT EXISTS archive_queue (
  series_id      text PRIMARY KEY REFERENCES lib_series(id) ON DELETE CASCADE,
  state          text NOT NULL DEFAULT 'queued',
  boundary       real,
  floor_at_start real,
  direction      text NOT NULL DEFAULT 'up',
  added_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  last_at        timestamptz,
  done_count     int NOT NULL DEFAULT 0,
  failed_count   int NOT NULL DEFAULT 0,
  bytes          bigint NOT NULL DEFAULT 0,
  current_number real,
  note           jsonb
);
CREATE INDEX IF NOT EXISTS archive_queue_state ON archive_queue (state);
-- Per source: the next start, reserved before a chapter begins so neither a restart nor a crash loop shortens
-- a break, the refusal backoff, and the running average of real time per chapter for the estimate.
CREATE TABLE IF NOT EXISTS archive_pace (
  source_id     text PRIMARY KEY,
  next_at       timestamptz,
  backoff_level int NOT NULL DEFAULT 0,
  backoff_until timestamptz,
  cycle_ms      int,
  last_at       timestamptz,
  last_reason   text
);
-- The pacing an admin sets: paused, chapters per hour per source, the hours it may run in (both NULL means any
-- time of day) and the free space it keeps. The defaults are slow on purpose: the point is to look like a reader.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS archive_paused      boolean NOT NULL DEFAULT false;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS archive_per_hour    int     NOT NULL DEFAULT 4;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS archive_window_from int;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS archive_window_to   int;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS archive_min_free_gb int     NOT NULL DEFAULT 20;

-- (#72 needs no schema. Everything above is additive: v0.48.4 starts on it and ignores it. No DATA_MIGRATIONS
-- entry: existing series are renumbered lazily by their next check, and first_at is read through COALESCE.)

-- v0.49.1: the other names a series goes by (lib/altTitles.ts; the idea and the parsing are @TIGamingTV's, PR
-- #119). One row per name, keyed on its normalised form, so the same name spelt twice is one row. origin says
-- where it came from: description (read out of the series' main source's own description), admin (typed by
-- hand) or import (a tracker's synonyms, import_candidates.alt_titles, when the import added the series).
-- added_by is the admin's account id as text, with no reference: a name outlives the account that typed it.
-- removed_at marks a name an admin removed: the row stays as a tombstone, so reading the main source's
-- description again does not bring the name back. Every read and every search skips it.
CREATE TABLE IF NOT EXISTS series_alt_titles (
  series_id  text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  norm       text NOT NULL,
  title      text NOT NULL,
  origin     text NOT NULL CHECK (origin IN ('description', 'admin', 'import')),
  added_by   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (series_id, norm)
);
-- v0.49.1: Find other sources runs (lib/findSources.ts), newest 20 kept. scope is {seriesIds} or {sourceId,
-- seriesIds}: the series ids it resolved to, in its order, for either kind, so a run closed after a restart can
-- list the ones it never reached. results holds one entry per series settled, {seriesId, title, followed:
-- [{sourceId, name, chapters}], why?}.
-- status is running, done, stopped (an admin's stop), failed or interrupted (the server went away under it: a row
-- still running after a restart is closed so at boot). started_by is the admin's account id as text.
CREATE TABLE IF NOT EXISTS source_find_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_by  text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running',
  scope       jsonb NOT NULL DEFAULT '{}'::jsonb,
  total       int NOT NULL DEFAULT 0,
  done        int NOT NULL DEFAULT 0,
  followed    int NOT NULL DEFAULT 0,
  results     jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS source_find_runs_started ON source_find_runs (started_at DESC);
-- (Both tables are new and nothing older writes to them: v0.49.0 starts on this schema and ignores them.)

-- An install that ran the fork build of PR #119 before v0.49.1 has a series_alt_titles of another shape, which the
-- CREATE TABLE IF NOT EXISTS above leaves as it is: no removed_at, added_by a uuid referencing users, a source_id
-- column, and origins 'confirmed' and 'merged'. Every read of the other names filters on removed_at, so on such an
-- install each read failed, altTitlesFor answered nothing, the Sources sheet listed no other names and Find other
-- sources searched under the series' own title alone. Brought to v0.49.1's shape here, each step only when it is
-- needed, so a v0.49.1 table is untouched: the column added, the reference dropped and the id kept as text, the two
-- origins read as an admin's (a person confirmed both), the extra column dropped and the origin CHECK added.
ALTER TABLE series_alt_titles ADD COLUMN IF NOT EXISTS removed_at timestamptz;
DO $$
DECLARE c record;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'series_alt_titles'
                AND column_name = 'added_by' AND data_type = 'uuid') THEN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'series_alt_titles'::regclass AND contype = 'f'
                AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                     WHERE attrelid = 'series_alt_titles'::regclass AND attname = 'added_by')]::smallint[]
    LOOP
      EXECUTE format('ALTER TABLE series_alt_titles DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE series_alt_titles ALTER COLUMN added_by TYPE text USING added_by::text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'series_alt_titles' AND column_name = 'source_id') THEN
    ALTER TABLE series_alt_titles DROP COLUMN source_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'series_alt_titles'::regclass AND contype = 'c') THEN
    UPDATE series_alt_titles SET origin = 'admin' WHERE origin NOT IN ('description', 'admin', 'import');
    ALTER TABLE series_alt_titles ADD CONSTRAINT series_alt_titles_origin_check
      CHECK (origin IN ('description', 'admin', 'import'));
  END IF;
END $$;

-- v0.51.0: automatic hero banners, made from a series' own pages (lib/autoHero.ts). One row per series that has had
-- one made or tried. seed picks its chapters and pages (Shuffle sets a new one; 0 until then); made_at is when the
-- current one was made; failed_at and fail_reason are the last try that made none, which is not repeated for a week.
-- The images are image-cache entries (CACHE_DIR), keyed by series and seed. A new table and nothing else: v0.50.0
-- starts on this schema and never meets it.
CREATE TABLE IF NOT EXISTS series_hero (
  series_id   text PRIMARY KEY REFERENCES lib_series(id) ON DELETE CASCADE,
  seed        integer NOT NULL DEFAULT 0,
  made_at     timestamptz,
  failed_at   timestamptz,
  fail_reason text
);

-- v0.52.0: the language a series is in, and editions of one work (lib/lang.ts, lib/seriesLang.ts, lib/editions.ts).
-- lang: BCP-47, as lib/lang.ts canonLang writes it, stated at add time, by the v0.52.0 data migration (below, in
-- DATA_MIGRATIONS) or by an admin; NULL = not stated, inferred from the main source, else unstated_lang.
-- work_id: series that are language editions of one work share it; NULL = a series on its own.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS lang    text;
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS work_id uuid;
CREATE INDEX IF NOT EXISTS lib_series_work_idx ON lib_series (work_id) WHERE work_id IS NOT NULL;
-- One edition per language per work. A hidden edition keeps its slot, so Put back can never collide.
CREATE UNIQUE INDEX IF NOT EXISTS lib_series_work_lang_idx ON lib_series (work_id, lang) WHERE work_id IS NOT NULL;
-- MangaDex languages besides English, as app codes (the choices are lib/lang.ts MANGADEX_LANGS). Applied live.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS mangadex_langs jsonb NOT NULL DEFAULT '[]'::jsonb;
-- The language of sources and series that do not say. English, as lib/borrowNames.ts has assumed since v0.47.0.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS unstated_lang  text  NOT NULL DEFAULT 'en';
-- (Every column is nullable or has a default, and the unique index is partial on work_id, which v0.51.0 never
-- writes: v0.51.0 boots on this schema and keeps writing its rows.)
-- What a rollback leaves, put right at every boot (in steady state both match nothing). v0.52.0's merge takes the
-- row merged away out of its work (lib/libraryAdmin.ts mergeSeries); v0.51.0's, after a rollback, does not, so the
-- absorbed row kept its language's slot in the unique index above, and adding that language to the work again was
-- refused as "That language already has its edition" with no such edition in sight. Then a work left with one
-- edition, by that merge or by a v0.51.0 Forget, stands alone again, as lib/editions.ts dissolveLoneWork leaves it.
UPDATE lib_series SET work_id = NULL WHERE merged_into IS NOT NULL AND work_id IS NOT NULL;
UPDATE lib_series s SET work_id = NULL
 WHERE s.work_id IS NOT NULL
   AND (SELECT count(*) FROM lib_series w WHERE w.work_id = s.work_id AND w.merged_into IS NULL) <= 1;

-- v0.55.0: what the nightly runs (server.ts): 'repair', the safe repair, as every release before, or 'autofix', Health's
-- Fix everything (lib/autofix.ts). Its runs are repair_runs rows of kind 'autofix', so there is no table. One column with
-- a default: v0.54.x boots on this schema and never reads it, and going back runs its own nightly repair as it always did.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS nightly_mode text NOT NULL DEFAULT 'repair';

-- v0.55.1 (#148): a library holds one or more folders. One row per folder, and a folder belongs to one library at most;
-- a series belongs to the library holding the longest folder its own folder is in, across every library's folders
-- (lib/library.ts libraryIdFor). The default library 'lib' holds none: its empty path still means "everything no other
-- library holds". libraries.path stays, holding the library's FIRST folder, the one the admin listed first: v0.55.0
-- reads only that column, so after a rollback it boots on this schema, never meets the table, and still files new
-- folders by each library's first one.
CREATE TABLE IF NOT EXISTS library_paths (
  library_id text NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path       text PRIMARY KEY
);
CREATE INDEX IF NOT EXISTS library_paths_library_idx ON library_paths (library_id);
-- Seeded from libraries.path, and put right at every boot after a rollback (in steady state both match nothing).
-- A library whose first folder is not among its rows was re-pathed by v0.55.0, which knew only that one folder: its
-- rows are what it held before, and they go. Then every library holds its own first folder -- v0.55.0 created or
-- re-pathed it there, checking only libraries.path for a duplicate, and has filed that folder into it since -- taking
-- it from a library that held it as a further folder.
DELETE FROM library_paths lp USING libraries l
 WHERE l.id = lp.library_id AND l.path <> ''
   AND NOT EXISTS (SELECT 1 FROM library_paths x WHERE x.library_id = l.id AND x.path = l.path);
INSERT INTO library_paths (library_id, path)
SELECT id, path FROM libraries WHERE path <> '' AND id <> 'lib'
    ON CONFLICT (path) DO UPDATE SET library_id = EXCLUDED.library_id
 WHERE library_paths.library_id <> EXCLUDED.library_id;

-- v0.55.2 (#147): notice chapters (lib/noticeChapters.ts, lib/seriesType.ts). Sources post notices for readers as
-- a short chapter N.x after their latest chapter N; the admin may hide every chapter numbered with a fraction that
-- has 3 pages or fewer, per series type, and override that per series. series_type: manga, manhwa, manhua, webtoon or comic as learned (NULL =
-- unknown), with series_type_from naming the evidence (lib/seriesTypeSignals.ts SERIES_TYPE_FROM);
-- series_overrides.series_type is the admin's word. lib_series.hide_notices: the series' own switch, NULL = its
-- type's. server_settings.hide_notice_types: the types whose notice chapters are hidden, empty = off (the default).
-- All nullable or defaulted, so the previous release boots on this schema and simply shows every chapter.
ALTER TABLE lib_series       ADD COLUMN IF NOT EXISTS series_type      text;
ALTER TABLE lib_series       ADD COLUMN IF NOT EXISTS series_type_from text;
ALTER TABLE lib_series       ADD COLUMN IF NOT EXISTS hide_notices     boolean;
ALTER TABLE series_overrides ADD COLUMN IF NOT EXISTS series_type      text;
ALTER TABLE server_settings  ADD COLUMN IF NOT EXISTS hide_notice_types jsonb NOT NULL DEFAULT '[]'::jsonb;
-- The chapters whose file number has a fraction, by series: the few rows a notice can be among (lib/noticeChapters.ts
-- mayBeNotice, hiddenBookCount), so the hidden counts and the read-progress roll-ups do not visit every chapter of
-- the library while a switch is on (about 1,800 of 48,000 on the owner's). Partial and small; nothing else reads it.
CREATE INDEX IF NOT EXISTS lib_books_fraction_idx ON lib_books (series_id) WHERE number <> floor(number);

-- v0.55.2 (#150): chapter numbers from file names, for libraries collected by hand. name_rule is the rule that reads a
-- chapter's number out of its file name (lib/naming.ts numberByRule): 1, the first number in the name, as every chapter
-- was read until now; 2, chapterFromName (a chapter word, then an issue's #, never a year in brackets nor a volume's
-- number), for every file the scanner meets from this release on. A row keeps the rule it was born with, and every scan
-- reads its file by that rule (lib/library.ts persistScan): nothing already in a library is renumbered. The default
-- makes every existing row rule 1. v0.55.1 boots on this schema: it never names the column, so a file it adds is rule
-- 1, and its scan reads every file by the first number again -- rule-2 rows included -- until v0.55.2's next scan reads
-- those by rule 2 once more.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS name_rule smallint NOT NULL DEFAULT 1;
-- number_end: the last chapter of a file that holds several, "Batman 01-07 (1987).cbz" -- number 1, number_end 7 --
-- written by the scan for a rule-2 file, NULL for one chapter (lib/chapterRanges.ts says what each reader does with
-- one). Deliberately no CHECK that it is above number: a v0.55.1 scan after a rollback rewrites number by the first
-- number in the name and never meets this column, and a CHECK would make that UPDATE, and its folder, fail. A stored
-- end not above the number is read as no range instead, until v0.55.2's next scan writes both again.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS number_end real;

-- v0.55.2 (#147 beside #150): when a chapter row was first scanned. Updates counts what came since a reader last
-- looked in chapter rows and, while a notice switch is on, leaves out the hidden notices among the rows that came
-- (lib/enrich.ts newSinceSeen) -- which it can only tell apart by when they came. Taken by number, a file collected
-- late below the series' top (a 01-07 omnibus beside a hidden 44.5) was the notice, and swallowed. The scan's
-- ON CONFLICT never names the column, so a row keeps the time it first came; since v0.55.7 its INSERT names it, with
-- the time the scan began (lib/library.ts firstSeen: Rescan everything tells two scans apart by it). Rows
-- from before this release all carry the time of the upgrade and tie, ordered by number as before. v0.55.1 boots on
-- this schema: it never names the column, and its INSERTs take the default.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- v0.55.3 (#147, TIGamingTV): which chapters the notice switches hide (lib/noticeChapters.ts). true, the default, is
-- v0.55.2's rule: a chapter numbered with a fraction that has 3 pages or fewer, counted. false is the rule #147 was first
-- written with: every chapter numbered with a fraction, of the types and the series switched on. v0.55.2 boots on this
-- schema and never reads it: it hides by the page rule, which is what the default says.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS hide_notice_short_only boolean NOT NULL DEFAULT true;

-- v0.55.4 (discussion #150): Rescan everything (lib/rescan.ts), the Tasks panel's on-demand look for the chapters whose
-- files are gone from your own folders. Its last Apply and what it did, persisted like Verify chapter files' run above,
-- so the Tasks line still says it after a restart; the preview's plan lives in memory only. Both nullable: v0.55.3
-- boots on this schema and never names them.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS rescan_last_run    timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS rescan_last_result jsonb;

-- v0.55.7: ONE block, the release's pieces in order. All additive and nullable: v0.55.6 boots on this schema and
-- never names them.
--
-- (#168) An online match is stored only when it is named as the series is (lib/onlineMatch.ts). checked_at is
-- when an automatic AniList link (linked_by NULL) or a stored cover or banner was held to that check; NULL is never,
-- which the background recheck takes up (lib/matchCheck.ts): every row from before this release, a link an edition
-- copies from another, and whatever an older version writes after a rollback. Deliberately NO DEFAULT: ADD COLUMN would
-- write it into every existing row, and each would read as checked. The recheck's last run is persisted like Verify's,
-- for the Tasks line.
ALTER TABLE series_trackers ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE series_art      ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS match_check_last_run    timestamptz;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS match_check_last_result jsonb;
--
-- (#150) The file a scan last read a series' ComicInfo from -- its first chapter archive -- as JSON [how it was
-- read, path, mtime ms, size] (lib/library.ts infoReadOf). A scan opens that archive again only when the file is no
-- longer the one it read: on @Kedryn's Unraid every scan opened the first archive of every folder. NULL = read it at the
-- next scan. v0.55.6 never names it: its scans read every folder, as they always did.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS info_read text;

-- Deleted chapters shown as ghosts (lib/deletedGhosts.ts): with it on, a chapter whose file was deleted on purpose -- a
-- tombstone whose pruned_reason is not 'missing' -- is drawn on the series page as a ghost row and listed to Mihon as
-- "not downloaded", instead of as a deleted chapter. Display only: the updater, the counts and progress read the
-- tombstone as before. Off by default; an older build boots on this schema and never names it.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS deleted_as_ghosts boolean NOT NULL DEFAULT false;

-- v0.55.8: Delete downloaded chapters for a selection is a detached admin job. Keeping the selection, progress and
-- result in Postgres means closing the browser or crossing a proxy timeout cannot turn a destructive operation into an
-- unknown retry. worker_id distinguishes this process from a row a previous process left running; the admin plugin
-- closes those rows as interrupted at boot. There may be only one active run, matching the one shared folder-writer
-- lock used by downloads, repairs, rescans and renumbering.
CREATE TABLE IF NOT EXISTS admin_bulk_delete_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        uuid NOT NULL,
  started_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  heartbeat_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'done', 'cancelled', 'failed', 'interrupted')),
  cancel_requested boolean NOT NULL DEFAULT false,
  pause            boolean NOT NULL DEFAULT true,
  series_ids       text[] NOT NULL,
  total            int NOT NULL,
  done             int NOT NULL DEFAULT 0,
  summary          jsonb NOT NULL DEFAULT '{"applied":0,"chapters":0,"bytes":0,"kept":0,"paused":0,"skipped":0,"failed":0,"chapterSkips":{}}'::jsonb,
  results          jsonb NOT NULL DEFAULT '[]'::jsonb,
  current          jsonb,
  error            text
);
-- A v0.55.8 prerelease may already have created the run table without chapter-level crash state.
ALTER TABLE admin_bulk_delete_runs ADD COLUMN IF NOT EXISTS current jsonb;
-- Intent is committed before unlink. A new process can therefore distinguish "never reached this chapter" from
-- "may have unlinked it", inspect the exact owned path, and finish the tombstone before closing the run. Applied and
-- skipped rows remain with the run as its destructive-operation journal and disappear with the bounded run history.
CREATE TABLE IF NOT EXISTS admin_bulk_delete_items (
  run_id       uuid NOT NULL REFERENCES admin_bulk_delete_runs(id) ON DELETE CASCADE,
  series_id    text NOT NULL,
  book_id      text NOT NULL,
  root         text NOT NULL,
  file         text NOT NULL,
  position     int NOT NULL,
  state        text NOT NULL CHECK (state IN ('intent', 'applied', 'skipped', 'unresolved')),
  bytes        bigint NOT NULL DEFAULT 0,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_bulk_delete_items_state
  ON admin_bulk_delete_items (run_id, state, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_bulk_delete_one_running
  ON admin_bulk_delete_runs ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_admin_bulk_delete_started ON admin_bulk_delete_runs (started_at DESC);

-- v0.56.0: Discover shows one card per work and leaves out what the library holds (lib/discoverIdentity.ts). title_works
-- is which work a NAME is, keyed by its nameKey (lib/onlineMatch.ts): asked of AniList, MangaDex and MangaUpdates once,
-- in the background, and kept with every other name the answer gave. work is NULL when every service was asked and
-- none knew the name (asked again after 30 days). server_settings.discover_lookups is Admin -> Settings "Match Discover
-- titles online": off, nothing is sent anywhere. The two indexes find a library series by the source series a Discover
-- item is. All additive: v0.55.11 boots on this schema and ignores it.
CREATE TABLE IF NOT EXISTS title_works (
  key        text PRIMARY KEY,
  work       text,
  via        text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS discover_lookups boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS lib_series_source_pair_idx ON lib_series (source_id, source_series_id);
CREATE INDEX IF NOT EXISTS series_sources_source_pair_idx ON series_sources (source_id, source_series_id);

-- v0.57.0: a merge keeps one copy of a chapter both series had (lib/extraCopies.ts). The other copy's row goes; its file
-- is deleted when it is in the download folder, and anywhere else -- a library folder the server may not write to --
-- stays on disk, named here so the scan does not index it again (lib/setAside.ts). mtime and size are the file's when
-- it was set aside: a different file at that path is indexed as usual. kept_book_id is the copy that stayed. Additive:
-- v0.56.0 boots on this schema and ignores it (its scan would list those files again).
CREATE TABLE IF NOT EXISTS set_aside_files (
  root         text NOT NULL,
  file         text NOT NULL,
  series_id    text,
  number       real,
  kept_book_id text,
  reason       text NOT NULL,
  mtime        bigint,
  size         bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root, file)
);

-- v0.58.0: a series' outside rating (lib/anilistScores.ts): AniList's score out of 100 and how many people list the
-- entry, keyed by the AniList id a series is linked to (series_trackers), so a series relinked to another entry reads
-- that entry's row and nothing has to be invalidated. Both NULL for an entry AniList no longer answers for (asked
-- again on the next refresh round). The Library's Most popular / Top rated sorts and Home's Most popular rail read it.
-- Additive: v0.57.0 boots on this schema and ignores it.
CREATE TABLE IF NOT EXISTS anilist_scores (
  anilist_id  text PRIMARY KEY,
  score       smallint,
  popularity  integer,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- v0.61.0: what AniList relates an entry to (lib/anilistRelated.ts): its sequels, prequels, main story, side stories,
-- spin-offs and alternative versions (relations), and the entries its readers recommend (recs), keyed like
-- anilist_scores by the AniList id a series is linked to. Each item keeps AniList's own adult flag and genres: the 18+
-- rules are applied per viewer when it is read, never to this shared copy. Both empty for an entry AniList did not answer
-- for (asked again once the row is stale). The series page's Related, the reader's Next in the story, Discover's Because
-- you read and the held recommendations of More like this read it; nothing asks AniList when a page opens. Additive:
-- v0.60.1 boots on this schema and ignores it.
CREATE TABLE IF NOT EXISTS anilist_related (
  anilist_id  text PRIMARY KEY,
  relations   jsonb NOT NULL DEFAULT '[]'::jsonb,
  recs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- v0.61.0: the release radar (lib/releaseRadar.ts) -- when a series' next chapter is likely, from when its chapters
-- came: the dates its sources list, else when they arrived on this server (most chapters carry no source date).
-- One row per series, rewritten whole after every listing refresh and after a check lands chapters; no row while
-- nothing dates the series or it has no source. basis is 'source' or 'arrival' (NULL: one release, no rhythm); kind
-- and interval_days are the cadence (lib/groupStats.ts cadenceOf); next_at and due_until bound the estimate, NULL when
-- the rhythm is too uneven, too short, or the series ended or is on hiatus; quiet_after is when silence stops being
-- "late"; steady means it keeps one weekday; ended its status says it is finished. Read by every series' yomi.radar,
-- the Library's Releasing soon sort, Updates' Expected this week and the smart update checks. server_settings.
-- update_smart is Admin -> Settings "Smart update checks": off by default, the sweep asks every series as before.
-- Additive: v0.60.1 boots on this schema and ignores both.
CREATE TABLE IF NOT EXISTS series_radar (
  series_id     text PRIMARY KEY REFERENCES lib_series(id) ON DELETE CASCADE,
  basis         text,
  kind          text NOT NULL DEFAULT 'unknown',
  interval_days real,
  last_at       timestamptz,
  next_at       timestamptz,
  due_until     timestamptz,
  quiet_after   timestamptz,
  steady        boolean NOT NULL DEFAULT false,
  ended         boolean NOT NULL DEFAULT false,
  computed_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS update_smart boolean NOT NULL DEFAULT false;

-- v0.61.0: smart and shared Lists (lib/lists.ts, lib/smartLists.ts). query is a smart list's Library filters and order, in
-- the Library's own URL words ({v:1, q, read, status, genres, lib, src, anysrc, sort, dir}); NULL is a list picked by
-- hand, and a list's kind is fixed when it is made. shared lets the household read a list (never change it); it is only
-- listed to a member it shows at least one series to. Additive: v0.60.1 boots on this schema and shows a smart list as
-- an empty list, and a shared one to its owner only.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS query jsonb;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS collections_shared_idx ON collections (shared) WHERE shared;

-- v0.61.1 (#199): the nightly backup in Admin -> Settings -> Updates & schedules (lib/backup.ts backupSettings).
-- backup_enabled false skips the nightly run (Run now still backs up); backup_keep is how many runs to keep, NULL meaning
-- BACKUP_KEEP (14 unless set), so an install that set the variable keeps its number until one is saved there.
-- Additive: v0.61.0 boots on this schema and ignores both.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS backup_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS backup_keep int;

-- v0.62.0: the language a chapter's file is in when that is not its source's (lib/copyLanguage.ts bookLang): set once,
-- below, for the chapters MangaDex's English source took in another language before it stopped falling back, and
-- cleared when the file is replaced (lib/library.ts setBookMeta, lib/partial.ts restampBook). NULL: its source's. The
-- wrong-language notice reads it (routes/catalog.ts, GET /api/series/:id/versions). Additive: v0.61.x ignores it.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS lang text;

-- New-member defaults (#208, item 6; Admin -> Members): what an account the server makes by itself starts with -- a
-- sign-up, or a first sign-in through the OIDC provider with OIDC_ALLOW_SIGNUP (lib/memberDefaults.ts). Kept the way the
-- account keeps them: new_member_libraries NULL for every library (no user_libraries rows), else exactly these library
-- ids, none when empty; new_member_max_age_rating NULL for no limit, as users.max_age_rating; new_member_perms as
-- users.perms, where {} allows downloads. All three unset by default, so a server that never sets them makes accounts
-- exactly as before. Additive: v0.63.0 boots on this schema and ignores them.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS new_member_libraries      text[];
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS new_member_max_age_rating int;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS new_member_perms          jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The chapter numbers an admin hid from a series (#240, rebuilt to hide only): for everyone, by the effective number (an
-- override's when there is one). The hide fragments in lib/noticeChapters.ts leave them out of every surface, the sweep
-- never fetches one, and nothing is deleted: a hidden chapter's file and rows stay exactly as they are, and Restore shows
-- it again at once. On the series row, as the notice switch is (hide_notices). NULL when nothing is hidden -- never an
-- empty array (lib/hiddenChapters.ts) -- so the column's own statistics tell the planner how few series hide anything,
-- and the partial index finds those few: priced as every series, the hidden-chapter lookup inside Continue reading's
-- per-series picks crossed jit_inline_above_cost and spent seconds compiling a query that runs in milliseconds.
-- Additive: v0.71.0 boots on this schema and shows every chapter.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS hidden_numbers real[];
CREATE INDEX IF NOT EXISTS lib_series_hiding_idx ON lib_series (id) WHERE hidden_numbers IS NOT NULL;

-- v0.77.0 (#229): spread joining's answer for a chapter file (lib/spreadMeasure.ts SpreadAnswer): which of its pages are
-- one double-page spread a source served as two files, with the detector's version and the file's mtime and page count
-- when it was measured. NULL until a reader who turned Join split double pages on opens the chapter. Written for every
-- chapter looked at, nothing found and unreadable alike, so none is measured twice; a new mtime or detector measures
-- again. Additive: v0.76.x ignores it.
ALTER TABLE lib_books ADD COLUMN IF NOT EXISTS spreads jsonb;

-- Admin -> Settings "Finish downloads on their own" (lib/finishDownloads.ts). ON by default: a series whose source
-- lists chapters it does not have yet is gone back to every quarter of an hour, and again the moment a site's
-- cooldown ends, instead of five chapters every six hours; a site's "slow down" (429) or block (403) is a later, not
-- a never, so it does not use up a chapter's three tries; and an add whose first chapter a site refused keeps the
-- series, so it can be finished. Off, all of it behaves as v0.77.x did. Additive: v0.77.x ignores it.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS finish_downloads boolean NOT NULL DEFAULT true;
-- What the finishing sweep goes back for (lib/finishDownloads.ts BEHIND_SQL): the chapters a series is behind on that
-- the sweep still tries -- not one left alone at its retry cap, nor one held for its preferred group. source_missing
-- counts those too ("{n} behind" must), and a series behind only on them was visited every quarter of an hour by a
-- sweep that could fetch nothing of it. NULL until the next visit, read as source_missing. Additive: v0.77.x ignores it.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS finish_missing integer;
-- v0.79.0: when a series whose remaining chapters only a source that did not answer lists is worth going back to: that
-- source's cooldown end, or a quarter of an hour on (lib/updater.ts staleUntil). NULL when it is not waiting on one.
-- Additive: v0.78.x ignores it.
ALTER TABLE lib_series ADD COLUMN IF NOT EXISTS finish_after timestamptz;

-- v0.80.0, the scout (lib/sourceScout.ts): a series whose sources cannot get it its chapters -- every one cooling,
-- refusing or broken for the numbers it lacks -- is looked for on the other installed sources, and a source that is
-- this series and lists what it lacks is followed on its own. series_scout is the series' request: why, which numbers,
-- which sources to try first, and when it may be looked at again (the backoff). Written by a cheap upsert wherever a
-- series gets stuck (lib/scoutRequests.ts); the worker decides what, if anything, to search. Additive: v0.79.x ignores
-- it.
CREATE TABLE IF NOT EXISTS series_scout (
  series_id  text PRIMARY KEY REFERENCES lib_series(id) ON DELETE CASCADE,
  reason     text NOT NULL,
  numbers    real[] NOT NULL DEFAULT '{}',
  seeds      text[] NOT NULL DEFAULT '{}',
  priority   int NOT NULL DEFAULT 0,
  asked_at   timestamptz NOT NULL DEFAULT now(),
  next_at    timestamptz NOT NULL DEFAULT now(),
  last_at    timestamptz,
  fruitless  int NOT NULL DEFAULT 0,
  verdict    text,
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS idx_series_scout_next ON series_scout (next_at);
-- What each source said when the server looked for a series on it (lib/scoutMemory.ts): one row per series and
-- source, kept for a while so a source that said no is not asked again every day. 'removed': an admin unfollowed it,
-- and nothing automatic follows it again for that series. Additive: v0.79.x ignores it.
CREATE TABLE IF NOT EXISTS scout_verdicts (
  series_id        text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  source_id        text NOT NULL,
  verdict          text NOT NULL,
  their_title      text,
  source_series_id text,
  coverage         real,
  our_count        int,
  at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, source_id)
);

-- Backup extensions (v0.82.0, lib/backupExtensions.ts): the extensions Uchiyomi installed by itself to finish downloads
-- -- Fix everything's, and the scout's. Hidden from Discover, removed after three days without use, put back when a
-- series is stuck again. state: trial (installed, being checked), active, parked (removed by Uchiyomi, may come back),
-- refused (a person removed it: Uchiyomi never installs it again). via: autofix or scout. A package with no row is the
-- admin's own. Additive: v0.81.x ignores it.
CREATE TABLE IF NOT EXISTS backup_extensions (
  pkg_name       text PRIMARY KEY,
  name           text,
  lang           text,
  state          text NOT NULL,
  via            text,
  installed_at   timestamptz,
  last_needed_at timestamptz NOT NULL DEFAULT now(),
  parked_at      timestamptz,
  why            text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- The follows a removed backup took with it: the series, its id there and its title there, so a series stuck again
-- gets it back with one reinstall and one look instead of a search through every extension.
CREATE TABLE IF NOT EXISTS backup_links (
  series_id        text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  source_id        text NOT NULL,
  pkg_name         text NOT NULL REFERENCES backup_extensions(pkg_name) ON DELETE CASCADE,
  source_series_id text,
  their_title      text,
  parked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_backup_links_pkg ON backup_links (pkg_name);
-- Since when the series has been waiting for the scout, kept across its requests: a backup is reinstalled only for a
-- series stuck an hour or more, never for a cooldown of a few minutes.
ALTER TABLE series_scout ADD COLUMN IF NOT EXISTS stuck_since timestamptz;
-- v0.83.0: what a repository extension the scout tried did not have (lib/backupExtensions.ts recordMiss): a series it
-- was searched for in vain, or (series_id NULL) a language it has no source in. Not tried again for it for 30 days.
CREATE TABLE IF NOT EXISTS backup_misses (
  pkg_name  text NOT NULL,
  series_id text REFERENCES lib_series(id) ON DELETE CASCADE,
  lang      text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_backup_misses ON backup_misses (pkg_name, COALESCE(series_id, ''), COALESCE(lang, ''));
-- Translated pages (v0.85.0, lib/translate/): off until an admin downloads the engine and turns this on.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS translate_pages boolean NOT NULL DEFAULT false;
-- One page in one language: the bubbles the engine read and what it wrote in each (regions), never the picture -- that
-- is drawn from the regions when asked for. engine: the model size and pipeline version it was made with, so a new
-- engine translates afresh rather than serve an old one's work. status: done, or failed (error says why).
CREATE TABLE IF NOT EXISTS page_translations (
  book_id    text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
  page       int NOT NULL,
  lang       text NOT NULL,
  engine     text NOT NULL,
  status     text NOT NULL,
  regions    jsonb,
  error      text,
  ms         int,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, page, lang, engine)
);
-- The spelling each name was first given in a series and language: the next pages are told to keep it.
CREATE TABLE IF NOT EXISTS translate_names (
  series_id text NOT NULL REFERENCES lib_series(id) ON DELETE CASCADE,
  lang      text NOT NULL,
  source    text NOT NULL,
  target    text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, lang, source)
);

-- v0.87.0: what the household says about a chapter (lib/comments.ts). Keyed on the chapter row, which keeps its id when
-- its file moves, its series merges or a rescan follows a renamed file; the few places that delete a chapter row carry
-- these first (extraCopies.ts removeCopy, rescan.ts HOLDS) or count them as gone (libraryAdmin.ts Forget). A member's
-- words go with their account. page: the page the comment was written on, when it was written in the reader.
-- Additive: v0.86.x ignores both tables.
CREATE TABLE IF NOT EXISTS chapter_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id    text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL,
  page       integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_chapter_comments_book ON chapter_comments (book_id, created_at);
-- One reaction a member a chapter: tapping another emoji changes it.
CREATE TABLE IF NOT EXISTS chapter_reactions (
  book_id    text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, user_id)
);

-- v0.89.0 (#305): how many other sources a series may follow, the admin's choice (lib/followLimit.ts), 1 to 10. NULL until
-- one is picked, and then MAX_FOLLOWED_SOURCES (or three) is the limit, as it was. Additive: v0.88.x reads the env alone.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS max_followed_sources int;

-- v0.89.0 (#262): a reader's own say on where a double-page spread is (lib/spreadMarks.ts). join shows the pair (page,
-- page + 1) as one spread where the detector found none; split shows a pair it joined as two pages. One account's, for
-- its own reader only, and never in lib_books.spreads, so a re-measure cannot erase it. pages: the chapter's page count
-- when it was made -- a mark on another file of the chapter points at other pages, and is not applied. Goes with its
-- chapter row and its account. Additive: v0.88.x ignores the table.
CREATE TABLE IF NOT EXISTS spread_marks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
  page       int  NOT NULL CHECK (page >= 1),
  mark       text NOT NULL CHECK (mark IN ('join', 'split')),
  pages      int  NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id, page)
);
CREATE INDEX IF NOT EXISTS idx_spread_marks_book ON spread_marks (book_id);

-- v0.91.0 (#314): when an admin last left an extension source's site after Open site (lib/sources/suwayomi/siteSessions.ts).
-- A source whose site wanted that -- a sign-in, a check the engine's background browser cannot pass -- gets a quiet visit
-- of its home page whenever it fails, at most once in half an hour: BatCave's guard pass lasts a day, and it fails with a
-- plain 404 when it runs out. NULL for every other source. Additive: v0.90.x ignores the column.
ALTER TABLE suwayomi_sources ADD COLUMN IF NOT EXISTS site_opened_at timestamptz;

-- v0.98.0: Discover's trending titles (lib/trending.ts), one row per country of origin (KR, JP, CN): what AniList last
-- answered, kept so a restart or a deploy answers the hero and the trending rows from this copy at once instead of
-- waiting on AniList -- or, with AniList busy, showing no hero at all. Rewritten whole by a pull at most every six hours;
-- shared by every viewer, and filtered per viewer when it is read, never here. Additive: v0.97.x ignores the table.
CREATE TABLE IF NOT EXISTS anilist_trending (
  country     text PRIMARY KEY,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- Profiles that open without a password, from the local network only. These
-- columns come first and nothing writes them yet. password_login: /auth/login accepts the row (false for a profile
-- with no password). local_open: it opens without a password from the local network. managed_by: the account that
-- manages it; deleting that account leaves the profile to the admin rather than deleting its reading too. Every row
-- an older release wrote reads as it did (true, false, NULL), and a rollback has none of them to write.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_login boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS local_open     boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_by     uuid REFERENCES users(id) ON DELETE SET NULL;
-- A profile anyone at home can open never runs the server. The desktop app's own account is the exception it already
-- is (lib/desktopUser.ts): its window is the only way in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_local_open_not_admin') THEN
    ALTER TABLE users ADD CONSTRAINT users_local_open_not_admin
      CHECK (NOT local_open OR role <> 'admin' OR auth_kind = 'desktop');
  END IF;
END $$;
-- A session's name through its rotations (session_id; NULL on a row from before it, which is then its own id), the
-- session it was opened from (parent_session: ending that one ends this one, lib/auth.ts revokeDerived), and how it
-- was entered (via). lib/auth.ts supersede carries all three to the next token.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id     uuid;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS parent_session uuid;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS via            text;
CREATE INDEX IF NOT EXISTS idx_rt_parent  ON refresh_tokens (parent_session) WHERE parent_session IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rt_session ON refresh_tokens (session_id) WHERE session_id IS NOT NULL;

-- The accounts a device remembers (lib/deviceRing.ts): a sign-in that ticked Remember on this device, by device -- the
-- hash of its yomi_dev cookie, never the cookie -- and the session it can take up again. No key to refresh_tokens:
-- sessions are revoked, not deleted, and an entry opens only while its session is live; the daily prune drops the rest.
-- Additive: an older release never reads it.
CREATE TABLE IF NOT EXISTS device_ring (
  device_hash text        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid        NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz,
  PRIMARY KEY (device_hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_device_ring_user ON device_ring (user_id);
-- The sign-in screen's "who is reading?" at home (routes/auth.ts /auth/pick): off unless an admin turns it on.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS local_pick boolean NOT NULL DEFAULT false;
-- The home network and the trusted proxies as Admin -> Settings -> Server -> Home network sets them (lib/clientAddr.ts):
-- NULL is the default (the private networks; loopback, link-local and private proxies). LOCAL_NETWORKS and TRUST_PROXY
-- in the environment outrank both. Additive: an older release never reads them.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS local_networks  text;
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS trusted_proxies text;
`;

// Serialises migrate() across processes. CREATE TABLE IF NOT EXISTS is not safe to run concurrently:
// two connections racing on the same new type or table collide inside pg_type's unique index rather than
// one of them quietly no-opping. Anything that can start two BFFs at once -- a second replica, a restart
// overlapping a slow boot, or a test suite running files in parallel -- hits it.
const MIGRATE_LOCK = 8_263_195; // arbitrary, just has to be stable across processes

/**
 * Run a data migration exactly once, ever.
 *
 * Must be called with MIGRATE_LOCK held, so two booting processes cannot both decide the work is pending.
 * The stamp is written inside the same transaction as the work: if `fn` throws, the rollback takes the stamp
 * with it and the step is retried on the next boot, and there is no state where the ledger disagrees with
 * the database.
 *
 * These hold a transaction open during boot, so the rule is: **pure SQL, bounded, and fast even on a large
 * library.** Anything that touches the filesystem -- reading forty thousand archives, say -- belongs in a
 * background job with its own progress, never here, or boot time grows with the size of someone's library.
 */
export async function runOnce(
  client: PoolClient,
  id: string,
  fn: (c: PoolClient) => Promise<void>,
): Promise<boolean> {
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [id]);
  if (done.rowCount) return false;
  const t0 = Date.now();
  await client.query('BEGIN');
  try {
    await fn(client);
    await client.query('INSERT INTO schema_migrations (id, ms) VALUES ($1, $2)', [id, Date.now() - t0]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/**
 * The chapter-date repair's id, apart because migrate.int.test.ts runs it again by name. Version-free on purpose: ids
 * are permanent, and this one was written before its release had a number.
 */
export const CHAPTER_DATES_MIGRATION = 'suwayomi-chapter-dates-in-seconds';

/** The backup extensions' one-time seed, apart because backupExtensions.int.test.ts runs it again by name. */
export const BACKUP_SEED_MIGRATION = 'v0.82.0-backup-extensions';

/**
 * v0.82.0: the extensions Fix everything installed before backups existed become backups, by the audit log -- the one
 * record of who installed what. Per package, its newest install, uninstall or "turn on its sources":
 *   - a Fix everything install, still installed, and none of its sources since followed, attached or made a series'
 *     main by a person: a backup (`active`), needed as of now -- three days' grace before anything is removed;
 *   - otherwise, when a person's newest act on it was to remove it and it is not installed: `refused`, never installed
 *     by Uchiyomi again.
 * A person's follow is one with neither `auto` nor a Find run's own pick (`find_sources`, `replace`): the follow route,
 * a Find review, an attach, a Make main. Anything else -- an extension a person installed, or turned on, or chose for
 * a series -- stays theirs, as it was.
 */
async function seedBackupExtensions(c: PoolClient): Promise<void> {
  await c.query(`
    WITH last AS (
      SELECT DISTINCT ON (detail->>'pkgName') detail->>'pkgName' AS pkg, event, detail->>'via' AS via, at
        FROM audit_log
       WHERE event IN ('extension.install', 'extension.uninstall', 'extension.enable') AND detail->>'pkgName' IS NOT NULL
       ORDER BY detail->>'pkgName', at DESC, id DESC),
    srcs AS (
      SELECT pkg_name, array_agg('sw:' || source_id) AS ids, max(ext_name) AS name,
             min(lang) FILTER (WHERE enabled) AS lang
        FROM suwayomi_sources WHERE pkg_name IS NOT NULL GROUP BY pkg_name),
    chosen AS (
      SELECT DISTINCT s.pkg_name FROM srcs s JOIN last l ON l.pkg = s.pkg_name JOIN audit_log a ON a.at > l.at
       WHERE (a.event = 'series.follow_source' AND a.detail->>'auto' IS NULL
               AND (a.detail->>'via' IS NULL OR a.detail->>'via' IN ('find_review', 'replace_review'))
               AND a.detail->>'source' = ANY(s.ids))
          OR (a.event = 'series.attach_source' AND a.detail->>'source' = ANY(s.ids))
          OR (a.event = 'series.main_source' AND a.detail->>'via' IN ('manual', 'review') AND a.detail->>'to' = ANY(s.ids)))
    INSERT INTO backup_extensions (pkg_name, name, lang, state, via, installed_at, last_needed_at, why)
    SELECT l.pkg, s.name, s.lang, 'active', 'autofix', l.at, now(), 'seed'
      FROM last l JOIN srcs s ON s.pkg_name = l.pkg
     WHERE l.event = 'extension.install' AND l.via = 'autofix'
       AND NOT EXISTS (SELECT 1 FROM chosen ch WHERE ch.pkg_name = l.pkg)
    ON CONFLICT (pkg_name) DO NOTHING`);
  await c.query(`
    WITH person AS (
      SELECT DISTINCT ON (detail->>'pkgName') detail->>'pkgName' AS pkg, event, at
        FROM audit_log
       WHERE event IN ('extension.install', 'extension.uninstall', 'extension.enable')
         AND detail->>'via' IS NULL AND detail->>'pkgName' IS NOT NULL
       ORDER BY detail->>'pkgName', at DESC, id DESC)
    INSERT INTO backup_extensions (pkg_name, state, parked_at, why)
    SELECT p.pkg, 'refused', p.at, 'by_admin' FROM person p
     WHERE p.event = 'extension.uninstall'
       AND NOT EXISTS (SELECT 1 FROM suwayomi_sources ss WHERE ss.pkg_name = p.pkg)
    ON CONFLICT (pkg_name) DO NOTHING`);
}

/**
 * Run-once data migrations, oldest first. Ids are permanent: renaming one re-runs it everywhere.
 */
const DATA_MIGRATIONS: { id: string; run: (c: PoolClient) => Promise<void> }[] = [
  // Proves the mechanism end to end on real installs before anything depends on it.
  { id: '0001-noop', run: async (c) => { await c.query('SELECT 1'); } },

  // Copy every orphaned row into orphan_refs BEFORE deleting it, so "we removed your data" is recoverable
  // with one UPDATE rather than a restore from last night's dump. Small tables; bounded and fast.
  {
    id: '0002-quarantine-orphans',
    run: async (c) => {
      const targets: [string, string, string][] = [
        ['favorites', 'series_id', 'lib_series'],
        ['collection_items', 'series_id', 'lib_series'],
        ['ratings', 'series_id', 'lib_series'],
        ['series_colors', 'series_id', 'lib_series'],
        ['series_art', 'series_id', 'lib_series'],
        ['series_seen', 'series_id', 'lib_series'],
        ['series_trackers', 'series_id', 'lib_series'],
        ['series_overrides', 'series_id', 'lib_series'],
        ['notes', 'series_id', 'lib_series'],
        ['read_progress', 'series_id', 'lib_series'],
        ['read_progress', 'book_id', 'lib_books'],
      ];
      for (const [tbl, col, parent] of targets) {
        await c.query(
          `INSERT INTO orphan_refs (tbl, col, row)
           SELECT $1, $2, to_jsonb(t) FROM ${tbl} t
            WHERE t.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = t.${col})`,
          [tbl, col],
        );
        await c.query(
          `DELETE FROM ${tbl} t WHERE t.${col} IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = t.${col})`,
        );
      }
      // book notes point at nothing rather than being thrown away
      await c.query(
        `UPDATE notes SET book_id = NULL
          WHERE book_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.id = notes.book_id)`,
      );
      await c.query(
        `UPDATE lib_series SET cover_book_id = NULL
          WHERE cover_book_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.id = cover_book_id)`,
      );
    },
  },

  // Now the data is clean, promote the NOT VALID constraints. VALIDATE takes only a SHARE UPDATE EXCLUSIVE
  // lock, so it blocks neither reads nor writes.
  {
    id: '0003-validate-fks',
    run: async (c) => {
      const rows = await c.query<{ conname: string; tbl: string }>(
        `SELECT conname, conrelid::regclass::text AS tbl FROM pg_constraint
          WHERE contype = 'f' AND NOT convalidated AND conname LIKE 'fk_%'`,
      );
      for (const r of rows.rows) {
        await c.query(`ALTER TABLE ${r.tbl} VALIDATE CONSTRAINT "${r.conname}"`);
      }
    },
  },
  // Installs that already have the CASCADE version of this constraint (it shipped in the FK pass) keep it,
  // because the DO block above only creates constraints that are missing. Swap it in place.
  {
    id: '0004-read-progress-book-restrict',
    run: async (c) => {
      const cur = await c.query(
        `SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_read_progress_book_id'`,
      );
      if (!cur.rowCount || cur.rows[0].confdeltype !== 'c') return; // absent, or already not-cascade
      await c.query(`ALTER TABLE read_progress DROP CONSTRAINT fk_read_progress_book_id`);
      await c.query(
        `ALTER TABLE read_progress ADD CONSTRAINT fk_read_progress_book_id
           FOREIGN KEY (book_id) REFERENCES lib_books(id) ON DELETE RESTRICT NOT VALID`,
      );
    },
  },

  // v0.40.0 changed what an incomplete chapter means: a tiny-but-valid image is a page, a chapter at 80 %
  // is written with placeholders, and a failed copy is taken from another source. The ledger rows that had
  // hit CHAPTER_RETRY_CAP under the old rules (153 "N-1 of N pages" rows on one install, none a block) would
  // otherwise sit capped forever, because only a landed chapter resets attempts. One reset, once, so the
  // first sweep after this deploy tries each of them again under the new rules. Refusals keep their count.
  {
    id: 'v0.40.0-retry-incomplete',
    run: async (c) => {
      await c.query(`UPDATE chapter_failures SET attempts = 0 WHERE status = 'incomplete'`);
    },
  },

  // v0.52.0: state the language of every series whose main source is MangaDex, from the copies its listing chose.
  // The one case inference cannot see: when a title has no English chapters, MangaDex's English adapter falls back
  // to Spanish, Portuguese and the rest (lib/sources/mangadex.ts CHAPTER_LANGS), so a Spanish title added through it
  // reads as the adapter's English. The majority language of its MangaDex rows is what it really is, in the app's
  // codes (es-la is es-419: lib/lang.ts MANGADEX_LANGS); a code outside the table stays unstated. Only MangaDex's own
  // rows count, since a follower's copies say nothing about the main source, and a stated language is never
  // overwritten. One grouped read of those series' listings and one UPDATE.
  {
    id: 'v0.52.0-series-lang-from-mangadex',
    run: async (c) => {
      await c.query(
        `WITH tally AS (
           SELECT l.series_id, lower(l.chosen->>'lang') AS md, count(*) AS n
             FROM series_listing l
             JOIN lib_series s ON s.id = l.series_id
            WHERE s.source_id = 'mangadex' AND s.lang IS NULL
              AND l.source_id = 'mangadex' AND COALESCE(l.chosen->>'lang', '') <> ''
            GROUP BY 1, 2
         ), top AS (
           SELECT DISTINCT ON (series_id) series_id, md FROM tally ORDER BY series_id, n DESC, md
         )
         UPDATE lib_series s SET lang = m.code
           FROM top t JOIN unnest($1::text[], $2::text[]) AS m(md, code) ON m.md = t.md
          WHERE s.id = t.series_id AND s.lang IS NULL`,
        [MANGADEX_LANGS.map((l) => l.md), MANGADEX_LANGS.map((l) => l.code)],
      );
    },
  },

  // v0.55.2 (#147), notice chapters: the type of every series whose genres name one (lib/seriesTypeSignals.ts
  // typeFromGenres), so the per-type switches mean something on the first boot rather than after every series is
  // rescanned. typeFromGenres itself, in JS rather than a copy of its rule in SQL, so the two cannot disagree: a
  // genre menu naming several origins, or a lone "Manga", types nothing here either. The admin's genre override
  // counts, as everywhere. Only series nothing has typed yet: one read and one UPDATE.
  {
    id: 'v0.55.2-series-type-from-genres',
    run: async (c) => {
      const rows = (await c.query<{ id: string; genres: string[] | null }>(
        `SELECT s.id, COALESCE(o.genres, s.genres) AS genres
           FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.series_type IS NULL`)).rows;
      const typed = rows.flatMap((r) => { const t = typeFromGenres(r.genres); return t ? [{ id: r.id, ...t }] : []; });
      if (!typed.length) return;
      await c.query(
        `UPDATE lib_series s SET series_type = v.type, series_type_from = v.src
           FROM unnest($1::text[], $2::text[], $3::text[]) AS v(id, type, src)
          WHERE s.id = v.id AND s.series_type IS NULL`,
        [typed.map((t) => t.id), typed.map((t) => t.type), typed.map((t) => t.from)],
      );
    },
  },

  // v0.55.3, failures follow the series: every failed chapter filed under a source its series no longer uses -- neither
  // its main source nor one it follows -- is filed under its main source, its tries starting again, as a main-source
  // switch does from now on (lib/chapterFailures.ts REFILE_FAILURES_SQL, the same statement, so the two cannot
  // disagree). Live, Replace had left 32 such rows under AllManga for two series now on Natomanga. One UPDATE, and no
  // column: a v0.55.2 rollback reads the rows as any others, and its next failure of the chapter writes its own status.
  {
    id: 'v0.55.3-failures-follow-the-series',
    run: async (c) => { await c.query(REFILE_FAILURES_SQL, [null]); },
  },

  // v0.55.5: a site's whole genre menu out of the genres a series carries (lib/genres.ts cleanGenres, the same function
  // the engine, the add and the scan now pass every genre list through, so the four cannot disagree). The Manganato
  // engine read every genre link on a Natomanga page, the site's 59-link menu among them: twelve live series held all
  // 69 genres, Hentai and Smut too. The scanned genres, and an admin's override as well: Edit details sends every field
  // on any save since v0.53.0, so a series anyone retitled holds the menu there -- and a menu's run is nobody's choice.
  // Then each series cleaned is typed from what is left, by learnSeriesType's rule (never over a stronger provenance):
  // a menu names three origins, so typeFromGenres typed none of them. No column: a v0.55.4 rollback reads clean genres.
  {
    id: 'v0.55.5-genres-without-site-menu',
    run: async (c) => {
      const cleaned: string[] = [];
      for (const [table, key] of [['lib_series', 'id'], ['series_overrides', 'series_id']] as const) {
        const rows = (await c.query<{ id: string; genres: string[] }>(
          `SELECT ${key} AS id, genres FROM ${table} WHERE EXISTS (SELECT 1 FROM unnest(genres) g WHERE lower(btrim(g)) = 'ongoing')`)).rows;
        for (const r of rows) {
          const genres = cleanGenres(r.genres);
          if (genres.length === r.genres.length) continue;
          await c.query(`UPDATE ${table} SET genres = $2 WHERE ${key} = $1`, [r.id, genres]);
          cleaned.push(r.id);
        }
      }
      if (!cleaned.length) return;
      const rows = (await c.query<{ id: string; genres: string[] | null }>(
        `SELECT s.id, COALESCE(o.genres, s.genres) AS genres
           FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id WHERE s.id = ANY($1)`, [[...new Set(cleaned)]])).rows;
      for (const r of rows) {
        const t = typeFromGenres(r.genres);
        if (!t) continue;
        await c.query(
          `UPDATE lib_series SET series_type = $2, series_type_from = $3
            WHERE id = $1 AND COALESCE(array_position($4::text[], series_type_from), 0) <= array_position($4::text[], $3::text)`,
          [r.id, t.type, t.from, SERIES_TYPE_FROM],
        );
      }
    },
  },


  // v0.62.0: before MangaDex's English adapter stops falling back to another language (the next step, and
  // lib/sources/mangadex.ts), each chapter it took in another language keeps that language on its row: once the next
  // check lists English only, nothing else on the server says which copy the file was. The listing still holds the
  // copy (MangaDex names a language per chapter), found by the chapter id the file was stamped with (v0.49.0). It is
  // what tells the wrong-language notice that an English series' chapter 5 is in Spanish. Files from before the stamp
  // cannot be matched, and keep reading as their source's: English.
  {
    id: 'v0.62.0-chapters-keep-their-language',
    run: async (c) => {
      await c.query(
        `UPDATE lib_books b SET lang = x.lang
           FROM (SELECT DISTINCT ON (bk.id) bk.id, cp->>'lang' AS lang
                   FROM lib_books bk
                   JOIN series_listing l ON l.series_id = bk.series_id
                   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.copies, '[]'::jsonb)) cp
                  WHERE bk.source_id = 'mangadex' AND bk.pruned_at IS NULL AND bk.source_chapter_id IS NOT NULL
                    AND cp->>'source' = 'mangadex' AND cp->>'sourceId' = bk.source_chapter_id
                    AND lower(btrim(COALESCE(cp->>'lang', ''))) NOT IN ('', 'en')
                  ORDER BY bk.id) x
          WHERE b.id = x.id`,
      );
    },
  },

  // v0.62.0: MangaDex's English adapter no longer falls back to another language (lib/sources/mangadex.ts). A series
  // that fallback filled reads as English from the adapter but is stated in its real language (the add's
  // majorityLang, or v0.52.0's migration above), and without a move it would stop updating. So each one moves to
  // MangaDex in its own language, the adapter that language has had since v0.52.0, and that language is switched
  // on so the adapter registers at this same boot (server.ts loads the MangaDex languages after migrate()).
  //
  // Evidence, not the label alone: a series moves only when its listing CHOSE MangaDex copies in that language,
  // which is what the fallback did. A series somebody stated as Japanese while reading English chapters stays
  // put, and nothing switches Japanese on. The data changes are Make main's (lib/mainSource.ts switchMainSource):
  // the new main stops being a follower, the old main's listing rows go (the next check lists the new one), and
  // the series' failure rows are re-filed under the new main (REFILE_FAILURES_SQL). The MangaDex id is the same in
  // every language, so source_series_id stays.
  {
    id: 'v0.62.0-mangadex-series-to-their-language',
    run: async (c) => {
      const langs = MANGADEX_LANGS.filter((l) => l.code !== 'en');
      const moved = (await c.query<{ id: string; lang: string }>(
        `WITH m AS (SELECT * FROM unnest($1::text[], $2::text[]) AS m(code, md))
         UPDATE lib_series s SET source_id = 'mangadex-' || lower(s.lang)
           FROM m
          WHERE s.source_id = 'mangadex' AND s.lang = m.code AND s.deleted_at IS NULL AND s.merged_into IS NULL
            AND EXISTS (SELECT 1 FROM series_listing l
                         WHERE l.series_id = s.id AND l.source_id = 'mangadex'
                           AND lower(l.chosen->>'lang') IN (lower(m.code), lower(m.md)))
         RETURNING s.id, s.lang`,
        [langs.map((l) => l.code), langs.map((l) => l.md)],
      )).rows;
      if (!moved.length) return;
      const ids = moved.map((r) => r.id);
      await c.query(
        `DELETE FROM series_sources ss USING lib_series s
          WHERE ss.series_id = s.id AND s.id = ANY($1::text[]) AND ss.source_id = s.source_id`, [ids]);
      await c.query(`DELETE FROM series_listing WHERE series_id = ANY($1::text[]) AND source_id = 'mangadex'`, [ids]);
      await c.query(REFILE_FAILURES_SQL, [ids]);
      await c.query(
        `UPDATE server_settings
            SET mangadex_langs = (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                                    FROM (SELECT jsonb_array_elements_text(mangadex_langs) AS v
                                          UNION SELECT unnest($1::text[])) x)
          WHERE id = 1`,
        [[...new Set(moved.map((r) => r.lang))]],
      );
    },
  },

  // The engine upgrade: chapter dates the extension engine gave in SECONDS. v2.3.2243 stamps a new chapter its
  // extension listed without a date with the current time in epoch seconds (`Instant.now().epochSecond`; measured on
  // a throwaway engine), and the adapter read every date as milliseconds -- so they were stored as 1970-01-21. The
  // adapter now reads both (sources/suwayomi/sources.ts uploadedAt); this puts right what it already stored, in every
  // place a chapter's date lives: lib_books (setBookDates), series_listing's column and its `chosen` and `copies`
  // JSON, and series_post_numbers.
  //
  // A stored date after the epoch and before 1973-03-04 (1e11 ms) can only be such a value: it becomes that many
  // SECONDS after the epoch when that lands between 2000-01-01 and two days from now, and no date otherwise -- never a
  // guess. A date at or before the epoch is left alone, as is everything after March 1973. On the owner's server
  // (2026-10-14, read-only): 175 chapters, 174 listing rows and 366 listing copies, all from extension sources, all
  // between 2026-10-04 and 2026-10-14; no posting-order rows.
  {
    id: CHAPTER_DATES_MIGRATION,
    run: async (c) => {
      // The real moment a seconds-valued timestamp stood for, or NULL. `ts` is SQL text, used twice.
      const fixed = (ts: string) => `(CASE WHEN to_timestamp(extract(epoch FROM ${ts}) * 1000)
          BETWEEN timestamptz '2000-01-01' AND now() + interval '2 days'
          THEN to_timestamp(extract(epoch FROM ${ts}) * 1000) END)`;
      const misread = (ts: string) => `${ts} > 'epoch' AND ${ts} < '1973-03-04'`;
      for (const table of ['lib_books', 'series_listing', 'series_post_numbers']) {
        await c.query(`UPDATE ${table} SET published_at = ${fixed('published_at')} WHERE ${misread('published_at')}`);
      }
      // The JSON keeps a date as an ISO string ("2026-10-10T07:26:49.000Z" as the adapter wrote it, "+00:00" from some
      // APIs). Only a string that IS one is read as a timestamp: the CASE comes first, so nothing else is ever cast. A
      // date put right is written back the adapter's way; one that was no date is dropped from its copy, as the adapter
      // now drops it.
      const iso = (v: string) =>
        `(CASE WHEN ${v} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})$' THEN (${v})::timestamptz END)`;
      const repaired = (j: string) => `(CASE WHEN ${fixed(iso(`${j}->>'publishedAt'`))} IS NULL THEN ${j} - 'publishedAt'
          ELSE jsonb_set(${j}, '{publishedAt}', to_jsonb(to_char(${fixed(iso(`${j}->>'publishedAt'`))} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) END)`;
      const bad = (j: string) => misread(iso(`${j}->>'publishedAt'`));
      await c.query(`UPDATE series_listing SET chosen = ${repaired('chosen')} WHERE ${bad('chosen')}`);
      await c.query(
        `UPDATE series_listing l
            SET copies = (SELECT jsonb_agg(CASE WHEN ${bad('cp')} THEN ${repaired('cp')} ELSE cp END ORDER BY i)
                            FROM jsonb_array_elements(l.copies) WITH ORDINALITY AS e(cp, i))
          WHERE jsonb_typeof(l.copies) = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.copies) cp WHERE ${bad('cp')})`,
      );
    },
  },
  {
    // v0.81.0: "Finish downloads on their own" is the one switch for everything automatic about downloads, looking for
    // other sources included -- that was its own switch, "Use other sources on their own" (auto_follow_on_failure,
    // "Look for failed chapters on other sources" before v0.80.0). The two columns stay, and Admin -> Settings now
    // writes both together. Where they disagree, both go off: an admin who turned either off never finds part of it
    // switched back on by an upgrade.
    id: 'v0.81.0-one-switch-for-automatic-downloads',
    run: async (c) => {
      await c.query(`UPDATE server_settings SET finish_downloads = false, auto_follow_on_failure = false
                      WHERE id = 1 AND finish_downloads IS DISTINCT FROM auto_follow_on_failure`);
    },
  },
  {
    id: BACKUP_SEED_MIGRATION,
    run: seedBackupExtensions,
  },
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // blocks until any other migrating process finishes, then finds the work already done
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK]);
    try {
      await client.query('BEGIN');
      await client.query(DDL);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    // after the DDL, still under the lock, so the tables they touch are guaranteed to exist
    for (const m of DATA_MIGRATIONS) {
      if (await runOnce(client, m.id, m.run)) console.log(`[migrate] applied ${m.id}`);
    }
  } finally {
    // release before returning the connection to the pool, or the lock outlives this call
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATE_LOCK]).catch(() => {});
    client.release();
  }

  // Seed the admin from the OPTIONAL env-provided argon2 hash (plaintext never stored). If no hash is set, the
  // users table is left empty and the first-run web setup (POST /api/setup) creates the admin instead. Never in SSO-only
  // mode (v0.63.0, #208): its first admin comes from the provider, and a password admin is exactly what it does away
  // with (lib/authMode.ts; boot says the setting is ignored).
  const existing = await one<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (!existing && env.initialUserPasswordHash && !ssoOnly()) {
    const row = await one<{ id: string }>(
      `INSERT INTO users (display_name, username, role, password_hash, auth_kind)
       VALUES ('admin', 'admin', 'admin', $1, 'password') RETURNING id`,
      [env.initialUserPasswordHash],
    );
    if (row) {
      await pool.query(
        `INSERT INTO app_settings (user_id, data) VALUES ($1, '{}'::jsonb)
         ON CONFLICT (user_id) DO NOTHING`,
        [row.id],
      );
    }
  } else if (existing) {
    // A pre-multi-user install's one account becomes its admin -- but only while the server has no admin at all.
    // This ran on every boot unconditionally, so a restart undid any demotion of the oldest account made in
    // Admin -> Members or by OIDC_ADMIN_GROUP, and promoted the next-oldest member once the oldest was deleted.
    // Reintroduce by dropping the NOT EXISTS: adminPromotion.int.test.ts sees the demoted founder admin again.
    await pool.query(
      `UPDATE users SET role = 'admin'
        WHERE created_at = (SELECT min(created_at) FROM users) AND role <> 'admin'
          AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
    );
    // The same legacy account may predate usernames. Separate, and guarded, so it can never collide with
    // uq_users_username or rename anyone once an 'admin' exists.
    await pool.query(
      `UPDATE users SET username = 'admin'
        WHERE created_at = (SELECT min(created_at) FROM users) AND username IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin')`,
    );
  }
}

export interface UserRow {
  id: string;
  username: string | null;
  display_name: string;
  role: string;
  password_hash: string;
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  return one('SELECT id, username, display_name, role, password_hash FROM users WHERE username = $1', [username]);
}

export async function getSingleUser(): Promise<UserRow | null> {
  return one('SELECT id, username, display_name, role, password_hash FROM users ORDER BY created_at ASC LIMIT 1');
}
