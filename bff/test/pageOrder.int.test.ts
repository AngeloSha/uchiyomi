// The reader's cached page sizes are read in today's page order (lib/naming.ts pageCmp, #436).
//
// `lib_books.page_dims` keeps the order its pages were measured in. Sizes measured before pageCmp hold a folder-wrapped
// archive's pages in naturalCmp's order -- 1, 10, 2 -- and the reader used to return them as stored, so the fixed order
// would never reach a chapter anyone had already opened, and page cleanup (which now numbers pages by pageCmp) would
// hide a different page than the one the reader showed under the same number.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const S = 's_page_order';
const WRAPPED = ['1.png', '2.png', '10.png'].map((n) => `Series [3948394]/${n}`);

test('cached page sizes follow the page order, and a PDF keeps its own', { skip }, async () => {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const { owned } = await import('../src/lib/ownedCatalog');
  const { SYSTEM_CTX } = await import('../src/lib/visibility');
  await migrate();
  const wipe = async () => {
    await q('DELETE FROM lib_books WHERE series_id = $1', [S]);
    await q('DELETE FROM lib_series WHERE id = $1', [S]);
  };
  await wipe();
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count) VALUES ($1,'T!po',$1,$2,2)`, [S, `T!po/${S}`]);
  const dims = (names: string[]) => JSON.stringify(names.map((name) => ({ name, width: 600, height: 900 })));
  // naturalCmp's order, as an older release measured and cached it.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, page_dims) VALUES ($1,$2,'T!po',$3,1,'Chapter 1',3,$4)`,
    [`${S}_cbz`, S, `T!po/${S}/Chapter 1.cbz`, dims([WRAPPED[0], WRAPPED[2], WRAPPED[1]])]);
  // A PDF's pages are in the document's order, which no name sort may change.
  await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, page_dims) VALUES ($1,$2,'T!po',$3,2,'Chapter 2',3,$4)`,
    [`${S}_pdf`, S, `T!po/${S}/Chapter 2.pdf`, dims(['page-3', 'page-1', 'page-2'])]);
  try {
    const names = async (id: string) => ((await owned.bookPages(SYSTEM_CTX, id)) as Array<{ fileName: string; number: number }>)
      .map((p) => p.fileName);
    // Reintroduce returning page_dims as stored (lib/ownedCatalog.ts bookPages) and this reads 1, 10, 2.
    assert.deepEqual(await names(`${S}_cbz`), WRAPPED, 'the reader kept the old cached order');
    assert.deepEqual(await names(`${S}_pdf`), ['page-3', 'page-1', 'page-2'], 'a PDF was re-sorted by name');
  } finally {
    await wipe();
  }
});
