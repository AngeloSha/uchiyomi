// Admin → Libraries → Delete files: what the toast says about the server's answer (lib/deleteFiles.ts).
//
// The server leaves a chapter file it may not look at (EACCES, an I/O error) on disk and counts it in `unchecked`. A
// toast that reads "Deleted 0 files" in green over that tells the admin the series is clean while its files are all
// still there, so a result with any unchecked file says how many were left and what to look at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteFilesNotice } from '../lib/deleteFiles';
import { LOCALES, setActiveDict } from '../lib/i18n';

test('a complete delete keeps its counted, translated success toast, from an older server too', () => {
  assert.deepEqual(deleteFilesNotice({ files: 1, bytes: 1048576 }), { message: 'Deleted 1 file, 1.0 MB', type: 'success' });
  assert.deepEqual(deleteFilesNotice({ files: 2, bytes: 2097152, unchecked: 0 }), { message: 'Deleted 2 files, 2.0 MB', type: 'success' });
});

test('a delete that left files it could not look at says how many, and what to check', () => {
  // Reintroduce the plain success toast: both of these read as a clean delete, in green.
  assert.deepEqual(deleteFilesNotice({ files: 1, bytes: 1048576, unchecked: 1 }), {
    message: "Deleted 1 file, 1.0 MB · 1 file could not be checked and was left alone. Check the folder's permissions.", type: 'info',
  });
  assert.deepEqual(deleteFilesNotice({ files: 0, bytes: 0, unchecked: 3 }), {
    message: "Deleted 0 files, 0.0 MB · 3 files could not be checked and were left alone. Check the folder's permissions.", type: 'info',
  });
});

test('every language says the whole partial-delete toast in its own words', () => {
  try {
    for (const { code } of LOCALES.filter((x) => x.code !== 'en')) {
      const dict = JSON.parse(readFileSync(join(__dirname, '../public/locales', `${code}.json`), 'utf8'));
      const keys = ['Deleted {n} files, {size}', '1 file could not be checked and was left alone', '{n} files could not be checked and were left alone', "Check the folder's permissions."];
      for (const key of keys) assert.ok(dict[key] && dict[key] !== key, `${code}: ${key}`);
      setActiveDict(dict);
      const notice = deleteFilesNotice({ files: 0, bytes: 0, unchecked: 2 });
      assert.equal(notice.type, 'info');
      assert.ok(notice.message.includes(dict["Check the folder's permissions."]), `${code}: ${notice.message}`);
      assert.ok(!notice.message.includes('{n}') && !notice.message.includes('{size}'), `${code}: ${notice.message}`);
    }
  } finally { setActiveDict({}); }
});
