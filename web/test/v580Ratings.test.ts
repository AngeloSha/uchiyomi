// v0.58.0, the web half: AniList's score and popularity beside the reader's own stars, and five more Library orders.
//
// The owner asked for a series rating from somewhere else (AniList) while keeping their own stars, to sort by popularity
// and see it in the Library and on Home, and to sort by number of chapters, "etc.". Their choices: Home gets "Most popular
// in your library"; the Library gets Most popular, Top rated (AniList's score), My rating, Most chapters and Recently read,
// after the four it had. What a card says is pure (lib/sortValue.ts) and runs here; the tiles are rendered statically, as
// actionList.test.ts renders its rows; the wiring a static render cannot reach is read from source, as
// v558Preferences.test.ts reads its own. v0.60.0 grouped the orders into the toolbar's Sort menu (lib/librarySort.ts) and
// gave the value line its icons ("★ 84", "312K readers"); test/v600Library.test.ts holds the rest of that release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SORTS, SORT_GROUPS } from '../lib/librarySort';
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

test('the Library offers the nine orders as the grouped Sort menu, each as the sort string the server knows', () => {
  // The owner's nine (v0.58.0), grouped in v0.60.0 the way a reader thinks of them: what happened lately, what people
  // think of it, how big it is, its name. Reintroduce a typo in a sort string ('popular,desc'): an older server and this
  // one both sort it by title, and nothing on screen says so -- this fails; move an order to another group, or drop one:
  // the menu fails.
  assert.deepEqual(SORT_GROUPS.map((g) => [g.label, g.sorts.map((s) => [s.key, s.label, s.sort])]), [
    // v0.61.0, deliberately: Releasing soon joins Activity -- the release radar's estimate, soonest first.
    ['Activity', [['updated', 'Updated', 'lastModified,desc'], ['read', 'Recently read', 'lastRead,desc'], ['new', 'Newest', 'createdDate,desc'],
      ['soon', 'Releasing soon', 'releasing,asc']]],
    ['Ratings', [['popular', 'Most popular', 'popularity,desc'], ['score', 'Top rated', 'score,desc'], ['rating', 'My rating', 'rating,desc']]],
    ['Size', [['chapters', 'Most chapters', 'chapters,desc'], ['unread', 'Most unread', 'unread,desc']]],
    ['Name', [['az', 'A–Z', 'metadata.titleSort,asc']]],
  ]);
  // Every order in exactly one group, the default first: SORTS[0] is the page's fallback for a key it does not know.
  assert.deepEqual(SORT_GROUPS.flatMap((g) => g.sorts), [...SORTS]);
  assert.deepEqual(new Set(SORTS.map((s) => s.key)).size, 10, 'v0.61.0: the nine, and Releasing soon');
  assert.equal(SORTS[0].key, 'updated');
  // The labels reach the extractor (rendered as tr(s.label)), and the page accepts the new ids from the URL and from the
  // saved default because its validSort reads SORTS -- the line v558Preferences.test.ts pins.
  assert.match(read('lib/librarySort.ts'),
    /const SORT_LABELS = keys\('Updated', 'Newest', 'A–Z', 'Most unread', 'Most popular', 'Top rated', 'My rating', 'Most chapters', 'Recently read', 'Releasing soon'\);/);
  assert.match(read('lib/librarySort.ts'), /const GROUP_LABELS = keys\('Activity', 'Ratings', 'Size', 'Name'\);/);
  assert.match(code(read('app/library/page.tsx')), /const validSort = \(v: unknown\): v is string => typeof v === 'string' && SORTS\.some\(\(s\) => s\.key === v\)/);
  assert.match(read('app/library/page.tsx'), /import \{ SORTS, [^}]*\} from '@\/lib\/librarySort';/, 'the page reads another list of orders');
});

/** What a card's line says, isolates dropped: [kind, text, hint], or null for no line. */
const line = (v: ReturnType<typeof sortValue>) => (v ? [v.kind, seen(v.text), seen(v.hint)] : null);

test('a card says the value its shelf is sorted by, for the five new orders only', () => {
  // Reintroduce a line for an older order (Updated saying "Updated 3d ago"): "updated says a value" fails -- those four
  // are answered by the card already (its NEW mark, its unread count, its title). v0.60.0: the card draws the kind -- a
  // star before AniList's score, the people icon before its popularity -- so the text is the number ("84", "312K readers"),
  // and the long form ("84% on AniList") is the hint the card puts on the line's hover.
  const s = rated();
  assert.deepEqual(line(sortValue(s, 'popular')), ['popularity', '312K readers', '312K on AniList']);
  assert.deepEqual(line(sortValue(s, 'score')), ['score', '84', '84% on AniList']);
  assert.deepEqual(line(sortValue(s, 'rating')), ['rating', '★ 4/5', '★ 4/5']);
  assert.deepEqual(line(sortValue(s, 'chapters')), ['chapters', '37 chapters', '37 chapters']);
  assert.equal(sortValue(series({}, 1), 'chapters')?.text, '1 chapter', 'one chapter reads "1 chapters"');
  assert.deepEqual(line(sortValue(s, 'read')), ['read', 'Read 3d ago', 'Read 3d ago']);
  assert.equal(sortValue(series({ lastReadAt: new Date(Date.now() - 20_000).toISOString() }), 'read')?.text, 'Read just now');
  assert.deepEqual(line(sortValue(series({ anilist: { score: 61, popularity: 1_234_567 } }), 'popular')), ['popularity', '1.2M readers', '1.2M on AniList']);
  assert.deepEqual(line(sortValue(series({ anilist: { score: 61, popularity: 950 } }), 'popular')), ['popularity', '950 readers', '950 on AniList']);
  assert.equal(sortValue(series({ anilist: { score: 61, popularity: 1 } }), 'popular')?.text, '1 reader', 'one reader reads "1 readers"');
  for (const k of ['updated', 'new', 'az', 'unread', 'random', '']) assert.equal(sortValue(s, k), null, `${k} says a value`);
});

test('a series without the value says nothing: an older server, no AniList link, never rated, never read', () => {
  // They sort last on the server; a card that said "0 on AniList" or "Read never" would look like a value. Reintroduce
  // `?? 0` for a missing popularity: "an older server's card says a popularity" fails.
  const older = series();
  for (const k of ['popular', 'score', 'rating', 'read']) assert.equal(sortValue(older, k), null, `an older server's card says a ${k}`);
  const none = series({ anilist: null, lastReadAt: null, rating: null });
  for (const k of ['popular', 'score', 'rating', 'read']) assert.equal(sortValue(none, k), null, `a series without it says a ${k}`);
  // One of AniList's two numbers without the other.
  assert.equal(sortValue(series({ anilist: { score: null, popularity: 950 } }), 'score'), null);
  assert.equal(sortValue(series({ anilist: { score: 71, popularity: null } }), 'popular'), null);
  // Junk is nothing, and a fractional score is a whole percent.
  assert.equal(sortValue(series({ anilist: { score: Number.NaN, popularity: 'x' as unknown as number } }), 'score'), null);
  assert.equal(anilistNumbers({ score: Number.NaN, popularity: null }), null);
  assert.equal(sortValue(series({ lastReadAt: 'not a date' }), 'read'), null);
  assert.deepEqual(line(sortValue(series({ anilist: { score: 83.6, popularity: null } }), 'score')), ['score', '84', '84% on AniList']);
  assert.equal(sortValue(series({ rating: 0 }), 'rating'), null);
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
    assert.equal(sortValue(rated(), 'score')?.hint, '84\u00a0% sur AniList', 'the percent sign can break from its number');
    assert.equal(sortValue(rated(), 'popular')?.hint, `\u2068${compactText(312_071)}\u2069 sur AniList`);
    assert.equal(seen(sortValue(rated(), 'popular')!.hint).replace(/\s/g, ' '), '312 k sur AniList');
    assert.equal(sortValue(rated(), 'popular')?.text, `\u2068${compactText(312_071)}\u2069 lecteurs`, 'the card\'s count is not isolated, or not French');
    assert.equal(seen(anilistLine({ score: 84, popularity: 312_071 })).replace(/\s/g, ' '), 'AniList 84 % · 312 k');
    assert.equal(sortValue(rated(), 'chapters')?.text, '37 chapitres');
    assert.match(sortValue(rated(), 'read')!.text, /^Lu il y a 3 jours$/);
  });
  // Arabic: "312 ألف" is a number and a word. Isolated, a Latin "AniList" before it cannot pull the number away from its
  // word. Reintroduce a bare count: "the Arabic count is not isolated" fails.
  inLanguage('ar', () => {
    const count = compactText(312_071);
    assert.equal(count.replace(/\s/g, ' '), '312 ألف');
    assert.equal(sortValue(rated(), 'popular')?.hint, `\u2068${count}\u2069 على AniList`, 'the Arabic count is not isolated');
    assert.ok(sortValue(rated(), 'popular')!.text.includes(`\u2068${count}\u2069`), 'the card\'s Arabic count is not isolated');
    assert.equal(anilistLine({ score: 84, popularity: 312_071 }), `AniList: 84٪ · \u2068${count}\u2069`);
  });
  inLanguage('ja', () => {
    assert.equal(seen(sortValue(rated(), 'popular')!.hint), 'AniList で 31万人');
    assert.equal(sortValue(rated(), 'rating')?.text, '★ 4/5', 'the stars are not words');
    assert.equal(sortValue(rated(), 'score')?.text, '84', 'a score is its number');
  });
  inLanguage('de', () => {
    // German shortens only from a million.
    assert.equal(seen(sortValue(rated(), 'popular')!.hint), '312.071 auf AniList');
    assert.equal(seen(sortValue(rated(), 'popular')!.text), '312.071 Leser');
    assert.equal(sortValue(rated(), 'score')?.hint, '84\u00a0% auf AniList');
  });
});

test('every new string is in all eight languages, and the Sort key says each order once', () => {
  // localeCoverage.test.ts holds every key to the eight files; this names the release's own, so a key renamed in code
  // and left behind in the files fails here by name.
  assert.deepEqual(LOCALES, ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']);
  for (const lang of LOCALES) {
    const d = dict(lang);
    for (const k of NEW_KEYS) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${lang}.json has no "${k}"`);
  }
  // Japanese said "{name}順" around labels that end in 順 already: "更新順順", and now "人気順順". The count line said it
  // until v0.60.0; the toolbar's Sort key says it now, as its name (components/LibraryToolbar.tsx). Reintroduce the old
  // header: this fails for every order.
  inLanguage('ja', () => {
    for (const s of SORTS) {
      const header = tr('Sorted by {name}', { name: tr(s.label).toLowerCase() });
      assert.doesNotMatch(header, /順順/, `the header doubles 順: ${header}`);
    }
  });
  assert.match(code(read('components/LibraryToolbar.tsx')), /const said = tr\('Sorted by \{name\}', \{/, 'the Sort key does not say the order it is in');
});

test('the Library tile shows the line under its title, and nothing without one', () => {
  // Rendered: the line is the paragraph after the title's, and an empty note draws no empty paragraph (a blank 11-px
  // row under every title on the four older orders). Reintroduce `{note !== undefined && …}`: "an empty line" fails.
  // As the app mounts them: under the session (the tile's right-click menu asks who is reading) and the query client.
  // v0.60.0: the line names its kind, draws its icon -- the star is the score's name to a screen reader -- and carries the
  // long form as its hover.
  const mounted = (el: React.ReactElement) => renderToStaticMarkup(createElement(AuthProvider, null,
    createElement(QueryClientProvider, { client: new QueryClient() }, el)));
  type Note = Parameters<typeof SeriesTile>[0]['note'];
  const tile = (note?: Note) => mounted(createElement(SeriesTile, { series: rated(), note }));
  const popular = seen(tile(sortValue(rated(), 'popular')));
  assert.match(popular, /Walk Tale<\/p><p data-sort-value="popularity" title="312K on AniList" class="[^"]*text-fog-500[^"]*"><svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span class="min-w-0 truncate">312K readers<\/span><\/p>/);
  const score = tile(sortValue(rated(), 'score'));
  assert.match(score, /Walk Tale<\/p><p data-sort-value="score" title="84% on AniList" class="[^"]*"><svg [^>]*role="img" aria-label="AniList score"[^>]*>[\s\S]*?<\/svg><span class="min-w-0 truncate">84<\/span><\/p>/,
    'the score has no star, or the star does not name it');
  // The reader's own stars and the words-only kinds: no icon, and no hover repeating the line.
  assert.match(tile(sortValue(rated(), 'rating')), /Walk Tale<\/p><p data-sort-value="rating" class="[^"]*"><span class="min-w-0 truncate">★ 4\/5<\/span><\/p>/);
  // A plain string is still a line, for a rail's own fact.
  assert.match(tile('Some words'), /Walk Tale<\/p><p data-sort-value="true" class="[^"]*text-fog-500[^"]*"><span class="min-w-0 truncate">Some words<\/span><\/p>/);
  assert.doesNotMatch(tile(''), /data-sort-value/, 'an empty line');
  assert.doesNotMatch(tile(), /data-sort-value/, 'an empty line');
  assert.doesNotMatch(tile(null), /data-sort-value/, 'an empty line');
  // Home's card takes the same kind of line.
  const card = (note?: Note) => mounted(createElement(SeriesCard, { series: rated(), note }));
  assert.match(card(sortValue(rated(), 'score')), /Walk Tale\s*<\/p><p data-card-note="score" title="84% on AniList" class="[^"]*"><svg [^>]*role="img" aria-label="AniList score"[^>]*>[\s\S]*?<\/svg><span class="min-w-0 truncate">84<\/span><\/p>/);
  assert.match(card('84% on AniList'), /Walk Tale\s*<\/p><p data-card-note="true" class="[^"]*"><span class="min-w-0 truncate">84% on AniList<\/span><\/p>/);
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

test('the series page says AniList\'s word and the reader\'s own once, in one panel: linked, and clearable', () => {
  // v0.58.0 said both up to three times -- a chip over the desktop banner, the meta line, a line under the stars. v0.60.0
  // made it one panel (components/RatingsPanel.tsx; test/ratingsPanel.test.ts renders it): AniList's tile opening the
  // entry, and the reader's stars, the current one tapped again clearing it. Reintroduce any of the three old places
  // (`data-anilist-chip`, `data-anilist-meta`, `data-anilist-rating`, or "★ {rating}/5" in the page): this fails.
  const page = code(read('app/series/page.tsx'));
  for (const old of ['data-anilist-chip', 'data-anilist-meta', 'data-anilist-rating', 'anilistLine(', '<StarRating']) {
    assert.ok(!page.includes(old), `the series page says it again: ${old}`);
  }
  assert.doesNotMatch(page, /★ \{rating\}\/5/, 'the reader\'s stars are said beside the panel again');
  // Once per layout: under the cover on a phone, atop the right column from lg.
  assert.equal((page.match(/<RatingsPanel anilist=\{series\.yomi\?\.anilist\} rating=\{rating\} onRate=\{rate\}/g) ?? []).length, 2);
  const panel = code(read('components/RatingsPanel.tsx'));
  assert.match(panel, /<a href=\{tile\.url\} target="_blank" rel="noopener noreferrer"/, 'the AniList tile does not open the entry');
  assert.match(panel, /const next = nextRating\(before, tapped\);/, 'a tap on the current star does not clear it');
  assert.match(panel, /const hint = tr\('Average score on AniList, and how many people there have it on a list'\);/);
  // The two fields arrive inside `yomi`, optional, as an older server sends neither; the entry's id since v0.60.0.
  const flags = slice(read('lib/types.ts'), 'export interface UchiyomiFlags', '\n}');
  assert.match(flags, /anilist\?: AniListNumbers \| null;/);
  assert.match(flags, /lastReadAt\?: string \| null;/);
  assert.match(slice(read('lib/types.ts'), 'export interface AniListNumbers', '\n}'), /id\?: string \| null;/);
});
