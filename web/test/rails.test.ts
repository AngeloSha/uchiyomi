// A horizontal rail has to be movable with the input the reader actually has.
//
// Discover's two rails were `hide-scrollbar … overflow-x-auto`. On a phone or a trackpad that is fine, which
// is why it survived review; on a desktop mouse it left NO input at all. The bar was deleted by that class,
// Lenis's smooth wheel swallows a vertical wheel over a horizontal-only scroller, and there were no arrows.
// The reported symptom was "there is no scroll bar underneath it to move to the side and see the rest".
//
// Read from source rather than driven in a browser on purpose: the trending rail only renders when AniList
// answers, so a browser assertion about it would be a test that depends on a third party being up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every className string in a file, so a rail's classes can be inspected without parsing JSX. */
const classNames = (src: string): string[] =>
  [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);

test("Discover's rails do not hide their own scrollbar", () => {
  for (const file of ['app/discover/page.tsx', 'components/SourcePicker.tsx', 'components/ScrollRail.tsx']) {
    const src = read(file);
    const hiding = classNames(src).filter((c) => c.includes('hide-scrollbar'));
    assert.deepEqual(hiding, [], `${file} still hides a scrollbar: ${hiding.join(' | ')}`);
  }
});

test('the rail goes through ScrollRail, and leaves room for the bar', () => {
  // globals.css styles the bar at 8px, so anything under pb-2 puts it on top of the content above it.
  const MIN_PB = 3; // Tailwind pb-3 = 0.75rem = 12px
  let rails = 0;
  // SourcePicker used to carry a second rail, the language strip. That whole dimension was removed after it
  // turned out to be the trigger for a wall that stalled mid-load, so the trending rail is the only one left.
  for (const file of ['app/discover/page.tsx']) {
    const src = read(file);
    assert.ok(src.includes('<ScrollRail'), `${file} has no ScrollRail — is a rail still hand-rolled?`);
    // No raw overflow-x-auto left behind: that is the shape that had the problem.
    const raw = classNames(src).filter((c) => c.includes('overflow-x-auto'));
    assert.deepEqual(raw, [], `${file} still has a hand-rolled horizontal scroller: ${raw.join(' | ')}`);

    for (const m of src.matchAll(/<ScrollRail[\s\S]*?className="([^"]*)"/g)) {
      rails++;
      const pb = /(?:^|\s)pb-(\d+(?:\.\d+)?)/.exec(m[1]);
      assert.ok(pb, `a rail in ${file} has no bottom padding, so the scrollbar sits on its content`);
      assert.ok(
        Number(pb![1]) >= MIN_PB,
        `a rail in ${file} has pb-${pb![1]}; the 8px scrollbar needs at least pb-${MIN_PB}`,
      );
    }
  }
  assert.equal(rails, 1, `expected the trending rail, found ${rails}`);
});

test('the arrows exist, are desktop-only, and mirror under RTL', () => {
  const src = read('components/ScrollRail.tsx');
  assert.ok(/scrollBy\(/.test(src), 'the arrows do not scroll anything');
  assert.ok(/hidden[\s\S]{0,200}lg:grid/.test(src), 'the arrows are not hidden on touch viewports');
  assert.ok(/disabled=\{ends\.(start|end)\}/.test(src), 'the arrows are never disabled at the ends');

  // scrollBy({left}) is a PHYSICAL delta: it does not mirror under dir="rtl", where scrollLeft runs from 0
  // down to -(scrollWidth - clientWidth). This app mirrors fully, so the sign has to come from the computed
  // direction. Getting this wrong makes both arrows dead in Arabic, which is silent.
  assert.ok(/direction === 'rtl'/.test(src), 'the scroll direction is not mirrored for RTL');
  assert.ok(/rtl \? -1 : 1/.test(src), 'the RTL sign flip is missing from the scroll delta');
  assert.ok(/Math\.abs\(el\.scrollLeft\)/.test(src), 'the end detection will be wrong under RTL (negative scrollLeft)');
});
