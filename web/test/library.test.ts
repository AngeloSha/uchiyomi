// The library after the browse tab was folded into it.
//
// The library used to spread its controls across three horizontally-scrolling chip rails in its header --
// four sorts, a Filters button, an 18+ toggle and a Select toggle in one row of seven, with the library tabs
// above them -- and hold the rest in a hand-rolled copy of the Sheet primitive. The browse tab, meanwhile,
// was a second library: `/browse?genre=X` ran the same search with the same grid geometry as
// `/library?genres=X`, and the only thing it had of its own was the genre wall.
//
// Read from source rather than driven in a browser, like rails.test.ts and queryKeys.test.ts, so these run
// under `npm test` with no server and no browser. The behavioural half lives in test/e2e.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const classNames = (src: string): string[] =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

/**
 * The file with its comments removed.
 *
 * ⚠️ Needed because several of the comments below QUOTE the code they forbid, to explain what the bug was.
 * A scan that cannot tell the two apart fails on its own documentation, which is a good way to end up
 * deleting the explanation to make the test pass.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** Every .tsx under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('the library header has no hand-rolled horizontal rail left', () => {
  // Reintroduce by putting the sort chips back as the header row they were:
  //   <div className="hide-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5"> … </div>
  // On a desktop mouse that offers no input at all -- the bar is deleted by the class and Lenis eats the
  // wheel over a horizontal-only scroller. It is the exact shape rails.test.ts was written against.
  for (const f of ['app/library/page.tsx', 'components/LibraryFilters.tsx']) {
    const found = classNames(code(read(f))).filter((c) => /overflow-x-auto|hide-scrollbar/.test(c));
    assert.deepEqual(found, [], `${f} hand-rolled a horizontal scroller again: ${found.join(' | ')}`);
  }
});

test('the phone filter panel is the shared Sheet, not a copy of it', () => {
  // ⚠️ The copy this replaced looked identical and behaved differently: no `role="dialog"`, no
  // `aria-modal`, no Escape-to-close, and no `data-lenis-prevent` -- so a flick inside the filter list
  // scrolled the grid behind it. Reintroduce by restoring that local FilterSheet: Escape stops working and
  // a screen reader is handed an anonymous <div>.
  const src = read('app/library/page.tsx');
  assert.match(src, /import \{[^}]*\bSheet\b[^}]*\} from '@\/components\/ui'/, 'the library no longer uses the shared Sheet');
  assert.doesNotMatch(src, /fixed inset-0 z-50/, 'the library hand-rolled a modal container again');

  const ui = read('components/ui.tsx');
  for (const need of ['role="dialog"', 'aria-modal', 'data-lenis-prevent', "e.key === 'Escape'"]) {
    assert.ok(ui.includes(need), `Sheet lost ${need}`);
  }
  // The library has a bottom nav bar; the reader, which Sheet was written for, does not.
  // Reintroduce by dropping `overBottomNav`: the last genre in the list sits under the nav, untappable.
  assert.match(src, /<Sheet[\s\S]{0,200}?overBottomNav/, 'the filter sheet no longer clears the bottom nav');
});

test('nothing anywhere still points at the deleted /browse route', () => {
  // Reintroduce by leaving any one of the six links behind -- the sparkle button in the library header was
  // the easiest to miss. In a static export with `trailingSlash: true` and no server rewrites that is a
  // hard 404 plus a Next prefetch error in the console.
  assert.ok(!existsSync(join(ROOT, 'app/browse')), 'app/browse/ is back');
  const offenders: string[] = [];
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]) {
    if (/['"`]\/browse/.test(readFileSync(f, 'utf8'))) offenders.push(f.slice(ROOT.length + 1));
  }
  assert.deepEqual(offenders, [], `these still link to /browse: ${offenders.join(', ')}`);
});

test('every route the browser tests navigate to actually exists', () => {
  // ⚠️ THE VACUITY GUARD, and it is not hypothetical: deleting app/browse/page.tsx while leaving '/browse'
  // in layout.mjs PASSES today. `page.goto(...).catch(() => {})` swallows the failure, and a 404 body has
  // fewer than 12 painted elements, so the fill rule reports "too little on screen to judge width" and
  // calls it ok. A page list that names a route which does not exist is a test measuring a 404.
  // Reintroduce by adding '/browse' back to PAGES in layout.mjs.
  const listed = new Set<string>();
  const pages = /const PAGES = \(process\.env\.PAGES \|\| '([^']+)'/.exec(read('test/e2e/layout.mjs'));
  assert.ok(pages, 'could not find PAGES in layout.mjs — this check just went blind');
  for (const p of pages![1].split(',')) listed.add(p.trim());
  for (const m of read('test/e2e/run.mjs').matchAll(/\['[a-z]+', '(\/[a-z/]*)'\]/g)) listed.add(m[1]);
  assert.ok(listed.size >= 6, `only ${listed.size} routes scanned — the scan itself is broken`);

  // `/profile/?tab=Settings` is the same route as `/profile` with a tab picked (v0.39.0): the query is
  // stripped before the path is mapped to a page file, or the four `?tab=` entries would each look like
  // a route that does not exist.
  assert.ok([...listed].some((p) => p.includes('?tab=')), 'no ?tab= page is measured — the settings grids of v0.39.0 are not covered');
  for (const p of listed) {
    const route = p.replace(/\?.*$/, '');
    const f = route === '/' ? 'app/page.tsx' : `app${route.replace(/\/$/, '')}/page.tsx`;
    assert.ok(existsSync(join(ROOT, f)), `${p} is in an e2e page list but ${f} does not exist — that test measures a 404`);
  }
});

test('no sort the grid cannot page through', () => {
  // ⚠️ `sortSql()` supports `random`, and exposing it would look like it works. It maps to `ORDER BY
  // random()`, the grid pages with LIMIT/OFFSET, and useInfiniteQuery APPENDS -- so page 2 re-rolls the
  // shuffle, redrawing series already scrolled past and silently omitting others. You would have to count
  // to notice. "Surprise me" is the honest version: one series, one request, no pagination.
  // Reintroduce by adding { key: 'random', label: 'Shuffle', sort: 'random,desc' } to SORTS.
  const sorts = [...read('components/LibraryFilters.tsx').matchAll(/sort: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(sorts.length >= 4, `the SORTS scan found ${sorts.length} entries — it is not reading the array`);
  for (const s of sorts) {
    assert.doesNotMatch(s, /random/i, `"${s}": a random order cannot be paginated, and the grid paginates`);
  }
});

test('the genre list comes from the counted endpoint, not the flat one', () => {
  // ⚠️ TWO reasons, and the second is a correctness bug rather than a feature.
  //  1. `/api/genres/overview` is what carries the counts and the cover ids the browse wall was made of.
  //  2. `/api/genres` is `SELECT DISTINCT g` -- RAW spellings -- while the filter matches
  //     `lower(g) = lower($n)`. On the library this was written against that is 100 distinct strings for 93
  //     genres: "Martial arts" and "Martial Arts" render as two chips that are one filter, and picking
  //     either returns the same 76 series. `genreOverview` groups case-insensitively, so this cannot happen.
  // Reintroduce by pointing the panel back at '/api/genres': the counts and mosaics vanish and the seven
  // duplicate pairs come back.
  const src = read('components/LibraryFilters.tsx');
  assert.match(src, /'\/api\/genres\/overview\?covers=4'/, 'the panel is not reading the counted genre endpoint');
  assert.match(src, /queryKey: \['genres-overview'\]/, 'the query key no longer matches the endpoint');
  assert.doesNotMatch(src, /'\/api\/genres'/, 'the flat, case-duplicating genre list is back');
});

test('a genre selected under a different spelling still reads as selected', async () => {
  // ⚠️ The url and the facet label can legitimately disagree about capitalisation, because the SERVER folds
  // and the two lists do not come from the same query. On this library `SELECT DISTINCT g` yields 100
  // strings for 93 genres -- seven pairs differing only in case -- and any link shared before this change
  // can carry either spelling.
  // Reintroduce by comparing with `===`: /library?genres=Martial%20arts draws the Martial Arts row
  // unselected, tapping it appends a SECOND copy, and the pill above the grid cannot clear it.
  const { sameGenre } = await import('../lib/genres');
  assert.equal(sameGenre('Martial arts', 'Martial Arts'), true);
  assert.equal(sameGenre('Slice of life', 'Slice of Life'), true);
  assert.equal(sameGenre(' Horror ', 'horror'), true, 'a stray space from a hand-edited url is not a genre');
  assert.equal(sameGenre('Horror', 'Historical'), false, 'different genres stay different');
  assert.equal(sameGenre('', 'Horror'), false);

  // And the panel must actually use it rather than an exact match.
  const src = read('components/LibraryFilters.tsx');
  assert.match(src, /sameGenre/, 'the panel compares genres exactly again');
  assert.doesNotMatch(code(src), /genres\.includes\(/, 'an exact-match genre comparison came back');
});

test('formats are still separated from genres', () => {
  // Manhwa carries 161 of 2,132 series here, so under a count ranking it outranks every actual mood while
  // saying nothing about what a book is like. Browse quarantined these; that judgement had to survive the
  // page being deleted. Reintroduce by dropping the FORMAT_KEYS split: Manhwa sits between Horror and Isekai
  // at the top of the genre list.
  const src = read('components/LibraryFilters.tsx');
  assert.match(src, /FORMAT_KEYS/, 'the format/genre separation went with the browse page');
  assert.ok(read('lib/genres.ts').includes('FORMAT_KEYS'), 'lib/genres.ts lost FORMAT_KEYS');
});

test('every label the panel renders reaches the translation extractor', () => {
  // The extractor cannot see a label rendered as `tr(x.label)`, only inline literals -- which is what
  // `keys()` is for, and which has already shipped untranslated labels three times here.
  // ⚠️ The statuses in particular used to be rendered as `v.charAt(0) + v.slice(1).toLowerCase()`, i.e. in
  // English, in all eight languages, forever, with nothing in the suite noticing.
  // Reintroduce by going back to that expression, or by dropping a key from the locale files.
  const src = read('components/LibraryFilters.tsx');
  for (const arr of ['SORT_LABELS', 'READ_LABELS', 'STATUS_LABELS']) {
    assert.match(src, new RegExp(`const ${arr} = keys\\(`), `${arr} is not registered with keys()`);
  }
  assert.doesNotMatch(code(src), /charAt\(0\) \+ /, 'a label is being title-cased in JS instead of translated');

  const es = JSON.parse(read('public/locales/es.json'));
  for (const label of ['Ongoing', 'Completed', 'Hiatus', 'Cancelled', 'Sort by', 'Read state', 'Status',
                       'Genres', 'Format', 'Find a genre', 'Sorted by {name}', 'filtered']) {
    assert.ok(label in es, `"${label}" renders through tr() but is in no locale file`);
  }
});

test('every locale file carries the same keys', () => {
  // The suite has no en.json -- English is the source string -- so i18n.mjs builds the required set from
  // es.json and checks the rest against it. A string added to one file and not the other seven fails there,
  // in a browser run; this says so in a unit test instead.
  const dir = join(ROOT, 'public/locales');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 8, `expected 8 locale files, found ${files.length}`);
  const es = new Set(Object.keys(JSON.parse(read('public/locales/es.json'))));
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const missing = [...es].filter((k) => !(k in d));
    const empty = [...es].filter((k) => d[k] === '');
    assert.deepEqual(missing, [], `${f} is missing ${missing.length} keys, e.g. ${missing.slice(0, 3).join(', ')}`);
    assert.deepEqual(empty, [], `${f} has ${empty.length} empty translations`);
  }
});

test('no responsive step that can never apply', () => {
  // ⚠️ THIS SHIPPED AND NOTHING NOTICED. Tailwind v4 emits every arbitrary `min-[…]` variant BEFORE the
  // named breakpoints, so on a 1920px display `2xl:grid-cols-9` (96rem) came later in the stylesheet and
  // beat `min-[1800px]:grid-cols-10` sitting right beside it. That combination was written in four grids --
  // library, search (twice) and discover -- and the tenth column had never once appeared. Measured in a
  // browser at 2560px: seven columns where the class list says ten.
  //
  // Nothing failed, because a grid one step short of its own source still looks like a grid. The fix is
  // `--breakpoint-3xl` / `--breakpoint-4xl` in globals.css: a NAMED breakpoint sorts by value with the rest.
  // Reintroduce by writing `min-[1800px]:grid-cols-10` next to a `2xl:` class again.
  const css = read('app/globals.css');
  for (const bp of ['--breakpoint-3xl', '--breakpoint-4xl']) {
    assert.ok(css.includes(bp), `${bp} is gone — the grids past 2xl have no working breakpoint`);
  }
  const NAMED = /\b(?:sm|md|lg|xl|2xl|3xl|4xl):([a-z-]+)-/;
  const offenders: string[] = [];
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]) {
    for (const cls of classNames(code(readFileSync(f, 'utf8')))) {
      // The property an arbitrary min-[] variant sets, e.g. `min-[1800px]:grid-cols-10` -> `grid-cols`.
      for (const m of cls.matchAll(/min-\[[0-9]+px\]:([a-z-]+?)-[a-z0-9-]+/g)) {
        const prop = m[1];
        // …clashes with any NAMED variant in the same class list touching the same property.
        const named = [...cls.matchAll(new RegExp(`\\b(?:sm|md|lg|xl|2xl|3xl|4xl):${prop}-`, 'g'))];
        if (named.length) offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0]} is overridden by a named breakpoint on the same property`);
      }
    }
  }
  assert.ok(NAMED.test('lg:grid-cols-5'), 'the named-variant pattern itself stopped matching');
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the library filter state is still the URL, with one writer', () => {
  // Filters live in the URL so they survive the back button, can be shared, and are part of the react-query
  // key -- changing one refetches from page 0 rather than appending to a stale list. The panel is a pure
  // component over props for the same reason: two writers would race.
  // Reintroduce by giving LibraryFilters its own useSearchParams/useRouter: the sidebar and the sheet then
  // disagree about what is selected the moment one of them navigates.
  const panel = read('components/LibraryFilters.tsx');
  assert.doesNotMatch(panel, /useSearchParams|useRouter/, 'the filter panel writes the URL itself');
  const page = read('app/library/page.tsx');
  assert.equal((page.match(/router\.replace\(/g) ?? []).length, 2,
    'expected exactly two URL writers in the library: setParam and clearAll');
});

// ---- The select bar's bulk actions (v0.37.0, rebuilt from PR #53) ----

test('the select bar removes by hiding, never by deleting files', () => {
  // ⚠️ PR #53's bulk Delete hid AND deleted files in one request over up to 500 series, behind a typed
  // DELETE: "Select all" plus one word wiped hand-curated folders in the READ library with no undo. The
  // rebuilt chip posts to the hide-only route and says so in the series page's own words. Reintroduce by
  // pointing the chip at a route that deletes files (or by dropping the 'No files are deleted.' line from
  // the dialog): the dialog would then promise what the route does not keep.
  const src = code(read('app/library/page.tsx'));
  assert.match(src, /'\/api\/admin\/series\/bulk\/hide'/, 'the bulk remove no longer calls the hide-only route');
  assert.doesNotMatch(src, /bulk\/delete|delete-files|\/files'/, 'the library bar reaches a file-deleting route');
  assert.match(src, /tr\('No files are deleted\.'\)/, 'the confirm dialog lost the sentence that makes it honest');
  assert.doesNotMatch(src, /confirmText=/, 'a typed confirmation came back: a count-confirm is the whole point of hide-only');
  assert.match(src, /Remove \{n\} series from the library\?/, 'the dialog title no longer carries the count');
});

test('Fetch newest starts a job and polls it, rather than holding one request open', () => {
  // The server loop downloads and can run for minutes over a big selection; a request held open that long
  // dies at the proxy while the server keeps going, and a re-tap starts a second loop. Reintroduce by
  // awaiting a single POST and reading the results off its answer: no GET, no 2 s poll.
  const src = code(read('app/library/page.tsx'));
  assert.match(src, /api<\{ ok: true; total: number \}>\('\/api\/library\/bulk\/newest', \{ method: 'POST'/, 'the chip no longer starts the job');
  assert.match(src, /followBulkNewest\(\{/, 'the chip no longer follows the job through lib/bulkNewest');
  assert.match(src, /api<BulkNewestStatus>\('\/api\/library\/bulk\/newest'\)/, 'the chip no longer polls the job');
  assert.match(src, /setTimeout\(r, BULK_NEWEST_POLL_MS\)/, 'the poll interval is not the shared one');
  const lib = code(read('lib/bulkNewest.ts'));
  assert.match(lib, /BULK_NEWEST_POLL_MS = 2000/, 'the poll interval is not the 2 s the series page uses');
  assert.match(lib, /if \(!st\.running\) return \{ outcome: 'finished'/, 'the poll does not stop when the job does');
});

/** Drives lib/bulkNewest with a scripted GET: each entry is one poll's answer, `null` an unanswered one. */
async function follow(answers: (Partial<import('../lib/bulkNewest').BulkNewestStatus> | null)[], cancelAfterPoll?: number) {
  const { followBulkNewest } = await import('../lib/bulkNewest');
  let polls = 0;
  let cancelled = false;
  const progress: number[] = [];
  const end = await followBulkNewest({
    poll: async () => {
      const a = answers[polls++];
      if (polls === cancelAfterPoll) cancelled = true;
      if (a === null || a === undefined) throw new Error('502');
      return { running: false, done: 0, total: 0, results: [], ...a };
    },
    onProgress: (s) => progress.push(s.done),
    wait: async () => {},
    cancelled: () => cancelled,
  });
  return { end, polls, progress };
}

test('one poll answered then three misses is a lost run, not a summary', async () => {
  // ⚠️ The lost-track toast used to fire only when NO poll had ever answered; a run that answered once with
  // `running: true` and then went dark fell through to the summary, which reported "Fetched 1 chapter" in
  // success tone for a run still going, and ended select mode as if it were done. Reintroduce by returning
  // `'finished'` whenever `status` is non-null after the miss cap (`return { outcome: last ? 'finished' :
  // 'lost', status: last }` at the end of followBulkNewest).
  const partial = { running: true, done: 1, total: 3, results: [{ id: 's0', outcome: 'downloaded' as const }] };
  const { end, polls } = await follow([partial, null, null, null]);
  assert.equal(end.outcome, 'lost', 'a run that went dark after a partial answer is lost, not finished');
  assert.equal(polls, 4, 'one answer plus the three-miss cap');
  assert.equal(end.status?.running, true, 'the partial status is handed back, but marked as still running');
  // And the page shows the lost-track toast for that outcome, never the summary.
  const src = code(read('app/library/page.tsx'));
  assert.match(src, /if \(end\.outcome === 'lost'\) \{ toast\(tr\('Lost track of the fetch\. Check the library in a moment\.'\), 'error'\)/, 'the page no longer toasts lost-track for a lost run');
  assert.match(src, /else if \(end\.outcome === 'finished'\)/, 'the summary is no longer gated on a finished run');

  // The two neighbours of that case, so the fix is not "everything is lost now".
  assert.equal((await follow([null, null, null])).end.outcome, 'lost', 'never answered is still lost');
  const done = await follow([partial, { running: false, done: 3, total: 3, results: [] }]);
  assert.equal(done.end.outcome, 'finished');
  assert.equal(done.end.status?.done, 3);
  const flaky = await follow([partial, null, null, { running: false, done: 3, total: 3, results: [] }]);
  assert.equal(flaky.end.outcome, 'finished', 'two misses then an answer is a hiccup, not a lost run');
  assert.deepEqual(flaky.progress, [1, 3], 'every answered poll reports progress');
});

test('Cancel stays live while a Fetch newest run is followed', async () => {
  // A 500-series run is minutes of pacing plus downloads, and every chip -- Cancel included -- was disabled
  // for all of it: the only way out of the frozen bar was to navigate away. Cancel now stops the polling
  // and leaves select mode; the run completes server-side. Reintroduce by putting `disabled={acting}` back
  // on the Cancel chip, or by dropping the `cancelled()` checks from followBulkNewest.
  const src = code(read('app/library/page.tsx'));
  const cancel = /<button[^>]*onClick=\{\(\) => \{ stopFollowing\.current\?\.\(\); setSelecting\(false\); setPicked\(new Set\(\)\); \}\}[^>]*>\{tr\('Cancel'\)\}/.exec(src)?.[0] ?? '';
  assert.ok(cancel, 'the Cancel chip no longer stops the follow before leaving select mode');
  assert.match(cancel, /disabled=\{acting && !fetching\}/, 'Cancel is disabled for the whole run again');
  assert.match(src, /stopFollowing\.current = \(\) => \{ cancelled = true; wake\?\.\(\); \}/, 'Cancel no longer ends the current wait');
  assert.match(src, /if \(end\.outcome !== 'cancelled'\) settle\(\)/, 'a cancelled run settles, wiping a selection made since');

  const running = { running: true, done: 1, total: 5, results: [] };
  const { end, polls } = await follow([running, running, running, running], 2);
  assert.equal(end.outcome, 'cancelled', 'the follow does not stop on cancel');
  assert.equal(polls, 2, 'polling went on after cancel');
});

test('a remove that hid nothing says so, in error tone, and keeps the selection', () => {
  // "Removed 0 series · 1 skipped" in success tone, with select mode ended as if something had happened, is
  // what a selection of merged-away rows used to get. Reintroduce by dropping the `r.hidden === 0` branch.
  const src = code(read('app/library/page.tsx'));
  assert.match(src, /if \(r\.hidden === 0\) \{\s*toast\(r\.skipped\.length === 1 \? tr\('Nothing removed · 1 skipped'\) : tr\('Nothing removed · \{n\} skipped', \{ n: r\.skipped\.length \}\), 'error'\);\s*\}/, 'the nothing-hidden toast is gone, or not in error tone');
  const branch = /if \(r\.hidden === 0\) \{[\s\S]*?\} else \{([\s\S]*?)\n\s*\}/.exec(src);
  assert.ok(branch, 'the success path is no longer the else of the nothing-hidden check');
  assert.doesNotMatch(/if \(r\.hidden === 0\) \{[\s\S]*?\} else/.exec(src)![0], /settle\(\)/, 'a remove that hid nothing leaves select mode');
  assert.match(branch![1], /settle\(\)/, 'a remove that hid something no longer settles');
});

test('the select bar fits two rows on a phone and one at 1024 px: the admin actions are behind More at every width', () => {
  // ⚠️ Seven chips plus the count wrap to three rows at 390 px (series/page.tsx warns about exactly this),
  // and a third row covers a third of the grid, so a `More` chip opens the admin actions in a Sheet instead.
  // Reintroduce by showing the admin chips at every width: measure36-style puppeteer at 390 px shows three rows.
  // v0.49.1: Find other sources joined Move to library and Remove from library. As a ninth key from lg up it needed
  // 1081 px (measured with the app's CSS and fonts, 240 selected): two rows in English at 1024 AND 1280 px, where eight
  // took 940 of 992. So the three are rows of More at every width, and More stays for admins from lg up (735 px in
  // English, 822 in German, which took two rows before). Reintroduce any of them as a key in the bar: "an admin action
  // is a key in the bar" fails; drop the admin's More from lg up: "the admin actions cannot be reached from lg up".
  const src = read('app/library/page.tsx');
  const bar = /bottom-\[calc\(5\.75rem\+env\(safe-area-inset-bottom\)\)\][\s\S]*?<\/div>\s*<\/div>\s*\)\}/.exec(src)?.[0] ?? '';
  assert.ok(bar.length > 200, 'could not find the select bar');
  const chips = [...bar.matchAll(/className=\{?[`"]chip[^`"]*[`"]\}?/g)].map((m) => m[0]);
  const phoneOnly = chips.filter((c) => /\blg:hidden\b/.test(c));
  assert.equal(phoneOnly.length, 1, 'expected exactly one phone-only More chip');
  assert.ok(chips.length <= 6, `${chips.length} chips reach the phone bar; more than six wraps to a third row at 390 px`);
  assert.doesNotMatch(code(bar), /setMoving\(true\)|setRemoving\(true\)|findSelected/, 'an admin action is a key in the bar');
  assert.match(bar, /onClick=\{\(\) => setMore\(true\)\} className=\{`chip text-xs disabled:opacity-50 \$\{isAdmin \? '' : 'lg:hidden'\}`\}/,
    'the admin actions cannot be reached from lg up');
  // From lg up, every chip and key an admin sees there: at most the seven that measured one row at 1024 px.
  const keys = [...bar.matchAll(/className=\{?[`"]((?:chip|btn-key)\b[^`"]*)[`"]\}?/g)].map((m) => m[1]);
  const wide = keys.filter((c) => !/\blg:hidden\b/.test(c) || /isAdmin/.test(c));
  assert.ok(wide.length <= 7, `${wide.length} keys in the bar from lg up; nine wrapped to two rows at 1024 and 1280 px`);
  // And the sheet closes before either dialog opens: a Sheet (z-60) paints over a Modal (z-50).
  assert.match(code(src), /setMore\(false\); setMoving\(true\)/, 'Move to library opens its modal under the sheet');
  assert.match(code(src), /setMore\(false\); setRemoving\(true\)/, 'Remove opens its dialog under the sheet');
  assert.match(code(src), /setMore\(false\); setFinding\(true\);/, 'Find other sources is not a row of More, or opens its dialog under the sheet');
});

test('every string the select bar renders is in the locale files, singulars included', () => {
  // Reintroduce by dropping any one of these from es.json (the parity test then catches the other seven).
  const es = JSON.parse(read('public/locales/es.json'));
  for (const label of ['Select all', 'Fetch newest', 'More', 'Remove from library', 'Remove 1 series from the library?',
                       'Remove {n} series from the library?', 'Removed 1 series', 'Removed {n} series', '1 skipped', '{n} skipped',
                       '1 failed', '{n} failed', 'Fetched 1 chapter', 'Fetched {n} chapters', '1 up to date', '{n} up to date',
                       'Nothing to fetch', 'Fetching {done} of {total}…', 'Could not start the fetch', 'Could not remove those',
                       'Lost track of the fetch. Check the library in a moment.', '{n} selected', 'No files are deleted.',
                       'Nothing removed · 1 skipped', 'Nothing removed · {n} skipped',
                       'The chapters stay exactly where they are on disk, and nothing in your library folder is touched.',
                       "Everyone's reading progress, history, favourites and ratings are kept, so you can put them back at any time from Admin → Library."]) {
    assert.ok(label in es, `"${label}" renders through tr() but is in no locale file`);
  }
});

test('Archive slowly: a key from lg up, a row of More on a phone, for anyone who may download', () => {
  // #117. The phone bar holds two rows at 390 px (above), so the archive is a row of More there, and More is
  // there for members who may download, not only admins -- whose two rows in it stay theirs. A key, not a
  // chip: the owner kept chips for filters and sorts. Reintroduce by showing the key at every width (drop
  // `hidden lg:inline-flex`): "the archive key reaches the phone bar" fails; gate More on `isAdmin` again: "a
  // member who may download has no way to archive on a phone" fails.
  const src = code(read('app/library/page.tsx'));
  assert.match(src, /\{canDownload\(user\) && <button disabled=\{acting\} onClick=\{archiveSelected\} className="btn-key hidden lg:inline-flex">\{tr\('Archive slowly'\)\}<\/button>\}/,
    'the archive key reaches the phone bar');
  // More is a member's on a phone only (from lg up Archive slowly is a key), and an admin's at every width (v0.49.1).
  assert.match(src, /\{\(isAdmin \|\| canDownload\(user\)\) && <button disabled=\{acting\} onClick=\{\(\) => setMore\(true\)\} className=\{`chip text-xs disabled:opacity-50 \$\{isAdmin \? '' : 'lg:hidden'\}`\}/,
    'a member who may download has no way to archive on a phone');
  const sheet = src.slice(src.indexOf("<Sheet title={tr('{n} selected'"), src.indexOf('</Sheet>', src.indexOf("<Sheet title={tr('{n} selected'")));
  assert.match(sheet, /\{canDownload\(user\) && \(\s*<button onClick=\{\(\) => \{ setMore\(false\); void archiveSelected\(\); \}\}/, 'More has no Archive slowly, or keeps the sheet open under the notice');
  assert.match(sheet, /\{isAdmin && \(\s*<>\s*<button onClick=\{\(\) => \{ setMore\(false\); setMoving\(true\); \}\}/, "a member's More offers the admin's Move to library");
  // One request per 500 (the route's cap), and one notice for the whole selection: components/ArchiveQueue.tsx.
  const q = code(read('components/ArchiveQueue.tsx'));
  assert.match(q, /for \(let i = 0; i < ids\.length; i \+= ARCHIVE_MAX_SERIES\)/, 'a big selection is one request past the route cap');
  assert.match(q, /ids\.length === 1 \? archiveOutcomeNotice\([^)]*\) : archiveBulkNotice\(results\)/, 'a selection is not summed up in one notice');
});

// ---- The source filters (v0.49.2): Main source and Any source, @TIGamingTV's PR #124 ----

test('the source counts refresh with the grid: they are keyed under the prefix every bulk action invalidates', async () => {
  // PR #124 keyed the counts ['library-sources'], outside ['library'], with a five-minute staleTime. After Remove
  // from library, settle() refetched the grid and the series left it, while the panel beside it went on counting
  // that series until a reload. Everything that changes the shelf refreshes it with
  // `invalidateQueries({ queryKey: ['library'] })`: settle() after every bulk action, pull to refresh, the header's
  // refresh, an add, a series edit. So the counts live under that prefix. Reintroduce by keying them
  // ['library-sources'] again: "a bulk action leaves the source counts stale" fails.
  const { partialMatchKey } = await import('@tanstack/react-query');
  const panel = code(read('components/LibraryFilters.tsx'));
  const key = /export function useLibrarySources\(\) \{\s*return useQuery\(\{\s*queryKey: (\[[^\]]*\]),/.exec(panel)?.[1];
  assert.ok(key, 'could not find the source counts query');
  assert.ok(partialMatchKey(JSON.parse(key!.replace(/'/g, '"')), ['library']), `a bulk action leaves the source counts stale: they are keyed ${key}`);
  // The matcher is react-query's own, and it does tell the old key apart, so the check above can fail.
  assert.equal(partialMatchKey(['library-sources'], ['library']), false);
  // What refreshes them after a bulk action.
  const settle = /const settle = \(\) => \{([\s\S]*?)\n {2}\};/.exec(code(read('app/library/page.tsx')))?.[1] ?? '';
  assert.match(settle, /qc\.invalidateQueries\(\{ queryKey: \['library'\] \}\);/, 'a bulk action no longer refreshes the library');
  // ⚠️ And nothing writes into the prefix: a setQueriesData over ['library'] shaped for the grid's pages would now
  // hand the counts a page, or the grid a list of sources.
  const writers = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'lib'))]
    .filter((f) => /set(?:Queries|Query)Data\(\s*(?:\{\s*queryKey:\s*)?\['library'/.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(ROOT.length + 1));
  assert.deepEqual(writers, [], `these write into the ['library'] prefix: ${writers.join(', ')}`);
});

test('Any source says followed, the app\'s word for a second source, never linked, which is the trackers\'', () => {
  // A series FOLLOWS a second source: Sources & translations, Find other sources and Health all say so, and
  // "linked" is what the app says of a tracker ("linked for progress sync"). PR #124's help line said "a linked
  // one", in English and in each language's word for connected. Reintroduce "linked" in the line: "Any source's
  // line says linked" fails; put one language back to its word for linked: that language fails, by name.
  const panel = code(read('components/LibraryFilters.tsx'));
  assert.match(panel, /help=\{tr\('Series that read from this source, as their main source or a followed one\.'\)\}/, "Any source's line says linked");
  // Each file in its own word for a followed source, as in "A followed source lists them" and "No source followed".
  const FOLLOWED: Record<string, string> = { ar: 'متابَع', de: 'verfolgte', es: 'seguida', fr: 'suivie', ja: 'フォロー中', 'pt-BR': 'seguida', ru: 'отслеживаемого', zh: '已关注' };
  for (const [lang, word] of Object.entries(FOLLOWED)) {
    const d = JSON.parse(read(`public/locales/${lang}.json`));
    assert.ok(!('Series that read from this source, as their main source or a linked one.' in d), `${lang}.json kept the old key`);
    assert.ok(d['Series that read from this source, as their main source or a followed one.']?.includes(word),
      `${lang}: Any source's line does not use the file's word for followed (${word})`);
  }
});

test('src is the main source and anysrc any source, from the URL to the search, the grid key and the badge', () => {
  // Two URL params three letters apart that mean two different searches, so a swap is easy to make and hard to
  // see: both filters still work, each returning the other's series. PR #124's review swapped them in
  // conditionFrom, then dropped them from the grid's key, and the suite passed both times. Reintroduce the swap
  // (`if (src) all.push({ anySource: … })`): "src is not the main source" fails; drop `src, anysrc` from the
  // queryKey: "the grid's key does not carry the source filters" fails, and a change of source filter would append
  // its pages to the list the old filter fetched.
  const page = code(read('app/library/page.tsx'));
  const fn = /function conditionFrom\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(page);
  assert.ok(fn, 'could not find conditionFrom');
  const params = fn![1].split(',').map((p) => p.trim().split(/[\s:=]/)[0]);
  assert.deepEqual(params.slice(4), ['src', 'anysrc'], 'conditionFrom takes the source filters in another order');
  // Which parameter guards each condition, and which one it carries.
  const pushed = Object.fromEntries([...fn![2].matchAll(/if \((\w+)\) all\.push\(\{ (\w+): \{ operator: 'is', value: (\w+) \} \}\);/g)]
    .map((m) => [m[2], `${m[1]} -> ${m[3]}`]));
  assert.equal(pushed.mainSource, 'src -> src', 'src is not the main source');
  assert.equal(pushed.anySource, 'anysrc -> anysrc', 'anysrc is not any source');
  assert.match(page, /const src = params\.get\('src'\) \|\| '';\s*const anysrc = params\.get\('anysrc'\) \|\| '';/, 'the URL params are read into the wrong names');
  assert.match(page, /useMemo\(\(\) => conditionFrom\(read, status, genres, lib, src, anysrc\), \[read, status, genres\.join\(','\), lib, src, anysrc\]\)/,
    'the condition memo does not carry both source filters, in order');
  assert.match(page, /queryKey: \['library', active\.key, read, status, genres\.join\(','\), lib, src, anysrc\],/, "the grid's key does not carry the source filters");
  assert.match(page, /const activeCount = [^;]*\+ \(src \? 1 : 0\) \+ \(anysrc \? 1 : 0\);/, 'the badge does not count the source filters');
  // The writing side: Main source's chips set `src` and count `main`, Any source's set `anysrc` and count `any`, and
  // both placements of the panel are handed both values; each active chip clears its own param.
  const panel = code(read('components/LibraryFilters.tsx'));
  assert.match(panel, /<SourceSection title=\{tr\('Main source'\)\}[\s\S]{0,200}?count=\{\(s\) => s\.main\} value=\{mainSrc\} onPick=\{\(id\) => onSet\('src', id\)\} \/>/,
    'Main source does not write src, or counts the wrong number');
  assert.match(panel, /<SourceSection title=\{tr\('Any source'\)\}[\s\S]{0,200}?count=\{\(s\) => s\.any\} value=\{anySrc\} onPick=\{\(id\) => onSet\('anysrc', id\)\} \/>/,
    'Any source does not write anysrc, or counts the wrong number');
  assert.equal((page.match(/mainSrc=\{src\} anySrc=\{anysrc\}/g) ?? []).length, 2, 'the sidebar and the sheet are not both handed the source filters');
  assert.match(page, /\{src && \(\s*<button onClick=\{\(\) => setParam\('src', ''\)\}[^>]*>\s*\{tr\('Main: \{name\}', \{ name: sourceName\(src\) \}\)\} ×/, "the Main chip clears something else");
  assert.match(page, /\{anysrc && \(\s*<button onClick=\{\(\) => setParam\('anysrc', ''\)\}[^>]*>\s*\{tr\('Any: \{name\}', \{ name: sourceName\(anysrc\) \}\)\} ×/, "the Any chip clears something else");
});

test('in Japanese and Chinese the source filters use those files\' full-width brackets and colon, and ja says any once', () => {
  // Both files write （） and ： (Library: {fs} is ライブラリ：{fs} and 书库：{fs}); PR #124's strings had ( ) and :.
  // And the Japanese section title said すべてのソース, "all sources", over chips whose active form says いずれか：,
  // "any". Reintroduce a half-width bracket or colon in either file: that string fails, by its key; put
  // すべてのソース back: "ja: Any source and its active chip say any in two different words" fails.
  const KEYS = ['Main source', 'Any source', 'Series added from this source.',
    'Series that read from this source, as their main source or a followed one.', 'Main: {name}', 'Any: {name}'];
  for (const lang of ['ja', 'zh']) {
    const d = JSON.parse(read(`public/locales/${lang}.json`));
    for (const k of KEYS) assert.doesNotMatch(d[k], /[():]/, `${lang}: "${k}" has a half-width bracket or colon: ${d[k]}`);
  }
  const ja = JSON.parse(read('public/locales/ja.json'));
  assert.ok(ja['Any source'].startsWith(ja['Any: {name}'].split('：')[0]), 'ja: Any source and its active chip say any in two different words');
});

test('a chosen source chip is drawn chosen, even for a source that is not loaded', () => {
  // `.chip-active` is in @layer components and `text-fog-500` is a utility, so where a chip carried both the
  // utility won: the chosen chip of a source that is not loaded (its extension gone, the engine down) kept the
  // grey of an unchosen one and lost its accent. The class list is evaluated here for all four cases. Reintroduce
  // `${value === s.id ? 'chip-active' : ''} ${s.installed ? '' : 'text-fog-500'}`: "a chosen chip for a source
  // that is not loaded is drawn unchosen" fails.
  const panel = code(read('components/LibraryFilters.tsx'));
  const section = panel.slice(panel.indexOf('function SourceSection('), panel.indexOf('function Eyebrow('));
  const tpl = /<button key=\{s\.id\}[\s\S]*?className=\{`([^`]*)`\}/.exec(section)?.[1];
  assert.ok(tpl, 'could not find the source chip');
  const classes = (value: string, installed: boolean): string[] =>
    (new Function('value', 's', `return \`${tpl}\`;`)(value, { id: 'x', installed }) as string).split(/\s+/).filter(Boolean);
  assert.ok(classes('x', false).includes('chip-active') && !classes('x', false).includes('text-fog-500'),
    'a chosen chip for a source that is not loaded is drawn unchosen');
  assert.ok(classes('', false).includes('text-fog-500'), 'a source that is not loaded no longer looks it');
  assert.ok(classes('x', true).includes('chip-active'));
  assert.deepEqual(classes('', true), ['chip', 'text-xs']);
});
