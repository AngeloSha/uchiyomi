// reconcileLibrary (lib/library.ts): the fix for a database restored from a backup, which never includes
// DL_ROOT -- so a restored dump is a pile of un-pruned lib_books rows whose files were never brought back.
// The updater's have-set trusts any such row at face value, so those chapters report "up to date" forever.
// This file pins reconcileLibrary's half: a row with no real file behind it is removed, unless reading
// history holds it back, in which case it is tombstoned instead -- and an entire library that LOOKS gone is
// left alone, because that is what an unmounted volume looks like too.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = join(tmpdir(), `uchiyomi-rcl-${process.pid}`);
const ROOT = join(TMP, 'lib');
const DL = join(TMP, 'dl');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = ROOT;
  process.env.DL_ROOT = DL;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let reconcileLibrary: () => Promise<{ checked: number; deleted: number; tombstoned: number; skipped?: string }>;

const S = (k: string) => `s_rcl_${k}`;
const exists = (p: string) => stat(p).then(() => true).catch(() => false);

async function file(abs: string) {
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, 'not a real cbz, just needs to exist');
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ reconcileLibrary } = (await import('../src/lib/library')) as any);
  await migrate();
});

// reconcileLibrary reads the WHOLE lib_books table, unscoped by series -- that is the point of it -- so
// this file owns the table for the duration of its run rather than filtering by an id prefix like its
// neighbours. Safe against the rest of the suite because node's test runner (--test-concurrency=1 in
// package.json) runs one FILE at a time, never this file racing another's fixtures.
beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress`).catch(() => {});
  await q(`DELETE FROM lib_books`).catch(() => {});
  await q(`DELETE FROM lib_series`).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
  // The mount points themselves exist, the way a real Docker volume always does even when nothing has been
  // written into it yet: what most of these tests are missing is a series' own subfolder, not the volume.
  await mkdir(DL, { recursive: true });
  await mkdir(ROOT, { recursive: true });
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM read_progress`).catch(() => {});
  await q(`DELETE FROM lib_books`).catch(() => {});
  await q(`DELETE FROM lib_series`).catch(() => {});
  await q(`DELETE FROM users WHERE username = $1`, ['rcl-user']).catch(() => {});
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

test('a row whose file never came back with the restore is removed, so the number is missing again', { skip }, async () => {
  const id = S('gone');
  const folder = 'T!rcl/Gone';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rcl','Gone',$2,1)`, [id, folder]);
  // No file written at all: exactly what a database-only restore leaves behind.
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!rcl',$3,1,'Chapter 1',$4)`,
    [`${id}_b1`, id, `${folder}/Chapter 1.cbz`, DL],
  );

  const r = await reconcileLibrary();
  assert.equal(r.deleted, 1, 'a row with no reading history and no file must be removed outright');
  assert.equal(r.tombstoned, 0);
  assert.deepEqual(await q('SELECT id FROM lib_books WHERE series_id = $1', [id]), [], 'the row is gone, not merely marked');
  const [row] = await q<{ books_count: number }>('SELECT books_count FROM lib_series WHERE id = $1', [id]);
  assert.equal(Number(row.books_count), 0, 'the count follows the same rule persistScan uses');
});

test('a row with reading history is tombstoned, never deleted', { skip }, async () => {
  const id = S('read');
  const folder = 'T!rcl/Read';
  await q('DELETE FROM users WHERE username = $1', ['rcl-user']).catch(() => {});
  const [{ id: uid }] = await q<{ id: string }>(
    `INSERT INTO users (display_name, username, role, password_hash, auth_kind) VALUES ('rcl','rcl-user','user','x','password') RETURNING id`,
  );
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rcl','Read',$2,1)`, [id, folder]);
  const bookId = `${id}_b1`;
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!rcl',$3,1,'Chapter 1',$4)`,
    [bookId, id, `${folder}/Chapter 1.cbz`, DL],
  );
  await q(
    `INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,$2,$3,1,true)`,
    [uid, bookId, id],
  );

  const r = await reconcileLibrary();
  assert.equal(r.deleted, 0, 'the FK must refuse the delete, before this ever tries it');
  assert.equal(r.tombstoned, 1);
  const [row] = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE id = $1', [bookId]);
  assert.ok(row.pruned_at, 'left as an honest tombstone, not silently kept as if the file were there');

  await q('DELETE FROM read_progress WHERE user_id = $1', [uid]);
  await q('DELETE FROM users WHERE id = $1', [uid]);
});

test('a row whose file IS there is left alone', { skip }, async () => {
  const id = S('live');
  const folder = 'T!rcl/Live';
  await file(join(DL, folder, 'Chapter 1.cbz'));
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rcl','Live',$2,1)`, [id, folder]);
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!rcl',$3,1,'Chapter 1',$4)`,
    [`${id}_b1`, id, `${folder}/Chapter 1.cbz`, DL],
  );

  const r = await reconcileLibrary();
  assert.equal(r.deleted, 0);
  assert.equal(r.tombstoned, 0);
  const [row] = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE series_id = $1', [id]);
  assert.equal(row.pruned_at, null);
});

test('an already-pruned row is left alone -- the read-cleanup tombstone is not this job\'s business', { skip }, async () => {
  const id = S('pruned');
  const folder = 'T!rcl/Pruned';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rcl','Pruned',$2,1)`, [id, folder]);
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root, pruned_at) VALUES ($1,$2,'T!rcl',$3,1,'Chapter 1',$4,now())`,
    [`${id}_b1`, id, `${folder}/Chapter 1.cbz`, DL],
  );

  const r = await reconcileLibrary();
  assert.equal(r.checked, 0, 'an already-pruned row is not even a candidate');
  assert.equal(r.deleted, 0);
  assert.equal(r.tombstoned, 0);
});

test('a whole missing folder costs one stat, not one per chapter, and every book in it is caught', { skip }, async () => {
  const id = S('folder');
  const folder = 'T!rcl/WholeFolder';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rcl','WholeFolder',$2,3)`, [id, folder]);
  for (const n of [1, 2, 3]) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!rcl',$3,$4,$5,$6)`,
      [`${id}_b${n}`, id, `${folder}/Chapter ${n}.cbz`, n, `Chapter ${n}`, DL],
    );
  }
  // The folder itself is never created under DL at all.
  assert.equal(await exists(join(DL, folder)), false, 'PREMISE: the folder was never restored');

  const r = await reconcileLibrary();
  assert.equal(r.deleted, 3, 'every chapter in the missing folder is caught, not just the ones stat individually');
});

test('a library that looks entirely gone is left untouched -- that is what an unmounted volume looks like', { skip }, async () => {
  const id = S('unmounted');
  const folder = 'T!rcl/Unmounted';
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!rcl','Unmounted',$2,1)`, [id, folder]);
  const bookId = `${id}_b1`;
  await q(
    `INSERT INTO lib_books (id, series_id, source, file, number, title, root) VALUES ($1,$2,'T!rcl',$3,1,'Chapter 1',$4)`,
    [bookId, id, `${folder}/Chapter 1.cbz`, DL],
  );
  // Point DL_ROOT itself at a path that does not exist, the way an unmounted share would: every folder
  // check fails, not just this one series' -- which is the signal reconcileLibrary refuses to act on.
  await rm(TMP, { recursive: true, force: true });

  const r = await reconcileLibrary();
  assert.equal(r.skipped, 'unmounted');
  assert.equal(r.deleted, 0);
  assert.equal(r.tombstoned, 0);
  const [row] = await q<{ pruned_at: string | null }>('SELECT pruned_at FROM lib_books WHERE id = $1', [bookId]);
  assert.equal(row.pruned_at, null, 'nothing was touched, unlike a real single-series removal');
});
