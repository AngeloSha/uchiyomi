// "Every series by this author" (v0.100.0, #338): the Library's `authorName` condition and its search, against the
// real catalogue -- the line an admin's override, the series' own and the server's filled-in details give (the same
// COALESCE the series page shows), the listing's gate, one card per work, and a smart list saved from it.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const SYSTEM_CTX = { userId: null, libraryIds: null, maxAgeRating: null } as const;

// id, title, the series' own line, an admin's override, the server's filled-in line.
const SERIES: Array<[string, string, string | null, string | null, string | null]> = [
  ['s_au_solo', 'AU Solo', 'Chugong (추공), Gi So-Ryeong (기소령)', null, null],
  ['s_au_korean', 'AU Korean', '추공', null, null],
  ['s_au_override', 'AU Override', 'Somebody Else', 'CHUGONG', null],
  ['s_au_filled', 'AU Filled', '', null, 'Chugong'],
  ['s_au_john', 'AU John', 'John Oh', null, null],
  ['s_au_oh', 'AU Oh', 'Hong-Sil (홍실), Oh (성불예정)', null, null],
  ['s_au_gone', 'AU Gone', 'Chugong', null, null],
];
const IDS = SERIES.map((s) => s[0]);
let q: any, pool: any, owned: any, evaluate: any, UnsupportedFilter: any;

before(async () => {
  if (!DSN) return;
  ({ q, pool } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  ({ owned, UnsupportedFilter } = await import('../src/lib/ownedCatalog'));
  ({ evaluate } = await import('../src/lib/smartLists'));
  await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [IDS]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]);
  for (const [id, title, own, override, filled] of SERIES) {
    await q(`INSERT INTO lib_series (id, source, title, folder, books_count, author) VALUES ($1,'T!au',$2,$1,1,$3)`, [id, title, own]);
    if (override) await q('INSERT INTO series_overrides (series_id, author) VALUES ($1,$2)', [id, override]);
    if (filled) await q('INSERT INTO series_auto_details (series_id, author) VALUES ($1,$2)', [id, filled]);
  }
  // A series deleted from the library: by the same author, never listed.
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = 's_au_gone'`);
});
after(async () => {
  if (!DSN) return;
  await q('DELETE FROM series_overrides WHERE series_id = ANY($1)', [IDS]);
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [IDS]);
  await pool.end();
});

const titles = (page: any) => (page.content as any[]).map((s) => s.metadata?.title ?? s.name).sort();
const byAuthor = (value: string, operator = 'is', collapseEditions = false) =>
  owned.searchSeries(SYSTEM_CTX, { condition: { allOf: [{ authorName: { operator, value } }] }, collapseEditions }, 0, 40, 'metadata.titleSort,asc');

test('a name lists every series that names the same person, in any spelling, from whichever line shows', { skip }, async () => {
  // Reintroduce by reading lib_series.author alone: AU Override (an admin's CHUGONG) and AU Filled are missing.
  assert.deepEqual(titles(await byAuthor('Chugong (추공)')), ['AU Filled', 'AU Korean', 'AU Override', 'AU Solo']);
  assert.deepEqual(titles(await byAuthor('Chugong (추공)', 'is', true)), ['AU Filled', 'AU Korean', 'AU Override', 'AU Solo'],
    'one card per work reads the same condition');
  assert.equal((await byAuthor('Chugong (추공)')).totalElements, 4, 'the count agrees with the page');
});

test('a whole name, never a fragment: "Oh" is not inside "John Oh"', { skip }, async () => {
  assert.deepEqual(titles(await byAuthor('Oh (성불예정)')), ['AU Oh']);
  assert.deepEqual(titles(await byAuthor('Nobody At All')), []);
  const not = titles(await byAuthor('Chugong (추공)', 'isNot')).filter((t: string) => t.startsWith('AU '));
  assert.deepEqual(not, ['AU John', 'AU Oh']);
});

test('the Library\'s search finds a series by its author as well as its title', { skip }, async () => {
  const found = titles(await owned.searchSeries(SYSTEM_CTX, { fullTextSearch: '성불예정' }, 0, 40));
  assert.deepEqual(found, ['AU Oh']);
  assert.deepEqual(titles(await owned.searchSeries(SYSTEM_CTX, { fullTextSearch: 'AU Korean' }, 0, 40)), ['AU Korean'], 'titles still match');
});

test('a smart list saved from an author answers the same shelf', { skip }, async () => {
  const page = await evaluate(SYSTEM_CTX, { v: 1, author: 'Chugong (추공)', sort: 'az' }, 0, 40);
  assert.equal(page.unsupported, false);
  assert.deepEqual(titles(page), ['AU Filled', 'AU Korean', 'AU Override', 'AU Solo']);
});

test('a request cannot hand in its own id list, or a name the condition cannot read', { skip }, async () => {
  // The resolved leaf is a class instance JSON cannot make: what a client sends in its shape is an unknown key.
  await assert.rejects(() => owned.searchSeries(SYSTEM_CTX, { condition: { ids: ['s_au_john'], negate: false } }, 0, 40),
    (e: any) => e instanceof UnsupportedFilter);
  await assert.rejects(() => byAuthor('Chugong', 'contains'), (e: any) => e instanceof UnsupportedFilter);
  await assert.rejects(() => byAuthor(''), (e: any) => e instanceof UnsupportedFilter);
});
