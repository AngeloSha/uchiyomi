// Which sources land in which language group, and which six actually get fetched.
//
// The reported symptom was "some sources say Japanese but they also offer English stuff". The data said no
// source declares two languages: every row has exactly one, none is NULL and none is comma-separated. What
// was actually happening is the inverse. MangaDex declared NO language, so it joined all thirty groups, and
// its adapter is hardcoded to ask for `translatedLanguage[]=en`. Pick the Japanese chip and the wall filled
// with one Japanese source, four universals, and English-only MangaDex. From the reader's chair that is
// exactly "says Japanese, serves English".
//
// The second half is the language rail itself: 29 of that install's 45 rows are ONE site (3Hentai) installed
// once per language, which is the Mihon SourceFactory model. Counting rows made the rail a rendering of that
// site's supported-language list -- thirty chips, most of them leading back to the same place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inGroup, languagesOf, budgetFor, Src } from '../lib/sourceGroups';

const src = (p: Partial<Src> & { id: string }): Src =>
  ({ name: p.id, lang: null, latest: true, status: 'ok', ...p }) as Src;

test('a source that declares a language stays in it', () => {
  const ja = src({ id: 'a', lang: 'ja' });
  assert.equal(inGroup(ja, 'ja'), true);
  assert.equal(inGroup(ja, 'en'), false);
  assert.equal(inGroup(ja, ''), true, 'no chosen language means everything is in group');
});

test('THE REGRESSION: a source with no declared language joins every group', () => {
  // This is deliberate and load-bearing for genuinely multi-language sources, which is why the fix was to
  // give MangaDex a language rather than to change this rule.
  const any = src({ id: 'b', lang: null });
  assert.equal(inGroup(any, 'ja'), true);
  assert.equal(inGroup(any, 'ko'), true);
  assert.equal(inGroup(src({ id: 'c', lang: 'all' }), 'ja'), true);

  // …and MangaDex, which asks the API for English and nothing else, must now stay out of the Japanese group.
  const mangadex = src({ id: 'mangadex', lang: 'en' });
  assert.equal(inGroup(mangadex, 'ja'), false, 'English-only MangaDex is back in the Japanese group');
  assert.equal(inGroup(mangadex, 'en'), true);
});

test('a multi-value language lands in both groups rather than in a group of its own', () => {
  // Matches zero rows today. It exists so a future Suwayomi that emits `en,ja` is handled instead of being
  // bucketed under the literal string "en,ja", which no chip ever selects.
  const both = src({ id: 'd', lang: 'en,ja' });
  assert.equal(inGroup(both, 'en'), true);
  assert.equal(inGroup(both, 'ja'), true);
  assert.equal(inGroup(both, 'ko'), false);
  const codes = languagesOf([both]).map((l) => l.code).sort();
  assert.deepEqual(codes, ['en', 'ja']);
});

test('the language rail counts sites, not rows', () => {
  // One site registered once per language, exactly as the real install has it — and twice in English, which
  // is what makes this test able to tell rows and sites apart at all.
  const factory = [
    src({ id: '3h-en', name: '3Hentai', lang: 'en' }),
    src({ id: '3h-en-alt', name: '3Hentai', lang: 'en' }),
    ...['ja', 'ko', 'zh'].map((l) => src({ id: `3h-${l}`, name: '3Hentai', lang: l })),
  ];
  const real = [src({ id: 'aqua', name: 'Aqua Manga', lang: 'en' }), src({ id: 'md', name: 'MangaDex', lang: 'en' })];
  const langs = languagesOf([...factory, ...real]);
  const en = langs.find((l) => l.code === 'en')!;
  const ja = langs.find((l) => l.code === 'ja')!;
  assert.equal(en.count, 3, 'English has four rows but only three sites — the rail is counting rows');
  assert.equal(ja.count, 1);
  // English leads because it has more sites, which is the only ordering signal that means anything here.
  assert.equal(langs[0].code, 'en');
});

test('languages nobody can browse get no chip', () => {
  const langs = languagesOf([
    src({ id: 'x', lang: 'fr', latest: false }),          // cannot browse newest at all
    src({ id: 'y', lang: 'de', status: 'disabled' }),     // switched off by the admin
    src({ id: 'z', lang: 'all' }),                        // would otherwise appear in all thirty counts
    src({ id: 'w', lang: null }),
  ]);
  assert.deepEqual(langs, [], 'a chip was offered for a language with nothing behind it');
});

test('the budget prefers healthy, then the declared language, then what the library actually uses', () => {
  // In the order the server actually returns them, which resolves alphabetically — so only the `used`
  // comparator can lift Aqua Manga above "18 Porn Comic". A pool that already listed Aqua first would pass
  // with the ranking removed entirely, because Array.sort is stable.
  const pool = [
    src({ id: 'porn18', name: '18 Porn Comic', lang: 'en', used: 0 }),
    src({ id: 'blocked-en', name: 'Blocked EN', lang: 'en', status: 'blocked', used: 500 }),
    src({ id: 'aqua', name: 'Aqua Manga', lang: 'en', used: 176 }),
    src({ id: 'off', name: 'Off', lang: 'en', status: 'disabled', used: 999 }),
    src({ id: 'universal', name: 'Universal', lang: null, used: 0 }),
  ];

  // A blocked source is a guaranteed timeout for a guaranteed nothing, so it sorts last however popular it
  // is -- which at a realistic budget means it is not fetched at all.
  assert.deepEqual(
    budgetFor(pool, 'en', 9).map((s) => s.id),
    ['aqua', 'porn18', 'universal', 'blocked-en'],
    'a disabled source was fetched, or the ordering is wrong',
  );

  // THE REGRESSION, measured on production after this shipped: with "declares the language" ranked above
  // "the library came from it", the English chip fetched five adult extension sources and MangaDex, and
  // Aqua Manga -- 189 of that library's 214 series -- was never in the six, because it is a universal source
  // and declares no language. A universal the reader actually uses beats a declared source they never have.
  const real = budgetFor([
    src({ id: 'declared-1', name: 'Declared One', lang: 'en', used: 0 }),
    src({ id: 'declared-2', name: 'Declared Two', lang: 'en', used: 0 }),
    src({ id: 'aqua-univ', name: 'Aqua Manga', lang: null, used: 189 }),
  ], 'en', 2).map((s) => s.id);
  assert.equal(real[0], 'aqua-univ', 'a universal source with the whole library behind it was not fetched first');

  // The reported symptom of the old ordering: health-then-alphabetical put "18 Porn Comic" and "1Manga.co"
  // at the front of the English group while Aqua Manga -- 176 of this library's 214 series, answering in
  // 2.5s -- was never among the six actually fetched.
  const three = budgetFor(pool, 'en', 3).map((s) => s.id);
  assert.equal(three[0], 'aqua', 'the most-used source was not fetched first');
  assert.equal(three.includes('blocked-en'), false, 'a blocked source displaced a healthy one');
});

test('the budget still falls back to universals when the language has few sources', () => {
  const picked = budgetFor([
    src({ id: 'universal', name: 'Universal', lang: null }),
    src({ id: 'ja-only', name: 'JA Only', lang: 'ja' }),
  ], 'ja');
  assert.deepEqual(picked.map((s) => s.id), ['ja-only', 'universal'], 'the declared language must come first');
});
