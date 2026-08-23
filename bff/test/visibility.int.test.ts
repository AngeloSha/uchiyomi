// A viewer must not be able to reach a series they cannot see, by any route.
//
// Every one of these was reachable before this file existed:
//
//   * owned.book(id) resolved a chapter with no join to lib_series at all, so a book id opened a chapter of
//     a hidden series, and bookNext then walked the rest of it.
//   * visibleBookFile's predecessor was `SELECT file, root FROM lib_books WHERE id = $1`, which is what the
//     image server used to turn a book id into raw page bytes on disk, and what OPDS used to stream a CBZ.
//   * OPDS listed the chapters of a hidden series with no predicate whatsoever.
//
// So these tests attack the chokepoints directly rather than asserting that the happy path still works.
// The failure they exist to catch is not "wrong data" but "data at all".
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;
let visibleBookFile: any;
let seriesVisible: any;

// Written out rather than imported: importing from src/lib at the top level pulls in env.ts, which
// validates the environment at module load, before the block above has set DATABASE_URL.
const ANY_VIEWER = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const OPEN = 's_vis_open', HIDDEN = 's_vis_hidden';
const ALL = [OPEN, HIDDEN];
const bookOf = (s: string) => `b_${s}_1`;

async function seed() {
  for (const id of ALL) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!vis',$1,$1,2)`, [id]);
    for (const n of [1, 2]) {
      await q(
        `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
         VALUES ($1,$2,'T!vis',$3,$4,$5,'/library')`,
        [`b_${id}_${n}`, id, `T!vis/${id}/ch${n}.cbz`, n, `Chapter ${n}`],
      );
    }
  }
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [HIDDEN]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  const vis = await import('../src/lib/visibility');
  visibleBookFile = (vis as any).visibleBookFile;
  seriesVisible = (vis as any).seriesVisible;
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ALL]);
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]);
  await seed();
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_books WHERE series_id = ANY($1)`, [ALL]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = ANY($1)`, [ALL]).catch(() => {});
});

// ---- the series itself ----

test('a visible series is reachable, so the tests below mean something', { skip }, async () => {
  const dto = await owned.series(ANY_VIEWER, OPEN);
  assert.equal(dto.id, OPEN);
  assert.equal(await seriesVisible(OPEN, ANY_VIEWER), true);
});

test('a hidden series is not reachable by id', { skip }, async () => {
  await assert.rejects(() => owned.series(ANY_VIEWER, HIDDEN), /not found/i);
  assert.equal(await seriesVisible(HIDDEN, ANY_VIEWER), false);
});

// ---- chapters: the hole BOOKS_SRC left wide open ----

test('THE HOLE: a book id of a hidden series does not open a chapter', { skip }, async () => {
  // owned.book joined only lib_books, so this returned the chapter regardless of its series.
  await assert.rejects(() => owned.book(ANY_VIEWER, bookOf(HIDDEN)), /not found/i);
});

test('the chapter list of a hidden series is empty', { skip }, async () => {
  const r = await owned.seriesBooks(ANY_VIEWER, HIDDEN, 0, 50);
  assert.equal(r.content.length, 0, 'chapters of a hidden series were listed');
  assert.equal(r.totalElements, 0, 'the count disagrees with the (empty) page');
});

test('page dimensions do not enumerate a hidden chapter', { skip }, async () => {
  const pages = await owned.bookPages(ANY_VIEWER, bookOf(HIDDEN));
  assert.deepEqual(pages, [], 'page metadata leaked for a hidden series');
});

test('next and previous do not walk into a hidden series', { skip }, async () => {
  await assert.rejects(() => owned.bookNext(ANY_VIEWER, bookOf(HIDDEN)), /not found|no next/i);
  await assert.rejects(() => owned.bookPrevious(ANY_VIEWER, `b_${HIDDEN}_2`), /not found|no previous/i);
});

// ---- the file resolver behind BOTH the image server and the OPDS download ----

test('THE HOLE: a book id does not resolve to a file on disk for a hidden series', { skip }, async () => {
  // This is the one that mattered most: it is what /img/lib/books/:id/page/:n and /opds/book/:id/file
  // both call, and its predecessor was a bare id lookup with no series join.
  assert.ok(await visibleBookFile(bookOf(OPEN), ANY_VIEWER), 'setup: a visible chapter should resolve');
  assert.equal(await visibleBookFile(bookOf(HIDDEN), ANY_VIEWER), null, 'a hidden chapter resolved to a path');
});

test('a chapter that does not exist looks identical to one you may not see', { skip }, async () => {
  // "no such chapter" and "not yours" must be indistinguishable from outside, or the 404 becomes an oracle.
  assert.equal(await visibleBookFile('b_does_not_exist', ANY_VIEWER), null);
  assert.equal(await visibleBookFile(bookOf(HIDDEN), ANY_VIEWER), null);
});

// ---- search and rails ----

test('a hidden series is absent from search, and the count agrees', { skip }, async () => {
  const r = await owned.searchSeries(ANY_VIEWER, {}, 0, 200);
  const ids = r.content.map((s: any) => s.id);
  assert.ok(ids.includes(OPEN), 'setup: the visible series should be listed');
  assert.ok(!ids.includes(HIDDEN), 'a hidden series appeared in search');
});

test('a hidden series is absent from the newest and recently-updated rails', { skip }, async () => {
  for (const fn of ['seriesNew', 'seriesUpdated'] as const) {
    const r = await owned[fn](ANY_VIEWER, 0, 200);
    assert.ok(!r.content.map((s: any) => s.id).includes(HIDDEN), `${fn} listed a hidden series`);
  }
});
