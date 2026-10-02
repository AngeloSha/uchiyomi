// The language of a series and of a source (lib/seriesLang.ts, v0.52.0), against real rows and registered sources:
//
//   - a series' language is its own (lib_series.lang), else its main source's, else the server's unstated one,
//     which boot reads from server_settings;
//   - the follow guard passes a source in the series' language or in any, refuses the rest, compares exact codes
//     when another edition of the work shares the base language (a removed one too, a merged one not), and never
//     refuses the series' own main source.
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

const S = (k: string) => `s_sl_${k}`;
const WORK = '5a1e0000-0000-4000-8000-000000000052';

let q: any, seriesLanguage: any, sourceLanguage: any, followGuard: any, loadUnstatedLang: any, setUnstatedLang: any;

function source(id: string, lang?: string) {
  return {
    id, name: `Zzz ${id}`, lang,
    async search() { return []; },
    async getSeries() { return null; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
  };
}

async function series(key: string, o: { source: string; lang?: string; work?: string }) {
  await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, lang, work_id)
           VALUES ($1, 'T!sl', $1, $1, $2, $1, $3, $4)`, [S(key), o.source, o.lang ?? null, o.work ?? null]);
}

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  ({ seriesLanguage, sourceLanguage, followGuard, loadUnstatedLang } = (await import('../src/lib/seriesLang')) as any);
  ({ setUnstatedLang } = (await import('../src/lib/lang')) as any);
  await migrate();
  registerAdapter(source('sl-en', 'en') as any);
  registerAdapter(source('sl-es419', 'es-419') as any);
  registerAdapter(source('sl-mdes', 'es-la') as any);  // MangaDex's spelling of the same language
  registerAdapter(source('sl-es', 'es') as any);
  registerAdapter(source('sl-none') as any);           // declares nothing: an add-a-site engine
  registerAdapter(source('sl-all', 'all') as any);     // Suwayomi's every-language source
});

beforeEach(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE id LIKE 's_sl_%'`);
});

after(async () => {
  if (!DSN) return;
  await q(`DELETE FROM lib_series WHERE id LIKE 's_sl_%'`).catch(() => {});
  await q(`UPDATE server_settings SET unstated_lang = 'en' WHERE id = 1`).catch(() => {});
  setUnstatedLang?.('en');
});

test("a series' language is its own, else its main source's, else the server's unstated one", { skip }, async () => {
  await series('own', { source: 'sl-es419', lang: 'pt-br' });
  await series('src', { source: 'sl-es419' });
  await series('none', { source: 'sl-none' });
  await series('all', { source: 'sl-all' });
  // Reintroduce by dropping the series' own language: "own" reads its source's es-419.
  assert.deepEqual(await seriesLanguage(S('own')), { lang: 'pt-BR', stated: true, workId: null, sameBaseSibling: false },
    'the series\' own language is not the one it reads');
  // Reintroduce by dropping the main source's language: "src" reads the unstated en.
  assert.deepEqual(await seriesLanguage(S('src')), { lang: 'es-419', stated: false, workId: null, sameBaseSibling: false },
    'a series stating nothing does not read its main source\'s language');
  assert.equal((await seriesLanguage(S('none'))).lang, 'en');
  assert.equal((await seriesLanguage(S('all'))).lang, 'en', 'a source in every language says nothing about this series');
  assert.deepEqual(await seriesLanguage(S('gone')), { lang: 'en', stated: false, workId: null, sameBaseSibling: false });

  // The server's setting, as boot reads it. Reintroduce by hardcoding 'en' as the last step (or by a loadUnstatedLang
  // that reads nothing): the Spanish server's series stay English.
  await q(`UPDATE server_settings SET unstated_lang = 'es' WHERE id = 1`);
  try {
    assert.equal(await loadUnstatedLang(), 'es', 'boot did not read the setting');
    assert.equal((await seriesLanguage(S('none'))).lang, 'es', 'the unstated language is not the server\'s setting');
    assert.equal((await seriesLanguage(S('all'))).lang, 'es');
    assert.equal((await seriesLanguage(S('src'))).lang, 'es-419', 'a source that says outranks the setting');
  } finally {
    await q(`UPDATE server_settings SET unstated_lang = 'en' WHERE id = 1`);
    await loadUnstatedLang();
  }
});

test('the follow guard: same language or any, exact beside a same-base edition, and never the own source', { skip }, async () => {
  await series('ed419', { source: 'sl-es419', lang: 'es-419', work: WORK });
  await series('edes', { source: 'sl-es', lang: 'es', work: WORK });
  await series('en', { source: 'sl-none' });
  await series('fallback', { source: 'sl-en', lang: 'es-419' }); // a Spanish title added through an English adapter

  assert.equal(sourceLanguage('sl-all'), 'any');
  assert.equal(sourceLanguage('sl-none'), 'en', 'a source that says nothing is in the unstated language');
  assert.equal(sourceLanguage('sl-mdes'), 'es-419');
  assert.equal(sourceLanguage('sl-not-registered'), 'en');

  const facts = await seriesLanguage(S('ed419'));
  assert.equal(facts.workId, WORK);
  assert.equal(facts.sameBaseSibling, true, 'es beside es-419 shares the base language');
  const ed = await followGuard(S('ed419'));
  assert.ok(ed('sl-mdes'), 'a source in its language, spelt MangaDex\'s way');
  // Reintroduce by ignoring sameBaseSibling (no `exact`): es passes for the es-419 edition.
  assert.equal(ed('sl-es'), false, 'es is the other edition\'s language');
  // Reintroduce by dropping the 'any' pass: the every-language source is refused.
  assert.ok(ed('sl-all'), 'a source in every language may serve any edition');
  assert.equal(ed('sl-en'), false);
  assert.equal(ed('sl-none'), false, 'a source that says nothing is English here');

  const en = await followGuard(S('en'));
  assert.ok(en('sl-en'));
  assert.equal(en('sl-es419'), false, 'a Spanish source for an English series');
  assert.equal(en('sl-mdes'), false);

  // Reintroduce by dropping the own-source pass: the title refuses the adapter it is read through.
  const fallback = await followGuard(S('fallback'));
  assert.ok(fallback('sl-en'), 'the series\' own main source');
  assert.equal(fallback('sl-none'), false, 'another English source is still refused');
  assert.ok(fallback('sl-es'), 'with no same-base edition, es serves es-419');

  // A removed edition keeps its language slot, so the codes stay exact; a merged-away series is no edition.
  // Reintroduce by skipping removed siblings (deleted_at IS NULL, as visible() would): the removed es edition stops
  // counting. Reintroduce by dropping merged_into IS NULL: the merged one still counts.
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [S('edes')]);
  assert.equal((await followGuard(S('ed419')))('sl-es'), false, 'a removed edition stopped holding its language');
  await q(`UPDATE lib_series SET merged_into = $2 WHERE id = $1`, [S('edes'), S('ed419')]);
  assert.ok((await followGuard(S('ed419')))('sl-es'), 'a merged-away series still counted as an edition');
});
