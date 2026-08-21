// What persistScan() actually writes, against a real Postgres and a real library on disk.
//
// This file exists because library identity is about to stop being derived from the file path, and
// persistScan had NO tests at all — despite deciding every series id, every book id, and therefore what a
// user's reading progress is attached to. A mistake there is silent: the library still renders, the rows
// still exist, and the progress is simply on a row nothing points at any more.
//
// So these pin CURRENT behaviour, bugs included. Where today's behaviour is wrong, the test name says so and
// asserts the wrong thing on purpose. When the identity work lands, those specific tests are expected to
// fail, and each failure should be a line someone chose to change.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, rename, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;

// Roots are read at module load (`process.env.LIBRARY_ROOT || '/library'`), so they must be set before the
// first import of library.ts. mkdtempSync would be neater but these have to exist before any await.
const ROOT_A = join(tmpdir(), `uchiyomi-lib-${process.pid}`);
const ROOT_B = join(tmpdir(), `uchiyomi-dl-${process.pid}`);

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_ROOT = ROOT_A;
  process.env.DL_ROOT = ROOT_B;
}

const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

type Q = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let q: Q;
let persistScan: () => Promise<{ series: number; books: number; ms: number }>;

/** A minimal but genuinely valid CBZ: one page plus a ComicInfo.xml the scanner can parse. */
async function writeCbz(abs: string, opts: { series?: string; number?: number; pages?: number; pixel?: string } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const pages = opts.pages ?? 1;
  for (let i = 1; i <= pages; i++) {
    zip.addFile(`${String(i).padStart(3, '0')}.jpg`, Buffer.from(opts.pixel ?? `page-${i}-bytes`));
  }
  if (opts.series) {
    zip.addFile(
      'ComicInfo.xml',
      Buffer.from(
        `<?xml version="1.0"?><ComicInfo><Series>${opts.series}</Series>` +
          `<Number>${opts.number ?? 1}</Number><Writer>A. Writer</Writer>` +
          `<Genre>Action, Drama</Genre><Web>https://example.invalid/x</Web>` +
          `<Summary>A summary.</Summary></ComicInfo>`,
      ),
    );
  }
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, zip.toBuffer());
}

const seriesDir = (root: string, source: string, title: string) => join(root, source, title);
const chapter = (root: string, source: string, title: string, file: string) => join(root, source, title, file);

/** Remove every row this file created, identified by the temp folder prefix. */
async function wipe() {
  await q(`DELETE FROM lib_books WHERE root = $1 OR root = $2`, [ROOT_A, ROOT_B]);
  await q(`DELETE FROM lib_series WHERE source LIKE 'T!%'`);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as { q: Q });
  ({ persistScan } = await import('../src/lib/library'));
  await migrate();
  await mkdir(ROOT_A, { recursive: true });
  await mkdir(ROOT_B, { recursive: true });
  await wipe();
});

after(async () => {
  if (!DSN) return;
  await wipe().catch(() => {});
  await rm(ROOT_A, { recursive: true, force: true }).catch(() => {});
  await rm(ROOT_B, { recursive: true, force: true }).catch(() => {});
});

const oneSeries = async (folder: string) =>
  (await q(`SELECT * FROM lib_series WHERE folder = $1`, [folder]))[0];
const booksOf = async (seriesId: string) =>
  q(`SELECT id, file, root, number, title FROM lib_books WHERE series_id = $1 ORDER BY file`, [seriesId]);

test('persistScan: a fresh scan creates the series and its chapters', { skip }, async () => {
  const src = 'T!fresh';
  await writeCbz(chapter(ROOT_A, src, 'Solo Leveling', 'Chapter 1.cbz'), { series: 'Solo Leveling', number: 1 });
  await writeCbz(chapter(ROOT_A, src, 'Solo Leveling', 'Chapter 2.cbz'), { series: 'Solo Leveling', number: 2 });

  await persistScan();

  const s = await oneSeries(`${src}/Solo Leveling`);
  assert.ok(s, 'series row was not created');
  assert.equal(s.title, 'Solo Leveling', 'title should come from ComicInfo <Series>');
  assert.equal(s.author, 'A. Writer');
  assert.deepEqual(s.genres, ['Action', 'Drama']);
  assert.equal(s.books_count, 2);

  const books = await booksOf(s.id);
  assert.equal(books.length, 2);
  assert.deepEqual(books.map((b) => b.number), [1, 2]);
  assert.deepEqual(books.map((b) => b.title), ['Chapter 1', 'Chapter 2']);
  assert.ok(books.every((b) => b.root === ROOT_A));
});

test('persistScan: cover_book_id points at a book row that actually exists', { skip }, async () => {
  // The scanner computes cover_book_id by hashing a path rather than reading it back, so it is only correct
  // as long as ids are a pure function of the path. This is the single assertion most likely to catch the
  // identity change breaking every cover in the product.
  const src = 'T!cover';
  await writeCbz(chapter(ROOT_A, src, 'Cover Test', 'Chapter 1.cbz'), { series: 'Cover Test' });
  await writeCbz(chapter(ROOT_A, src, 'Cover Test', 'Chapter 2.cbz'), { series: 'Cover Test' });
  await persistScan();

  const s = await oneSeries(`${src}/Cover Test`);
  assert.ok(s.cover_book_id, 'no cover_book_id was set');
  const hit = await q(`SELECT id, file FROM lib_books WHERE id = $1`, [s.cover_book_id]);
  assert.equal(hit.length, 1, `cover_book_id ${s.cover_book_id} does not resolve to a book`);
  assert.equal(hit[0].file, `${src}/Cover Test/Chapter 1.cbz`, 'cover should be the first chapter');
});

test('persistScan: rescanning changes nothing — same ids, same counts', { skip }, async () => {
  const src = 'T!idem';
  await writeCbz(chapter(ROOT_A, src, 'Idem', 'Chapter 1.cbz'), { series: 'Idem' });
  await persistScan();
  const before1 = await oneSeries(`${src}/Idem`);
  const beforeBooks = await booksOf(before1.id);

  await persistScan();
  const after1 = await oneSeries(`${src}/Idem`);
  const afterBooks = await booksOf(after1.id);

  assert.equal(after1.id, before1.id, 'series id changed on rescan');
  assert.equal(after1.books_count, before1.books_count);
  assert.deepEqual(afterBooks.map((b) => b.id), beforeBooks.map((b) => b.id), 'book ids changed on rescan');
  const total = await q(`SELECT count(*)::int n FROM lib_series WHERE folder = $1`, [`${src}/Idem`]);
  assert.equal(total[0].n, 1, 'rescan duplicated the series row');
});

test('persistScan: adding a chapter adds one book and keeps the series id', { skip }, async () => {
  const src = 'T!add';
  await writeCbz(chapter(ROOT_A, src, 'Growing', 'Chapter 1.cbz'), { series: 'Growing' });
  await persistScan();
  const before1 = await oneSeries(`${src}/Growing`);

  await writeCbz(chapter(ROOT_A, src, 'Growing', 'Chapter 2.cbz'), { series: 'Growing' });
  await persistScan();
  const after1 = await oneSeries(`${src}/Growing`);

  assert.equal(after1.id, before1.id);
  assert.equal(after1.books_count, 2);
});

test('persistScan: re-downloading a chapter in place keeps the same book id', { skip }, async () => {
  // Replacing a broken chapter is a normal user action, and it must not look like a new book — the reading
  // progress is attached to the id.
  const src = 'T!redl';
  const file = chapter(ROOT_A, src, 'Redownload', 'Chapter 1.cbz');
  await writeCbz(file, { series: 'Redownload', pages: 1 });
  await persistScan();
  const s = await oneSeries(`${src}/Redownload`);
  const [bookBefore] = await booksOf(s.id);

  await writeCbz(file, { series: 'Redownload', pages: 5, pixel: 'different-bytes-entirely' });
  await persistScan();
  const [bookAfter] = await booksOf(s.id);

  assert.equal(bookAfter.id, bookBefore.id, 'a re-download changed the book id');
});

test('persistScan: TODAY renaming a folder orphans the series — this is the bug being fixed', { skip }, async () => {
  const src = 'T!rename';
  await writeCbz(chapter(ROOT_A, src, 'Old Name', 'Chapter 1.cbz'), { series: 'Old Name' });
  await persistScan();
  const before1 = await oneSeries(`${src}/Old Name`);

  await rename(seriesDir(ROOT_A, src, 'Old Name'), seriesDir(ROOT_A, src, 'New Name'));
  await persistScan();

  const after1 = await oneSeries(`${src}/New Name`);
  assert.ok(after1, 'renamed folder produced no series');
  assert.notEqual(after1.id, before1.id, 'EXPECTED TO FAIL once identity is decoupled: id should survive a rename');

  const ghost = await oneSeries(`${src}/Old Name`);
  assert.ok(ghost, 'EXPECTED TO FAIL later: the old row survives today because the scanner never deletes');
  assert.equal(ghost.books_count, 1, 'and it keeps a stale count for files that no longer exist');
});

test('persistScan: TODAY a file deleted from disk keeps its row forever', { skip }, async () => {
  const src = 'T!prune';
  await writeCbz(chapter(ROOT_A, src, 'Pruned', 'Chapter 1.cbz'), { series: 'Pruned' });
  await writeCbz(chapter(ROOT_A, src, 'Pruned', 'Chapter 2.cbz'), { series: 'Pruned' });
  await persistScan();
  const s = await oneSeries(`${src}/Pruned`);
  assert.equal(s.books_count, 2);

  await rm(chapter(ROOT_A, src, 'Pruned', 'Chapter 2.cbz'));
  await persistScan();

  const after1 = await oneSeries(`${src}/Pruned`);
  const books = await booksOf(after1.id);
  assert.equal(books.length, 2, 'EXPECTED TO FAIL once pruning lands: the deleted chapter still has a row');
  assert.equal(after1.books_count, 2, 'and books_count stays permanently wrong');
});

test('persistScan: the same series under BOTH roots merges into one row', { skip }, async () => {
  // 146 of 210 series on the live instance are in this shape, so it is load-bearing, not an edge case:
  // a series part-downloaded by the extension engine into one root and by Uchiyomi into the other.
  const src = 'T!tworoot';
  await writeCbz(chapter(ROOT_A, src, 'Split', 'Chapter 1.cbz'), { series: 'Split' });
  await writeCbz(chapter(ROOT_B, src, 'Split', 'Chapter 2.cbz'), { series: 'Split' });

  await persistScan();

  const rows = await q(`SELECT id FROM lib_series WHERE folder = $1`, [`${src}/Split`]);
  assert.equal(rows.length, 1, 'the two roots produced two series rows');

  const books = await booksOf(rows[0].id);
  assert.equal(books.length, 2, 'books from both roots should belong to the one series');
  assert.deepEqual(
    books.map((b) => b.root).sort(),
    [ROOT_A, ROOT_B].sort(),
    'each book should record the root it actually lives in',
  );
});

test('persistScan: TODAY the same filename in both roots collapses to one row', { skip }, async () => {
  // Both paths hash to the same book id, so the second root's upsert overwrites the first's `root`. The file
  // in the other root becomes unreachable to the page server. This is the narrow, genuine bug inside the
  // otherwise-deliberate two-root merge.
  const src = 'T!collide';
  await writeCbz(chapter(ROOT_A, src, 'Collide', 'Chapter 1.cbz'), { series: 'Collide', pixel: 'from-root-a' });
  await writeCbz(chapter(ROOT_B, src, 'Collide', 'Chapter 1.cbz'), { series: 'Collide', pixel: 'from-root-b' });

  await persistScan();

  const s = await oneSeries(`${src}/Collide`);
  const books = await booksOf(s.id);
  assert.equal(books.length, 1, 'EXPECTED TO FAIL once ids are not path-derived: two files, one row');
  assert.equal(books[0].root, ROOT_B, 'the later root wins and the earlier file is orphaned on disk');
});

test('persistScan: a folder with no chapters is skipped entirely', { skip }, async () => {
  const src = 'T!empty';
  await mkdir(seriesDir(ROOT_A, src, 'Nothing Here'), { recursive: true });
  await persistScan();
  assert.equal(await oneSeries(`${src}/Nothing Here`), undefined);
});

test('persistScan: an unreadable archive still yields a book row, using the filename', { skip }, async () => {
  // A corrupt file must not abort the scan or vanish — the health page is what surfaces it.
  const src = 'T!corrupt';
  await mkdir(seriesDir(ROOT_A, src, 'Corrupt'), { recursive: true });
  await writeFile(chapter(ROOT_A, src, 'Corrupt', 'Chapter 1.cbz'), Buffer.from('this is not a zip'));
  await writeCbz(chapter(ROOT_A, src, 'Corrupt', 'Chapter 2.cbz'), { series: 'Corrupt' });

  await persistScan();

  const s = await oneSeries(`${src}/Corrupt`);
  assert.ok(s, 'a corrupt first chapter aborted the whole series');
  assert.equal(s.title, 'Corrupt', 'with no readable ComicInfo the folder name is the title');
  assert.equal((await booksOf(s.id)).length, 2);
});

test('persistScan: chapter numbers come from the filename, decimals included', { skip }, async () => {
  const src = 'T!numbers';
  for (const f of ['Chapter 1.cbz', 'Chapter 2.5.cbz', 'Chapter 10.cbz']) {
    await writeCbz(chapter(ROOT_A, src, 'Numbering', f), { series: 'Numbering' });
  }
  await persistScan();
  const s = await oneSeries(`${src}/Numbering`);
  const books = await booksOf(s.id);
  assert.deepEqual(books.map((b) => Number(b.number)).sort((a, b) => a - b), [1, 2.5, 10]);
});
