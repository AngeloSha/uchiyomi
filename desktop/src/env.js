// @ts-check
'use strict';
/**
 * The environment the bff runs with: contract 1 of the desktop build, and nothing else of ours.
 *
 * The shell sets exactly the variables in CONTRACT below. The bff's desktop switch (bff/src/lib/desktop.ts)
 * validates the required ones -- it refuses to start without UCHIYOMI_DATA_DIR, PORT, DL_ROOT or a secret of
 * 32+ characters -- and DERIVES the rest when they are unset: CONFIG_DIR, CACHE_DIR, BACKUP_DIR, SOURCES_DIR,
 * CUSTOM_SITES_FILE (all under the data dir), LIBRARY_ROOT (an empty <data>/library), MIN_FREE_GB 5,
 * CACHE_MAX_BYTES 4 GiB, PUBLIC_ORIGIN, LIBRARY_BACKEND=owned, NODE_ENV. One owner per value: a path set
 * here AND derived there could disagree the day one of them changes.
 *
 * ⚠️ Built from an ALLOWLIST of the shell's own environment, never a copy of it. The shell's environment is
 * whatever the user's session had (PGHOST, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, a stray DATABASE_URL...), and
 * the bff should see only what it needs. SystemRoot stays: without it Windows sockets and crypto fail in
 * confusing ways.
 */
const path = require('node:path');

const KEEP = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'USERNAME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
  'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);

/** Contract 1: every variable the shell sets. `LIBRARY_ROOT` only when the user chose a read library. */
const CONTRACT = Object.freeze([
  'UCHIYOMI_DESKTOP', 'UCHIYOMI_DATA_DIR', 'PORT', 'DL_ROOT', 'UCHIYOMI_DESKTOP_SECRET',
  'DATABASE_URL', 'PGPASSWORD', 'PG_DUMP_PATH', 'WEB_ROOT', 'FLARESOLVERR_URL',
  'SUWAYOMI_URL', 'SUWAYOMI_USERNAME', 'SUWAYOMI_PASSWORD', 'LIBRARY_ROOT', 'UCHIYOMI_DESKTOP_USER',
]);

/**
 * Two existing bff variables the shell also sets, outside the contract on purpose: NODE_ENV (desktop.ts
 * would default it to the same value) and EMBEDDED_DB=1, which only labels the database "embedded" on the
 * admin Overview (routes/admin.ts) -- true here, the shell started Postgres itself.
 */
const EXTRA = Object.freeze(['NODE_ENV', 'EMBEDDED_DB']);

/** What bff/src/lib/desktop.ts derives when unset; the shell must NOT set these (see the header). */
const DERIVED_BY_BFF = Object.freeze([
  'CONFIG_DIR', 'CACHE_DIR', 'BACKUP_DIR', 'SOURCES_DIR', 'CUSTOM_SITES_FILE', 'MIN_FREE_GB', 'CACHE_MAX_BYTES',
  'PUBLIC_ORIGIN', 'LIBRARY_BACKEND',
]);

/** Every bff env var whose server default is a POSIX path (desktopParity.test.ts pins this against the bff). */
const POSIX_DEFAULTS = Object.freeze(['CONFIG_DIR', 'CACHE_DIR', 'BACKUP_DIR', 'LIBRARY_ROOT', 'DL_ROOT', 'SOURCES_DIR', 'CUSTOM_SITES_FILE']);

/**
 * @param {{
 *   L: ReturnType<typeof import('./paths').layout>,
 *   resources: string,
 *   uiPort: number,
 *   pgPort: number,
 *   pgPassword: string,
 *   pgBinDir: string,
 *   libraryDir: string,          // DL_ROOT: the folder chosen on first run
 *   readLibrary?: string | null, // LIBRARY_ROOT: an existing manga folder the user added (optional)
 *   secret: string,              // per launch, >= 32 chars
 *   solverUrl: string,           // http://127.0.0.1:<port>/<token>
 *   enginePort: number,
 *   engineUser: string,
 *   enginePass: string,
 *   osUser: string,
 *   platform?: string,
 *   baseEnv?: NodeJS.ProcessEnv,
 * }} o
 */
function bffEnv(o) {
  const platform = o.platform || process.platform;
  const delim = platform === 'win32' ? ';' : ':';
  /** @type {Record<string, string>} */
  const e = {};
  let pathKey = 'PATH';
  for (const [k, v] of Object.entries(o.baseEnv || process.env)) {
    if (v === undefined || !KEEP.has(k.toUpperCase())) continue;
    if (k.toUpperCase() === 'PATH') pathKey = k;
    e[k] = v;
  }
  // The bundled bin/ first (belt and braces beside PG_DUMP_PATH), then on Windows System32, so any `tar` the
  // bff spawns is Windows' own bsdtar even when the app was started from a shell that puts Git's GNU tar first
  // -- GNU tar reads `C:\...` as a remote host.
  const sys32 = platform === 'win32' ? path.join((o.baseEnv || process.env).SystemRoot || 'C:\\Windows', 'System32') + delim : '';
  e[pathKey] = o.pgBinDir + delim + sys32 + (e[pathKey] || '');
  // Linux is dev-only (a PostgreSQL source build without rpath); Windows and macOS binaries find their own libs.
  if (platform === 'linux') e.LD_LIBRARY_PATH = path.join(o.pgBinDir, '..', 'lib');
  Object.assign(e, {
    NODE_ENV: 'production',
    EMBEDDED_DB: '1',
    UCHIYOMI_DESKTOP: '1',
    UCHIYOMI_DATA_DIR: o.L.root,
    PORT: String(o.uiPort),
    DL_ROOT: o.libraryDir,
    UCHIYOMI_DESKTOP_SECRET: o.secret,
    DATABASE_URL: `postgres://yomi@127.0.0.1:${o.pgPort}/yomi`,
    // node-pg and pg_dump both read it when the URL carries no password, so the password is never on a
    // command line (macOS `ps` shows every user's).
    PGPASSWORD: o.pgPassword,
    PG_DUMP_PATH: path.join(o.pgBinDir, platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'),
    WEB_ROOT: path.join(o.resources, 'web'),
    FLARESOLVERR_URL: o.solverUrl,
    // Always set, even before the engine is installed: the bff then shows "engine not running" until it is,
    // and its Suwayomi-dependent jobs (the extension monitor) are wired from the first boot.
    SUWAYOMI_URL: `http://127.0.0.1:${o.enginePort}`,
    SUWAYOMI_USERNAME: o.engineUser,
    SUWAYOMI_PASSWORD: o.enginePass,
    UCHIYOMI_DESKTOP_USER: o.osUser,
  });
  if (o.readLibrary) e.LIBRARY_ROOT = o.readLibrary;
  return e;
}

module.exports = { bffEnv, CONTRACT, EXTRA, DERIVED_BY_BFF, POSIX_DEFAULTS, KEEP };
