// Admin → Libraries → Delete files: what the toast says about the server's answer (lib/deleteFiles.ts).
//
// The server leaves a chapter file it may not look at (EACCES, an I/O error) on disk and counts it in `unchecked`. A
// toast that reads "Deleted 0 files" in green over that tells the admin the series is clean while its files are all
// still there, so a result with any unchecked file says how many were left and what to look at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteFilesNotice, notOnDiskTitle } from '../lib/deleteFiles';
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

test('a folder deleted by hand says its files were already gone, not "Deleted 0 files" (#328)', () => {
  // Reintroduce the plain count for it: the toast reads "Deleted 0 files, 0.0 MB" in green while the chapters were
  // just marked and Forget is offered next.
  assert.deepEqual(deleteFilesNotice({ files: 0, bytes: 0, unchecked: 0, gone: 24, unproven: 0 }),
    { message: 'Its files were already gone. Its chapters are marked deleted.', type: 'success' });
  // Some deleted, the rest already gone: the count of what this call deleted, as before.
  assert.deepEqual(deleteFilesNotice({ files: 2, bytes: 2097152, gone: 3 }), { message: 'Deleted 2 files, 2.0 MB', type: 'success' });
  assert.equal(notOnDiskTitle(1), '1 chapter file is not on disk');
  assert.equal(notOnDiskTitle(24), '24 chapter files are not on disk');
});

test('the Removed list asks before marking files it could not prove gone, and asks with the same call (#328)', () => {
  // The question appears only for an answer with `unproven` rows, says nothing in green over it, and its yes is the
  // same call with `gone: true`. Reintroduce by toasting every answer: "Deleted 0 files" sits on top of the question.
  const src = readFileSync(join(__dirname, '../app/admin/page.tsx'), 'utf8');
  const fn = src.slice(src.indexOf('const deleteFiles = async (r: DeletedRow, gone = false)'), src.indexOf('const toast = useToast();', src.indexOf('function LibraryPanel')));
  assert.ok(fn.length > 0, 'no deleteFiles in the Removed list');
  assert.match(fn, /json: gone \? \{ confirm: r\.title, gone: true \} : \{ confirm: r\.title \}/, 'the yes is not the same call with gone');
  assert.match(fn, /if \(res\.files \|\| res\.gone \|\| res\.unchecked \|\| !res\.unproven\) toast\(/, 'a green "Deleted 0 files" sits over the question');
  assert.match(fn, /setNotThere\(!gone && res\.unproven \? \{ row: r, n: res\.unproven \} : null\)/, 'the question is not asked for unproven rows');
  const dlg = src.slice(src.indexOf('{notThere && ('), src.indexOf('onClose={() => setNotThere(null)}'));
  assert.ok(dlg.includes('title={notOnDiskTitle(notThere.n)}'), 'the question has no counted title');
  assert.ok(dlg.includes("confirmLabel={tr('Mark them gone')}"), 'the yes is not "Mark them gone"');
  assert.ok(dlg.includes('onConfirm={() => deleteFiles(notThere.row, true)}'), 'the yes does not mark them');
  assert.ok(!/\n\s*danger\n/.test(dlg), 'marking rows is not the irreversible step: no rose button');
});

test('every language says the whole partial-delete toast in its own words', () => {
  try {
    for (const { code } of LOCALES.filter((x) => x.code !== 'en')) {
      const dict = JSON.parse(readFileSync(join(__dirname, '../public/locales', `${code}.json`), 'utf8'));
      const keys = ['Deleted {n} files, {size}', '1 file could not be checked and was left alone', '{n} files could not be checked and were left alone', "Check the folder's permissions.",
        // v0.95.0 (#328): the files already gone, and the question about the ones it could not prove gone.
        'Its files were already gone. Its chapters are marked deleted.', '1 chapter file is not on disk', '{n} chapter files are not on disk', 'Mark them gone',
        "Uchiyomi can't tell a file you deleted from one on a drive that isn't connected right now, so it left them as they were. If you deleted or moved them yourself, mark them gone. Then you can forget the series."];
      for (const key of keys) assert.ok(dict[key] && dict[key] !== key, `${code}: ${key}`);
      setActiveDict(dict);
      const notice = deleteFilesNotice({ files: 0, bytes: 0, unchecked: 2 });
      assert.equal(notice.type, 'info');
      assert.ok(notice.message.includes(dict["Check the folder's permissions."]), `${code}: ${notice.message}`);
      assert.ok(!notice.message.includes('{n}') && !notice.message.includes('{size}'), `${code}: ${notice.message}`);
    }
  } finally { setActiveDict({}); }
});
