// @ts-check
'use strict';
/**
 * --smoke only: the main process's uncaught exceptions and unhandled rejections, each logged with its stack the
 * moment it happens and kept for the smoke's result, which any one of them fails (main.js runSmoke).
 *
 * ⚠️ With no listener of our own, Electron 44 answers an uncaught exception in the main process with
 * dialog.showErrorBox -- a MODAL box -- and keeps the process alive (lib/browser/init.ts, "Don't quit on fatal
 * error"). On a CI runner nobody dismisses it: the main thread stops (no timers, no log lines) and lib.mjs smoke()
 * kills the app at its 10-minute timeout with no result -- the S2-ii hang of the v0.55.9 and v0.55.10 release runs,
 * whose cause (a child's log ended on 'exit') PR #182 fixed. Electron's handler steps aside as soon as another
 * listener exists (`listenerCount('uncaughtException') > 1`), so this one alone ends the box.
 * Unhandled rejections never froze anything -- Electron runs the main process with
 * --unhandled-rejections=warn-with-error-code, a warning on a stderr nobody reads -- but they fail the smoke too:
 * a rejection nobody handles is an operation that failed without anyone noticing.
 *
 * The app itself (window, tray) keeps Electron's behaviour; whether a person should see that box is not decided here.
 * @param {{ error: (msg: string, extra?: unknown) => void }} log  log.js: synchronous, so the line is on disk at once
 * @returns {Array<{ kind: string, stack: string }>}  live: grows with every later one
 */
function catchUncaught(log) {
  /** @type {Array<{ kind: string, stack: string }>} */
  const seen = [];
  /** @param {string} kind */
  const keep = (kind) => (/** @type {unknown} */ e) => {
    // Whatever was thrown or rejected with: an Error, a string, undefined.
    const stack = String(/** @type {any} */ (e)?.stack || e);
    seen.push({ kind, stack });
    log.error(`smoke: ${kind} in the main process -- the smoke fails`, { stack });
  };
  process.on('uncaughtException', keep('uncaughtException'));
  process.on('unhandledRejection', keep('unhandledRejection'));
  return seen;
}

module.exports = { catchUncaught };
