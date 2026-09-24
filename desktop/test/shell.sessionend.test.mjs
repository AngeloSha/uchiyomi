// Windows shutting down, restarting or signing out with Uchiyomi in the tray. Electron emits no before-quit then,
// so until v0.44.0's review Windows just terminated the app: postgres killed rather than fast-stopped, the engine's
// last H2 write lost, the rotated refresh cookie never flushed. The handlers live in sessionend.js so they can be
// driven here with a fake window; the Windows messages themselves only exist on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { installSessionEnd } = require('../src/sessionend.js');
const { installOnQuit } = require('../src/updates.js');
const { Postgres } = require('../src/postgres.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

function rig({ stopped = false } = {}) {
  const win = new EventEmitter();
  const calls = [];
  installSessionEnd(win, {
    log: quiet,
    quit: (r) => { calls.push(`quit:${r}`); return Promise.resolve(); },
    stopped: () => stopped,
    stopPostgresNow: () => { calls.push('pg-now'); return 'fast'; },
  });
  const ask = () => { let held = false; win.emit('query-session-end', { preventDefault: () => { held = true; } }); return held; };
  return { win, calls, ask };
}

test('Windows asking to end the session gets the ordered stop, not a kill', () => {
  // Reintroduce by deleting the installSessionEnd(...) call from main.js's createWindow: "main.js does not handle
  // the session ending" fails; by dropping the preventDefault: "the shutdown was not held" fails.
  const r = rig();
  assert.equal(r.ask(), true, 'the shutdown was not held for the ordered stop');
  assert.deepEqual(r.calls, ['quit:session-end']);
  // The ordered stop finished before Windows moved on: nothing more to do.
  const done = rig({ stopped: true });
  done.win.emit('session-end', {});
  assert.deepEqual(done.calls, []);
  // Windows ended the session anyway ("Shut down anyway", a forced restart) mid-stop: postgres now, synchronously.
  const late = rig({ stopped: false });
  late.win.emit('session-end', {});
  assert.deepEqual(late.calls, ['pg-now']);
  // Wired into the real window.
  const main = fs.readFileSync(path.join(here, '..', 'src', 'main.js'), 'utf8');
  const cw = main.slice(main.indexOf('function createWindow('), main.indexOf('function isOwnOrigin('));
  assert.match(cw, /installSessionEnd\(\/\*\* @type \{any\} \*\/ \(win\), \{/, 'main.js does not handle the session ending');
  assert.match(cw, /quit: \(reason\) => quit\(reason\)/);
  assert.match(cw, /stopPostgresNow: \(\) => sup\?\.stopPostgresNow\(\)/);
  const q = main.slice(main.indexOf('async function quit('));
  assert.ok(q.indexOf('stopped = true;') > q.indexOf('sup?.stop(reason)'), 'quit() never says the ordered stop is done');
});

test('a downloaded update is not installed while Windows ends the session', () => {
  // Reintroduce by returning true for 'session-end': an installer started during logoff can be killed half-way.
  assert.equal(installOnQuit('session-end'), false);
  assert.equal(installOnQuit('session-end', { install: true }), false);
  assert.equal(installOnQuit('tray'), true, 'the tray\'s Quit still installs');
});

test('the last-resort postgres stop is a synchronous fast stop through pg_ctl', { skip: process.platform === 'win32' }, () => {
  // Reintroduce by making stopSync async (or by an immediate stop): the recorded call below differs.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-pgsync-'));
  try {
    const bin = path.join(d, 'pg', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const argsFile = path.join(d, 'args.txt');
    // A pg_ctl stand-in that records how it was called and "stops" the server by removing postmaster.pid.
    fs.writeFileSync(path.join(bin, 'pg_ctl'), `#!/bin/sh\necho "$@" > "${argsFile}"\nrm -f "${path.join(d, 'data', 'postmaster.pid')}"\nexit 0\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(d, 'data'));
    const pg = new Postgres({ distDir: path.join(d, 'pg'), pgdata: path.join(d, 'data'), logFile: path.join(d, 'pg.log'), tmpDir: d, log: quiet });
    assert.equal(pg.stopSync(), 'not-running', 'no server, nothing to stop');
    fs.writeFileSync(path.join(d, 'data', 'postmaster.pid'), `${process.pid}\n`);
    const r = pg.stopSync();
    assert.equal(typeof r, 'string', 'stopSync is not synchronous');
    assert.equal(r, 'fast');
    assert.equal(fs.readFileSync(argsFile, 'utf8').trim(), `-D ${path.join(d, 'data')} -m fast -w -t 10 stop`);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
