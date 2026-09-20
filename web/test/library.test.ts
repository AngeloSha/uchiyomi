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

test('the select bar fits two rows on a phone: admin actions fold behind More', () => {
  // ⚠️ Seven chips plus the count wrap to three rows at 390 px (series/page.tsx warns about exactly this),
  // and a third row covers a third of the grid. The two admin chips are `hidden lg:inline-flex` and a `More`
  // chip (`lg:hidden`) opens them in a Sheet instead. Reintroduce by showing the admin chips at every width:
  // measure36-style puppeteer at 390 px shows three rows of chips.
  const src = read('app/library/page.tsx');
  const bar = /bottom-\[calc\(5\.75rem\+env\(safe-area-inset-bottom\)\)\][\s\S]*?<\/div>\s*<\/div>\s*\)\}/.exec(src)?.[0] ?? '';
  assert.ok(bar.length > 200, 'could not find the select bar');
  const chips = [...bar.matchAll(/className=\{?[`"]chip[^`"]*[`"]\}?/g)].map((m) => m[0]);
  const phoneOnly = chips.filter((c) => /\blg:hidden\b/.test(c));
  const wideOnly = chips.filter((c) => /\bhidden\b.*\blg:inline-flex\b/.test(c));
  assert.equal(phoneOnly.length, 1, 'expected exactly one phone-only More chip');
  assert.equal(wideOnly.length, 2, 'expected the two admin chips to be wide-screen only');
  const phoneChips = chips.length - wideOnly.length;
  assert.ok(phoneChips <= 6, `${phoneChips} chips reach the phone bar; more than six wraps to a third row at 390 px`);
  // And the sheet closes before either dialog opens: a Sheet (z-60) paints over a Modal (z-50).
  assert.match(code(src), /setMore\(false\); setMoving\(true\)/, 'Move to library opens its modal under the sheet');
  assert.match(code(src), /setMore\(false\); setRemoving\(true\)/, 'Remove opens its dialog under the sheet');
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
