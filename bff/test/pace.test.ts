// The per-source pace level: raised by every 429, lowered by nothing but time.
//
// Pure arithmetic over an injected clock, so ten quiet minutes cost nothing here. What it pins is the
// shape the downloader relies on: a level that persists past the chapter that earned it, a ceiling, a
// declared gap of zero that still slows down, and a decay that is lazy and stepwise.
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteRateLimited, paceLevel, paceFor, clearPace, setPaceClock, PACE_MAX_LEVEL, PACE_DECAY_MS, MAX_PAGE_GAP_MS,
} from '../src/lib/pace';

let now = 1_000_000;
beforeEach(() => { now = 1_000_000; setPaceClock(() => now); clearPace(); });
after(() => { setPaceClock(null); clearPace(); });

const plain = { id: 'src-plain' }; // declares nothing: every engine and pack site
const ext = { id: 'src-ext', pageGapMs: 0, pageConcurrency: 4 }; // the Suwayomi adapter's declaration
const DEFAULTS = { gapMs: 250 };

test('a source that has never answered 429 runs at exactly what it declared', () => {
  assert.equal(paceLevel(plain.id), 0);
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: 250, workers: 1, level: 0 });
  assert.deepEqual(paceFor(ext, DEFAULTS), { gap: 0, workers: 4, level: 0 });
  assert.deepEqual(paceFor({ id: 'x', pageGapMs: 30, pageConcurrency: 2 }, DEFAULTS), { gap: 30, workers: 2, level: 0 });
});

test('a declared pool width is clamped and NaN-proof at level 0', () => {
  // `Math.max(1, NaN)` is NaN, and an Array.from of NaN workers fetches nothing. Reintroduce by returning
  // `src.pageConcurrency ?? 1` unclamped from paceFor: the nonsense declaration reads NaN and 99 reads 99.
  assert.equal(paceFor({ id: 'n', pageConcurrency: Number('nonsense') }, DEFAULTS).workers, 1);
  assert.equal(paceFor({ id: 'n', pageConcurrency: 99 }, DEFAULTS).workers, 8);
  assert.equal(paceFor({ id: 'n', pageConcurrency: 0 }, DEFAULTS).workers, 1);
  assert.equal(paceFor({ id: 'n', pageConcurrency: 2.9 }, DEFAULTS).workers, 2);
});

test('every 429 raises the level by one, up to the ceiling, and the level outlives the chapter', () => {
  // Reintroduce by dropping `Math.min(PACE_MAX_LEVEL, ...)` in noteRateLimited: the sixth hit reads 6 and
  // the chapter gate is 64 times the declared gap, which is over a minute between chapters.
  noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), 1, 'one hit, one level -- and it is still there for the next chapter');
  noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), 2);
  for (let i = 0; i < 10; i++) noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), PACE_MAX_LEVEL, 'capped');
  assert.equal(PACE_MAX_LEVEL, 4);
  assert.equal(paceLevel(ext.id), 0, 'per source: the other source is untouched');
});

test('slowed, the pool is one wide and the gap doubles per level up to MAX_PAGE_GAP_MS', () => {
  // Reintroduce by returning `pace.workers` unchanged for a slowed source: the `one wide` assertion reads
  // 4, and the resume that narrowed to one worker inside the chapter is undone by the next chapter.
  noteRateLimited(ext.id);
  noteRateLimited(plain.id);
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: 500, workers: 1, level: 1 }, 'level 1: doubled, one wide');
  noteRateLimited(plain.id);
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: 1000, workers: 1, level: 2 });
  noteRateLimited(plain.id); noteRateLimited(plain.id);
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: MAX_PAGE_GAP_MS, workers: 1, level: 4 }, '250 x 16 is over the ceiling');
  assert.equal(MAX_PAGE_GAP_MS, 4000);
  assert.deepEqual(paceFor({ id: plain.id, pageGapMs: 30, pageConcurrency: 2 }, DEFAULTS), { gap: 480, workers: 1, level: 4 },
    'a declared gap is what doubles');
});

test('a declared gap of 0 falls back to the server default when slowed, because 0 x 16 is still 0', () => {
  // The Suwayomi adapter declares pageGapMs 0 (the engine paces the site). Slowed, that source has to have
  // SOME gap or "slowed" means nothing. Reintroduce by using `src.pageGapMs ?? defaults.gapMs` instead of
  // `||` in the slowed branch of paceFor: the gap reads 0 at level 1.
  noteRateLimited(ext.id);
  assert.deepEqual(paceFor(ext, DEFAULTS), { gap: 500, workers: 1, level: 1 });
});

test('ten quiet minutes take one level off, lazily, and a hit after a partial decay builds on what is left', () => {
  // Reintroduce by returning the stored entry without the `steps` computation in current(): the level
  // never comes down and a source that was rate-limited once on Monday is still crawling on Friday.
  for (let i = 0; i < 4; i++) noteRateLimited(plain.id);
  now += PACE_DECAY_MS - 1;
  assert.equal(paceLevel(plain.id), 4, 'not a full step yet');
  now += 1;
  assert.equal(paceLevel(plain.id), 3, 'one step after ten minutes');
  now += 2 * PACE_DECAY_MS + 5 * 60_000; // 25 more minutes: two whole steps, five minutes into the third
  assert.equal(paceLevel(plain.id), 1);
  noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), 2, 'a new hit raises the DECAYED level, not the original one');
  now += 2 * PACE_DECAY_MS;
  assert.equal(paceLevel(plain.id), 0, 'and it reaches zero');
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: 250, workers: 1, level: 0 }, 'back to the declaration');
});

test('decay advances the stamp rather than resetting it, so partial minutes are not lost', () => {
  // Reintroduce by storing `lastHitAt: clock()` on decay: 25 quiet minutes read as level 2 with 0 served,
  // and the next step comes at 35 minutes instead of 30.
  for (let i = 0; i < 4; i++) noteRateLimited(plain.id);
  now += 2 * PACE_DECAY_MS + 5 * 60_000; // 25 minutes: level 2, five minutes towards level 1
  assert.equal(paceLevel(plain.id), 2);
  now += 5 * 60_000; // 30 minutes in total
  assert.equal(paceLevel(plain.id), 1, 'the third step lands at 30 minutes, not 35');
});

test('a successful download does not reset the level: only time does', () => {
  // There is deliberately no "reportOk" hook here. A chapter that got through at the slower pace is
  // evidence the slower pace works, not that the fast one does. The absence is pinned by the API surface:
  // nothing exported lowers a level except the clock and the tests-only clearPace().
  noteRateLimited(plain.id);
  const before = paceLevel(plain.id);
  assert.equal(before, 1);
  const exported = Object.keys(require('../src/lib/pace')).sort();
  assert.deepEqual(exported, ['MAX_PAGE_GAP_MS', 'PACE_DECAY_MS', 'PACE_MAX_LEVEL', 'clearPace', 'noteRateLimited', 'paceFor', 'paceLevel', 'setPaceClock']);
  clearPace();
  assert.equal(paceLevel(plain.id), 0, 'clearPace is for tests');
});
