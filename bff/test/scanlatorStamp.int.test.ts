// The provenance stamp on a downloaded chapter: who released the file on disk, and from which adapter.
//
// setBookMeta writes it, the book DTO carries it, and the scanner never touches it. The trap this file
// exists for is the DTO leg: bookDto reads through booksSrc, whose inner SELECT enumerates its columns by
// hand. A column left out of that list does not error -- the DTO field simply reads null, everywhere, with
// every existing test green (nothing else asserts on a stamped value). The same trap SERIES_COLS documents
// for series, on the book side.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A viewer that sees every library. Written out rather than imported because importing from src/lib pulls
// in env.ts, which validates the environment at module load, before the block below has set DATABASE_URL.
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let owned: any;
let setBookMeta: typeof import('../src/lib/library')['setBookMeta'];

const S = 's_stamp_series';
const FOLDER = 'T!stamp/Stamp';
const BOOKS: Array<[string, number]> = [
  ['b_stamp_1', 1],
  ['b_stamp_2', 2],
  ['b_stamp_3', 3],
];

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ owned } = (await import('../src/lib/ownedCatalog')) as any);
  ({ setBookMeta } = await import('../src/lib/library'));
  await migrate();
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]);
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]);
  await q(
    `INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!stamp','Stamp Test',$2,3)`,
    [S, FOLDER],
  );
  for (const [id, number] of BOOKS) {
    await q(
      `INSERT INTO lib_books (id, series_id, source, file, number, title, root)
       VALUES ($1,$2,'T!stamp',$3,$4,$5,'/library')`,
      [id, S, `${FOLDER}/Chapter ${number}.cbz`, number, `Chapter ${number}`],
    );
  }
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_books WHERE series_id = $1`, [S]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id = $1`, [S]).catch(() => {});
});

const stamped = async (id: string) => {
  const b = await owned.book(SYSTEM_CTX, id);
  return { scanlator: b.scanlator, sourceId: b.sourceId };
};

test('THE BOOK COLUMN-LIST TRAP: a stamp written by setBookMeta reaches the book DTO', { skip }, async () => {
  // Reintroduce by deleting `b.scanlator` from booksSrc's inner SELECT in lib/ownedCatalog.ts: no query
  // fails, and "book DTO carries the scanlator" reads null.
  await setBookMeta(FOLDER, [{ number: 2, scanlator: 'B', source: 'src-x' }]);

  const one = await stamped('b_stamp_2');
  assert.equal(one.scanlator, 'B', 'book DTO carries the scanlator');
  assert.equal(one.sourceId, 'src-x', 'book DTO carries the source id');

  // The list path reads through the same column list; both DTO producers have to agree.
  const listed = (await owned.seriesBooks(SYSTEM_CTX, S, 0, 50)).content.find((b: any) => b.id === 'b_stamp_2');
  assert.equal(listed?.scanlator, 'B', 'seriesBooks carries the scanlator');
  assert.equal(listed?.sourceId, 'src-x', 'seriesBooks carries the source id');
});

test('an empty list is a no-op', { skip }, async () => {
  await setBookMeta(FOLDER, [{ number: 1, scanlator: 'A', source: 'src-x' }]);
  await setBookMeta(FOLDER, []);
  assert.deepEqual(await stamped('b_stamp_1'), { scanlator: 'A', sourceId: 'src-x' });
});

test('a number not in the list keeps its stamp', { skip }, async () => {
  // Only the chapters that LANDED are stamped: a later run that lands chapter 3 must not relabel chapter 1.
  await setBookMeta(FOLDER, [{ number: 1, scanlator: 'A', source: 'src-x' }]);
  await setBookMeta(FOLDER, [{ number: 3, scanlator: 'B', source: 'src-y' }]);
  assert.deepEqual(await stamped('b_stamp_1'), { scanlator: 'A', sourceId: 'src-x' }, 'chapter 1 untouched');
  assert.deepEqual(await stamped('b_stamp_3'), { scanlator: 'B', sourceId: 'src-y' });
  assert.deepEqual(await stamped('b_stamp_2'), { scanlator: null, sourceId: null }, 'a never-stamped book reads null, not undefined');
});

test('the stamp matches the RAW number, not an override', { skip }, async () => {
  // Same rule as setBookDates: the numbers come from the source's listing, which lines up with the raw
  // filename number, and a presentation override must not move the stamp onto a different file.
  await q(`INSERT INTO book_overrides (book_id, number) VALUES ('b_stamp_2', 7) ON CONFLICT (book_id) DO UPDATE SET number = 7`);
  try {
    await setBookMeta(FOLDER, [{ number: 2, scanlator: 'B', source: 'src-x' }]);
    assert.equal((await stamped('b_stamp_2')).scanlator, 'B', 'the file whose raw number is 2 got the stamp');
    await setBookMeta(FOLDER, [{ number: 7, scanlator: 'Z', source: 'src-z' }]);
    assert.equal((await stamped('b_stamp_2')).scanlator, 'B', 'the override number does not attract a stamp');
  } finally {
    await q(`DELETE FROM book_overrides WHERE book_id = 'b_stamp_2'`).catch(() => {});
  }
});
