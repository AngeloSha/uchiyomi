// Which look a title opens in (v0.61.0): the stored default, its source's default, its own memory -- and, when asked
// for, a mode picked from the shape of its pages.
//
// Three reader bugs sat on this path, and automatic mode would have hit them on every title it touched:
//   F1. The title's look arrived a render AFTER the chapter became ready. The initial scroll had already run on the
//       global mode, so a global Webtoon + a source default of Paged + a resume at page 9 opened on slide 0 while
//       the counter said 9, and the first swipe sent page 2 and rewound the progress.
//   F2. A late answer from /api/settings was laid over the reader's live state whole, putting the global look back
//       over the open title.
//   F3. Switching mode mid-chapter swapped the scroller and nothing put the new one on the page being read.
// The pure parts are tested here; the reader's use of them is pinned by source guards below, and the browser walk
// (test/e2e/v610Walk-reader.mjs) drives the three cases end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_PREFS, LOOK_KEYS, migratePrefs, titleLook, mergePulled, seriesPinChange, type ReaderPrefs } from '../lib/readerPrefs';
import { guessMode, type AutoGuess } from '../lib/readerAuto';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with its comments removed: several comments quote the code they forbid. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const between = (src: string, from: string, to: string, what: string): string => {
  const a = src.indexOf(from);
  assert.notEqual(a, -1, `${what}: "${from}" is gone`);
  const b = src.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `${what}: "${to}" is gone`);
  return src.slice(a, b);
};

const base: ReaderPrefs = { ...DEFAULT_PREFS, mode: 'vertical', theme: 'amoled', brightness: 0.8 };

test("a title's look: series memory > source default > the stored default", () => {
  // The precedence the per-source default (v0.45) and the per-series memory have always promised, now one function.
  assert.equal(titleLook(base, {}, {}).prefs.mode, 'vertical', 'nothing stored: the default stands');
  assert.equal(titleLook(base, { mode: 'paged' }, {}).prefs.mode, 'paged', 'the source default beats the global one');
  assert.equal(titleLook(base, { mode: 'paged' }, { mode: 'vertical' }).prefs.mode, 'vertical', 'the series beats its source');
  const mixed = titleLook(base, { mode: 'paged', theme: 'sepia' }, { theme: 'gray' }).prefs;
  assert.deepEqual([mixed.mode, mixed.theme], ['paged', 'gray'], 'each key is taken from the nearest memory that holds it');
  assert.equal(mixed.brightness, 0.8, 'what is not a look is the default\'s');
  // A direction is only a look when the memory holds one (#102).
  assert.equal(titleLook({ ...base, pagedDirection: 'rtl' }, { mode: 'paged' }, {}).prefs.pagedDirection, 'rtl');
});

test("a title's look is built from the stored default", () => {
  // `base` is what the reader passes: loadPrefs(), never its live state. Live state carries the previous title's look,
  // so an edition switch to a series with no memory opened in the last one's mode. Reintroduce by laying the look over
  // the live prefs in the reader: the source guard below fails; here the function must not keep anything of its own.
  const previousTitle: ReaderPrefs = { ...base, mode: 'paged', theme: 'sepia' };
  const next = titleLook(base, {}, {});
  assert.notEqual(next.prefs.mode, previousTitle.mode);
  assert.deepEqual(next, { prefs: base, autoApplied: null }, 'a title with no memory opens exactly on the stored default');
});

test("a late pull keeps the open title's look", () => {
  // F2. The account's answer is the GLOBAL default; with a title open, its look is the title's.
  // Reintroduce by spreading `pulled` over `cur` whatever `titleOpen` says: the mode flips back to Webtoon.
  const open: ReaderPrefs = { ...base, mode: 'paged', theme: 'sepia', spread: true, pagedDirection: 'rtl' };
  const pulled: ReaderPrefs = { ...base, mode: 'vertical', theme: 'amoled', spread: false, pagedDirection: 'series', brightness: 0.5, gap: 8 };
  const after = mergePulled(open, pulled, true);
  assert.deepEqual([after.mode, after.theme, after.spread, after.pagedDirection], ['paged', 'sepia', true, 'rtl'], 'a late pull changed the open title\'s look');
  assert.deepEqual([after.brightness, after.gap], [0.5, 8], 'what is not a look is still adopted');
  // Before a title is open the pull is the whole default, as it always was.
  assert.equal(mergePulled(open, pulled, false).mode, 'vertical');
});

test('the reader applies the title\'s look with `ready`, and no effect lays it on afterwards (F1)', () => {
  // Reintroduce the post-ready look effect (`useEffect(() => { … withTitleLook … }, [seriesId, seriesSourceId])`), or
  // move setPrefs(look.prefs) below setReady(true): one of these fails.
  const src = code(read('app/reader/page.tsx'));
  const load = between(src, 'const first = await loadChapter(bookId);', '}, [bookId, reloadKey]);', 'the load effect');
  const look = load.indexOf('const look = titleLook(loadPrefs(), src ? loadSourcePrefs(src.id) : {}, memory, autoGuess.current);\n      setPrefs(look.prefs);');
  const ready = load.lastIndexOf('setReady(true);');
  assert.ok(look > 0, 'the load effect does not lay the title\'s look over the STORED default');
  assert.ok(look < ready, 'the title\'s look is set after `ready`, so the initial scroll runs on the wrong mode');
  assert.ok(!load.slice(look, ready).includes('await '), 'something is awaited between the look and `ready`: they are no longer one render');
  assert.doesNotMatch(src, /\}, \[seriesId, seriesSourceId\]\);/, 'the post-ready look effect is back');
  assert.doesNotMatch(src, /withTitleLook\(/, 'the reader lays a look over its live state again');
});

test('a pull of the account\'s settings goes through mergePulled, and a mode switch re-anchors (F2, F3)', () => {
  // Reintroduce `setPrefs((cur) => ({ ...cur, ...p }))` on the pull, or delete the mode layout effect: a guard fails.
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /syncPrefsFromServer\(\)\.then\(\(p\) => setPrefs\(\(cur\) => mergePulled\(cur, p, titleOpen\.current\)\)\)/, 'the pull is laid over the live look whole');
  const anchor = between(src, 'useLayoutEffect(() => {\n    const el = scrollRef.current;\n    if (!el || !didInitScroll.current || laidOutMode.current === prefs.mode) return;', '}, [prefs.mode]);', 'the mode re-anchor');
  assert.match(anchor, /el\.scrollLeft = trackSign \* \(slideOf\[current\] \?\? current\) \* el\.clientWidth;/, 'a switch to Paged does not land on the page being read');
  assert.match(anchor, /el\.scrollTop = tops\[current\] \?\? 0;/, 'a switch to Webtoon does not land on the page being read');
});

// ---- v0.61.0, G6: Pick the mode for each series ----

const pages = (n: number, w: number, h: number) => Array.from({ length: n }, () => ({ width: w, height: h }));

test('the automatic pick, case by case', () => {
  // Reintroduce any rule out of order -- the type before the shape, say -- and a row below fails.
  const table: [string, Parameters<typeof guessMode>[0], AutoGuess | null][] = [
    ['tall pages are strips, whatever the type', { pages: pages(6, 720, 2000), type: 'manga' }, { mode: 'vertical', reason: 'strips' }],
    ['two 689 x 20,000 strips', { pages: pages(2, 689, 20000) }, { mode: 'vertical', reason: 'strips' }],
    ['three short pages are not strips', { pages: pages(3, 720, 1000) }, null],
    ['one page ten widths tall is', { pages: pages(1, 700, 7000) }, { mode: 'vertical', reason: 'strips' }],
    ['a median below 2 over four pages is not tall', { pages: [...pages(3, 720, 1000), ...pages(2, 720, 9000)] }, null],
    ['a manhwa of slices', { pages: pages(30, 720, 400), type: 'manhwa' }, { mode: 'vertical', reason: 'manhwa' }],
    ['a webtoon whose pages are unknown', { pages: [{ width: null, height: null }], type: 'webtoon' }, { mode: 'vertical', reason: 'webtoon' }],
    ['a manhwa in print, pages shaped like pages', { pages: pages(20, 1000, 1500), type: 'manhwa' }, null],
    ['a manga', { pages: pages(20, 1000, 1500), type: 'manga' }, { mode: 'paged', reason: 'manga' }],
    ['a comic', { pages: pages(20, 1300, 2000), type: 'comic' }, { mode: 'paged', reason: 'comic' }],
    ['a right-to-left series of unknown type', { pages: pages(20, 1000, 1500), type: 'unknown', rtl: true }, { mode: 'paged', reason: 'rtl' }],
    ['a right-to-left series of strips is still strips', { pages: pages(2, 689, 20000), rtl: true }, { mode: 'vertical', reason: 'strips' }],
    ['a manhua says nothing', { pages: pages(20, 1000, 1500), type: 'manhua' }, null],
    ['nothing known', { pages: [] }, null],
  ];
  for (const [what, t, want] of table) assert.deepEqual(guessMode(t), want, what);
  // A repeated page or a placeholder is no evidence of shape.
  const credits = [...pages(4, 720, 1000).map((p) => ({ ...p, junk: true })), ...pages(4, 720, 3000)];
  assert.deepEqual(guessMode({ pages: credits }), { mode: 'vertical', reason: 'strips' });
});

test('the automatic mode sits between the source default and the global one, and is off by default', () => {
  const auto: AutoGuess = { mode: 'paged', reason: 'manga' };
  const on = { ...base, autoMode: true };
  assert.equal(DEFAULT_PREFS.autoMode, false, 'the automatic pick is on for every install');
  assert.equal(migratePrefs({}).autoMode, false);
  assert.equal(migratePrefs({ autoMode: 'yes' }).autoMode, false);
  assert.ok(!(LOOK_KEYS as readonly string[]).includes('autoMode'));
  assert.deepEqual(titleLook(base, {}, {}, auto), { prefs: base, autoApplied: null }, 'the guess applied with the switch off');
  const picked = titleLook(on, {}, {}, auto);
  assert.equal(picked.prefs.mode, 'paged');
  assert.deepEqual(picked.autoApplied, auto, 'the reader is not told the mode was the pick\'s');
  assert.deepEqual(titleLook(on, {}, {}, null), { prefs: on, autoApplied: null }, 'no guess, the default stands');
  // Only the mode: the rest of the look is the memories' and the default's.
  assert.equal(titleLook(on, { theme: 'sepia' }, {}, auto).prefs.theme, 'sepia');
});

test("the automatic mode never overrides a source's or a series' mode", () => {
  // Reintroduce by applying the guess whenever there is one (drop `!source.mode && !series.mode`): both fail.
  const auto: AutoGuess = { mode: 'vertical', reason: 'strips' };
  const on = { ...base, mode: 'paged' as const, autoMode: true };
  const bySource = titleLook(on, { mode: 'paged' }, {}, auto);
  assert.deepEqual([bySource.prefs.mode, bySource.autoApplied], ['paged', null], 'the pick overrode the source default');
  const bySeries = titleLook(on, {}, { mode: 'paged', theme: 'gray' }, auto);
  assert.deepEqual([bySeries.prefs.mode, bySeries.autoApplied], ['paged', null], 'the pick overrode the series\' own mode');
  // A theme pinned without a mode (the pick's own pins, below) leaves the pick free.
  assert.equal(titleLook(on, {}, { theme: 'gray' }, auto).prefs.mode, 'vertical');
});

test('an automatic mode is not pinned by a theme change', () => {
  // Reintroduce by pinning `n.mode` whatever chose it: the guess is frozen into the title's memory, and switching the
  // pick off never reaches that title again.
  const auto: AutoGuess = { mode: 'vertical', reason: 'manhwa' };
  const n = { ...base, mode: 'vertical' as const, theme: 'sepia' as const, autoMode: true };
  assert.deepEqual(seriesPinChange({ theme: 'sepia' }, n, { autoApplied: auto }), { theme: 'sepia', spread: false }, 'a theme change pinned the picked mode');
  assert.deepEqual(seriesPinChange({ spread: true }, { ...n, spread: true }, { autoApplied: auto }), { theme: 'sepia', spread: true });
  assert.deepEqual(seriesPinChange({ pagedDirection: 'rtl' }, { ...n, pagedDirection: 'rtl' }, { autoApplied: auto }),
    { theme: 'sepia', spread: false, pagedDirection: 'rtl', directionChosen: true });
  // Tapping Mode pins it, as it always did -- automatic or not.
  assert.deepEqual(seriesPinChange({ mode: 'paged' }, { ...n, mode: 'paged' }, { autoApplied: auto }), { mode: 'paged', theme: 'sepia', spread: false });
  // And with no pick in force, a theme change pins the mode as before (#102's rule, unchanged).
  assert.deepEqual(seriesPinChange({ theme: 'sepia' }, n), { mode: 'vertical', theme: 'sepia', spread: false });
});

test('the reader picks the mode from the chapter it opens, and says so', () => {
  // Reintroduce by guessing without the series' type (drop `type: seriesType`): a manhwa of page-like slices opens in
  // the default. Drop `autoApplied` from the sheet: the reader is never told why the mode changed.
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /autoGuess\.current = guessMode\(\{ pages: first\.pages, type: seriesType, rtl: readsRtl \}\);/);
  assert.match(src, /seriesType = s\?\.seriesType \?\? null;\s*rememberSeriesType\(first\.seriesId, seriesType\);/, 'the type is not kept for opening the series offline');
  assert.match(src, /seriesPinChange\(p, n, \{ autoApplied: p\.mode \? null : autoApplied \}\)/, 'the reader pins a picked mode on a theme change');
  assert.match(code(read('components/ReaderSettings.tsx')), /\{autoApplied && \(/, 'the sheet does not say what the pick chose');
});
