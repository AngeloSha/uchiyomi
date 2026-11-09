import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagedOpenOffset, pagedScrollStep, zoomedScrollOffset } from '../lib/readerPagedScroll';
import { actionForKey, keyMapFor } from '../lib/readerKeys';

test('vertical paged keys read a tall page before turning, regardless of its horizontal reading direction', () => {
  const map = keyMapFor('paged');
  const pane = { scrollTop: 0, scrollHeight: 1800, clientHeight: 600 };
  for (const key of [' ', 'ArrowDown', 'PageDown']) {
    const action = actionForKey({ key }, map)!;
    assert.equal(pagedScrollStep(action, pane), 528, key);
    assert.equal(pagedScrollStep(action, { ...pane, scrollTop: 1100 }), 100, 'stop at the page edge');
    assert.equal(pagedScrollStep(action, { ...pane, scrollTop: 1200 }), 0, 'only then turn');
  }
  for (const event of [{ key: ' ', shiftKey: true }, { key: 'ArrowUp' }, { key: 'PageUp' }]) {
    const action = actionForKey(event, map)!;
    assert.equal(pagedScrollStep(action, { ...pane, scrollTop: 900 }), -528);
    assert.equal(pagedScrollStep(action, { ...pane, scrollTop: 100 }), -100);
    assert.equal(pagedScrollStep(action, pane), 0, 'at the top, turn back');
  }
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    assert.equal(pagedScrollStep(actionForKey({ key }, map)!, { ...pane, scrollTop: 600 }), 0, 'physical arrows turn immediately');
  }
  assert.equal(pagedScrollStep('next', { ...pane, scrollHeight: 600 }), 0, 'a whole visible page turns');
  assert.equal(pagedScrollStep('next', { ...pane, scrollTop: 1199.5 }), 0, 'subpixel edge does not trap the key');
});

test('zoom keeps an off-centre image point in place on both axes and survives a round trip', () => {
  // A reader panned sideways at 2x zoom; zooming again must not recenter the page.
  for (const [offset, viewport] of [[120, 800], [740, 600]]) {
    const next = zoomedScrollOffset(offset, viewport, 2, 3);
    assert.equal((next + viewport / 2) / 3, (offset + viewport / 2) / 2, 'same source-image point under the centre');
    assert.equal(zoomedScrollOffset(next, viewport, 3, 2), offset);
  }
  assert.equal(zoomedScrollOffset(120, 800, 2, 3), 380, 'retain the panned horizontal point, not the page centre');
  assert.equal(zoomedScrollOffset(0, 800, 3, 1), 0, 'native scroll cannot reach a negative offset');
  // Shrinking 2400x3000 content to 1600x2000 in an 800x600 pane clamps DOM offsets from (1500,2200) to
  // (800,1400) before a layout effect reads them. The anchor must use the saved offsets from before the shrink.
  assert.equal(Math.min(800, zoomedScrollOffset(1500, 800, 3, 2)), 800);
  assert.ok(Math.abs(zoomedScrollOffset(2200, 600, 3, 2) - 1366.6666666666667) < 1e-9);
});

test('the paged reader uses the visible pane for keys and both zoom axes without changing tap undo or whole-page mode', () => {
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(src, /if \(prefs\.mode === 'paged' && prefs\.pagedFitWidth && !o\.tap\) \{\s*const pane = el\.querySelector<HTMLElement>\(`\[data-paged-scroll="\$\{slideNow\(\)\}"\]`\);/);
  assert.match(src, /const step = pane \? pagedScrollStep\(action, pane\) : 0;\s*if \(pane && step\) \{ pane\.scrollBy\(\{ top: step, behavior \}\); return; \}/);
  assert.ok(src.indexOf('const step = pane ? pagedScrollStep(action, pane)') < src.indexOf('stepFocus(action, o)'), 'finish the current focused page before changing to its partner');
  assert.match(src, /\[current, focus\?\.page, prefs\.mode, prefs\.pagedFitWidth\]/, 'a different focused page starts at its top');
  assert.match(src, /widthZoomAnchor\.current = pane \? \{ pane, slide, page: current, focusedPage: focus\?\.page, zoom, x: pane\.scrollLeft, y: pane\.scrollTop \} : null;\s*setZoomState\(next\);/, 'snapshot before React changes the image dimensions');
  assert.match(src, /anchor\?\.pane === pane && anchor\.slide === index && anchor\.page === current\s*&& anchor\.focusedPage === focus\?\.page && anchor\.zoom === before/, 'a new page or focused partner cannot reuse an old snapshot');
  assert.match(src, /pane\.scrollTop = zoomedScrollOffset\(saved\?\.y \?\? pane\.scrollTop, pane\.clientHeight, before, zoom\);/);
  assert.match(src, /pane\.scrollLeft = zoomedScrollOffset\(saved\?\.x \?\? pane\.scrollLeft, pane\.clientWidth, before, zoom\);/);
});

test('going back to a width-fitted page opens it at its foot, going forward at its top (#401)', () => {
  // From @Forgitusername's #401. Reintroduce `pane.scrollTop = 0` for every arrival: the page read last opens at its top
  // again, and reading backwards means scrolling down through it to find where it was left.
  assert.equal(pagedOpenOffset({ scrollHeight: 3000, clientHeight: 800 }, true), 2200);
  assert.equal(pagedOpenOffset({ scrollHeight: 3000, clientHeight: 800 }, false), 0);
  assert.equal(pagedOpenOffset({ scrollHeight: 600, clientHeight: 800 }, true), 0, 'a page shorter than the screen has no foot to go to');
  const src = readFileSync(join(__dirname, '..', 'app/reader/page.tsx'), 'utf8');
  assert.match(src, /if \(d < 0 && to !== from && prefs\.pagedFitWidth\) \{\s*openAtFoot\.current = \{ slide: to, at: Date\.now\(\) \};/, 'a turn back does not mark its page');
  assert.match(src, /if \(back\) back\.scrollTop = pagedOpenOffset\(back, true\);/, 'the page is not at its foot before it glides in');
  assert.match(src, /const foot = fresh && mark!\.slide === index && \(mark!\.page === undefined \|\| mark!\.page === focus\?\.page\);/);
  assert.match(src, /if \(pane\) \{ pane\.scrollTop = pagedOpenOffset\(pane, foot\);/, 'the arrival does not read the mark');
  assert.match(src, /if \(prefs\.pagedFitWidth && idxs\.indexOf\(to\) < idxs\.indexOf\(focus\.page\)\) openAtFoot\.current = \{ slide: s, page: to, at: Date\.now\(\) \};/,
    'back to the earlier page of a pair opens it at its top');
});
