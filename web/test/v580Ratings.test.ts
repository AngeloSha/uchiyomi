// v0.58.0, the web half: AniList's score and popularity beside the reader's own stars, and five more Library orders.
//
// The owner asked for a series rating from somewhere else (AniList) while keeping their own stars, to sort by popularity
// and see it in the Library and on Home, and to sort by number of chapters, "etc.". Their choices: Home gets "Most popular
// in your library"; the Library gets Most popular, Top rated (AniList's score), My rating, Most chapters and Recently read,
// after the four it had. What a card says is pure (lib/sortValue.ts) and runs here; the tiles are rendered statically, as
// actionList.test.ts renders its rows; the wiring a static render cannot reach is read from source, as
// v558Preferences.test.ts reads its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SORTS } from '../components/LibraryFilters';
import { SeriesCard, SeriesTile } from '../components/cards';
import { AuthProvider } from '../lib/auth';
import { anilistLine, anilistNumbers, sortValue } from '../lib/sortValue';
import { compactText, setActiveLocale } from '../lib/format';
import { setActiveDict, t as tr } from '../lib/i18n';
import type { Series } from '../lib/types';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the lines they explain. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const slice = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not where this test looks`);
  return src.slice(a, b);
};
/** What a reader sees: the isolates around a count are invisible. */
const seen = (s: string) => s.replace(/[\u2066-\u2069]/g, '');
const LOCALES = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const dict = (lang: string) => {
  const { _meta, ...d } = JSON.parse(read(`public/locales/${lang}.json`)) as Record<string, string>;
  return d;
};
/** Run `fn` with the app in `lang`: its dictionary and its formatters. */
function inLanguage(lang: string, fn: () => void) {
  setActiveDict(dict(lang));
  setActiveLocale(lang);
  try { fn(); } finally { setActiveDict({}); setActiveLocale('en'); }
}

const DAY = 86_400_000;
const series = (yomi: Partial<NonNullable<Series['yomi']>> = {}, booksCount = 37): Series => ({
  id: 's1', libraryId: 'l1', name: 'Walk Tale', booksCount, booksReadCount: 0, booksUnreadCount: 0, booksInProgressCount: 0,
  metadata: { title: 'Walk Tale' }, yomi: { favorite: false, rating: null, ...yomi },
});
const rated = () => series({ anilist: { score: 84, popularity: 312_071 }, rating: 4, lastReadAt: new Date(Date.now() - 3 * DAY).toISOString() });

const NEW_KEYS = ['Most popular', 'Top rated', 'My rating', 'Most chapters', 'Recently read', '{count} on AniList', '{score}% on AniList',
  'Read {when}', 'Most popular in your library', 'AniList {score}% · {count}', 'AniList {score}%',
  'Average score on AniList, and how many people there have it on a list'];

test('the Library offers the five new orders after the four it had, each as the sort string the server knows', () => {
  // The owner's list, in their order, the four older ones first and unchanged. Reintroduce a typo in a sort string
  // ('popular,desc'): an older server and this one both sort it by title, and nothing on screen says so -- this fails.
  assert.deepEqual(SORTS.map((s) => [s.key, s.label, s.sort]), [
    ['updated', 'Updated', 'lastModified,desc'],
    ['new', 'Newest', 'createdDate,desc'],
    ['az', 'A–Z', 'metadata.titleSort,asc'],
    ['unread', 'Most unread', 'unread,desc'],
    ['popular', 'Most popular', 'popularity,desc'],
    ['score', 'Top rated', 'score,desc'],
    ['rating', 'My rating', 'rating,desc'],
    ['chapters', 'Most chapters', 'chapters,desc'],
    ['read', 'Recently read', 'lastRead,desc'],
  ]);
  // The labels reach the extractor (rendered as tr(s.label)), and the page accepts the new ids from the URL and from the
  // saved default because its validSort reads SORTS -- the line v558Preferences.test.ts pins.
  assert.match(read('components/LibraryFilters.tsx'),
    /const SORT_LABELS = keys\('Updated', 'Newest', 'A–Z', 'Most unread', 'Most popular', 'Top rated', 'My rating', 'Most chapters', 'Recently read'\);/);
  assert.match(code(read('app/library/page.tsx')), /const validSort = \(v: unknown\): v is string => typeof v === 'string' && SORTS\.some\(\(s\) => s\.key === v\)/);
});

test('a card says the value its shelf is sorted by, for the five new orders only', () => {
  // Reintroduce a line for an older order (Updated saying "Updated 3d ago"): "updated says a value" fails -- those four
  // are answered by the card already (its NEW mark, its unread count, its title).
  const s = rated();
  assert.equal(seen(sortValue(s, 'popular')), '312K on AniList');
  assert.equal(sortValue(s, 'score'), '84% on AniList');
  assert.equal(sortValue(s, 'rating'), '★ 4/5');
  assert.equal(sortValue(s, 'chapters'), '37 chapters');
  assert.equal(sortValue(series({}, 1), 'chapters'), '1 chapter', 'one chapter reads "1 chapters"');
  assert.equal(sortValue(s, 'read'), 'Read 3d ago');
  assert.equal(sortValue(series({ lastReadAt: new Date(Date.now() - 20_000).toISOString() }), 'read'), 'Read just now');
  assert.equal(seen(sortValue(series({ anilist: { score: 61, popularity: 1_234_567 } }), 'popular')), '1.2M on AniList');
  assert.equal(seen(sortValue(series({ anilist: { score: 61, popularity: 950 } }), 'popular')), '950 on AniList');
  for (const k of ['updated', 'new', 'az', 'unread', 'random', '']) assert.equal(sortValue(s, k), '', `${k} says a value`);
});

test('a series without the value says nothing: an older server, no AniList link, never rated, never read', () => {
  // They sort last on the server; a card that said "0 on AniList" or "Read never" would look like a value. Reintroduce
  // `?? 0` for a missing popularity: "an older server's card says a popularity" fails.
  const older = series();
  for (const k of ['popular', 'score', 'rating', 'read']) assert.equal(sortValue(older, k), '', `an older server's card says a ${k}`);
  const none = series({ anilist: null, lastReadAt: null, rating: null });
  for (const k of ['popular', 'score', 'rating', 'read']) assert.equal(sortValue(none, k), '', `a series without it says a ${k}`);
  // One of AniList's two numbers without the other.
  assert.equal(sortValue(series({ anilist: { score: null, popularity: 950 } }), 'score'), '');
  assert.equal(sortValue(series({ anilist: { score: 71, popularity: null } }), 'popular'), '');
  // Junk is nothing, and a fractional score is a whole percent.
  assert.equal(sortValue(series({ anilist: { score: Number.NaN, popularity: 'x' as unknown as number } }), 'score'), '');
  assert.equal(anilistNumbers({ score: Number.NaN, popularity: null }), null);
  assert.equal(sortValue(series({ lastReadAt: 'not a date' }), 'read'), '');
  assert.equal(sortValue(series({ anilist: { score: 83.6, popularity: null } }), 'score'), '84% on AniList');
  assert.equal(sortValue(series({ rating: 0 }), 'rating'), '');
});

test('the series page line: "AniList 84% · 312K", or the half AniList has', () => {
  assert.equal(seen(anilistLine({ score: 84, popularity: 312_071 })), 'AniList 84% · 312K');
  assert.equal(anilistLine({ score: 84, popularity: null }), 'AniList 84%');
  assert.equal(seen(anilistLine({ score: null, popularity: 312_071 })), '312K on AniList');
  assert.equal(anilistLine({ score: null, popularity: null }), '');
  assert.equal(anilistLine(null), '', 'no checked AniList link');
  assert.equal(anilistLine(undefined), '', 'an older server');
});

test('in the reader\'s language: the count shortened their way and isolated, the percent sign kept on its number', () => {
  // French writes "84 %": glued with a no-break space, or at a card's width the sign broke onto a line of its own.
  // Reintroduce the bare translation: "the percent sign can break from its number" fails.
  inLanguage('fr', () => {
    assert.equal(sortValue(rated(), 'score'), '84\u00a0% sur AniList', 'the percent sign can break from its number');
    assert.equal(sortValue(rated(), 'popular'), `\u2068${compactText(312_071)}\u2069 sur AniList`);
    assert.equal(seen(sortValue(rated(), 'popular')).replace(/\s/g, ' '), '312 k sur AniList');
    assert.equal(seen(anilistLine({ score: 84, popularity: 312_071 })).replace(/\s/g, ' '), 'AniList 84 % · 312 k');
    assert.equal(sortValue(rated(), 'chapters'), '37 chapitres');
    assert.match(sortValue(rated(), 'read'), /^Lu il y a 3 jours$/);
  });
  // Arabic: "312 ألف" is a number and a word. Isolated, a Latin "AniList" before it cannot pull the number away from its
  // word. Reintroduce a bare count: "the Arabic count is not isolated" fails.
  inLanguage('ar', () => {
    const count = compactText(312_071);
    assert.equal(count.replace(/\s/g, ' '), '312 ألف');
    assert.equal(sortValue(rated(), 'popular'), `\u2068${count}\u2069 على AniList`, 'the Arabic count is not isolated');
    assert.equal(anilistLine({ score: 84, popularity: 312_071 }), `AniList: 84٪ · \u2068${count}\u2069`);
  });
  inLanguage('ja', () => {
    assert.equal(seen(sortValue(rated(), 'popular')), 'AniList で 31万人');
    assert.equal(sortValue(rated(), 'rating'), '★ 4/5', 'the stars are not words');
  });
  inLanguage('de', () => {
    // German shortens only from a million.
    assert.equal(seen(sortValue(rated(), 'popular')), '312.071 auf AniList');
    assert.equal(sortValue(rated(), 'score'), '84\u00a0% auf AniList');
  });
});

test('every new string is in all eight languages, and the Library header says each order once', () => {
  // localeCoverage.test.ts holds every key to the eight files; this names the release's own, so a key renamed in code
  // and left behind in the files fails here by name.
  assert.deepEqual(LOCALES, ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']);
  for (const lang of LOCALES) {
    const d = dict(lang);
    for (const k of NEW_KEYS) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${lang}.json has no "${k}"`);
  }
  // Japanese said "{name}順" around labels that end in 順 already: "更新順順", and now "人気順順". Reintroduce the old
  // header: this fails for every order.
  inLanguage('ja', () => {
    for (const s of SORTS) {
      const header = tr('Sorted by {name}', { name: tr(s.label).toLowerCase() });
      assert.doesNotMatch(header, /順順/, `the header doubles 順: ${header}`);
    }
  });
});

test('the Library tile shows the line under its title, and nothing without one', () => {
  // Rendered: the line is the paragraph after the title's, and an empty note draws no empty paragraph (a blank 11-px
  // row under every title on the four older orders). Reintroduce `{note !== undefined && …}`: "an empty line" fails.
  // As the app mounts them: under the session (the tile's right-click menu asks who is reading) and the query client.
  const mounted = (el: React.ReactElement) => renderToStaticMarkup(createElement(AuthProvider, null,
    createElement(QueryClientProvider, { client: new QueryClient() }, el)));
  const tile = (note?: string) => mounted(createElement(SeriesTile, { series: rated(), note }));
  assert.match(tile('312K on AniList'), /Walk Tale<\/p><p data-sort-value="true" class="[^"]*text-fog-500[^"]*">312K on AniList<\/p>/);
  assert.doesNotMatch(tile(''), /data-sort-value/, 'an empty line');
  assert.doesNotMatch(tile(), /data-sort-value/, 'an empty line');
  // Home's card takes the same kind of line.
  const card = (note?: string) => mounted(createElement(SeriesCard, { series: rated(), note }));
  assert.match(card('84% on AniList'), /Walk Tale\s*<\/p><p data-card-note="true" class="[^"]*">84% on AniList<\/p>/);
  assert.doesNotMatch(card(''), /data-card-note/);
  // And the Library hands each tile its order's value.
  assert.match(code(read('app/library/page.tsx')), /<SeriesTile key=\{s\.id\} series=\{s\} eager=\{i < 12\} note=\{sortValue\(s, active\.key\)\}/,
    'the Library does not say the value its shelf is sorted by');
});

test('Home: "Most popular in your library" after Recently added, saying AniList\'s score, hidden without a list', () => {
  // Reintroduce the rail unconditionally (or with a RailSkeleton): a server older than v0.58.0 sends no `popular`, and
  // Home would hold a title over nothing, or a skeleton that never fills -- "the rail shows without a list" fails.
  const home = code(read('app/page.tsx'));
  const rail = slice(home, '{(data?.popular?.length ?? 0) > 0 && (', '</section>');
  assert.match(rail, /<SectionTitle action=\{<Link href="\/library\?sort=popular" className="text-xs text-accent">\{tr\('See all'\)\}<\/Link>\}>\{tr\('Most popular in your library'\)\}<\/SectionTitle>/,
    'See all does not open the Library sorted by popularity, as New episodes and Recently added open theirs');
  assert.match(rail, /\{data!\.popular!\.map\(\(s\) => <SeriesCard key=\{s\.id\} series=\{s\} note=\{sortValue\(s, 'score'\)\} \/>\)\}/,
    'the cards are not the other rails\' SeriesCard, or do not say AniList\'s score');
  assert.doesNotMatch(rail, /RailSkeleton|isLoading/, 'the rail shows without a list');
  assert.equal((home.match(/tr\('Most popular in your library'\)/g) ?? []).length, 1);
  const at = (s: string) => home.indexOf(s);
  assert.ok(at("tr('Recently added')") > 0 && at("tr('Recently added')") < at('data?.popular') && at('data?.popular') < at("tr('Top 10 in your library')"),
    'the rail is not between Recently added and Top 10 in your library');
  assert.ok(SORTS.some((s) => s.key === 'popular'), 'See all names an order the Library does not have');
  assert.match(read('lib/types.ts'), /popular\?: Series\[\];/, 'HomePayload has no optional `popular`');
});

test('the series page shows AniList\'s line beside the reader\'s own stars, and keeps theirs as it was', () => {
  // Beside each place the reader's rating shows: under the stars' "4/5", in the meta line after "★ 4/5", and as a chip
  // after the desktop banner's "★ 4/5". Reintroduce the line in place of the reader's own (`anilist || rating`): the
  // unchanged-own-rating assertions fail.
  const page = code(read('app/series/page.tsx'));
  assert.match(page, /const anilist = anilistLine\(series\?\.yomi\?\.anilist\);/);
  assert.match(page, /<StarRating value=\{rating\} onSet=\{setStars\} \/>\s*<span className="text-xs text-fog-500">\{rating \? `\$\{rating\}\/5` : tr\('Rate this'\)\}<\/span>\s*<\/div>\s*\{anilist && \(\s*<p data-anilist-rating title=\{anilistHint\}[^>]*>\{anilist\}<\/p>\s*\)\}/,
    'the AniList line is not under the reader\'s stars');
  assert.match(page, /rating \? <span className="text-accent">★ \{rating\}\/5<\/span> : null,\s*anilist \? <span data-anilist-meta title=\{anilistHint\}[^>]*>\{anilist\}<\/span> : null,/,
    'the meta line does not say AniList\'s beside the reader\'s');
  assert.match(page, /\{\(meta\?\.status \|\| rating \|\| anilist\) && \(/, 'the banner\'s chip row is not drawn for AniList alone');
  assert.match(page, /\{rating \? <span className="chip text-\[11px\] text-accent">★ \{rating\}\/5<\/span> : null\}\s*\{anilist \? <span data-anilist-chip className="chip text-\[11px\] tabular-nums">\{anilist\}<\/span> : null\}/,
    'the desktop banner has no AniList chip beside the reader\'s');
  assert.match(page, /const anilistHint = tr\('Average score on AniList, and how many people there have it on a list'\);/);
  // The reader's own, exactly as before.
  assert.match(page, /const setStars = async \(n: number\) => \{\s*setRating\(n\);\s*try \{ await api\(`\/api\/ratings\/\$\{id\}`, \{ method: 'PUT', json: \{ stars: n \} \}\); \} catch \{\}\s*\};/);
  assert.match(page, /if \(series\?\.yomi\) \{ setFav\(series\.yomi\.favorite\); setRating\(series\.yomi\.rating\); \}/);
  // The two fields arrive inside `yomi`, optional, as an older server sends neither.
  const flags = slice(read('lib/types.ts'), 'export interface UchiyomiFlags', '\n}');
  assert.match(flags, /anilist\?: AniListNumbers \| null;/);
  assert.match(flags, /lastReadAt\?: string \| null;/);
});
