// The per-source pace level: raised by every 429, lowered by nothing but time.
//
// Pure arithmetic over an injected clock, so ten quiet minutes cost nothing here. What it pins is the
// shape the downloader relies on: a level that persists past the chapter that earned it, a ceiling, a
// declared gap of zero that still slows down, and a decay that is lazy and stepwise.
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteRateLimited, paceLevel, paceFor, clearPace, setPaceClock, PACE_MAX_LEVEL, PACE_DECAY_MS, MAX_PAGE_GAP_MS,
  pagePace, slowPace, withSlowPace, resumePace, rateKeyOf,
} from '../src/lib/pace';
import { drawGap } from '../src/lib/archivePace';
import { registerAdapter, unregisterAdapter } from '../src/lib/sources/loader';
import { makeMangadex } from '../src/lib/sources/mangadex';

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
  // nothing exported lowers a level except the clock and the tests-only clearPace(). (withSlowPace only
  // ever slows a download further, and only inside its own scope; rateKeyOf only says whose level it is.)
  noteRateLimited(plain.id);
  const before = paceLevel(plain.id);
  assert.equal(before, 1);
  const exported = Object.keys(require('../src/lib/pace')).sort();
  assert.deepEqual(exported, ['MAX_PAGE_GAP_MS', 'PACE_DECAY_MS', 'PACE_MAX_LEVEL', 'clearPace', 'noteRateLimited', 'paceFor', 'paceLevel', 'pagePace', 'rateKeyOf', 'resumePace', 'setPaceClock', 'slowPace', 'withSlowPace']);
  clearPace();
  assert.equal(paceLevel(plain.id), 0, 'clearPace is for tests');
});

// ── withSlowPace: the slow archive's own pace (#117) ────────────────────────────────────────────────────

const SLOW = { pageGapMs: [1500, 4000] as [number, number] };

test('outside withSlowPace, pagePace is paceFor exactly', () => {
  // The archive's override must not leak into anyone else's download. Reintroduce by keeping the slow pace
  // in a module-level variable instead of the AsyncLocalStorage (set on entry, never cleared): after the
  // withSlowPace call below returns it is still in force, and the `nothing in force once the call
  // returned` assertion fails -- as would `exactly as declared`, with the Suwayomi source one wide.
  withSlowPace(SLOW, () => pagePace(ext, DEFAULTS));
  assert.equal(slowPace(), undefined, 'nothing in force once the call returned');
  assert.deepEqual(pagePace(ext, DEFAULTS), paceFor(ext, DEFAULTS), 'Suwayomi: exactly as declared');
  assert.deepEqual(pagePace(ext, DEFAULTS), { gap: 0, workers: 4, level: 0 });
  assert.deepEqual(pagePace(plain, DEFAULTS), { gap: 250, workers: 1, level: 0 });
  noteRateLimited(plain.id);
  assert.deepEqual(pagePace(plain, DEFAULTS), paceFor(plain, DEFAULTS), 'and slowed, the same as paceFor');
});

test('inside withSlowPace: one worker, and Suwayomi\'s gap 0 gives way to the range', () => {
  // Reintroduce by returning `pace.workers` from pagePace under a slow pace: the Suwayomi declaration keeps
  // its four workers and the `one wide` assertion fails with 4.
  withSlowPace(SLOW, () => {
    assert.deepEqual(slowPace()?.pageGapMs, [1500, 4000]);
    const p = pagePace(ext, DEFAULTS);
    assert.equal(p.workers, 1, 'one wide, whatever the adapter declares');
    assert.deepEqual(p.jitter, [1500, 4000], 'a declared gap of 0 is overridden by the range');
    assert.equal(p.gap, 1500, 'and the fixed gap is its low end');
  });
});

test('inside withSlowPace the adapter\'s own gap, or a pace level, is still a floor', () => {
  // The archive is meant to be slower than anything else, never faster. Reintroduce by using the range as
  // given (`jitter = s.pageGapMs`): the adapter that declares 3000 ms gets draws from 1500, and the `never
  // below its own gap` assertion fails.
  withSlowPace(SLOW, () => {
    assert.deepEqual(pagePace({ id: 'own', pageGapMs: 3000 }, DEFAULTS).jitter, [3000, 4000], 'never below its own gap');
    assert.deepEqual(pagePace({ id: 'own', pageGapMs: 6000 }, DEFAULTS).jitter, [6000, 6000], 'a gap above the range is the gap');
    for (let i = 0; i < 4; i++) noteRateLimited(plain.id); // level 4: 250 x 16 is over the ceiling
    assert.deepEqual(pagePace(plain, DEFAULTS), { gap: MAX_PAGE_GAP_MS, workers: 1, level: 4, jitter: [MAX_PAGE_GAP_MS, MAX_PAGE_GAP_MS] },
      'a slowed source keeps its doubled gap');
  });
});

test('the slow pace follows the chapter across awaits and timers, and each caller has its own', async () => {
  // AsyncLocalStorage, not a flag: a person's download that interleaves with the archive's must run at its
  // own pace. Reintroduce the module-level variable of the first test here: the plain download started
  // alongside reads the archive's range and the `has none` assertion fails.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const seen: Array<[string, unknown]> = [];
  await Promise.all([
    withSlowPace(SLOW, async () => {
      await sleep(5);
      seen.push(['archive', pagePace(ext, DEFAULTS).jitter]);
    }),
    (async () => {
      await sleep(1);
      seen.push(['person', pagePace(ext, DEFAULTS).jitter]);
    })(),
  ]);
  assert.deepEqual(new Map(seen).get('archive'), [1500, 4000], 'the archive keeps its pace after an await');
  assert.equal(new Map(seen).get('person'), undefined, 'the download alongside has none');
  const rand = () => 0.25;
  withSlowPace({ pageGapMs: [10, 20], rand }, () => assert.equal(pagePace(ext, DEFAULTS).rand, rand, 'a test may inject the draws'));
});

test('a 429 inside a chapter never makes the rest of it faster', () => {
  // fetchPages' resume loop doubles each gap up to MAX_PAGE_GAP_MS. A gap that already sat above the ceiling
  // -- an ARCHIVE_PAGE_GAP_MS of 5-8 s, an adapter that declares 6 s -- must stay where it was, or the resume
  // after a refusal is the FAST part. Reintroduce by doubling with `Math.min(g * 2, MAX_PAGE_GAP_MS)` in
  // resumePace: [5000, 8000] comes back as [4000, 4000] and the `never below` assertion fails.
  assert.deepEqual(resumePace({ gap: 5000, jitter: [5000, 8000] }), { gap: 5000, jitter: [5000, 8000] }, 'never below where it was');
  assert.deepEqual(resumePace({ gap: 6000, jitter: [6000, 6000] }), { gap: 6000, jitter: [6000, 6000] }, 'an adapter\'s own 6 s stays 6 s');
  assert.deepEqual(resumePace({ gap: 6000 }), { gap: 6000 }, 'and so does a plain download\'s');
  // Below the ceiling it doubles, as before; a declared 0 stays 0 inside the chapter (the engine paces it).
  assert.deepEqual(resumePace({ gap: 250 }), { gap: 500 });
  assert.deepEqual(resumePace({ gap: 3000 }), { gap: MAX_PAGE_GAP_MS });
  assert.deepEqual(resumePace({ gap: 0 }), { gap: 0 });
  assert.deepEqual(resumePace({ gap: 20, jitter: [20, 40] }), { gap: 40, jitter: [40, 80] }, 'both ends doubled');
  // Whatever goes in, neither end ever comes out lower.
  for (const [lo, hi] of [[0, 0], [100, 100], [1500, 4000], [3000, 4000], [3900, 4100], [4000, 9000], [7000, 7000]] as const) {
    const out = resumePace({ gap: lo, jitter: [lo, hi] });
    assert.ok(out.gap >= lo && out.jitter![0] >= lo && out.jitter![1] >= hi, `[${lo}, ${hi}] came back as [${out.jitter}]`);
    assert.ok(out.jitter![0] <= out.jitter![1]);
  }
});

test('at the ceiling a range keeps a spread, so the rest of the chapter is not a metronome', () => {
  // Doubling alone takes the default range to [3000, 4000] after one 429 and to [4000, 4000] after two: every
  // page exactly four seconds apart for the rest of the chapter. Reintroduce by returning [up(lo), top] from
  // resumePace: the second 429's range is [4000, 4000] and the `keeps a spread` assertion fails.
  const once = resumePace({ gap: 1500, jitter: [1500, 4000] });
  assert.deepEqual(once.jitter, [3000, 4000], 'the low end doubles');
  const twice = resumePace(once);
  assert.deepEqual(twice.jitter, [3000, 4000], 'keeps a spread of a quarter of the top');
  assert.deepEqual(resumePace(twice).jitter, [3000, 4000], 'and settles there');
  assert.deepEqual(resumePace({ gap: 3500, jitter: [3500, 4000] }).jitter, [3500, 4000], 'a narrower range keeps its own width');
  assert.deepEqual(resumePace({ gap: 2000, jitter: [2000, 2000] }).jitter, [MAX_PAGE_GAP_MS, MAX_PAGE_GAP_MS], 'a fixed gap stays a fixed gap');
});

test('after 429s at the ceiling the pages still draw their own gaps, never below the last ones', () => {
  // What fetchPages does with the resumed pace: every page is drawGap(jitter, gap), and the gap is a floor under
  // the draw, so a range alone proves nothing. Reintroduce by doubling `gap` on its own beside the range in
  // resumePace (`gap: up(p.gap)`): after two 429s from the default range it is 4000 beside [3000, 4000], every
  // page draws exactly 4000, and the `not all equal` assertion fails.
  let k = 0;
  const rand = () => (k++ % 1000) / 1000;
  let pace: { gap: number; jitter?: [number, number] } = { gap: 1500, jitter: [1500, 4000] };
  for (let n = 1; n <= 3; n++) {
    const was = Math.max(pace.gap, pace.jitter![0]);
    pace = resumePace(pace);
    const draws = Array.from({ length: 1000 }, () => drawGap(pace.jitter!, pace.gap, rand));
    const min = Math.min(...draws);
    const max = Math.max(...draws);
    assert.ok(new Set(draws).size > 100, `after ${n} 429s: ${JSON.stringify(pace)} draws ${min}..${max}, not all equal`);
    assert.ok(min >= was, `after ${n} 429s: a page drew ${min} ms, below the ${was} ms it was at`);
    assert.ok(max <= MAX_PAGE_GAP_MS, `after ${n} 429s: a page drew ${max} ms, above the ceiling`);
  }
});

test('a 429 in one MangaDex language slows every MangaDex language: the level belongs to the rate group', (t) => {
  // v0.52.0 (#123): MangaDex in Spanish and in Portuguese are two adapters and one site to its rate limit.
  // Reintroduce by keying the level on the source id again (drop rateKeyOf in noteRateLimited/paceLevel):
  // Portuguese reads 0 after Spanish's 429.
  const langs = ['es-419', 'pt-BR'].map(makeMangadex);
  for (const a of langs) registerAdapter(a);
  t.after(() => { for (const a of langs) unregisterAdapter(a.id); });
  noteRateLimited('mangadex-es-419');
  assert.equal(paceLevel('mangadex-pt-br'), 1, 'Portuguese did not slow down after Spanish was refused');
  assert.equal(rateKeyOf('mangadex-pt-br'), 'mangadex');
  assert.deepEqual(paceFor({ id: 'mangadex-pt-br' }, DEFAULTS), { gap: 500, workers: 1, level: 1 }, "the downloader's pace reads it");
  // Anything else keeps a level of its own, registered or not.
  assert.equal(paceLevel(plain.id), 0);
  assert.equal(rateKeyOf('not-registered'), 'not-registered');
});
