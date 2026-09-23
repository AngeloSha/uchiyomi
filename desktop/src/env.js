// @ts-check
'use strict';
/**
 * The environment the bff runs with. Every variable whose bff default is a POSIX path is set explicitly --
 * `/config`, `/cache`, `/library` and friends do not exist on Windows, and on macOS they are not writable.
 * Sources of those defaults: bff/src/env.ts (CONFIG_DIR, CACHE_DIR, BACKUP_DIR), lib/library.ts (LIBRARY_ROOT,
 * DL_ROOT), lib/sources/loader.ts (SOURCES_DIR), lib/sources/customSites.ts (CUSTOM_SITES_FILE).
 *
 * ⚠️ Built from an ALLOWLIST of the shell's environment, not a copy of it. The shell's environment is whatever
 * the user's session had (PGHOST, NODE_OPTIONS, ELECTRON_RUN_AS_NODE...), and the bff should see only what it
 * needs. SystemRoot stays: without it Windows sockets and crypto fail in confusing ways.
 */
const path = require('node:path');

const KEEP = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'USERNAME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
  'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);

/**
 * @param {{
 *   L: ReturnType<typeof import('./paths').layout>,
 *   resources: string,
 *   uiPort: number,
 *   pgPort: number,
 *   pgPassword: string,
 *   pgBinDir: string,
 *   version: string,
 * }} o
 */
function bffEnv(o) {
  /** @type {Record<string, string>} */
  const e = {};
  let pathKey = 'PATH';
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !KEEP.has(k.toUpperCase())) continue;
    if (k.toUpperCase() === 'PATH') pathKey = k;
    e[k] = v;
  }
  // pg_dump for the nightly backup (bff/src/lib/backup.ts spawns it from PATH). First, so it wins over any
  // PostgreSQL the user installed themselves -- a different major writes dumps ours cannot restore.
  e[pathKey] = o.pgBinDir + path.delimiter + (e[pathKey] || '');
  // Linux is dev-only (a PostgreSQL source build without rpath); Windows and macOS binaries find their own libs.
  if (process.platform === 'linux') e.LD_LIBRARY_PATH = path.join(o.pgBinDir, '..', 'lib');
  const origin = `http://127.0.0.1:${o.uiPort}`;
  Object.assign(e, {
    NODE_ENV: 'production',
    // ⚠️ Not read by the bff as of v0.43.0: server.ts:552 hard-codes host '0.0.0.0'. Set anyway so the day
    // Phase 1 lands `process.env.HOST || '0.0.0.0'` the app is loopback-only without a shell change.
    HOST: '127.0.0.1',
    PORT: String(o.uiPort),
    PUBLIC_ORIGIN: origin,
    DATABASE_URL: `postgres://yomi@127.0.0.1:${o.pgPort}/yomi`,
    // node-pg and pg_dump both read it when the URL carries no password, so the secret is never on a
    // command line (the bff's pg_dump call passes DATABASE_URL as an argument).
    PGPASSWORD: o.pgPassword,
    EMBEDDED_DB: '1',
    UCHIYOMI_DESKTOP: '1',
    UCHIYOMI_DESKTOP_VERSION: o.version,
    CONFIG_DIR: o.L.config,
    CACHE_DIR: o.L.cache,
    BACKUP_DIR: o.L.backups,
    LIBRARY_ROOT: o.L.library,
    DL_ROOT: o.L.downloads,
    SOURCES_DIR: o.L.sources,
    CUSTOM_SITES_FILE: path.join(o.L.config, 'sites.json'),
    WEB_ROOT: path.join(o.resources, 'web'),
    LIBRARY_BACKEND: 'owned',
    CACHE_MAX_BYTES: String(4 * 1024 * 1024 * 1024),
    MIN_FREE_GB: '5',
  });
  return e;
}

/** Every bff env var whose default is a POSIX path. Phase 2's desktopParity.test.ts pins this list. */
const POSIX_DEFAULTS = ['CONFIG_DIR', 'CACHE_DIR', 'BACKUP_DIR', 'LIBRARY_ROOT', 'DL_ROOT', 'SOURCES_DIR', 'CUSTOM_SITES_FILE'];

module.exports = { bffEnv, POSIX_DEFAULTS };
