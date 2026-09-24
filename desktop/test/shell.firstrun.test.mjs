// First run: which folders may hold the library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultLibraryDir, checkLibraryDir, prepareLibraryDir } = require('../src/firstrun.js');

test('the default is "Uchiyomi Library" in the home folder -- not Documents', () => {
  // Reintroduce by defaulting to Documents: the default then carries the sync warning.
  assert.equal(defaultLibraryDir('/Users/ana'), '/Users/ana/Uchiyomi Library');
  assert.equal(defaultLibraryDir('C:\\Users\\Jösé 名前', path.win32), 'C:\\Users\\Jösé 名前\\Uchiyomi Library');
  const c = checkLibraryDir(defaultLibraryDir('/Users/ana'), { dataRoot: '/Users/ana/Library/Application Support/Uchiyomi', home: '/Users/ana', platform: 'darwin', env: {} });
  assert.deepEqual(c, { ok: true, dir: '/Users/ana/Uchiyomi Library' });
});

test("never inside the app's own data folder, nor around it (the bff refuses nested libraries)", () => {
  // Reintroduce by checking only one direction of isInside: the data root's parent passes.
  const w = { dataRoot: 'C:\\Users\\a\\AppData\\Local\\Uchiyomi', home: 'C:\\Users\\a', platform: 'win32', env: {}, impl: path.win32 };
  for (const d of ['C:\\Users\\a\\AppData\\Local\\Uchiyomi', 'C:\\Users\\a\\AppData\\Local\\Uchiyomi\\manga', 'c:\\users\\A\\appdata\\local\\uchiyomi\\x', 'C:\\Users\\a\\AppData']) {
    const c = checkLibraryDir(d, w);
    assert.equal(c.ok, false, d);
    assert.match(c.error, /own data/);
  }
  assert.equal(checkLibraryDir('C:\\', w).ok, false);
  assert.equal(checkLibraryDir('C:\\Users\\a', w).ok, false);
  assert.equal(checkLibraryDir('relative\\dir', w).ok, false);
  assert.equal(checkLibraryDir('D:\\Manga', w).ok, true);
});

test('synced folders warn (OneDrive, Documents, iCloud Drive, Desktop on a Mac) but may be chosen anyway', () => {
  // Reintroduce by dropping the OneDrive environment variables: a redirected OneDrive folder gets no warning.
  const win = { dataRoot: 'C:\\Users\\a\\AppData\\Local\\Uchiyomi', home: 'C:\\Users\\a', platform: 'win32', env: { OneDrive: 'C:\\Users\\a\\OneDrive - Contoso' }, impl: path.win32 };
  assert.match(checkLibraryDir('C:\\Users\\a\\OneDrive - Contoso\\Manga', win).warning, /OneDrive/);
  assert.match(checkLibraryDir('C:\\Users\\a\\Documents\\Manga', win).warning, /Documents/);
  assert.equal(checkLibraryDir('C:\\Users\\a\\Uchiyomi Library', win).warning, undefined);
  const mac = { dataRoot: '/Users/a/Library/Application Support/Uchiyomi', home: '/Users/a', platform: 'darwin', env: {} };
  assert.match(checkLibraryDir('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/Manga', mac).warning, /iCloud/);
  assert.match(checkLibraryDir('/Users/a/Desktop/Manga', mac).warning, /Desktop/);
  assert.equal(checkLibraryDir('/Users/a/Desktop/Manga', mac).ok, true);
});

test('prepareLibraryDir makes the folder and proves it can write there', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  // Reintroduce by skipping the probe write: a read-only folder is accepted.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uchi-first-'));
  try {
    const d = path.join(tmp, 'a', 'Uchiyomi Library');
    assert.deepEqual(prepareLibraryDir(d), { ok: true });
    assert.deepEqual(fs.readdirSync(d), [], 'the probe file is removed again');
    const ro = path.join(tmp, 'ro');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    // An existing read-only folder: making it succeeds, so only the probe write can tell.
    const r = prepareLibraryDir(ro);
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot write/);
    assert.equal(prepareLibraryDir(path.join(ro, 'lib')).ok, false);
  } finally {
    fs.chmodSync(path.join(tmp, 'ro'), 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
