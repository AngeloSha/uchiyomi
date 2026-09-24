// Borrowing chapter names from another source (lib/borrowNames.ts), against a real Postgres and fake
// sources.
//
// The feature's whole risk is a plausible wrong name, so most of this pins who is NOT used: a source whose
// numbers do not cover ours, a hit whose title is only similar, a series switched off. The rest pins that
// what it writes is marked and can be taken back to exactly what the file says -- chapter 10 included,
// which a string-trimming reset once turned into "Chapter 1".
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

type Q = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let q: Q;
let borrow: typeof import('../src/lib/borrowNames');
let replaceListing: typeof import('../src/lib/seriesListing')['replaceListing'];

const OWN = 'bn-own', GOOD = 'bn-good', SHIFT = 'bn-shift', FUZZY = 'bn-fuzzy';
const SOURCES = [OWN, GOOD, SHIFT, FUZZY];
const A = 's_bn_alpha', B = 's_bn_beta';
const NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let savedGlobal: boolean | undefined;

/** What each fake answers: search hits by term, and chapter lists by the id within the source. */
const hits: Record<string, Record<string, Array<{ sourceId: string; title: string }>>> = {
  [GOOD]: { 'Borrow Alpha': [{ sourceId: 'g-alpha', title: 'Borrow Alpha' }] },
  // Lists the same title, but numbers it 101..110: a different edition, and every name would be wrong.
  [SHIFT]: {
    'Borrow Alpha': [{ sourceId: 's-alpha', title: 'Borrow Alpha' }],
    'Borrow Beta!': [{ sourceId: 's-beta', title: 'Borrow Beta' }],
  },
  // Numbers line up perfectly, but it is another work with a similar name.
  [FUZZY]: {
    'Borrow Alpha': [{ sourceId: 'f-alpha', title: 'Borrow Alpha: Side Stories' }],
    'Borrow Beta!': [{ sourceId: 'f-beta', title: 'Borrow Beta Zero' }],
  },
};
const chapters: Record<string, Array<{ number: number; title: string }>> = {
  // Chapter 3 is unnamed on the donor too: nothing is invented for it.
  'g-alpha': NUMS.map((n) => ({ number: n, title: n === 3 ? 'Chapter 3' : `Good ${n}` })),
  's-alpha': NUMS.map((n) => ({ number: n + 100, title: `Shifted ${n}` })),
  's-beta': NUMS.map((n) => ({ number: n + 100, title: `Shifted ${n}` })),
  'f-alpha': NUMS.map((n) => ({ number: n, title: `Wrong ${n}` })),
  'f-beta': NUMS.map((n) => ({ number: n, title: `Wrong ${n}` })),
};
const searches: Record<string, number> = {};

function fake(id: string) {
  return {
    id, name: `${id} name`,
    async search(term: string) {
      searches[id] = (searches[id] ?? 0) + 1;
      return (hits[id]?.[term] ?? []).map((h) => ({ ...h, source: id }));
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: sid }; },
    async listChapters(sid: string) {
      return (chapters[sid] ?? []).map((c) => ({ sourceId: `${sid}/${c.number}`, ...c }));
    },
    async getPageUrls() { return []; },
  };
}

const titles = async (s: string) => Object.fromEntries(
  (await q<{ number: number; title: string; title_source: string | null }>(
    'SELECT number, title, title_source FROM lib_books WHERE series_id = $1 ORDER BY number', [s]))
    .map((r) => [Number(r.number), { title: r.title, from: r.title_source }]));

async function seed(id: string, title: string) {
  const folder = `T!bn/${title}`;
  await q('DELETE FROM lib_books WHERE series_id = $1', [id]);
  await q('DELETE FROM lib_series WHERE id = $1', [id]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id)
           VALUES ($1,'T!bn',$2,$3,10,$4,'own-1')`, [id, title, folder, OWN]);
  for (const n of NUMS) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, root)
             VALUES ($1,$2,'T!bn',$3,$4,$5,'/library')`, [`${id}_${n}`, id, `${folder}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as { q: Q });
  await migrate();
  borrow = await import('../src/lib/borrowNames');
  ({ replaceListing } = await import('../src/lib/seriesListing'));
  const { registerAdapter } = await import('../src/lib/sources');
  for (const id of SOURCES) registerAdapter(fake(id) as any);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [SOURCES]);
  savedGlobal = (await q<{ borrow_names: boolean }>('SELECT borrow_names FROM server_settings WHERE id = 1'))[0]?.borrow_names;
  await q('UPDATE server_settings SET borrow_names = false WHERE id = 1');
  await seed(A, 'Borrow Alpha');
  // Punctuation folds away in the title match, so "Borrow Beta!" still looks for "Borrow Beta".
  await seed(B, 'Borrow Beta!');
});

after(async () => {
  if (!DSN) return;
  for (const s of [A, B]) {
    await q('DELETE FROM lib_books WHERE series_id = $1', [s]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = $1', [s]).catch(() => {});
  }
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [SOURCES]).catch(() => {});
  if (savedGlobal !== undefined) await q('UPDATE server_settings SET borrow_names = $1 WHERE id = 1', [savedGlobal]).catch(() => {});
});

test('off by default: nothing is asked and nothing changes', { skip }, async () => {
  const r = await borrow.borrowChapterNames(A);
  assert.equal(r.why, 'off');
  assert.equal(searches[GOOD] ?? 0, 0, 'no source was searched');
  assert.equal((await titles(A))[1].title, 'Chapter 1');
});

test('switched on for a series: names come only from the source whose numbering covers ours and whose title matches exactly', { skip }, async () => {
  // Reintroduce the fuzzy match (accept any hit) or drop the numbering check: "Wrong 1" or "Shifted 1" lands.
  await q('UPDATE lib_series SET borrow_names = true WHERE id = $1', [A]);
  const r = await borrow.borrowChapterNames(A);
  assert.equal(r.donor, GOOD);
  assert.equal(r.filled, 9, 'every chapter but 3, which the donor does not name either');
  const t = await titles(A);
  assert.deepEqual(t[1], { title: 'Good 1', from: GOOD }, 'a borrowed name records its donor');
  assert.deepEqual(t[10], { title: 'Good 10', from: GOOD });
  assert.deepEqual(t[3], { title: 'Chapter 3', from: null });
  const donor = (await q('SELECT name_donor FROM lib_series WHERE id = $1', [A]))[0].name_donor;
  assert.deepEqual(donor, { source: GOOD, sourceId: 'g-alpha' }, 'the donor is remembered for the next check');
});

test('a series with no trustworthy donor gets no names, and the search is not repeated on the next check', { skip }, async () => {
  await q('UPDATE lib_series SET borrow_names = true WHERE id = $1', [B]);
  const r = await borrow.borrowChapterNames(B);
  assert.equal(r.why, 'no_donor', 'the shifted source and the look-alike title are both refused');
  assert.ok(Object.values(await titles(B)).every((b) => /^Chapter \d+$/.test(b.title) && b.from === null));
  const before = { ...searches };
  const again = await borrow.borrowChapterNames(B);
  assert.equal(again.why, 'no_donor');
  assert.deepEqual(searches, before, 'a search that came back empty is remembered, not re-run every check');
});

test('the chapter\'s own source naming it wins over a borrowed name, and clears the mark', { skip }, async () => {
  const row = (number: number, title: string) => ({
    number, title, publishedAt: null, scanlator: null, groups: [], sourceId: OWN,
    chosen: { sourceId: `own/${number}`, number, title } as any, copies: [], status: 'available' as any,
  });
  await replaceListing(A, [row(2, 'Own Two'), row(4, 'Chapter 4')]);
  const t = await titles(A);
  assert.deepEqual(t[2], { title: 'Own Two', from: null });
  assert.deepEqual(t[4], { title: 'Good 4', from: GOOD }, 'a listing that only restates the number changes nothing');
});

test('switching it off takes the borrowed names back to what each file says', { skip }, async () => {
  // Reintroduce the old `trim(trailing '0' ...)` reset: chapter 10 reads "Chapter 1".
  const n = await borrow.clearBorrowedNames({ seriesId: A });
  assert.equal(n, 8, 'the nine borrowed, less the one the own source has since named');
  const t = await titles(A);
  assert.deepEqual(t[10], { title: 'Chapter 10', from: null });
  assert.deepEqual(t[1], { title: 'Chapter 1', from: null });
  assert.deepEqual(t[2], { title: 'Own Two', from: null }, 'a name the chapter\'s own source gave is not borrowed, and stays');
});

test('the server switch going off clears only the series that follow it', { skip }, async () => {
  await q('UPDATE lib_series SET borrow_names = NULL, name_donor = NULL WHERE id = $1', [A]);
  await q('UPDATE server_settings SET borrow_names = true WHERE id = 1');
  const r = await borrow.borrowChapterNames(A);
  assert.equal(r.donor, GOOD, 'a series following the server setting borrows while it is on');
  await q(`UPDATE lib_books SET title = 'Pinned', title_source = $2 WHERE id = $1`, [`${B}_1`, GOOD]);
  await q('UPDATE lib_series SET borrow_names = true WHERE id = $1', [B]);
  await borrow.clearBorrowedNames('following-server');
  assert.deepEqual((await titles(A))[1], { title: 'Chapter 1', from: null });
  assert.deepEqual((await titles(B))[1], { title: 'Pinned', from: GOOD }, 'a series switched on for itself keeps its names');
  await q('UPDATE server_settings SET borrow_names = false WHERE id = 1');
});
