// The add dialog's step after picking a source (v0.40.0).
//
// Picking a source fetched its series and chapter list in an effect with a request counter and hid the
// WHOLE dialog body behind "Loading…" until it landed -- the second "takes forever" the owner reported, and
// the one that hid the way back to another source exactly when a slow source made it the thing to tap. The
// detail is now a keyed query (a second pick of the same source is instant), a group with a choice to make
// pre-warms its first two providers as it opens, and the body paints at once with only the count, the
// groups and the chapter <select> waiting. Read from source, like wall.test.ts; each guard names the edit
// that fails it.
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

const DIALOG = 'components/AddSeriesDialog.tsx';

test('the detail is a query keyed on the pick, fresh for ten minutes, never retried', () => {
  // Keyed on `(source, sourceId)`, so A → B → A asks the server for A once and the pre-warm below has a key
  // to warm. `retry: false`: a source that failed is shown as failed with Change right beside it; a retry is
  // another twenty-second budget against the same site. The query's `signal` reaches `api()`, so a pick
  // abandoned mid-flight is cancelled. Reintroduce by restoring the `useEffect` + `want.current` detail
  // fetch: "the detail is fetched in an effect again" fails (the trending find keeps its ONE counter).
  const src = code(read(DIALOG));
  assert.match(src, /queryKey: \['src-detail', picked\?\.source, picked\?\.sourceId\]/, 'the detail is not keyed on the picked source and id');
  assert.match(src, /queryFn: \(\{ signal \}\) => fetchDetail\(picked!, signal\)/, 'the detail queryFn does not pass the signal');
  assert.match(src, /enabled: !!picked/, 'the detail query runs with nothing picked');
  assert.match(src, /staleTime: DETAIL_STALE_MS/, 'the detail is not held fresh');
  assert.match(src, /const DETAIL_STALE_MS = 10 \* 60_000;/, 'the detail freshness is not ten minutes');
  assert.match(src, /retry: false/, 'a failed detail is retried');
  assert.match(src, /const fetchDetail = \(p: Pick<Provider, 'source' \| 'sourceId'>, signal\?: AbortSignal\) =>\s*api<Detail>\(`\/api\/sources\/detail\?source=\$\{encodeURIComponent\(p\.source\)\}&sourceId=\$\{encodeURIComponent\(p\.sourceId\)\}`, \{ signal \}\);/, 'fetchDetail changed shape or dropped the signal');
  assert.equal(src.match(/\+\+want\.current/g)?.length, 1, 'the detail is fetched in an effect again (a second request counter)');
  assert.doesNotMatch(src, /setDetail\(/, 'the detail is React state again');
});

test('a group with a choice pre-warms its first two providers as it opens', () => {
  // Two, not all: each is a live request to a site, and the list is ranked, so the first two are where
  // nearly every tap lands. The pre-warm's key is the SAME shape as the query's, or it warms nothing. A
  // group of one picks itself, so it needs no pre-warm; a trending or result seed has no list to warm.
  // Reintroduce by prefetching `seed.providers` whole: "every provider is pre-warmed" fails; by writing
  // `['detail', p.source, p.sourceId]` for the prefetch: "the pre-warm key differs" fails.
  const src = code(read(DIALOG));
  const warm = src.slice(src.indexOf("if (seed.kind !== 'group' || seed.providers.length < 2) return;"));
  assert.notEqual(warm, src, 'the pre-warm is not gated on a group with more than one provider');
  assert.match(warm, /for \(const p of seed\.providers\.slice\(0, 2\)\) \{/, 'every provider is pre-warmed, or none');
  assert.match(warm, /qc\.prefetchQuery\(\{ queryKey: \['src-detail', p\.source, p\.sourceId\], queryFn: \(\{ signal \}\) => fetchDetail\(p, signal\), staleTime: DETAIL_STALE_MS, retry: false \}\)/, 'the pre-warm key differs from the query key, or its options do');
  // The effect depends on the seed and the client only: a dependency on `picked` would re-warm on every pick.
  assert.match(warm, /\}, \[seed, qc\]\);/, 'the pre-warm effect re-runs on something other than the seed');
});

test('the options step paints before the detail lands', () => {
  // The cover, the source line, the Change chip and the switches come from the pick; only the count, the
  // groups and the chapter <select> wait for the detail, and say so in their own place. Reintroduce by
  // wrapping the body in `!detail ? <p>{tr('Loading…')}</p> : …`: "the body is gated" fails.
  const src = code(read(DIALOG));
  // The options step is everything from its first derived value to the end of the file (the marker comment
  // above it is stripped with the rest).
  const at = src.indexOf('const summary = detail?.summary');
  assert.notEqual(at, -1, 'the options step lost its summary line -- update this slice');
  const options = src.slice(at);
  assert.doesNotMatch(options, /\{loading \|\| !detail \?|\{!detail \? \(/, 'the body is gated on the detail');
  assert.doesNotMatch(src, /tr\('Loading…'\)/, 'the whole-body Loading… is back');
  assert.match(options, /<Img src=\{sourceCover\(picked\.source, coverUrl\)\}/, "the cover is not the pick's");
  assert.match(options, /const coverUrl = detail\?\.coverUrl \?\? picked\.coverUrl;/, "the cover does not fall back to the pick's");
  assert.match(options, /<SourceIcon id=\{picked\.source\} name=\{picked\.name\} size=\{16\} \/>/, "the From line does not read the pick");
  assert.match(options, /tr\('Loading chapter list…'\)/, 'the count line does not say the list is loading');
  assert.match(options, /aria-live="polite" data-detail="loading"/, 'the loading line is not announced');
  // The chapter <select> and the groups are inside the detail gate; the switches and Add are outside it.
  const gated = options.slice(options.indexOf('{detail && (<>'), options.indexOf('</>)}'));
  assert.ok(gated.length > 0, 'the detail gate around the count/groups/select is gone');
  assert.match(gated, /<select value=\{pick\}/, 'the chapter select is rendered before the detail');
  assert.match(gated, /tr\('Translated by'\)/, 'the groups are rendered before the detail');
  const after = options.slice(options.indexOf('</>)}'));
  assert.match(after, /<Switch on=\{autoUpdate\}/, 'the auto-update switch waits for the detail');
  assert.match(after, /disabled=\{adding \|\| !detail\}/, 'Add is not disabled until the detail lands');
});

test('a source that does not answer says so, with Change right beside it', () => {
  // With `retry: false` a failed detail is final for this pick, so it has to be visible: the picker's own
  // sentence for an unreachable source, in amber, under the From line whose Change chip is the way out.
  // The old effect swallowed the failure and showed "Loading…" for ever. Reintroduce by dropping the
  // `detailQ.isError` branch: "a failed detail looks like a loading one" fails.
  const src = code(read(DIALOG));
  assert.match(src, /\) : detailQ\.isError \? \(\s*<p className="text-xs text-amber-300" data-detail="failed">\{tr\('Could not be reached right now\.'\)\}<\/p>/, 'a failed detail looks like a loading one');
  assert.match(src, /onClick=\{\(\) => \{ setPicked\(null\); setPickChoice\(null\); \}\}/, 'Change does not clear the pick and the chapter choice');
});

test('the chapter pick is derived from the detail, never set when it lands', () => {
  // `pickChoice` is what the person chose or null; the default comes from the detail at render time. Set
  // in an effect when the detail landed, a `count === 0` listing rendered one frame with `all` selected and
  // no such option, and picking another source raced the arrival of the new detail. Reintroduce by
  // `useState<ChapterPick>('all')` plus `setPick(d.count === 0 ? 'none' : 'all')` on arrival: "the pick is
  // set when the detail lands" fails.
  const src = code(read(DIALOG));
  assert.match(src, /const \[pickChoice, setPickChoice\] = useState<ChapterPick \| null>\(null\);/, 'the chapter choice is not nullable state');
  assert.match(src, /const pick: ChapterPick = pickChoice \?\? \(detail && detail\.count === 0 \? 'none' : 'all'\);/, 'the pick is not derived from the detail');
  assert.doesNotMatch(src, /setPick\(/, 'the pick is set when the detail lands');
  assert.match(src, /onChange=\{\(e\) => setPickChoice\(e\.target\.value as ChapterPick\)\}/, 'the select does not write the choice');
});

test('every string the dialog renders is in all eight locale files', () => {
  // The parity test (library.test.ts) only compares the eight files with each other, so a string that
  // reaches none of them falls back to English in every language without anything failing. This reads the
  // dialog instead. Reintroduce by deleting "Loading chapter list…" from public/locales/ar.json.
  const keys = trKeys([DIALOG]);
  assert.ok(keys.has('Loading chapter list…'), 'the loading line is no longer rendered -- the scan or the dialog changed');
  assert.ok(keys.size >= 40, `only ${keys.size} strings found in the dialog -- the scan itself is broken`);
  const locales = readdirSync(join(ROOT, 'public/locales')).filter((f) => f.endsWith('.json'));
  assert.equal(locales.length, 8, `expected eight locale files, found ${locales.join(', ')}`);
  for (const f of locales) {
    const d = JSON.parse(read(`public/locales/${f}`));
    const missing = [...keys].filter((k) => !(k in d) || !String(d[k]).trim());
    assert.deepEqual(missing, [], `${missing.length} of the dialog's strings are missing from ${f}: ${missing.slice(0, 12).join(' | ')}`);
  }
});
