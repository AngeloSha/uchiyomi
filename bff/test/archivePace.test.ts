// The slow archive's arithmetic (#117): page gaps, breaks, backoffs and the time window.
//
// Pure functions over an injected random and clock, so ten days of archiving cost nothing here. A seeded
// generator makes every draw below reproducible: when an assertion fails it fails the same way every run,
// and a bound that holds does not hold by luck.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_DEFAULTS, PER_HOUR_RANGE, cycleMs, pageGapRange, drawGap, nextBreakMs, backoffUntil, inWindow,
  windowOpensAt, ewmaCycle, etaMs,
} from '../src/lib/archivePace';

/** mulberry32: a small seeded generator, uniform over [0, 1). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;

test('the defaults are the approved ones', () => {
  assert.equal(ARCHIVE_DEFAULTS.perHour, 4);
  assert.deepEqual(ARCHIVE_DEFAULTS.pageGapMs, [1500, 4000]);
  assert.equal(ARCHIVE_DEFAULTS.minBreakMs, 45_000);
  assert.equal(ARCHIVE_DEFAULTS.longBreakChance, 0.1);
  assert.deepEqual(ARCHIVE_DEFAULTS.longBreakMs, [20 * MIN, 45 * MIN]);
  assert.deepEqual(PER_HOUR_RANGE, [1, 30]);
  assert.equal(cycleMs(4), 15 * MIN, 'four an hour is one every fifteen minutes');
  assert.equal(cycleMs(0), 1 * HOUR, 'clamped to the range, never a division by zero');
  assert.equal(cycleMs(1000), 2 * MIN);
  assert.equal(cycleMs(NaN), 15 * MIN, 'unreadable is the default');
});

test('ARCHIVE_PAGE_GAP_MS is read at call time, and a typo never makes the archive faster', () => {
  assert.deepEqual(pageGapRange({}), [1500, 4000]);
  assert.deepEqual(pageGapRange({ ARCHIVE_PAGE_GAP_MS: '' }), [1500, 4000]);
  assert.deepEqual(pageGapRange({ ARCHIVE_PAGE_GAP_MS: '2000,6000' }), [2000, 6000]);
  assert.deepEqual(pageGapRange({ ARCHIVE_PAGE_GAP_MS: ' 6000 , 2000 ' }), [2000, 6000], 'either order');
  assert.deepEqual(pageGapRange({ ARCHIVE_PAGE_GAP_MS: '3000' }), [3000, 3000], 'one number is a fixed gap');
  assert.deepEqual(pageGapRange({ ARCHIVE_PAGE_GAP_MS: '0,0' }), [0, 0], 'the e2e rig may ask for no gap');
  for (const bad of ['fast', '1500,', '-1,4000', '1,2,3', '1500;4000']) {
    assert.deepEqual(pageGapRange({ ARCHIVE_PAGE_GAP_MS: bad }), [1500, 4000], `"${bad}" falls back to the default`);
  }
  // The returned range is a copy: a caller that mutates it must not change the defaults for everyone.
  pageGapRange({})[0] = 1;
  assert.deepEqual(ARCHIVE_DEFAULTS.pageGapMs, [1500, 4000]);
});

test('each page gap is a fresh draw inside the range, never below the floor', () => {
  // Reintroduce by returning the constant `lo` from drawGap: every draw is 1500 and the `distinct values`
  // assertion fails with 1 -- the metronome the jitter exists to break up.
  const rand = seeded(117);
  const draws = Array.from({ length: 1000 }, () => drawGap([1500, 4000], 0, rand));
  assert.ok(draws.every((g) => g >= 1500 && g <= 4000), 'inside [1500, 4000]');
  const distinct = new Set(draws).size;
  assert.ok(distinct > 100, `a fresh draw per page: more than 100 distinct values in 1000, got ${distinct}`);
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(Math.abs(mean - 2750) < 100, `uniform: mean near 2750 ms, got ${mean}`);

  // The floor is the gap the chapter would have run at anyway: jitter only ever slows it down.
  const floored = Array.from({ length: 200 }, () => drawGap([1500, 4000], 3000, rand));
  assert.ok(floored.every((g) => g >= 3000 && g <= 4000), 'a 3000 ms floor lifts the low end only');
  assert.ok(new Set(floored).size > 20, 'and still varies above it');
  assert.ok(Array.from({ length: 50 }, () => drawGap([1500, 4000], 6000, rand)).every((g) => g === 6000),
    'a floor above the whole range is the gap');
  assert.equal(drawGap([1500, 4000], 0, () => 0.9999999), 4000, 'never past the top');
  assert.equal(drawGap([1500, 4000], 0, () => 0), 1500);
});

test('a break is never under 45 s, even after a chapter that overran its whole cycle', () => {
  // Reintroduce by dropping the minBreak floors in nextBreakMs (`base = cycle - chapter - longBudget`,
  // `short = base * jitter`): a 10-minute chapter at 30 an hour has a negative budget, and the `at least
  // 45 s` assertion fails with a break below zero -- the next chapter straight after, back to back.
  const rand = seeded(45);
  let least = Infinity;
  for (let i = 0; i < 2000; i++) {
    const b = nextBreakMs({ perHour: 30, chapterMs: 10 * MIN, rand });
    least = Math.min(least, b.ms);
  }
  assert.ok(least >= 45_000, `at least 45 s between chapters, got ${least} ms`);
  // A test knob may lower it, never below zero.
  const knob = nextBreakMs({ perHour: 30, chapterMs: 10 * MIN, rand: () => 0.99, minBreakMs: 50 });
  assert.ok(knob.ms >= 50 && knob.ms < 1000, `the e2e knob shortens the floor, got ${knob.ms}`);
});

test('the short break is the budget left over, jittered by half either way', () => {
  // Four an hour with a 4-minute chapter: 15 min - 4 min - the long breaks' average share (10% of 32.5 min)
  // = 465 s, jittered to [232.5 s, 697.5 s].
  const at = (r: number) => nextBreakMs({ perHour: 4, chapterMs: 4 * MIN, rand: (() => { let n = 0; return () => (n++ === 0 ? r : 0.5); })() });
  assert.deepEqual(at(0), { ms: 232_500, long: false, longMs: 0 });
  assert.deepEqual(at(0.5), { ms: 465_000, long: false, longMs: 0 });
  assert.equal(at(0.999).ms, Math.round(465_000 * 1.499));
});

test('long breaks come about one chapter in ten, 20 to 45 minutes each, on top of the short break', () => {
  const rand = seeded(2045);
  const longs: number[] = [];
  const N = 10_000;
  for (let i = 0; i < N; i++) {
    const b = nextBreakMs({ perHour: 4, chapterMs: 4 * MIN, rand });
    if (b.long) {
      longs.push(b.longMs);
      assert.ok(b.ms > b.longMs, 'the short break is still taken');
    } else {
      assert.equal(b.longMs, 0);
    }
  }
  const share = longs.length / N;
  assert.ok(share > 0.08 && share < 0.12, `about 10% long, got ${(share * 100).toFixed(1)}%`);
  assert.ok(longs.every((ms) => ms >= 20 * MIN && ms <= 45 * MIN), 'each long break between 20 and 45 minutes');
  assert.ok(Math.min(...longs) < 22 * MIN && Math.max(...longs) > 43 * MIN, 'spread across the range, not clustered');
});

test('over ten thousand chapters the rate comes out at chapters-an-hour', () => {
  // The short breaks pay for the long ones' average share, and a long break is taken ON TOP of a short one,
  // so the expected cycle is exactly the configured one. Reintroduce by dropping `- longBudget` from the
  // short-break base: every chapter also pays the long breaks' share twice, four an hour comes out near 3.3,
  // and the `within 5%` assertion fails.
  for (const [perHour, chapterMs, seed] of [[4, 4 * MIN, 1], [10, 1 * MIN, 2], [2, 10 * MIN, 3]]) {
    const rand = seeded(seed);
    const N = 10_000;
    let total = 0;
    for (let i = 0; i < N; i++) total += chapterMs + nextBreakMs({ perHour, chapterMs, rand }).ms;
    const rate = N / (total / HOUR);
    assert.ok(Math.abs(rate - perHour) / perHour < 0.05,
      `${perHour} an hour with ${chapterMs / MIN}-minute chapters: within 5%, got ${rate.toFixed(2)}`);
  }
});

test('a refusal backs off 1 h, 3 h, 12 h, then a day, and never ends inside the site\'s own cooldown', () => {
  // Reintroduce by returning `now + step` without the max over blocked_until: the cooldown that outlasts the
  // first rung is ignored, and the `not before the cooldown ends` assertion fails an hour early.
  const now = Date.UTC(2026, 8, 27, 12);
  assert.equal(backoffUntil(1, null, now), now + 1 * HOUR);
  assert.equal(backoffUntil(2, null, now), now + 3 * HOUR);
  assert.equal(backoffUntil(3, null, now), now + 12 * HOUR);
  assert.equal(backoffUntil(4, null, now), now + 24 * HOUR);
  assert.equal(backoffUntil(9, null, now), now + 24 * HOUR, 'the last rung repeats');
  assert.equal(backoffUntil(0, null, now), now, 'no refusals, no wait');

  const cooldown = new Date(now + 2 * HOUR);
  assert.equal(backoffUntil(1, cooldown, now), now + 2 * HOUR, 'not before the cooldown ends');
  assert.equal(backoffUntil(1, +cooldown, now), now + 2 * HOUR, 'as a Date or as ms');
  assert.equal(backoffUntil(2, cooldown, now), now + 3 * HOUR, 'and a longer rung still wins');
  assert.equal(backoffUntil(1, new Date(now - HOUR), now), now + HOUR, 'a cooldown already over changes nothing');

  assert.equal(backoffUntil(3, null, now, 'down'), now + 30 * MIN, 'down is a flat half hour, whatever the level');
  assert.equal(backoffUntil(3, cooldown, now, 'down'), now + 2 * HOUR, 'and still waits out a cooldown');
});

test('the time window: NULL is any time, and a window may cross midnight', () => {
  // Reintroduce by treating every window as `hour >= from && hour < to`: 22-6 then never matches anything
  // (no hour is both >= 22 and < 6) and the `23:00 is inside 22-6` assertion fails.
  for (let h = 0; h < 24; h++) {
    assert.equal(inWindow(h, null, null), true, `${h}:00 with no window`);
    assert.equal(inWindow(h, 22, null), true, 'one end missing is no window');
    assert.equal(inWindow(h, 5, 5), true, 'a window with no length would never open: treated as any time');
  }
  const night = (h: number) => inWindow(h, 22, 6);
  assert.equal(night(22), true, '22:00 opens 22-6');
  assert.equal(night(23), true, '23:00 is inside 22-6');
  assert.equal(night(0), true, 'past midnight');
  assert.equal(night(5), true, '05:59 is still inside');
  assert.equal(night(6), false, '06:00 closes it');
  assert.equal(night(12), false);
  assert.equal(night(21), false, 'an hour before it opens');

  const day = (h: number) => inWindow(h, 9, 17);
  assert.deepEqual([8, 9, 16, 17].map(day), [false, true, true, false], 'a same-day window is [from, to)');
  assert.deepEqual([0, 1, 12, 23].map((h) => inWindow(h, 0, 1)), [true, false, false, false], 'the first hour only');
});

test('a closed window says when it opens, by the local clock', () => {
  // Built from local dates, so it holds in any TZ the suite runs in.
  const at = (d: number, h: number, m = 0, ms = 0) => new Date(2026, 8, d, h, m, 0, ms).getTime();
  assert.equal(windowOpensAt(at(27, 12, 30), 22), at(27, 22), 'later today');
  assert.equal(windowOpensAt(at(27, 12, 30), 6), at(28, 6), 'already passed today: tomorrow');
  assert.equal(windowOpensAt(at(27, 12, 30), 12), at(28, 12), 'the same hour, half an hour in: tomorrow');
  assert.equal(windowOpensAt(at(27, 22), 22), at(27, 22), 'exactly on the hour is now');
  assert.equal(windowOpensAt(at(27, 22, 0, 1), 22), at(28, 22), 'a millisecond after is tomorrow');
  assert.equal(windowOpensAt(at(30, 23, 59), 0), new Date(2026, 9, 1, 0).getTime(), 'across a month end');
  // The clock is the argument: nothing here reads Date.now().
  assert.equal(windowOpensAt(0, 0) >= 0, true);
});

test('the running cycle follows real chapters, and one long wait cannot swamp it', () => {
  // Reintroduce by dropping the 3x cap in ewmaCycle: the night-long sample moves the average to about
  // 2.9 hours and the `capped at three cycles` assertion fails.
  const cfg = 15 * MIN;
  assert.equal(ewmaCycle(null, 20 * MIN, cfg), 20 * MIN, 'the first sample is the average');
  assert.equal(ewmaCycle(0, 20 * MIN, cfg), 20 * MIN);
  assert.equal(ewmaCycle(15 * MIN, 25 * MIN, cfg), 17 * MIN, 'a fifth of the way towards each new sample');
  const afterNight = ewmaCycle(15 * MIN, 14 * HOUR, cfg);
  assert.equal(afterNight, Math.round(15 * MIN + 0.2 * (45 * MIN - 15 * MIN)), 'capped at three cycles');
  assert.equal(ewmaCycle(null, 14 * HOUR, cfg), 45 * MIN, 'the first sample is capped too');
  assert.equal(ewmaCycle(15 * MIN, -5, cfg), Math.round(15 * MIN * 0.8), 'a clock that went backwards counts as 0');
});

test('an ETA counts the turns the other series on the source take', () => {
  assert.equal(etaMs({ left: 100, sharing: 1, cycleMs: 15 * MIN }), 25 * HOUR);
  assert.equal(etaMs({ left: 100, sharing: 3, cycleMs: 15 * MIN }), 75 * HOUR, 'three series take turns');
  assert.equal(etaMs({ left: 0, sharing: 3, cycleMs: 15 * MIN }), 0);
  assert.equal(etaMs({ left: 10, sharing: 0, cycleMs: 15 * MIN }), 150 * MIN, 'it is always at least itself');
});
