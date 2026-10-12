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
import { DEFAULT_PREFS, titleLook, mergePulled, type ReaderPrefs } from '../lib/readerPrefs';

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
  assert.equal(titleLook(base, {}, {}).mode, 'vertical', 'nothing stored: the default stands');
  assert.equal(titleLook(base, { mode: 'paged' }, {}).mode, 'paged', 'the source default beats the global one');
  assert.equal(titleLook(base, { mode: 'paged' }, { mode: 'vertical' }).mode, 'vertical', 'the series beats its source');
  const mixed = titleLook(base, { mode: 'paged', theme: 'sepia' }, { theme: 'gray' });
  assert.deepEqual([mixed.mode, mixed.theme], ['paged', 'gray'], 'each key is taken from the nearest memory that holds it');
  assert.equal(mixed.brightness, 0.8, 'what is not a look is the default\'s');
  // A direction is only a look when the memory holds one (#102).
  assert.equal(titleLook({ ...base, pagedDirection: 'rtl' }, { mode: 'paged' }, {}).pagedDirection, 'rtl');
});

test("a title's look is built from the stored default", () => {
  // `base` is what the reader passes: loadPrefs(), never its live state. Live state carries the previous title's look,
  // so an edition switch to a series with no memory opened in the last one's mode. Reintroduce by laying the look over
  // the live prefs in the reader: the source guard below fails; here the function must not keep anything of its own.
  const previousTitle: ReaderPrefs = { ...base, mode: 'paged', theme: 'sepia' };
  const next = titleLook(base, {}, {});
  assert.notEqual(next.mode, previousTitle.mode);
  assert.deepEqual(next, base, 'a title with no memory opens exactly on the stored default');
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
  // move setPrefs(titleLook(…)) below setReady(true): one of these fails.
  const src = code(read('app/reader/page.tsx'));
  const load = between(src, 'const first = await loadChapter(bookId);', '}, [bookId, reloadKey]);', 'the load effect');
  const look = load.indexOf('setPrefs(titleLook(loadPrefs(), src ? loadSourcePrefs(src.id) : {}, memory));');
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
