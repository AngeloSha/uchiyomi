// Chapter names borrowed from another source (lib/borrowNames.ts, #85 rebuilt), against real rows:
//
//   - off by default: nothing is searched;
//   - names come only from a donor that passes the follow judgement, in the series' language, by EXACT number,
//     into `chapter_name` with the donor marked -- never `title`, never over a name the chapter already has;
//   - a Spanish source, an adult source for a clean series, a disabled or cooling source is never asked;
//   - a search that throws is not reported to source health;
//   - a donor whose numbering differs is refused, and a search that found nothing waits a week;
//   - the chapter's own source naming it later wins; switching off takes back exactly what was borrowed.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
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

const LIB = 'lib_borrow';
const TITLE = 'Zzbn Borrowed Names';
const S = (k: string) => `s_bn_${k}`;
const NUMS = [1, 2, 3, 4, 5, 6, 7, 7.5, 8, 9, 10, 11, 12];

/** Searches asked, by source id. */
const searched: string[] = [];
/** Whether the donor lists 20..32 instead of 1..12: a donor whose numbering does not line up. */
let donorShifted = false;
/** Names the OWN source gives, by number (none by default: it only ever says "Chapter N"). */
const ownNames = new Map<number, string>();

function source(id: string, o: { lang?: string; nsfw?: boolean; title?: string; names?: (n: number) => string; throws?: boolean }) {
  return {
    id, name: `Zzz ${id}`, lang: o.lang, isNsfw: o.nsfw,
    async search(q: string) {
      searched.push(id);
      if (o.throws) throw new Error('boom');
      return [{ sourceId: `${id}-s`, source: id, title: o.title ?? q }];
    },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: o.title ?? TITLE }; },
    async listChapters() {
      if (id === 'bn-own') return NUMS.map((n) => ({ number: n, title: ownNames.get(n) ?? `Chapter ${n}`, sourceId: `${id}-c${n}` }));
      const nums = id === 'bn-good' && donorShifted ? NUMS.map((n) => n + 19) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      return nums.map((n) => ({ number: n, title: o.names ? o.names(n) : `Chapter ${n}`, sourceId: `${id}-c${n}` }));
    },
    async getPageUrls() { return []; },
    async latest() { return []; },
  };
}

let q: any, borrowNamesFor: any, clearBorrowedNames: any, updateSeries: any;

async function series(key: string) {
  await q('DELETE FROM lib_series WHERE id = $1', [S(key)]);
  await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, source_id, source_series_id, auto_update)
           VALUES ($1,'T!bn',$2,$1,$3,$4,'bn-own','bn-own-1',true)`, [S(key), TITLE, NUMS.length, LIB]);
  for (const n of NUMS) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages) VALUES ($1,$2,'T!bn',$3,$4,$5,5)`,
      [`${S(key)}_b${n}`, S(key), `${S(key)}/Chapter ${n}.cbz`, n, `Chapter ${n}`]);
  }
  await updateSeries(S(key), 0); // the listing
  searched.length = 0;
}
const book = async (key: string, n: number) =>
  (await q('SELECT title, chapter_name, chapter_name_source FROM lib_books WHERE id = $1', [`${S(key)}_b${n}`]))[0];
const on = (v: boolean) => q('UPDATE server_settings SET borrow_names = $1 WHERE id = 1', [v]);

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ borrowNamesFor, clearBorrowedNames } = (await import('../src/lib/borrowNames')) as any);
  ({ updateSeries } = (await import('../src/lib/updater')) as any);
  await migrate();
  registerAdapter(source('bn-own', { lang: 'en' }) as any);
  registerAdapter(source('bn-good', { lang: 'en', names: (n) => `Chapter ${n}: Good Name ${n}` }) as any);
  registerAdapter(source('bn-spanish', { lang: 'es', names: (n) => `Capítulo ${n}: Nombre ${n}` }) as any);
  registerAdapter(source('bn-adult', { lang: 'en', nsfw: true, names: (n) => `Chapter ${n}: Adult Name ${n}` }) as any);
  registerAdapter(source('bn-throws', { lang: 'en', throws: true }) as any);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1,'Borrow',$1) ON CONFLICT (id) DO NOTHING`, [LIB]);
});

beforeEach(async () => {
  if (!DSN) return;
  searched.length = 0;
  donorShifted = false;
  ownNames.clear();
  await on(false);
  await q(`DELETE FROM source_health WHERE source_id LIKE 'bn-%'`);
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]);
});

after(async () => {
  if (!DSN) return;
  await on(false).catch(() => {});
  await q('DELETE FROM lib_series WHERE library_id = $1', [LIB]).catch(() => {});
  await q(`DELETE FROM source_health WHERE source_id LIKE 'bn-%'`).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [LIB]).catch(() => {});
});

test('off by default: nothing is searched and nothing is written', { skip }, async () => {
  await series('off');
  const r = await borrowNamesFor(S('off'));
  // Reintroduce by dropping the borrowingOn check: the donor is searched and every chapter is named.
  assert.equal(r.why, 'off');
  assert.deepEqual(searched, []);
  assert.equal((await book('off', 1)).chapter_name, null);
});

test("names come from a donor that passes the follow judgement, in the series' language, into chapter_name only", { skip }, async () => {
  await on(true);
  await series('good');
  const r = await borrowNamesFor(S('good'));
  assert.equal(r.donor, 'bn-good', JSON.stringify(r));
  const b3 = await book('good', 3);
  assert.equal(b3.chapter_name, 'Good Name 3');
  assert.equal(b3.chapter_name_source, 'bn-good', 'a borrowed name carries no mark, so it could never be taken back');
  assert.equal(b3.title, 'Chapter 3', 'title is the filename\'s and must never be written');
  // EXACT numbers: the donor has 7 and 8, not 7.5. Reintroduce a floor and 7.5 is "Good Name 7".
  assert.equal((await book('good', 7.5)).chapter_name, null, 'a name was hung on the wrong chapter');
  assert.equal(r.named, 12);
});

test('a source in another language, or an adult one, is never asked -- even when nothing else can serve', { skip }, async () => {
  await on(true);
  await series('filters');
  // ⚠️ The good donor is TAKEN AWAY. With it there, the search stops at it and the two below are never
  // reached, so asserting "they were not asked" passed whatever the filters did -- the language mutation
  // failed a different test's assertion, which is how this was caught.
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('bn-good', true) ON CONFLICT (source_id) DO UPDATE SET disabled = true`);
  const r = await borrowNamesFor(S('filters'));
  // Reintroduce by dropping `sameLanguage` in `usable`: the Spanish source is asked, and its names are used.
  assert.ok(!searched.includes('bn-spanish'), `a Spanish source was asked: ${searched}`);
  // Reintroduce by dropping `allowed(id)`: the adult source is asked for a series on a clean shelf.
  assert.ok(!searched.includes('bn-adult'), `an adult source was asked for a clean series: ${searched}`);
  assert.equal(r.why, 'no_donor', JSON.stringify(r));
  assert.equal((await book('filters', 1)).chapter_name, null, 'a name came from a source that may not be asked');
  assert.ok(searched.includes('bn-throws'), `no source was asked at all, so this proves nothing: ${searched}`);
});

test('a search that throws is not reported to source health', { skip }, async () => {
  await on(true);
  await series('throws');
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ('bn-good', true) ON CONFLICT (source_id) DO UPDATE SET disabled = true`);
  await borrowNamesFor(S('throws'));
  assert.ok(searched.includes('bn-throws'), `the throwing source was never asked, so this proves nothing: ${searched}`);
  assert.ok(!searched.includes('bn-good'), 'a disabled source was asked');
  // Reintroduce by searching through searchAll (which reports): a health row appears for bn-throws.
  const h = await q(`SELECT * FROM source_health WHERE source_id = 'bn-throws'`);
  assert.equal(h.length, 0, `a names search put a source into source health: ${JSON.stringify(h)}`);
});

test('a donor whose numbering does not line up is refused, and the empty search waits a week', { skip }, async () => {
  await on(true);
  await series('shifted');
  donorShifted = true;
  const r = await borrowNamesFor(S('shifted'));
  // Reintroduce by accepting any exact-title hit without judging its numbering: every chapter gets a name.
  assert.equal(r.why, 'no_donor', JSON.stringify(r));
  assert.equal((await book('shifted', 1)).chapter_name, null);
  searched.length = 0;
  const again = await borrowNamesFor(S('shifted'));
  assert.equal(again.why, 'waiting');
  assert.deepEqual(searched, [], 'a search that found nothing was repeated the same week');
});

test("the chapter's own name is never replaced, and later outranks a borrowed one", { skip }, async () => {
  await on(true);
  ownNames.set(2, 'Chapter 2: Own Two');
  await series('own');
  await borrowNamesFor(S('own'));
  assert.equal((await book('own', 2)).chapter_name, 'Own Two', 'a borrowed name replaced the chapter\'s own');
  assert.equal((await book('own', 2)).chapter_name_source, null);
  assert.equal((await book('own', 5)).chapter_name, 'Good Name 5');
  // The own source starts naming chapter 5: the next check's listing heal replaces the borrowed name.
  ownNames.set(5, 'Chapter 5: Own Five');
  await updateSeries(S('own'), 0);
  const b5 = await book('own', 5);
  // Reintroduce by healing only NULL names (the v0.46.0 rule): the borrowed name stays.
  assert.equal(b5.chapter_name, 'Own Five');
  assert.equal(b5.chapter_name_source, null, 'the donor mark outlived the name it marked');
});

test('switching it off takes back exactly what was borrowed', { skip }, async () => {
  await on(true);
  ownNames.set(4, 'Chapter 4: Own Four');
  await series('clear');
  await borrowNamesFor(S('clear'));
  assert.equal((await book('clear', 1)).chapter_name, 'Good Name 1');
  const n = await clearBorrowedNames({ seriesId: S('clear') });
  assert.equal(n, 11);
  assert.equal((await book('clear', 1)).chapter_name, null);
  assert.equal((await book('clear', 4)).chapter_name, 'Own Four', 'an own name was taken back with the borrowed ones');
});
