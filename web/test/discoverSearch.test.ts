// Discover search that answers in seconds and fills in (v0.40.0).
//
// It was one `await api('/api/sources/search-all?q=')` behind eighteen skeletons until EVERY source had
// answered, and a Cloudflare source has a ninety-second budget, so "takes forever" was the accurate
// description. The server now answers within `wait=` with whatever has landed and says who is still being
// asked; the page polls while `pending` is non-zero and the wall fills in. Read from source, like
// wall.test.ts: whether the search is keyed on the SUBMITTED term, whether the poll reads `pending`, whether
// only the first request waits the long wait, whether an abandoned request is aborted, and whether the
// skeletons make way for the first answer. Each guard names the edit that fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file with its comments removed -- several comments below quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/**
 * Every English string a file asks `tr()` for, plus labels declared through `keys(...)` (lib/i18n.ts). The
 * literal's escapes are undone (`\'` and `\u2192`): the key is the STRING, and the Discover page writes its
 * arrow as an escape.
 */
const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\'/g, "'");
const trKeys = (files: string[]): Set<string> => {
  const keys = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
    for (const m of src.matchAll(/\btr\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(unescape(m[1]));
    for (const decl of src.matchAll(/\bkeys\(([^)]*)\)/g)) {
      for (const m of decl[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) keys.add(unescape(m[1]));
    }
  }
  return keys;
};

const PAGE = 'app/discover/page.tsx';

test('the search is a query keyed on the submitted term, not on the field', () => {
  // `q` is whatever is in the field; `term` is what was submitted. Keyed on `q`, every keystroke would be a
  // fan-out to every source, and keyed on a constant, a new term would paint under the old term's answer
  // until its own landed. Reintroduce by writing `queryKey: ['search-all', q]`: "keyed on the field" fails;
  // by bringing back `setSearchHits`: "the imperative search is back" fails.
  const src = code(read(PAGE));
  assert.match(src, /queryKey: \['search-all', term\]/, 'the search is not keyed on the submitted term (or is keyed on the field)');
  assert.match(src, /const \[term, setTerm\] = useState\(''\)/, 'there is no separate submitted term');
  assert.match(src, /enabled: mode === 'search' && !!term/, 'the search runs outside search mode or with an empty term');
  assert.doesNotMatch(src, /setSearchHits|setSearching|useState<SourceItem\[\]>\(\[\]\)/, 'the imperative search is back');
  assert.doesNotMatch(src, /await api<\{ content: SearchGroup\[\] \}>/, 'the search is awaited in a handler again');
});

test('the poll runs only while the server says sources are still pending', () => {
  // `refetchInterval` reads the answer's own `pending`: a constant interval would poll a finished search
  // every 1.5 s for as long as the page is open, and `false` would never fill the wall in. Reintroduce by
  // returning `SEARCH_POLL_MS` unconditionally: "does not read pending" fails.
  const src = code(read(PAGE));
  assert.match(src, /refetchInterval: \(qy\) => \(qy\.state\.data\?\.pending \? SEARCH_POLL_MS : false\)/, 'the poll does not read pending from the answer');
  assert.match(src, /const SEARCH_POLL_MS = 1500;/, 'the poll interval moved');
  // Leaving search mode disables the query, which is what stops the interval; a poll that ignored the mode
  // would keep asking the server about a search nobody is looking at.
  assert.match(src, /refetchOnWindowFocus: false/, 'a window focus re-runs the search');
});

test('only the first request waits the long wait; every poll asks for a short one', () => {
  // The first request may hold for six seconds while the sources answer. A poll that also held for six
  // seconds would sit on the server until its grace expired, so every fill-in would arrive six seconds late.
  // `first` is read from the query's own `dataUpdateCount`, which is zero until an answer has landed.
  // Reintroduce by dropping `&wait=` from the URL: "no wait= on the request" fails; by writing
  // `wait=${SEARCH_FIRST_WAIT_MS}` for every request: "every request waits the long wait" fails.
  const src = code(read(PAGE));
  assert.match(src, /search-all\?q=\$\{encodeURIComponent\(term\)\}&wait=\$\{first \? SEARCH_FIRST_WAIT_MS : SEARCH_POLL_WAIT_MS\}/, 'no wait= on the request, or every request waits the long wait');
  assert.match(src, /const first = \(client\.getQueryState\(queryKey\)\?\.dataUpdateCount \?\? 0\) === 0;/, 'first is not read from dataUpdateCount');
  assert.match(src, /const SEARCH_FIRST_WAIT_MS = 6000;/, 'the first wait is not six seconds');
  assert.match(src, /const SEARCH_POLL_WAIT_MS = 1500;/, 'the poll wait moved');
});

test('an abandoned search is aborted, never retried, and stays fresh for five minutes', () => {
  // The query's `signal` goes to `api()`, so a term replaced mid-flight is cancelled in the browser and the
  // old answer can never land on the new key. `retry: false`: a failed search is shown as failed -- a retry
  // is another fan-out to every source. Reintroduce by dropping `{ signal }` from the api call: "the
  // request ignores the signal" fails.
  const src = code(read(PAGE));
  assert.match(src, /queryFn: \(\{ signal, queryKey, client \}\) =>/, 'the queryFn does not take the signal');
  assert.match(src, /api<SearchAnswer>\(`\/api\/sources\/search-all\?q=[^`]*`, \{ signal \}\)/, 'the request ignores the signal');
  assert.match(src, /retry: false/, 'a failed search is retried');
  assert.match(src, /staleTime: 5 \* 60_000/, 'the same term again is not answered from the cache for five minutes');
});

test('skeletons make way for the first answer; "no results" waits for the last', () => {
  // Skeletons only until the first answer (or a failure): after that the wall shows what has landed and a
  // skeleton beside real tiles reads as a stuck load. And the "No results" sentence is a verdict, so it
  // waits until nothing is pending -- the first answer often has nothing yet. Reintroduce by gating the
  // skeletons on `searchQ.isFetching`: "skeletons are not gated on the answer" fails; by dropping
  // `!stillAsking` from the empty state: "no results is shown while sources are pending" fails.
  const src = code(read(PAGE));
  assert.match(src, /const pending = mode === 'newest' \? Math\.max\(0, budget\.length - settled\) : \(!searchQ\.data && !searchQ\.isError \? 3 : 0\);/, 'skeletons are not gated on the answer');
  assert.match(src, /const stillAsking = mode === 'search' \? \(searchQ\.data\?\.pending \?\? 0\) : 0;/, 'stillAsking does not read pending');
  assert.match(src, /\{!wall\.items\.length && !pending && !stillAsking && \(/, 'no results is shown while sources are pending');
  // A failed search says so in the same card and gets the same Try again button; a toast vanished with the
  // reason and left an empty wall.
  assert.match(src, /searchQ\.isError \? tr\('Search failed'\) : tr\('No results across your sources — try another title\.'\)/, 'a failed search is not told apart from an empty one');
  assert.match(src, /\(mode === 'newest' \|\| searchQ\.isError\) && \(/, 'a failed search has no Try again');
});

test('the progress line names who is still being asked, three names then a count', () => {
  // "3 of 8 sources answered · still asking MangaDex, Aqua Manga, Bato and 2 more" -- from the answer's
  // `sources[]`, the pending ones, the first three by name, then "and N more"; one name gets the singular
  // sentence. Reintroduce by dropping the slice and naming every pending source: "names are not capped"
  // fails, and a fifteen-source install wraps the line to three at 390 px.
  const src = code(read(PAGE));
  assert.match(src, /const SEARCH_NAMES_SHOWN = 3;/, 'the name cap moved');
  assert.match(src, /waiting\.slice\(0, SEARCH_NAMES_SHOWN\)\.join\(', '\)/, 'names are not capped');
  assert.match(src, /d\.sources\.filter\(\(s\) => s\.state === 'pending'\)\.map\(\(s\) => s\.name\)/, 'the names are not the pending sources');
  assert.match(src, /tr\('\{n\} of \{m\} sources answered · still asking \{names\}', \{ n, m, names \}\)/, 'the plural sentence is gone');
  assert.match(src, /tr\('\{n\} of \{m\} sources answered · still asking \{name\}', \{ n, m, name: waiting\[0\] \}\)/, 'the singular sentence is gone');
  assert.match(src, /more > 1 \? `\$\{shown\} \$\{tr\('and \{n\} more', \{ n: more \}\)\}` : more === 1 \? `\$\{shown\} \$\{tr\('and 1 more'\)\}` : shown/, '"and N more" is gone, or one more is not the singular key');
  // Rendered on its own row under the heading, and announced: the wall it describes changes under a screen
  // reader without a focus change.
  assert.match(src, /\{mode === 'search' && progress && \(/, 'the progress line is not gated on search mode');
  assert.match(src, /className="basis-full text-xs tabular-nums text-fog-500" aria-live="polite" data-search-progress/, 'the progress line lost its own row or its announcement');
});

test('the wall pins still hold, and the hits are derived from the answer', () => {
  // wall.test.ts pins `return foldByTitle(out, nameOf, rankOf);` and `wall.groups[key] ??
  // groupsRef.current[key]` byte for byte; both survive the rebuild, and the hits and the groups are now
  // DERIVED from the answer (a memo and an effect on `searchQ.data`) rather than set by a handler, so a
  // poll's answer replaces the rows without anything being cleared first. Reintroduce by filling groupsRef
  // inside the queryFn: "groups are not filled from the answer" fails.
  const src = read(PAGE);
  assert.match(src, /return foldByTitle\(out, nameOf, rankOf\);/, 'the wall is not folded');
  assert.match(src, /wall\.groups\[key\] \?\? groupsRef\.current\[key\]/, "open() does not read the wall's groups");
  assert.match(code(src), /const searchHits = useMemo<SourceItem\[\]>\(\(\) => \(searchQ\.data\?\.content \?\? \[\]\)\.map\(/, 'the hits are not derived from the answer');
  assert.match(code(src), /useEffect\(\(\) => \{\s*groupsRef\.current = \{\};\s*\(searchQ\.data\?\.content \?\? \[\]\)\.forEach\(\(g\) => \{ groupsRef\.current\[normTitle\(g\.title\)\] = g\.providers; \}\);\s*\}, \[searchQ\.data\]\);/, 'groups are not replaced from the latest answer');
});

test('every string the search renders is in all eight locale files', () => {
  // The parity test (library.test.ts) only compares the eight files with each other, so a string that
  // reaches none of them falls back to English in every language without anything failing. This reads the
  // page instead. Reintroduce by deleting any one of the four v0.40.0 keys from public/locales/ar.json.
  const keys = trKeys([PAGE]);
  for (const k of ['{n} of {m} sources answered · still asking {names}', '{n} of {m} sources answered · still asking {name}', 'and {n} more', 'and 1 more']) {
    assert.ok(keys.has(k), `"${k}" is no longer rendered by the page -- the scan or the page changed`);
  }
  const locales = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8, `expected eight locale files, found ${locales.join(', ')}`);
  for (const f of locales) {
    const d = JSON.parse(read(`public/locales/${f}`));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} of the page's strings are missing from ${f}: ${missing.slice(0, 12).join(' | ')}`);
  }
});
