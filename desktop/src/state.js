// @ts-check
'use strict';
/**
 * Two small JSON files next to the data: `state.json` (ports, pids -- not secret) and `secrets.json` (the
 * Postgres password). Written atomically: a torn state.json would lose the UI port, and the port is the web
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

function write(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

module.exports = { read, write };
