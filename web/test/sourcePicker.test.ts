// Which sources actually get fetched for the Discover wall, and in what order.
//
// This file used to also cover language grouping: which sources landed in which language chip, and how the
// chips were counted. That whole dimension is gone. It was the trigger for a stall -- switching chip mid-load
// left the page counting sources it had just forgotten, so its skeleton tiles never resolved and infinite
// scroll died for the session -- and thrashing the chips fired abandoned scrapes that each cost the server a
// full eight-second budget and then wrote a five-to-thirty-minute cooldown against the source.
//
// The ranking survived, because ranking was the half that earned its keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { budgetFor, budgetForMode, noteFor, retryIn, iconTint, Src } from '../lib/sourceGroups';

const src = (p: Partial<Src> & { id: string }): Src =>
  ({ name: p.id, lang: null, latest: true, status: 'ok', ...p }) as Src;

test('the budget prefers healthy sources, then what the library actually came from', () => {
  // In the order the server actually returns them, which resolves alphabetically -- so only the `used`
  // comparator can lift Aqua Manga above "18 Porn Comic". A pool that already listed Aqua first would pass
  // with the ranking removed entirely, because Array.sort is stable.
  const pool = [
    src({ id: 'porn18', name: '18 Porn Comic', used: 0 }),
    src({ id: 'blocked', name: 'Blocked', status: 'blocked', used: 500 }),
    src({ id: 'aqua', name: 'Aqua Manga', used: 176 }),
    src({ id: 'off', name: 'Off', status: 'disabled', used: 999 }),
    src({ id: 'universal', name: 'Universal', used: 0 }),
  ];

  // A blocked source is a guaranteed timeout for a guaranteed nothing, so it sorts last however popular it
  // is -- which at a realistic budget means it is not fetched at all. A disabled one is never fetched.
  assert.deepEqual(
    budgetFor(pool, 9).map((s) => s.id),
    ['aqua', 'porn18', 'universal', 'blocked'],
    'a disabled source was fetched, or the ordering is wrong',
  );

  const three = budgetFor(pool, 3).map((s) => s.id);
  assert.equal(three[0], 'aqua', 'the most-used source was not fetched first');
  assert.equal(three.includes('blocked'), false, 'a blocked source displaced a healthy one');
});

test('THE REGRESSION: a source the reader actually uses outranks one they never have', () => {
  // Measured on production. With "declares the chosen language" ranked above "the library came from it", the
  // English chip fetched five adult extension sources and MangaDex, while Aqua Manga -- 189 of that library's
  // 214 series -- was never among the six, because it declared no language at all. The language half is gone
  // now, but `used` is still what has to win, and this pins it.
  const picked = budgetFor([
    src({ id: 'other-1', name: 'Other One', used: 0 }),
    src({ id: 'other-2', name: 'Other Two', used: 0 }),
    src({ id: 'aqua', name: 'Aqua Manga', used: 189 }),
  ], 2).map((s) => s.id);
  assert.equal(picked[0], 'aqua', 'the source with the whole library behind it was not fetched first');
});

test('a source that cannot browse newest is never budgeted', () => {
  assert.deepEqual(
    budgetFor([src({ id: 'no-latest', latest: false }), src({ id: 'yes' })]).map((s) => s.id),
    ['yes'],
  );
});

test('THE STALL: resetting the wall must remount its children, or settled counts go stale', () => {
  // The bug this page was fixed for. `SourceLatest` reports "I have settled" from an effect, so it only fires
  // when its query state changes identity. A source present both before and after a wall reset kept its React
  // key, so it never unmounted; its cached query kept the same `data`, so the effect never re-ran; and the
  // parent had just cleared the bookkeeping. `settled` could then never reach `budget.length`, which is what
  // put skeleton tiles on screen that never resolved.
  //
  // Static guard rather than a render test: the invariant is "if the parent clears settle state, the child
  // key must change too", and today the parent simply never clears it.
  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  const clears = /setOrder\(\[\]\)|setStates\(\{\}\)|setById\(\{\}\)/.test(page);
  if (clears) {
    const key = page.match(/<SourceLatest[^>]*key=\{`([^`]+)`\}/)?.[1] ?? '';
    assert.ok(
      /gen|reset|lang|nonce/.test(key),
      `the wall clears its settle state but SourceLatest's key is \`${key}\` -- a source that survives the ` +
      'reset will keep its cached query, never re-report, and the wall will count it as never settled',
    );
  }
});

test('the wall consumes the abort signal, so abandoning a source does not cost a cooldown', () => {
  // Without reading react-query's signal, removeObserver takes its non-aborting branch: a source dropped from
  // the wall keeps scraping, the server spends its full budget on an answer nobody reads, and the resulting
  // timeout writes a multi-minute cooldown against that source. Abandoning a request made the wall worse.
  const picker = readFileSync(join(__dirname, '..', 'components', 'SourcePicker.tsx'), 'utf8');
  // Slice forward from queryFn, not to the first `enabled,` -- that matches the prop destructuring higher up
  // in the file, which made this slice run backwards and come back empty.
  const start = picker.indexOf('queryFn:');
  assert.ok(start > 0, 'SourceLatest no longer has a queryFn');
  const fn = picker.slice(start, start + 400);
  assert.match(fn, /\(\s*\{\s*signal\s*\}\s*\)\s*=>/, "queryFn does not accept react-query's signal");
  // Two mentions: once destructured from the context, once handed to api(). A regex trying to span the
  // argument list cannot -- the URL contains its own parentheses -- and a version that tried matched
  // nothing either way, which is a guard that tests nothing.
  const mentions = (fn.match(/signal/g) ?? []).length;
  assert.ok(mentions >= 2, `the signal is accepted but never passed through to api() (seen ${mentions}x)`);
});

test('THE REPORTED BUG: a broken source must not look like a quiet one', () => {
  // What prompted all of this: on Discover, "answered with nothing" and "is broken and could not answer"
  // were the same grey dot. Four of ten sources on a real install sat broken for weeks looking exactly like
  // sources that simply had no new chapters.
  //
  // Reintroduce by having `noteFor` return the same dot for `empty` whether or not a note is present.
  const broken = src({ id: 'broken', note: 'This source is blocking this server right now.' });
  const quiet = src({ id: 'quiet' });

  assert.equal(noteFor(broken, 'empty').dot, 'warn', 'a source with a reason must stand out');
  assert.equal(noteFor(quiet, 'empty').dot, 'quiet', 'a source with nothing new must not raise an alarm');
  assert.notEqual(noteFor(broken, 'empty').dot, noteFor(quiet, 'empty').dot);
  assert.equal(noteFor(broken, 'empty').note, broken.note);
  assert.equal(noteFor(quiet, 'empty').note, null);
});

test('a healthy or unasked source says nothing', () => {
  assert.deepEqual(noteFor(src({ id: 'a' }), 'ok'), { dot: 'ok', note: null });
  assert.deepEqual(noteFor(src({ id: 'a' }), 'idle'), { dot: 'idle', note: null });
});

test('a source that answers with nothing sorts below one that works', () => {
  // `quiet` is the server naming a state that used to be unrepresentable: no error was ever thrown, so no
  // cooldown was earned, so `status` stayed 'ok' and the wall kept fetching it first for weeks.
  //
  // Reintroduce by narrowing budgetFor's comparator from `status !== 'ok'` to `status === 'blocked'`:
  // 'quiet' then ties with healthy and its much larger `used` count lifts it back to the front.
  const picked = budgetFor([
    src({ id: 'drifted', status: 'quiet', used: 500 }),
    src({ id: 'works', used: 10 }),
  ], 2).map((x) => x.id);
  assert.deepEqual(picked, ['works', 'drifted'], 'a source that returns nothing was fetched first');
});

test('the cooldown is reported as a wait, not a timestamp', () => {
  const now = Date.parse('2026-08-27T09:00:00Z');
  assert.equal(retryIn(src({ id: 'a', blockedUntil: '2026-08-27T09:12:00Z' }), now), 'back in ~12 min');
  assert.equal(retryIn(src({ id: 'a', blockedUntil: '2026-08-27T08:50:00Z' }), now), null, 'an expired block is not a wait');
  assert.equal(retryIn(src({ id: 'a' }), now), null);
});

test('a source that cannot rank its own titles is not asked to', () => {
  // Popular is the source's OWN ranking, so a source without one has nothing to contribute and is dropped
  // entirely -- exactly as one without `latest` already is. Showing a chip that can never fill would be
  // worse than showing one chip fewer.
  //
  // Reintroduce by ignoring the mode in budgetForMode: 'no-pop' comes back and its column stays empty.
  const pool = [src({ id: 'both', popular: true, used: 5 }), src({ id: 'no-pop', used: 99 })];
  assert.deepEqual(budgetForMode(pool, 'newest', 9).map((s) => s.id), ['no-pop', 'both'], 'newest takes both');
  assert.deepEqual(budgetForMode(pool, 'popular', 9).map((s) => s.id), ['both'], 'popular takes only the one that can');
});

test('THE NAMESPACING: switching listing must remount the children', () => {
  // The wall keys everything by `${listMode}:${sourceId}` so the toggle never has to CLEAR anything -- and
  // clearing is the only thing that has ever broken this page. But the two halves are a pair: if the key
  // does not also change, a source present in both listings keeps its React key, keeps its cached query,
  // never re-reports, and the wall waits forever on a source it believes it has not heard from.
  //
  // Reintroduce by dropping `${listMode}` from SourceLatest's key.
  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  const key = page.match(/<SourceLatest[^>]*key=\{`([^`]+)`\}/)?.[1] ?? '';
  assert.ok(key.includes('listMode'), `SourceLatest's key is \`${key}\` and does not carry the listing mode`);
});

test('filtering shows less, it never loads less', () => {
  // Tapping a chip is display-only: every budgeted source keeps loading and nothing is discarded, which is
  // what makes it instant and what keeps it from stranding the wall. If it ever starts clearing state, the
  // guard above about remounting applies to it too.
  //
  // Reintroduce by clearing byId/order/states when a source is selected.
  const page = readFileSync(join(__dirname, '..', 'app', 'discover', 'page.tsx'), 'utf8');
  assert.doesNotMatch(page, /setOrder\(\[\]\)|setStates\(\{\}\)|setById\(\{\}\)/,
    'the wall is being cleared somewhere; see the stall guard above');
  assert.match(page, /selected && key !== /, 'the wall no longer filters by the selected source');
});

test('a source with no icon still gets a stable, deliberate colour', () => {
  const a = iconTint('Aqua Manga');
  assert.equal(a, iconTint('Aqua Manga'), 'the tile must not change colour between renders');
  assert.notEqual(a, iconTint('MangaDex'), 'two sources should not collide on one colour');
  assert.match(a, /^linear-gradient\(/);
});
