// @ts-check
'use strict';
/**
 * Two small JSON files next to the data: `state.json` (ports, pids -- not secret) and `secrets.json` (the
 * Postgres password; the extension engine's password is new at every launch and never written: supervisor.js). Written atomically: a torn state.json would lose the UI port, and the port is the web
 * origin that cookies, IndexedDB and the service worker are keyed on.
 */
const fs = require('node:fs');
const path = require('node:path');

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Errors Windows gives a rename over a file another process has open for a moment. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** How long a busy target is waited for, in all: a scan or a read takes milliseconds, a stuck handle never ends. */
const BUSY_MS = 2000;

/**
 * `renameSync`, retried while Windows says the target is busy. A rename over a file someone has open -- an antivirus
 * scan, a backup, an editor, or the desktop CI's S5 script polling state.json (2026-10-14) -- fails with EPERM for that
 * moment, and the first such collision failed startup outright: "startup failed", and the loading page forever. So, as
 * graceful-fs does on Windows, it waits and tries again (10 ms, doubling to 250 ms) for up to BUSY_MS. Synchronous like
 * the rest of this file: every caller writes and reads back in one step.
 * @param {string} from @param {string} to @param {(from: string, to: string) => void} [rename] for the tests
 */
function renameRetrying(from, to, rename = fs.renameSync) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let ms = 10, waited = 0; ; ms = Math.min(ms * 2, 250)) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (!BUSY.has(/** @type {NodeJS.ErrnoException} */ (e)?.code ?? '') || waited >= BUSY_MS) throw e;
      Atomics.wait(pause, 0, 0, ms);
      waited += ms;
    }
  }
}

function write(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  try {
    renameRetrying(tmp, file);
  } catch (e) {
    // Not left beside the real file: the next start would find a stray copy of a secret (secrets.json is written here).
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Read-modify-write. ⚠️ Several owners write state.json (the supervisor's ports and pid, main.js's library
 * folder and one-time notices, a person's hand-edited settings), so nobody may write back a copy read earlier:
 * that silently drops whatever another owner wrote since.
 * @param {string} file @param {(s: Record<string, any>) => void} fn
 */
function update(file, fn) {
  const s = read(file);
  fn(s);
  write(file, s);
  return s;
}

module.exports = { read, write, update, renameRetrying, BUSY_MS };
