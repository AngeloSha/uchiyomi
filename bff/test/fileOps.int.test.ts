// Renaming and deleting files in the user's own library.
//
// These are the only code paths in the app that write to a collection the user owns, so the tests that
// matter are the refusals.
//
// The one that would be worst to get wrong is a rename of a series split across both roots -- 146 of 210 on
// the instance this was built for. persistScan merges identical folderRel across roots, so renaming only the
// writable half leaves the old name live under the other one, and the next scan splits the series in two
// with half of everyone's progress on a row they cannot find. There is no scan-free window to do it in:
// scans run on every add, every updater sweep and the admin button.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, chmod, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-fo-${process.pid}`);
const DL = join(tmpdir(), `uchiyomi-fodl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let deleteSeriesFiles: any;
let renameSeriesFolder: any;

const S = 's_fo_series';
const FOLDER = 'T!fo/Berserk';

const exists = (p: string) => stat(p).then(() => true).catch(() => false);

async function seed(bothRoots: boolean) {
  await mkdir(join(ROOT, FOLDER), { recursive: true });
  await writeFile(join(ROOT, FOLDER, 'ch1.cbz'), 'one');
  if (bothRoots) {
    await mkdir(join(DL, FOLDER), { recursive: true });
    await writeFile(join(DL, FOLDER, 'ch2.cbz'), 'two');
  }
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!fo','Berserk',$2,1)`,
    [S, FOLDER],
  );
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
     VALUES ('b_fo_1',$1,'T!fo',$2,1,'Chapter 1',$3)`,
    [S, `${FOLDER}/ch1.cbz`, ROOT],
  );
  if (bothRoots) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ('b_fo_2',$1,'T!fo',$2,2,'Chapter 2',$3)`,
      [S, `${FOLDER}/ch2.cbz`, DL],
    );
  }
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const la = await import('../src/lib/libraryAdmin');
  deleteSeriesFiles = (la as any).deleteSeriesFiles;
  renameSeriesFolder = (la as any).renameSeriesFolder;
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await chmod(ROOT, 0o755).catch(() => {});
  await chmod(DL, 0o755).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true });
  await mkdir(DL, { recursive: true });
});

after(async () => {
  if (!DSN) return;
  await chmod(ROOT, 0o755).catch(() => {});
  await q('DELETE FROM lib_books WHERE series_id = $1', [S]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(DL, { recursive: true, force: true }).catch(() => {});
});

// ---- delete files ----

test('deleting files is refused unless the series is hidden first', { skip }, async () => {
  // The reversible step always happens first: hiding is undoable, deleting files is not.
  await seed(false);
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Remove the series first/i);
  assert.ok(await exists(join(ROOT, FOLDER, 'ch1.cbz')), 'a refused delete must not touch anything');
});

test('deleting files removes them from every root', { skip }, async () => {
  await seed(true);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, true);
  assert.equal(r.files, 2, 'both roots should have been cleared');
  assert.equal(await exists(join(ROOT, FOLDER)), false);
  assert.equal(await exists(join(DL, FOLDER)), false);
});

test('THE RULE: deleting files keeps the chapter rows and everyone\'s progress', { skip }, async () => {
  // read_progress.book_id is ON DELETE RESTRICT so a chapter row cannot silently take reading history with
  // it. Removing the bytes must not remove the record of having read them.
  await seed(false);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  await q(`DELETE FROM users WHERE username = 'fo-test'`);
  const u = await q<{ id: string }>(`INSERT INTO users (display_name, username, role, password_hash, auth_kind)
    VALUES ('F','fo-test','user','x','password') RETURNING id`);
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_fo_1',$2,20,true)`,
    [u[0].id, S],
  );
  try {
    assert.equal((await deleteSeriesFiles(S)).ok, true);
    assert.equal((await q('SELECT 1 FROM lib_books WHERE series_id = $1', [S])).length, 1, 'chapter rows were destroyed');
    assert.equal((await q('SELECT 1 FROM read_progress WHERE series_id = $1', [S])).length, 1, 'reading progress was destroyed');
  } finally {
    await q('DELETE FROM read_progress WHERE user_id = $1', [u[0].id]).catch(() => {});
    await q(`DELETE FROM users WHERE username = 'fo-test'`).catch(() => {});
  }
});

// ---- rename ----

test('a rename moves the folder in every root and rewrites the paths', { skip }, async () => {
  await seed(true);
  const r = await renameSeriesFolder(S, 'T!fo/Berserk (Deluxe)');
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.ok(await exists(join(ROOT, 'T!fo/Berserk (Deluxe)/ch1.cbz')));
  assert.ok(await exists(join(DL, 'T!fo/Berserk (Deluxe)/ch2.cbz')), 'the second root was left behind');
  assert.equal(await exists(join(ROOT, FOLDER)), false);

  const s = await q<{ folder: string; folder_prev: string }>('SELECT folder, folder_prev FROM lib_series WHERE id = $1', [S]);
  assert.equal(s[0].folder, 'T!fo/Berserk (Deluxe)');
  assert.equal(s[0].folder_prev, FOLDER, 'the breadcrumb column exists for exactly this');
  const files = await q<{ file: string }>('SELECT file FROM lib_books WHERE series_id = $1 ORDER BY file', [S]);
  assert.ok(files.every((f) => f.file.startsWith('T!fo/Berserk (Deluxe)/')), 'chapter paths were not rewritten');
});

test('ids and reading progress survive a rename', { skip }, async () => {
  await seed(true);
  const before1 = await q('SELECT id FROM lib_books WHERE series_id = $1 ORDER BY id', [S]);
  await renameSeriesFolder(S, 'T!fo/Renamed');
  assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1 ORDER BY id', [S]), before1, 'book ids changed');
  assert.equal((await q('SELECT id FROM lib_series WHERE id = $1', [S])).length, 1, 'the series id changed');
});

test('a rename is refused when the destination already exists', { skip }, async () => {
  await seed(true);
  await mkdir(join(DL, 'T!fo/Taken'), { recursive: true });
  const r = await renameSeriesFolder(S, 'T!fo/Taken');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already exists/i);
  // and nothing moved in the root where it WOULD have been free
  assert.ok(await exists(join(ROOT, FOLDER, 'ch1.cbz')), 'a refused rename half-applied');
});

test('THE REFUSAL: a rename is refused outright if any root is not writable', { skip: skip || asRoot }, async () => {
  // All roots or none. Renaming only the writable half is what splits a series in two on the next scan.
  await seed(true);
  await chmod(DL, 0o555);
  try {
    const r = await renameSeriesFolder(S, 'T!fo/Nope');
    assert.equal(r.ok, false, 'an unwritable root must refuse the whole rename');
    assert.match(r.fix ?? '', /PUID/, 'the refusal should say how to fix it');
    assert.ok(await exists(join(ROOT, FOLDER, 'ch1.cbz')), 'the writable root was renamed anyway');
    const s = await q<{ folder: string }>('SELECT folder FROM lib_series WHERE id = $1', [S]);
    assert.equal(s[0].folder, FOLDER, 'the database was changed despite the refusal');
  } finally {
    await chmod(DL, 0o755).catch(() => {});
  }
});

test('the same refusal, provable as any user: a root that is not there at all', { skip }, async () => {
  // The chmod test above is the realistic case but skips when running as root, and root is how the test
  // container happens to run. This exercises the same "every root must be usable or refuse" branch through
  // a missing root instead of an unwritable one, so the guard is covered no matter who runs the suite.
  await seed(true);
  await q(`UPDATE lib_books SET root = $1 WHERE id = 'b_fo_2'`, [join(tmpdir(), `uchiyomi-fo-absent-${process.pid}`)]);

  const r = await renameSeriesFolder(S, 'T!fo/Nope2');
  assert.equal(r.ok, false, 'a root that cannot be used must refuse the whole rename');
  assert.ok(await exists(join(ROOT, FOLDER, 'ch1.cbz')), 'the usable root was renamed anyway');
  const row = await q<{ folder: string }>('SELECT folder FROM lib_series WHERE id = $1', [S]);
  assert.equal(row[0].folder, FOLDER, 'the database changed despite the refusal');
});

test('a rename to a path outside the library is refused', { skip }, async () => {
  await seed(false);
  const r = await renameSeriesFolder(S, '../escaped');
  assert.equal(r.ok, false);
  assert.ok(await exists(join(ROOT, FOLDER, 'ch1.cbz')));
});

test('renaming to the same name is refused rather than doing nothing quietly', { skip }, async () => {
  await seed(false);
  const r = await renameSeriesFolder(S, FOLDER);
  assert.equal(r.ok, false);
  assert.match(r.reason, /different/i);
});
