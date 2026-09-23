// @ts-check
'use strict';
/**
 * Where everything lives.
 *
 * ⚠️ NOT Electron's `userData`. On Windows that is `%APPDATA%`, the ROAMING profile, which a domain PC copies
 * to a server at every sign-out -- the wrong home for a multi-GB library, cache and database. Everything goes
 * under `%LOCALAPPDATA%\Uchiyomi` instead, and Chromium's own profile (cookies, service worker, IndexedDB) is
 * moved in beside it with `app.setPath('userData', ...)` before anything reads it.
 *
 * macOS: `~/Library/Application Support/Uchiyomi`. Linux is a dev convenience only (no Linux build in v1).
 *
 * `--data-dir=<path>` (or UCHIYOMI_DATA_DIR) overrides the root. The CI checks use it to run several isolated
 * instances side by side, and a flag rather than only an env var because `Start-Process -Credential` gives the
 * child the other user's environment, not ours.
 */
const os = require('node:os');
const path = require('node:path');

function defaultRoot() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Uchiyomi');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Uchiyomi');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'uchiyomi');
}

/** @param {string | undefined} override */
function dataRoot(override) {
  const r = override || process.env.UCHIYOMI_DATA_DIR;
  return r ? path.resolve(r) : defaultRoot();
}

/** @param {string} root */
function layout(root) {
  const j = (...p) => path.join(root, ...p);
  return {
    root,
    config: j('config'),
    db: j('db'),
    pgdata: j('db', 'pg16'),
    // Read library (the scanner's root) and the download root. Phase 1 decides the user-visible defaults
    // (`~/Uchiyomi Library` chosen on first run); the spike keeps both inside the data root.
    library: j('library'),
    downloads: j('downloads'),
    sources: j('sources'),
    cache: j('cache'),
    backups: j('backups'),
    engine: j('engine'),
    logs: j('logs'),
    electron: j('electron'),
    tmp: j('tmp'),
    state: j('state.json'),
    secrets: j('secrets.json'),
  };
}

/**
 * The staged payload (bff/, web/, pg/). Packaged: `process.resourcesPath` (electron-builder `extraResources`).
 * From source: `desktop/resources`, where scripts/stage.mjs and scripts/pg-dist.mjs put it.
 * @param {{ isPackaged: boolean }} app
 */
function resourcesDir(app) {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
}

module.exports = { dataRoot, defaultRoot, layout, resourcesDir };
