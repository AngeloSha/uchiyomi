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
// A neighbour whose present file is the proof that a root is mounted, and a row merged into S.
const N = 's_fo_neighbour';
const M = 's_fo_merged';
const ALL = [S, N, M];

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
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
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
  await q('DELETE FROM lib_books WHERE series_id = ANY($1)', [ALL]).catch(() => {});
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
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

test('delete files marks the rows pruned with reason deleted, and only the rows whose file it removed', { skip }, async () => {
  // Until v0.37.0 the rows were left live after their bytes went: Put back then listed every chapter as
  // openable and each one 404'd, and the have-set counted them as held so nothing was ever fetched again.
  // The mark is the same one the chapter-level delete leaves (tombstoneBooks), with the reason that keeps it
  // held -- a deliberate deletion is not the verify task's 'missing'. Reintroduce by dropping the
  // tombstoneBooks call at the end of deleteSeriesFiles: pruned_at below reads null.
  await seed(true);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, true);
  const rows = await q<{ id: string; pruned_at: string | null; pruned_reason: string | null }>(
    'SELECT id, pruned_at, pruned_reason FROM lib_books WHERE series_id = $1 ORDER BY id', [S]);
  assert.equal(rows.length, 2, 'the rows must survive (everyone\'s progress hangs off them)');
  for (const row of rows) {
    assert.ok(row.pruned_at, `${row.id} still claims bytes that are gone`);
    assert.equal(row.pruned_reason, 'deleted', `${row.id} must say WHY, or the sweep cannot tell it from a missing file`);
  }
});

test('delete files leaves an absent file\'s row alone', { skip }, async () => {
  // ⚠️ A file that is not there is not a file this removed: on an unmounted share every stat fails while
  // every file is fine on the disk that is not here, and "Delete files" must not turn that into a library
  // of tombstones. The download root here has NOTHING present -- not this series' file, not anyone's --
  // which is exactly what an absent volume looks like, so its row stays as it was. `files` counts unlinks,
  // not rows, for the same reason: a second press used to report "Deleted 2 file(s)" for rows it had not
  // touched. Reintroduce by tombstoning every row of the root regardless of `st` (or by counting `files++`
  // before the stat): the download-root row below reads pruned, or `files` reads 2.
  await seed(true);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  await rm(join(DL, FOLDER, 'ch2.cbz'));
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, true);
  assert.equal(r.files, 1, 'only the file that was actually there counts as deleted');
  const [lib, dl] = await Promise.all([
    q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE id = $1', ['b_fo_1']),
    q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE id = $1', ['b_fo_2']),
  ]);
  assert.ok(lib[0].pruned_at, 'the row whose file was removed is marked');
  assert.equal(dl[0].pruned_at, null, 'a row whose file was already absent must not be marked by a delete');
});

/** A neighbouring series on `root`, with (or without) its one chapter file on disk. */
async function neighbour(root: string, present: boolean) {
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!fo','Neighbour','T!fo/Neighbour',1)
           ON CONFLICT (id) DO NOTHING`, [N]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!fo','T!fo/Neighbour/ch1.cbz',1,'Chapter 1',$3)`,
    [`b_fo_n_${root === DL ? 'dl' : 'lib'}`, N, root]);
  if (present) {
    await mkdir(join(root, 'T!fo/Neighbour'), { recursive: true });
    await writeFile(join(root, 'T!fo/Neighbour/ch1.cbz'), 'neighbour');
  }
}

test('Delete files on an empty readable root marks nothing', { skip }, async () => {
  // ⚠️ THE PROOF. An empty, readable directory is what a share that is not mounted leaves behind (and what
  // the image ships /library as), so a root where no chapter file of ANY series is present proves nothing
  // about any single row -- verify's whole-batch rule, applied here. The series' own rows are absent on
  // both roots; the neighbour's row on the download root is absent too (its file is not there either); the
  // neighbour's folder EXISTS but is empty, which must not count (the downloader mkdir -p's folders on a
  // bare mount point). Reintroduce by dropping the present-file proof in deleteSeriesFiles (tombstoning
  // `absentLive` without rootProven, or counting a present folder as proof): both rows below read pruned.
  await seed(true);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  await rm(join(ROOT, FOLDER, 'ch1.cbz'));
  await rm(join(DL, FOLDER, 'ch2.cbz'));
  await neighbour(DL, false);
  await mkdir(join(DL, 'T!fo/Neighbour'), { recursive: true });
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.files, 0);
  const rows = await q<{ id: string; pruned_at: string | null }>('SELECT id, pruned_at FROM lib_books WHERE series_id = $1 ORDER BY id', [S]);
  for (const row of rows) assert.equal(row.pruned_at, null, `${row.id} was marked on a root nothing proves is mounted`);
});

test('Delete files reconciles absent rows and missing tombstones on a root another series proves mounted', { skip }, async () => {
  // The other half of the proof: one present file of any series on the root is the volume being there, so a
  // row of THIS series whose file is absent was deleted by hand, and a 'missing' tombstone (verify's mark,
  // written only on a proven root) is a file that is not coming back by itself -- both become 'deleted', the
  // mark the sweep does not fetch back and the Removed row counts as files-gone (live_books 0), which is what
  // lets #55's hand-deleted series reach Forget. On the read library too: verify never marks a read-library
  // row, so this is the ONLY place such a row is ever reconciled. Reintroduce by dropping `reconciled` (or
  // the 'missing' UPDATE): a row below reads live, or still 'missing'.
  await seed(true);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root, pruned_at, pruned_reason)
           VALUES ('b_fo_3',$1,'T!fo',$2,3,'Chapter 3',$3, now(), 'missing')`, [S, `${FOLDER}/ch3.cbz`, DL]);
  await rm(join(ROOT, FOLDER, 'ch1.cbz'));
  await rm(join(DL, FOLDER, 'ch2.cbz'));
  await neighbour(ROOT, true);
  await neighbour(DL, true);
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.files, 0, 'nothing of this series was on disk to unlink');
  const rows = await q<{ id: string; pruned_at: string | null; pruned_reason: string | null }>(
    'SELECT id, pruned_at, pruned_reason FROM lib_books WHERE series_id = $1 ORDER BY id', [S]);
  assert.deepEqual(rows.map((x) => [x.id, !!x.pruned_at, x.pruned_reason]),
    [['b_fo_1', true, 'deleted'], ['b_fo_2', true, 'deleted'], ['b_fo_3', true, 'deleted']]);
  const n = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE series_id = $1', [N]);
  assert.ok(n.every((x) => x.pruned_at === null), "the neighbour's rows were marked");
  assert.ok(await exists(join(ROOT, 'T!fo/Neighbour/ch1.cbz')), "the neighbour's file was deleted");
});

test('delete files removes the folder of a row merged into the series', { skip }, async () => {
  // A merge moves the absorbed row's chapters to the survivor but their files stay under the absorbed
  // folder, so the survivor's Delete files unlinks them there -- and used to leave that directory standing,
  // empty, for Forget to refuse on forever (R3's probe P2). Reintroduce by rm'ing `row.folder` only: the
  // absorbed directory below still exists.
  await seed(false);
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [S]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, merged_into) VALUES ($1,'T!fo','Berserk (dup)','T!fo/Berserk dup',1,$2)`, [M, S]);
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ('b_fo_m1',$1,'T!fo','T!fo/Berserk dup/ch1.cbz',1,'Chapter 1',$2)`, [S, ROOT]);
  await mkdir(join(ROOT, 'T!fo/Berserk dup'), { recursive: true });
  await writeFile(join(ROOT, 'T!fo/Berserk dup/ch1.cbz'), 'dup');
  const r = await deleteSeriesFiles(S);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.files, 2, "the absorbed row's file was not unlinked");
  assert.equal(await exists(join(ROOT, FOLDER)), false);
  assert.equal(await exists(join(ROOT, 'T!fo/Berserk dup')), false, 'the absorbed folder was left standing');
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
