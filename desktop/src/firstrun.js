// @ts-check
'use strict';
/**
 * First run: where the manga go.
 *
 * The first launch asks for one folder, the library (the bff's DL_ROOT), before anything else starts. The
 * default is `Uchiyomi Library` in the home folder -- `C:\Users\<name>\Uchiyomi Library` on Windows,
 * `/Users/<name>/Uchiyomi Library` on macOS -- visible in Explorer/Finder, and deliberately NOT inside
 * Documents: Windows' OneDrive folder backup and macOS' "Desktop & Documents" iCloud sync upload whatever is
 * there, which for a manga library is gigabytes, and "files on demand" placeholders make pages fail to open
 * offline. The answer is saved in state.json (`libraryDir`) and never asked again.
 *
 * Pure (no Electron): the checks run in the tests with fake homes and path.win32.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** @param {string} [home] @param {typeof path} [impl] */
function defaultLibraryDir(home = os.homedir(), impl = path) {
  return impl.join(home, 'Uchiyomi Library');
}

/** Is `child` the same folder as `parent`, or inside it? Case-folded: NTFS and APFS are case-insensitive. */
function isInside(child, parent, impl = path) {
  const rel = impl.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !impl.isAbsolute(rel));
}

/**
 * Folders that a sync client uploads, for the "this will upload your library" warning.
 * @param {{ home: string, env?: NodeJS.ProcessEnv, platform?: string, impl?: typeof path }} o
 * @returns {Array<{ dir: string, what: string }>}
 */
function syncedFolders({ home, env = process.env, platform = process.platform, impl = path }) {
  const j = (...p) => impl.join(home, ...p);
  const out = [];
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    if (env[k]) out.push({ dir: env[k], what: 'OneDrive' });
  }
  out.push({ dir: j('OneDrive'), what: 'OneDrive' });
  if (platform === 'darwin') {
    out.push({ dir: j('Library', 'Mobile Documents'), what: 'iCloud Drive' });
    out.push({ dir: j('Library', 'CloudStorage'), what: 'a cloud drive' });
    out.push({ dir: j('Desktop'), what: 'Desktop (iCloud can sync it)' });
  }
  out.push({ dir: j('Documents'), what: platform === 'darwin' ? 'Documents (iCloud can sync it)' : 'Documents (OneDrive can back it up)' });
  out.push({ dir: j('Dropbox'), what: 'Dropbox' });
  out.push({ dir: j('Google Drive'), what: 'Google Drive' });
  return out;
}

/**
 * Can this folder be the library? Errors block; a warning asks "use it anyway?".
 * @param {string} dir
 * @param {{ dataRoot: string, home?: string, env?: NodeJS.ProcessEnv, platform?: string, impl?: typeof path }} o
 * @returns {{ ok: boolean, dir: string, error?: string, warning?: string }}
 */
function checkLibraryDir(dir, o) {
  const impl = o.impl || path;
  const home = o.home || os.homedir();
  const raw = String(dir || '').trim();
  if (!raw) return { ok: false, dir: raw, error: 'Choose a folder for the library.' };
  if (!impl.isAbsolute(raw)) return { ok: false, dir: raw, error: 'Choose a full folder path.' };
  const d = impl.resolve(raw);
  // ⚠️ Not the app's own data folder, nor anything inside or around it: the bff keeps an (empty) read library
  // at <data>/library and refuses to start when the two libraries sit one inside the other (every file would be
  // scanned twice), and <data> itself is replaced wholesale by an uninstall with "delete app data".
  if (isInside(d, o.dataRoot, impl) || isInside(o.dataRoot, d, impl)) {
    return { ok: false, dir: d, error: "That folder holds Uchiyomi's own data. Choose a separate folder for the manga." };
  }
  const root = impl.parse(d).root;
  if (d === root) return { ok: false, dir: d, error: 'Choose a folder, not the whole drive.' };
  if (d.toLowerCase() === impl.resolve(home).toLowerCase()) return { ok: false, dir: d, error: 'Choose a folder inside your home folder, not the home folder itself.' };
  const synced = syncedFolders({ home, env: o.env, platform: o.platform, impl }).find((s) => isInside(d, s.dir, impl));
  if (synced) {
    return { ok: true, dir: d, warning: `This folder is in ${synced.what}, which may upload the whole library to the cloud and keep pages online-only. A folder outside it is safer.` };
  }
  return { ok: true, dir: d };
}

/**
 * Make the folder and prove we can write to it (a probe file, removed again).
 * @param {string} dir
 * @returns {{ ok: boolean, error?: string }}
 */
function prepareLibraryDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.uchiyomi-write-test-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (e) {
    const code = /** @type {any} */ (e)?.code;
    return { ok: false, error: code === 'EACCES' || code === 'EPERM' ? 'Uchiyomi cannot write to that folder. Choose another one, or check its permissions.' : `That folder cannot be used: ${String(/** @type {any} */ (e)?.message || e)}` };
  }
}

module.exports = { defaultLibraryDir, checkLibraryDir, prepareLibraryDir, syncedFolders, isInside };
