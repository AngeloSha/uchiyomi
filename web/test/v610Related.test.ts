// v0.61.0: related works on the series page, the next in the story at the end of the reader, and Discover's own AniList
// rails and `?q=` (lane D).
//
// The owner approved "Related works + Because you read X", trending manga and manhua beside the manhwa, and Discover
// opening on a search. The server's rules (what is asked of AniList, what each viewer may be shown) run against Postgres
// in bff anilistRelated.int.test.ts; here, what the web makes of the answers: the relations' words, the cards (rendered),
// where a card leads and for whom, when the reader asks, and the page's wiring, read from source as the other Discover
// tests read theirs. Each guard names the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../lib/auth';
import { setActiveDict } from '../lib/i18n';
import { setActiveLocale } from '../lib/format';
import { RELATIONS, RELATION_LABELS, findHref, relationLabel, shownRows, type RelatedAnswer } from '../lib/related';
import { NextInStory, OutsideCard, RelatedRail } from '../components/RelatedRail';
import type { Series } from '../lib/types';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed, JSX ones whole: comments here quote the code they replaced. */
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const outside = { anilistId: 1005, title: 'Rel Prequel Outside', cover: 'https://s4.anilist.co/c/1005.jpg', format: 'MANGA', status: 'RELEASING', score: 70 };
const series = (id: string, title: string): Series => ({
  id, libraryId: 'lib', name: title, booksCount: 3, booksReadCount: 0, booksUnreadCount: 3, booksInProgressCount: 0,
  metadata: { title } as Series['metadata'],
});
const ANSWER: RelatedAnswer = {
  lookups: true,
  content: [
    { relation: 'SEQUEL', series: series('s_rel_sequel', 'Rel Sequel') },
    { relation: 'PREQUEL', outside },
    { relation: 'SEQUEL', outside: { ...outside, anilistId: 1008, title: 'Second Sequel Outside', cover: 'https://s4.anilist.co/c/1008.jpg' } },
    { relation: 'SPIN_OFF', series: series('s_rel_named', 'Named Held Work') },
  ],
};
/** A component, as the app mounts it: signed out (the loading state, which counts as allowed), its answer cached. */
const mounted = (el: React.ReactElement, answer?: RelatedAnswer) => {
  const client = new QueryClient();
  if (answer) client.setQueryData(['related', 's_rel_main'], answer);
  return renderToStaticMarkup(createElement(AuthProvider, null, createElement(QueryClientProvider, { client }, el)));
};

test('the six relations are named from keys(), in the order the server answers them', () => {
  // The labels reach tr() through a variable, so they are declared with keys() for the translators (localeCoverage scans
  // those). Reintroduce a bare array: localeCoverage no longer sees them and every language reads them in English.
  assert.match(code(read('lib/related.ts')), /export const RELATION_LABELS = keys\('Sequel', 'Prequel', 'Main story', 'Side story', 'Spin-off', 'Alternative version'\);/);
  assert.deepEqual([...RELATION_LABELS], ['Sequel', 'Prequel', 'Main story', 'Side story', 'Spin-off', 'Alternative version']);
  // The server's own list (bff lib/anilist.ts), in its order: a relation the web did not know would be a card with no word.
  const bff = /export const RELATIONS = \[([^\]]*)\] as const;/.exec(read('../bff/src/lib/anilist.ts'));
  assert.ok(bff, 'the server no longer declares its relations where this test looks');
  assert.deepEqual([...RELATIONS], bff![1].split(',').map((s) => s.trim().replace(/'/g, '')));
  assert.deepEqual(RELATIONS.map(relationLabel), ['Sequel', 'Prequel', 'Main story', 'Side story', 'Spin-off', 'Alternative version']);
  assert.equal(relationLabel('ADAPTATION'), '', 'a relation this version does not know has a word');
  setActiveDict({ 'Main story': 'Hauptgeschichte' });
  try { assert.equal(relationLabel('PARENT'), 'Hauptgeschichte', 'the relation is English in every language'); } finally { setActiveDict({}); }
  // Where an outside card leads: Discover, searching for it. The trailing slash is the static export's (DISCOVER_HREF).
  assert.equal(findHref('Solo Leveling: Ragnarok '), '/discover/?q=Solo%20Leveling%3A%20Ragnarok');
  // What is shown: nothing without lookups, only known relations with something to show, the sequels alone when asked.
  assert.deepEqual(shownRows({ lookups: false, content: ANSWER.content }), []);
  assert.deepEqual(shownRows({ lookups: true, content: [{ relation: 'ADAPTATION' as any, outside }, { relation: 'SEQUEL' }] }), []);
  assert.deepEqual(shownRows(ANSWER, 'SEQUEL').map((r) => r.series?.id ?? r.outside?.anilistId), ['s_rel_sequel', 1008]);
  assert.equal(shownRows(undefined).length, 0);
});

test('an outside card leads to Discover only for an account that may add series', () => {
  const card = (mayAdd: boolean, note?: string) => mounted(createElement(OutsideCard, { item: outside, note, mayAdd }));
  // Reintroduce the link whatever the permission (`mayAdd` ignored): "not a link without the permission" fails -- and a
  // member who may not add series is sent to a page that refuses them.
  const may = card(true, 'Prequel');
  // Outside the Next runtime the link drops the static export's trailing slash; findHref's own string is pinned above.
  assert.match(may, /^<a [^>]*href="\/discover\/?\?q=Rel%20Prequel%20Outside"/, 'the card does not lead to Discover searching for it');
  assert.match(may, /title="Find it on your sources"/);
  assert.match(may, /data-find-mark/, 'no add mark on a card that leads to adding');
  assert.doesNotMatch(may, /Not in your library/);
  assert.match(may, /<p data-card-note="true"[^>]*>Prequel<\/p>/, 'the relation is not the note under the title');
  assert.match(may, /<bdi dir="ltr">70%<\/bdi>/, 'the score is not shown, or not left to right');
  const mayNot = card(false, 'Prequel');
  assert.doesNotMatch(mayNot, /<a\b/, 'not a link without the permission');
  assert.doesNotMatch(mayNot, /data-find-mark/);
  assert.match(mayNot, /data-not-held="true"[^>]*>Not in your library<\/span>/, 'a card that leads nowhere does not say why');
  // The words are the reader's language.
  setActiveDict({ 'Not in your library': 'Nicht in deiner Bibliothek', 'Find it on your sources': 'In deinen Quellen finden' });
  try {
    assert.match(card(false), />Nicht in deiner Bibliothek</);
    assert.match(card(true), /title="In deinen Quellen finden"/);
  } finally { setActiveDict({}); }
  // The permission is the app's one rule (lib/auth.ts canDownload), read from the signed-in account, in both rails.
  const rail = code(read('components/RelatedRail.tsx'));
  assert.equal((rail.match(/const mayAdd = canDownload\(user\);/g) ?? []).length, 2, 'a rail decides the permission its own way');
});

test('Related: the library\'s own cards for what it holds, AniList\'s for the rest, each saying how it is related', () => {
  const html = mounted(createElement(RelatedRail, { seriesId: 's_rel_main' }), ANSWER);
  assert.match(html, /^<section class="mt-10" data-related="true">/);
  assert.match(html, /<h2[^>]*>Related<\/h2>/);
  // A held work is its series card, opening the series, with the relation as its note.
  assert.match(html, /href="\/series\/?\?id=s_rel_sequel"[\s\S]*?Rel Sequel\s*<\/p><p data-card-note="true"[^>]*><span class="min-w-0 truncate">Sequel<\/span>/);
  assert.match(html, /href="\/series\/?\?id=s_rel_named"[\s\S]*?<span class="min-w-0 truncate">Spin-off<\/span>/);
  assert.match(html, /data-outside="1005" class="[^"]*"[^>]*>[\s\S]*?>Prequel<\/p>/);
  // In the order the server answered.
  const order = [...html.matchAll(/href="\/series\/?\?id=(s_rel_\w+)"|data-outside="(\d+)"/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual([...new Set(order)], ['s_rel_sequel', '1005', '1008', 's_rel_named']);
  // Nothing at all without lookups, or with nothing to show -- no heading over an empty rail.
  assert.equal(mounted(createElement(RelatedRail, { seriesId: 's_rel_main' }), { lookups: false, content: ANSWER.content }), '');
  assert.equal(mounted(createElement(RelatedRail, { seriesId: 's_rel_main' }), { lookups: true, content: [] }), '');
  assert.equal(mounted(createElement(RelatedRail, { seriesId: 's_rel_main' })), '', 'a rail before its answer');
  // The reader's: the sequels alone, under their own heading, no relation repeated under each.
  const next = mounted(createElement(NextInStory, { seriesId: 's_rel_main' }), ANSWER);
  assert.match(next, /^<div class="mt-12 text-start" data-next-in-story="true">/);
  assert.match(next, /<h2[^>]*>Next in the story<\/h2>/);
  assert.match(next, /s_rel_sequel/);
  assert.match(next, /data-outside="1008"/);
  assert.doesNotMatch(next, /1005|s_rel_named/, 'a prequel or a spin-off is next in the story');
  assert.doesNotMatch(next, /data-card-note/);
  assert.equal(mounted(createElement(NextInStory, { seriesId: 's_rel_main' }), { lookups: true, content: [ANSWER.content[1]] }), '');
});

test('the rails are mirrored and squared: logical sides only, no capsule, and on the no-pills list', () => {
  // Reintroduce a physical side (`right-1.5`) or a round mark (`rounded-full` on the add mark): these fail.
  const rail = code(read('components/RelatedRail.tsx'));
  const classes = [...rail.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]).join(' ');
  assert.doesNotMatch(classes, /(?:^|[\s:])-?(?:left|right|ml|mr|pl|pr|rounded-l|rounded-r|border-l|border-r)-|text-(?:left|right)\b/, 'a physical side in RelatedRail.tsx');
  assert.doesNotMatch(classes, /\brounded-full\b/, 'a round tag or mark in RelatedRail.tsx');
  assert.match(classes, /end-1\.5/, 'the corner marks are not placed by logical sides');
  assert.match(read('test/noPills.test.ts'), /'components\/RelatedRail\.tsx',/, 'RelatedRail.tsx is not on the no-pills surfaces');
});

test('the series page shows Related above More like this; the reader asks only once the series is finished online', () => {
  const page = code(read('app/series/page.tsx'));
  assert.equal((page.match(/<RelatedRail\b/g) ?? []).length, 1);
  const at = page.indexOf('<RelatedRail seriesId={id} />');
  assert.ok(at > 0 && at < page.indexOf("tr('More like this')"), 'Related is not just above More like this');
  // The reader mounts Next in the story at the end of the series on the live list -- never at the end of what is
  // downloaded, where there may be fifty more chapters online -- and the query lives in the component, so nothing is
  // asked before then. Reintroduce the end card without the gate (`{<NextInStory …/>}` alone, or `ended &&` only): fails.
  const reader = code(read('app/reader/page.tsx'));
  assert.equal((reader.match(/<NextInStory\b/g) ?? []).length, 1);
  assert.match(reader, /\{ended && !offlineEnd && <NextInStory seriesId=\{seriesId\} \/>\}\s*\{!offlineEnd && !!upNext\?\.content\?\.length && \(/,
    'Next in the story is not gated on the end of the live list, or not above Because you finished this');
  assert.doesNotMatch(reader, /\/related`/, 'the reader asks for related works itself');
  const rail = code(read('components/RelatedRail.tsx'));
  assert.match(rail, /queryKey: \['related', seriesId\],\s*queryFn: \(\) => api<RelatedAnswer>\(`\/api\/series\/\$\{encodeURIComponent\(seriesId\)\}\/related`\),\s*enabled: !!seriesId,/);
});

test('Discover reads ?q= once, inside a Suspense boundary, opens on that search, and writes the address itself', () => {
  const src = code(read('app/discover/page.tsx'));
  // The static export refuses a page that reads the address outside Suspense. Reintroduce `export default function
  // DiscoverPage()` around the body: "no Suspense boundary" fails (and `next build` does).
  assert.match(src, /export default function DiscoverPage\(\) \{\s*return \(\s*<Suspense fallback=\{<div className="min-h-screen-d" \/>\}>\s*<DiscoverInner \/>\s*<\/Suspense>\s*\);\s*\}/,
    'no Suspense boundary');
  const inner = src.slice(src.indexOf('function DiscoverInner()'), src.indexOf('export default function DiscoverPage()'));
  assert.ok(inner.length > 1000, 'the page body is not DiscoverInner');
  assert.equal((src.match(/useSearchParams\(\)/g) ?? []).length, 1);
  assert.ok(inner.includes('const params = useSearchParams();'), 'the address is read outside the boundary');
  // Once, in the initialisers: a search started from the address is the page's own from then on.
  assert.match(inner, /const \[arrivedQ\] = useState\(\(\) => \(params\.get\('q'\) \?\? ''\)\.trim\(\)\.slice\(0, 200\)\);/);
  assert.match(inner, /useState<'newest' \| 'search'>\(arrivedQ \? 'search' : 'newest'\)/, 'an arrival does not open on its search');
  assert.match(inner, /const \[q, setQ\] = useState\(arrivedQ\);/, 'the field does not show what is searched');
  assert.match(inner, /const \[term, setTerm\] = useState\(arrivedQ\);/, 'the arrival is not submitted');
  assert.doesNotMatch(inner, /params\.get\('q'\)[\s\S]*params\.get\('q'\)/, 'the address is read more than once');
  // Replaced, never pushed: Back leaves Discover. A submitted search writes its term; back to Newest takes it away.
  assert.match(inner, /window\.history\.replaceState\(window\.history\.state, '', `\$\{u\.pathname\}\$\{u\.search\}\$\{u\.hash\}`\);/);
  assert.doesNotMatch(inner, /pushState|router\.push/);
  assert.match(inner, /setMode\('search'\);\s*writeQ\(next\);/, 'a search does not write its term');
  assert.match(inner, /const backToNewest = \(\) => \{ setQ\(''\); setMode\('newest'\); writeQ\(''\); \};/, 'back to Newest leaves ?q= behind');
  // An account the server refuses is not asked, even when the address says to search.
  assert.match(inner, /enabled: mode === 'search' && !!term && mayAdd,/);
});

test('Discover\'s rows sit inside the wall: the picks, then manhwa, manga and manhua, through one rail (v0.98.0)', () => {
  const src = code(read('app/discover/page.tsx'));
  // The countries are the server's (bff lib/anilist.ts TREND_COUNTRIES), each with its own words declared for the
  // translators, in the same order.
  assert.match(src, /const TREND_RAILS = \['KR', 'JP', 'CN'\] as const;/);
  assert.match(read('../bff/src/lib/anilist.ts'), /export const TREND_COUNTRIES = \['KR', 'JP', 'CN'\] as const;/);
  assert.match(src, /const TREND_LABELS = keys\('Trending manhwa', 'Trending manga', 'Trending manhua'\);/);
  assert.match(src, /const ROWS = \['foryou', \.\.\.TREND_RAILS\] as const;/, 'the picks row is not the first of the rows');
  // One key per country: Korea's, the hero's, as a literal (queryKeys.test.ts holds it to its endpoint); the others by
  // the country they ask for, while browsing, once Korea's is in. Reintroduce a shared key: Japan's answer paints Korea's row.
  assert.match(src, /queryKey: \['discover-trending', 'KR'\],\s*queryFn: \(\) => api<\{ content: Trending\[\]; pending\?: boolean \}>\('\/api\/discover\/trending\?country=KR'\),/);
  assert.match(src, /queries: TREND_RAILS\.slice\(1\)\.map\(\(country\) => \(\{\s*queryKey: \['discover-trending', country\],\s*queryFn: \(\) => api<\{ content: Trending\[\]; pending\?: boolean \}>\(`\/api\/discover\/trending\?country=\$\{country\}`\),\s*enabled: mayAdd && mode === 'newest' && heroSettled,/);
  assert.match(src, /queryKey: \['discover-because'\],\s*queryFn: \(\) => api<[^>]*>\('\/api\/discover\/because'\),\s*enabled: mayAdd && mode === 'newest' && heroSettled,/);
  // The hero's answer first: everything below the fold waits for it.
  assert.match(src, /const heroSettled = !trendQ\.isPending;/);
  // The rows: inside the wall, cut where they go (lib/shelves.ts weave), while browsing only, each only with something on
  // it, and once every row's first answer is in -- a row arriving late would take a place another already stood in.
  assert.match(src, /const rowKeys: RowKey\[\] = mode === 'newest' && rowsReady\s*\? ROWS\.filter/);
  assert.match(src, /const rowsReady = heroSettled && !recsQ\.isPending && !becauseQ\.isPending && moreTrending\.every\(\(m\) => !m\.isPending\);/);
  // Each row keeps its place, and one that comes late goes below what is on screen (lib/shelves.ts placeRows); the places
  // start again with the wall itself. Reintroduce `weave(…, rowKeys)` from scratch each render: a late row moves the wall.
  assert.match(src, /placedRef\.current\.placed = placeRows\(placedRef\.current\.placed, rowKeys, shownRef\.current, cols\);/);
  assert.match(src, /useEffect\(\(\) => \{ if \(cols >= 1\) shownRef\.current = wall\.items\.length; \}\);/);
  assert.match(src, /const wallKey = `\$\{mode\}\|\$\{listMode\}\|\$\{selected \?\? ''\}`;/);
  assert.match(src, /const \{ parts: wallParts, after: rowsAfter \} = weave\(wall\.items\.length, cols, placedRef\.current\.placed\);/);
  const woven = src.indexOf('{wallParts.slice(0, -1).map((part, n) => (part.kind === \'row\' ? rowOf(part.key) : (');
  const heading = src.indexOf("{mode === 'search' ? tr('Results across your sources')");
  const sentinel = src.indexOf('<div ref={sentinel} className="h-16" />');
  const waiting = src.indexOf('{rowsAfter.map(rowOf)}');
  assert.ok(heading > 0 && woven > heading, 'the rows are not inside the wall');
  assert.ok(sentinel > woven && waiting > sentinel, 'the rows the wall has not reached do not wait after it');
  // No row above the wall any more: the header is followed by the picker. Reintroduce a row there: this fails.
  const header = src.indexOf('</header>');
  const picker = src.indexOf('<SourcePicker');
  const between = src.slice(header, picker);
  assert.ok(!between.includes('<AniListRail') && !between.includes('rowOf'), 'a row sits above the wall again');
  // And a row is drawn in two places only: in its place inside the wall, or waiting after it.
  assert.equal((src.match(/\browOf\b/g) ?? []).length, 3, 'a row is drawn somewhere other than inside the wall or after it');
  // The picks name their read, isolated in the sentence; the trending rows rank their first ten.
  assert.match(src, /tr\('Because you read \{title\}', \{ title: `\\u2068\$\{pk\.from\.because\}\\u2069` \}\)/, 'the title is not isolated');
  assert.match(src, /<TrendingCard t=\{t\} onPick=\{pickRail\} rank=\{rank <= RANKED \? rank : undefined\} \/>/);
  // Every row is the one AniListRail, and its one ScrollRail (rails.test.ts holds the count).
  assert.equal((src.match(/<AniListRail\b/g) ?? []).length, 2);
  assert.match(src, /function AniListRail\([\s\S]*?<ScrollRail label=\{title\}/);
  // A card opens the add dialog, and an added card leaves its row -- the row it came from, by its AniList entry, and only
  // that one: the ref is forgotten when the dialog closes. Reintroduce the bare setSeed: the card stays.
  assert.match(src, /const pickRail = \(t: \{ id\?: number \| null; title: string \}\) => \{ fromKey\.current = null; fromRail\.current = railKey\(t\); setSeed\(\{ kind: 'trending', title: t\.title \}\); \};/);
  assert.match(src, /useEffect\(\(\) => \{ if \(!seed\) fromRail\.current = null; \}, \[seed\]\);/);
  assert.match(src, /const railCard = fromRail\.current;\s*if \(railCard\) setRailAdded\(\(prev\) => new Set\(prev\)\.add\(railCard\)\);/);
  assert.match(src, /\.filter\(\(pk\) => !railAdded\.has\(railKey\(pk\)\)\)/, 'an added pick stays on its row');
  assert.match(src, /\.filter\(\(\{ t \}\) => !railAdded\.has\(railKey\(t\)\)\)/, 'an added trending card stays on its row');
});

test('the new words are in all eight languages, and none is an English copy', () => {
  const words = ['Related', 'Sequel', 'Prequel', 'Main story', 'Side story', 'Spin-off', 'Alternative version', 'Find it on your sources',
    'Not in your library', 'Next in the story', 'Trending manga', 'Trending manhua'];
  const dir = join(ROOT, 'public/locales');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8);
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
    for (const k of words) {
      assert.ok(typeof d[k] === 'string' && d[k].trim(), `${f} has no "${k}"`);
      assert.notEqual(d[k], k, `${f} copies "${k}" in English`);
    }
  }
});
