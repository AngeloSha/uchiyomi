// Join split double pages (#229) and one page of a pair in frame (#232 by a tap, #261 by the `focus` key), v0.77.0: the
// rules as the pure functions they are, and the reader's wiring by its source, as readerSpread.test.ts holds the pairing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { joinedOrder, pairSlides, type SpreadItem } from '../lib/readerSpread';
import { DEFAULT_PREFS, LOOK_KEYS, migratePrefs } from '../lib/readerPrefs';
import { DEFAULT_KEYS_PAGED, DEFAULT_KEYS_VERTICAL, PAGE_ACTIONS, READER_ACTIONS, actionForKey, keyMapFor } from '../lib/readerKeys';
import { DEFAULT_PAD } from '../lib/readerPad';
import { DEFAULT_DEVICE, migrateDevicePrefs } from '../lib/readerDevice';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** One chapter of portrait pages numbered from 1; `join[k]` is what the server said of page k + 1 and the next. */
const mk = (joins: Array<'rtl' | 'ltr' | undefined>): SpreadItem[] =>
  joins.map((j, k) => ({ ci: 0, firstOfChapter: k === 0, number: k + 1, width: 800, height: 1200, join: j }));

test('a joined pair is one slide in Double spread, even as page 1, and the page before it is solo', () => {
  // The first page of a chapter is a cover unless it is half of a spread. Reintroduce by dropping `joinAt` from the
  // spread loop: page 1 stands alone again and an opening spread is two screens.
  const items = mk([undefined, undefined, 'rtl', undefined, undefined, undefined]);
  assert.deepEqual(pairSlides(items, true, { joinSplit: true }).slides, [[0], [1], [2, 3], [4, 5]]);
  assert.deepEqual(pairSlides(mk(['rtl', undefined, undefined, undefined]), true, { joinSplit: true }).slides, [[0, 1], [2, 3]]);
});

test('a joined pair is one slide in single-page reading too', () => {
  const items = mk([undefined, undefined, 'rtl', undefined, undefined]);
  const r = pairSlides(items, false, { joinSplit: true });
  assert.deepEqual(r.slides, [[0], [1], [2, 3], [4]]);
  assert.deepEqual(r.slideOf, [0, 1, 2, 2, 3], 'both pages of the pair open on its slide');
  assert.deepEqual(r.joined, [false, false, true, false], '`joined` marks the joined slide, and only it');
});

test('Join split double pages is off until chosen, and only a real `true` turns it on', () => {
  // The owner's call (v0.77.0): a wrong join puts two unrelated pages side by side, so nobody gets one unasked.
  // Reintroduce #229's default (on): every reader's chapters re-pair the day they upgrade.
  assert.equal(DEFAULT_PREFS.joinSplit, false);
  assert.equal(migratePrefs({}).joinSplit, false);
  assert.equal(migratePrefs({ joinSplit: 'yes' }).joinSplit, false);
  assert.equal(migratePrefs({ joinSplit: true }).joinSplit, true);
  assert.ok(!(LOOK_KEYS as readonly string[]).includes('joinSplit'), 'one setting for every title, not a title\'s look');
});

test('off, the slides are exactly what they were, joins on the pages or not', () => {
  const items = mk([undefined, 'rtl', undefined, undefined, 'ltr', undefined, undefined]);
  for (const spread of [false, true]) {
    const off = pairSlides(items, spread, { joinSplit: false });
    const before = pairSlides(items.map(({ join: _j, ...p }) => p), spread);
    assert.deepEqual(off.slides, before.slides);
    assert.ok(off.joined.every((j) => !j));
  }
});

test('under Wide pages → Split a joined pair is its two pages, one a slide; Double spread is never split', () => {
  // A spread's halves one by one is what Split shows of a spread in one file; a joined pair's halves are its pages.
  const items = mk([undefined, 'rtl', undefined, undefined]);
  assert.deepEqual(pairSlides(items, false, { joinSplit: true, split: true }).slides, [[0], [1], [2], [3]]);
  assert.deepEqual(pairSlides(items, true, { joinSplit: true, split: true }).slides, [[0], [1, 2], [3]]);
});

test('a placeholder never joins, nor across a hidden page or a chapter\'s end, nor beside a wide page', () => {
  const missing = mk([undefined, 'rtl', undefined, undefined]); missing[2].missing = true;
  assert.ok(!pairSlides(missing, false, { joinSplit: true }).joined.some(Boolean), 'a page the source never served is half of nothing');
  const hidden = mk([undefined, 'rtl', undefined, undefined]); hidden[2].number = 5;
  assert.ok(!pairSlides(hidden, true, { joinSplit: true }).joined.some(Boolean), 'a page hidden between the two broke nothing');
  const cross = mk([undefined, 'rtl', undefined, undefined]); cross[2].ci = 1; cross[3].ci = 1; cross[2].firstOfChapter = true;
  assert.ok(!pairSlides(cross, true, { joinSplit: true }).slides.some((s) => s.length === 2 && s[0] === 1));
  const wide = mk([undefined, 'rtl', undefined]); wide[2].width = 2400;
  assert.ok(!pairSlides(wide, false, { joinSplit: true }).joined.some(Boolean), 'a wide page is a spread already');
});

test('a joined spread sits by the side the server found, whatever way the book reads', () => {
  // 'rtl' on a page: the next one sits on its LEFT, as a right-to-left book runs on. Reintroduce by laying the pair out in
  // the track's order instead: a right-to-left spread read left to right shows its halves swapped.
  assert.deepEqual(joinedOrder(4, 5, 'rtl'), [5, 4]);
  assert.deepEqual(joinedOrder(4, 5, 'ltr'), [4, 5]);
  assert.deepEqual(joinedOrder(4, 5, undefined), [4, 5]);
});

test('Z brings one page of a pair into frame: an action of the key map, in paged mode, once a press', () => {
  // #261 had Z hard-coded beside the key map, so it could not be rebound, had no controller button and was missing from
  // the key list. Reintroduce by dropping `focus` from DEFAULT_KEYS_PAGED: Z does nothing.
  assert.deepEqual(DEFAULT_KEYS_PAGED.focus, ['z']);
  assert.deepEqual(DEFAULT_KEYS_VERTICAL.focus, [], 'the webtoon column has no pairs');
  assert.ok(READER_ACTIONS.includes('focus'));
  assert.ok(!PAGE_ACTIONS.has('focus'), 'a held Z must not flick in and out');
  assert.equal(actionForKey({ key: 'z' }, keyMapFor('paged')), 'focus');
  assert.equal(actionForKey({ key: 'z', repeat: true }, keyMapFor('paged')), null);
  assert.equal(actionForKey({ key: 'z' }, keyMapFor('vertical')), null);
  assert.equal(actionForKey({ key: 'x' }, keyMapFor('paged', { focus: ['x'] })), 'focus', 'rebindable like the rest');
  assert.deepEqual(DEFAULT_PAD.focus, [3], 'Y on a controller');
  // In the key list and the sheet, by its own words.
  assert.match(read('components/ReaderKeys.tsx'), /focus: \(\) => tr\('One page of a pair, or both'\),/);
});

test('tapping a page of a pair is this device\'s, and off until chosen', () => {
  assert.equal(DEFAULT_DEVICE.tapFocus, false);
  assert.equal(migrateDevicePrefs({}).tapFocus, false);
  assert.equal(migrateDevicePrefs({ tapFocus: 'yes' }).tapFocus, false);
  assert.equal(migrateDevicePrefs({ tapFocus: true }).tapFocus, true);
  assert.match(read('components/ReaderSettings.tsx'), /on=\{device\.tapFocus\} onChange=\{\(tapFocus\) => setDevice\(\{ tapFocus \}\)\}/);
});

test('with Tap a page of a pair off, a tap is the tap layout\'s, the middle showing the controls, as ever', () => {
  // #232 took taps on a pair's pages unconditionally: the middle of a pair in Double spread focused a page and nothing by
  // pointer brought the controls back. Reintroduce by asking pageOfPairAt whatever device.tapFocus says.
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /const target = device\.tapFocus \? pageOfPairAt\(e\.clientX, e\.clientY\) : null;/);
  assert.equal(src.split('pageOfPairAt(').length - 1, 1, 'pageOfPairAt is asked from one place, behind the switch');
});

test('only a joined spread loses the gap down the middle; every other pair keeps its gutter', () => {
  // #232 took the 4 px gap from every pair. Reintroduce by dropping `gap-1` outright: an ordinary Double spread changes look.
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /items-center justify-center\$\{isJoined \? '' : ' gap-1'\}/);
  assert.match(src, /area\.w \/ 2 - \(isJoined \? 0 : 2\)/);
  assert.match(src, /dir=\{isJoined \? 'ltr' : undefined\}/, 'a joined spread is laid out as drawn, not by the track');
});

test('the page list asks for spreads only with joining on, and a join found late keeps the page being read', () => {
  const src = code(read('app/reader/page.tsx'));
  assert.match(src, /const first = await loadChapter\(bookId, loadPrefs\(\)\.joinSplit\);/);
  assert.match(src, /const ch = await loadChapter\(next\.id, prefs\.joinSplit\);/);
  assert.match(src, /\/pages\$\{spreads \? '\?spreads=1' : ''\}/);
  assert.match(src, /joinSplit: prefs\.joinSplit \}\)/, 'pairSlides is not told whether joining is on');
  // The joins effect: two slides made one before the page being read would otherwise move the reader a page on.
  const eff = src.slice(src.indexOf('laidOutJoins.current === joinedAt'), src.indexOf('}, [joinedAt]);'));
  assert.ok(eff.length > 0, 'the joins effect is gone');
  // v0.89.0: on the page being read, or on the first page of a pair just taken apart (spreadMarks.test.ts).
  assert.match(eff, /const anchor = apart \? was\[0\] : current;\s*const s = slideOf\[anchor\] \?\? anchor;\s*placeTrack\(el, s\);/);
});

test('one page in frame is said with a squared key, never a capsule', () => {
  const src = read('app/reader/page.tsx');
  const label = src.slice(src.indexOf('data-focus-label'), src.indexOf('</div>', src.indexOf('data-focus-label')));
  assert.ok(label.length > 0, 'the label is gone');
  assert.match(label, /rounded-md/);
  assert.doesNotMatch(label, /rounded-full/);
  assert.match(label, /tr\('Show both pages'\)/);
});
