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

-- Content identity, so a chapter can be recognised after it moves. Derived from the archive's central
-- directory (entry names + CRC-32 + uncompressed sizes), which is cheap to read and survives recompression.
-- Nothing reads these yet; a background job fills them in, and fp_at is set even on failure so an unreadable
-- file is attempted once rather than retried on every pass.
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS fingerprint text;
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS fp_kind     text;         -- zip | rar | dir | error
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS fp_at       timestamptz;  -- when it was last attempted
ALTER TABLE lib_books  ADD COLUMN IF NOT EXISTS size        bigint;
CREATE INDEX IF NOT EXISTS lib_books_fp_idx ON lib_books (fingerprint) WHERE fingerprint IS NOT NULL;
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
