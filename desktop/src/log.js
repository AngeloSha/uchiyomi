// @ts-check
'use strict';
/**
 * The shell's own log, `<data>/logs/desktop.log`.
 *
 * Synchronous appends on purpose: the shell logs a few lines per minute, and the lines that matter most are the
 * ones written just before `app.exit()` -- an async stream loses exactly those.
 *
 * ⚠️ stdout is best-effort. A Windows GUI-subsystem process has no console unless its caller redirected one, so
 * a write can fail; the file is the record, stdout is a convenience for CI.
 */
const fs = require('node:fs');
const path = require('node:path');

let file = null;
if (process.stdout && typeof process.stdout.on === 'function') process.stdout.on('error', () => {});

function open(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'desktop.log');
}

function line(level, msg, extra) {
  const s = `${new Date().toISOString()} ${level} ${msg}${extra === undefined ? '' : ' ' + safeJson(extra)}\n`;
  try { process.stdout.write(s); } catch { /* no console */ }
  if (file) {
    try { fs.appendFileSync(file, s); } catch { /* disk full or gone; nothing better to do */ }
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Error ? { message: x.message, stack: x.stack } : x));
  } catch {
    return String(v);
  }
}

module.exports = {
  open,
  path: () => file,
  info: (m, e) => line('INFO', m, e),
  warn: (m, e) => line('WARN', m, e),
  error: (m, e) => line('ERROR', m, e),
};
