// The hero's position dots, once there are more slides than room for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dotWindow } from '../lib/carousel';

test('a short carousel shows every dot', () => {
  assert.deepEqual(dotWindow(3, 1).items, [0, 1, 2]);
  assert.equal(dotWindow(3, 1).moreBefore, false);
  assert.equal(dotWindow(3, 1).moreAfter, false);
});

test('THE OVERFLOW: the dot row is a fixed width whatever the slide count', () => {
  // The hero went from 5 slides to 10. One dot per slide put ~130px of dots on the same row as a padded
  // button inside a padded container, and the browser suite fails Discover on any horizontal overflow at
  // phone width. A window decouples slide count from layout entirely.
  //
  // Reintroduce by returning every index regardless of `total`: the length assertion below fails at once.
  for (const active of [0, 3, 7, 9]) {
    assert.equal(dotWindow(10, active).items.length, 5, `active=${active} drew a different number of dots`);
  }
  assert.equal(dotWindow(40, 20).items.length, 5, 'forty slides must still draw five dots');
});

test('the window never runs off either end', () => {
  // Reintroduce by dropping the clamp (`Math.min(..., total - max)`): active=9 yields [7,8,9,10,11], and
  // indices 10 and 11 do not exist, so the hero would crash reading slides[k].title.
  const first = dotWindow(10, 0);
  assert.deepEqual(first.items, [0, 1, 2, 3, 4]);
  assert.equal(first.moreBefore, false, 'nothing precedes the first slide');
  assert.equal(first.moreAfter, true);

  const last = dotWindow(10, 9);
  assert.deepEqual(last.items, [5, 6, 7, 8, 9]);
  assert.equal(last.moreAfter, false, 'nothing follows the last slide');
  assert.equal(last.moreBefore, true);

  for (const active of [0, 1, 5, 8, 9]) {
    for (const k of dotWindow(10, active).items) {
      assert.ok(k >= 0 && k < 10, `active=${active} produced out-of-range index ${k}`);
    }
  }
});

test('the window follows the active slide once it leaves the middle', () => {
  assert.deepEqual(dotWindow(10, 5).items, [3, 4, 5, 6, 7]);
  assert.ok(dotWindow(10, 5).items.includes(5), 'the active slide must always have a dot');
  for (let a = 0; a < 10; a++) assert.ok(dotWindow(10, a).items.includes(a), `active ${a} had no dot`);
});

test('THE INVISIBLE CHANGE: a wide viewport shows every slide it has room for', () => {
  // The hero went from 5 slides to 10 and looked identical, because the window was capped at 5 on every
  // screen size. The overflow it guards against is a phone problem: at desktop width there is room for all
  // ten, and hiding them there threw away the only visible sign that the change had shipped.
  //
  // Reintroduce by passing the same `max` regardless of viewport: the desktop assertion drops back to 5.
  const desktop = dotWindow(10, 0, 12);
  assert.equal(desktop.items.length, 10, 'a wide viewport should show all ten dots');
  assert.equal(desktop.moreBefore, false);
  assert.equal(desktop.moreAfter, false);

  // ...and the phone bound is unchanged, which is the half that must not regress.
  assert.equal(dotWindow(10, 0, 5).items.length, 5, 'a phone must still cap the row');
});

test('the window honours whatever bound it is given', () => {
  for (const max of [3, 5, 7, 12]) {
    assert.equal(dotWindow(40, 20, max).items.length, max, `max=${max} was not respected`);
    for (const k of dotWindow(40, 20, max).items) assert.ok(k >= 0 && k < 40);
  }
});

test('THE VACUOUS-GUARD TRAP: the hero must ask for a viewport-dependent bound', () => {
  // Testing dotWindow(10, 0, 12) proves the FUNCTION can show ten dots. It proves nothing about whether the
  // hero ever asks for ten, and the bug was entirely in the asking: the component passed a hardcoded 5, so
  // going from five slides to ten looked identical on every screen. The first version of this guard tested
  // only the function and passed happily with the bug reintroduced.
  //
  // Static check, because the invariant is about the call site. Reintroduce by hardcoding the third
  // argument in DiscoverHero.tsx and this fails immediately.
  const hero = readFileSync(join(__dirname, '..', 'components', 'DiscoverHero.tsx'), 'utf8');
  const at = hero.indexOf('dotWindow(');
  assert.ok(at > 0, 'the hero no longer uses dotWindow');
  const args = hero.slice(at + 'dotWindow('.length, hero.indexOf(')', at));
  assert.match(
    args,
    /wide/,
    `the hero asks for a fixed dot window (\`${args}\`), so a phone's limit is imposed on desktop too and ` +
    'extra slides stay invisible',
  );
});
