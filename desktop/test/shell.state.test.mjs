// state.js: state.json and secrets.json are written to a temporary file and renamed over the real one. On Windows that
// rename fails with EPERM while another process has the target open for a moment -- the desktop CI's S5 script polls
// state.json, and so can an antivirus or a backup -- and the first such collision failed the whole startup
// (2026-10-14, v0.64.0's PR: "EPERM: operation not permitted, rename 'state.json.840.tmp' -> 'state.json'").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const state = require('../src/state.js');

const busy = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test('a rename Windows calls busy is tried again until it goes through', () => {
  // Reintroduce by calling fs.renameSync once (no retry): this throws EPERM on the first try.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let calls = 0;
    state.renameRetrying('a', 'b', () => { calls++; if (calls < 3) throw busy(code); });
    assert.equal(calls, 3, `${code} was not retried`);
  }
});

test('any other error is thrown at once, and a target that stays busy gives up after about two seconds', () => {
  let calls = 0;
  assert.throws(() => state.renameRetrying('a', 'b', () => { calls++; throw busy('ENOENT'); }), /ENOENT/);
  assert.equal(calls, 1, 'a missing file was retried as if it were busy');
  // Reintroduce by retrying forever: this never returns (the test times out).
  const t = Date.now();
  assert.throws(() => state.renameRetrying('a', 'b', () => { throw busy('EPERM'); }), /EPERM/);
  const took = Date.now() - t;
  assert.ok(took >= state.BUSY_MS - 50 && took < state.BUSY_MS + 1500, `gave up after ${took} ms`);
});

test('write() replaces the file, and leaves no temporary copy behind when the rename finally fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  state.write(file, { uiPort: 1 });
  state.update(file, (s) => { s.mainPid = 2; });
  assert.deepEqual(state.read(file), { uiPort: 1, mainPid: 2 });
  // A rename that never succeeds: the error reaches the caller, and the .tmp (secrets.json's would hold the password)
  // is removed rather than left beside the real file.
  const real = fs.renameSync;
  fs.renameSync = () => { throw busy('EACCES'); };
  try {
    assert.throws(() => state.write(file, { uiPort: 3 }), /EACCES/);
  } finally {
    fs.renameSync = real;
  }
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'a temporary copy was left behind');
  assert.deepEqual(state.read(file), { uiPort: 1, mainPid: 2 }, 'the real file changed');
});
