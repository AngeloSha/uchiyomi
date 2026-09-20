import type { PoolClient } from 'pg';
import { pool, one } from './db';
import { env } from '../env';

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

CREATE OR REPLACE VIEW reading_stats AS
SELECT user_id,
       count(*) FILTER (WHERE completed)              AS chapters_completed,
       count(DISTINCT series_id)                      AS series_touched,
       count(*)                                       AS total_events,
       max(created_at)                                AS last_read_at
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins       int         NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until        timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret         text;                       -- base32; pending until totp_enabled
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled        boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes      text[]      NOT NULL DEFAULT '{}'; -- sha256 of one-time codes
ALTER TABLE users ADD COLUMN IF NOT EXISTS perms               jsonb       NOT NULL DEFAULT '{}'; -- {canDownload?}
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();

-- richer session/device info for the sessions UI
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_seen  timestamptz NOT NULL DEFAULT now();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip         text;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent text;
-- Which token replaced this one, set only when a refresh rotated it. It is what separates "this device
-- already moved on" from "this session was ended", and only the former is forgiven inside the grace window
-- in validateRefreshForRotation. A logout, an admin revoke and sign-out-everywhere all leave it null, so
-- they still take effect the instant they are written.
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
-- is numFromName(), which takes the FIRST number it finds. So "Vol 2 Ch 5.cbz" is chapter 2: it sorts
-- between 1 and 3 in the reader, and 2 is what gets reported to AniList. There is no filename parser that
-- is right for every collection, so the escape hatch is a manual, per-chapter override.
--
-- Deliberately manual. Re-parsing every filename with a smarter rule would silently renumber hundreds of
-- chapters at once, and a renumbered COMPLETED chapter changes what a tracker is told (see
-- tracker_progress above for why that direction is dangerous).
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
  // users table is left empty and the first-run web setup (POST /api/setup) creates the admin instead.
  const existing = await one<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (!existing && env.initialUserPasswordHash) {
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
    // pre-existing single user -> promote it to admin
    await pool.query(
      `UPDATE users SET role='admin', username=COALESCE(username,'admin')
       WHERE created_at = (SELECT min(created_at) FROM users) AND (role <> 'admin' OR username IS NULL)`,
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
