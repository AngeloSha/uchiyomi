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
ALTER TABLE users ADD COLUMN IF NOT EXISTS perms               jsonb       NOT NULL DEFAULT '{}'; -- {canDownload?, canManage?}
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();

-- richer session/device info for the sessions UI
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_seen  timestamptz NOT NULL DEFAULT now();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip         text;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent text;

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
CREATE TABLE IF NOT EXISTS series_overrides (
  series_id  text PRIMARY KEY,
  title      text,
  summary    text,
  cover      text,
  banner     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- per-user token for OPDS clients (used as the HTTP Basic password); one token per user, regenerate overwrites
CREATE TABLE IF NOT EXISTS opds_tokens (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz
);

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
`;

// Serialises migrate() across processes. CREATE TABLE IF NOT EXISTS is not safe to run concurrently:
// two connections racing on the same new type or table collide inside pg_type's unique index rather than
// one of them quietly no-opping. Anything that can start two BFFs at once -- a second replica, a restart
// overlapping a slow boot, or a test suite running files in parallel -- hits it.
const MIGRATE_LOCK = 8_263_195; // arbitrary, just has to be stable across processes

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
