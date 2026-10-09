// @ts-check
'use strict';
/**
 * A child's stdout + stderr, appended to its log file (logs/bff.log, logs/engine.log).
 *
 * ⚠️ The file is closed when BOTH streams have ended, never on the child's 'exit'. What a child writes just before
 * it exits can still be in the pipe when 'exit' fires: Node's child_process has always allowed that, and Electron's
 * utilityProcess delivers it since 44.5.1 (44.4.5 removed every stdout/stderr listener on 'exit' and dropped it).
 * The supervisor and the engine both ended their file on 'exit', so that late chunk became a write after end().
 * The stream's 'error' event had no listener, so it was an uncaught exception in the main process -- and Electron's
 * answer to one is a MODAL error box ("A JavaScript error occurred in the main process") and nothing else: the main
 * process stops until someone clicks OK. On the desktop CI that froze the shell halfway through its ordered stop,
 * until the smoke's 10-minute timeout killed it (S2-ii: 4 of 21 Windows runs on 44.5.1, every one with the bff's
 * last line arriving after its exit); on a PC it is that error box on Quit, with Postgres not yet stopped.
 *
 * A log is best-effort: its own errors (disk full, the folder removed) are swallowed here, never thrown. A stream
 * that never ends (another process still holding the pipe, or an Electron that drops the listeners again) does not
 * keep the file open forever: `graceMs` after 'exit' it is closed anyway, and anything later is dropped.
 */
const fs = require('node:fs');
const { finished } = require('node:stream');

/**
 * @param {string} file
 * @param {import('node:events').EventEmitter & { stdout?: NodeJS.ReadableStream | null, stderr?: NodeJS.ReadableStream | null }} child
 * @param {{ graceMs?: number }} [o]
 * @returns {fs.WriteStream} the log, for the caller's own lines (e.g. a spawn error)
 */
function logChildOutput(file, child, { graceMs = 10_000 } = {}) {
  const out = fs.createWriteStream(file, { flags: 'a' });
  out.on('error', () => { /* best-effort: see above */ });
  const end = () => { if (!out.writableEnded) out.end(); };
  const streams = [child.stdout, child.stderr].filter((s) => !!s);
  let open = streams.length;
  for (const s of streams) {
    s.on('data', (b) => { if (!out.writableEnded) out.write(b); });
    finished(s, () => { if (--open === 0) end(); });
  }
  if (!open) end();
  child.once('exit', () => { setTimeout(end, graceMs).unref?.(); });
  return out;
}

module.exports = { logChildOutput };
