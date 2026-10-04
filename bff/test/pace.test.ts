// The per-key pace level: raised by every 429, lowered slowly -- by a steady run of chapters held an hour, or by days.
//
// Pure arithmetic over an injected clock, so an hour's hold and three idle days cost nothing here. What it pins is
// the shape the downloader relies on: a level that persists past the chapter that earned it, a ceiling, a declared gap
// of zero that still slows down, a level that comes off a step at a time and never for one good chapter, a rest every
// chapter on the key sits out, and one key for every source whose pages come from one image server (v0.55.3).
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteRateLimited, noteDownloaded, notePageHosts, paceLevel, paceFor, clearPace, setPaceClock, PACE_MAX_LEVEL, PACE_HOLD_MS,
  PACE_IDLE_MS, PACE_STEADY_RUN, MAX_PAGE_GAP_MS, pagePace, slowPace, withSlowPace, resumePace, rateKeyOf, refusedLately,
  restLeft, serverOf,
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

test('a raised level is held: quiet minutes, hours and a day take nothing off', () => {
  // v0.55.3. Ten quiet minutes used to take a level off, and Natomanga's image server -- refusing for hours once it
  // had refused -- was asked at full speed again within the hour, every night. Reintroduce the ten-minute decay
  // (PACE_IDLE_MS = 10 * 60_000): the level reads 3 after ten minutes and the `held` assertions fail.
  for (let i = 0; i < 4; i++) noteRateLimited(plain.id);
  now += 10 * 60_000;
  assert.equal(paceLevel(plain.id), 4, 'held after ten quiet minutes');
  now += 2 * 3600_000;
  assert.equal(paceLevel(plain.id), 4, 'held after two quiet hours: nothing has come down at this pace to say it works');
  now += 24 * 3600_000;
  assert.equal(paceLevel(plain.id), 4, 'held after a quiet day');
  assert.ok(PACE_IDLE_MS >= 2 * 24 * 3600_000, `a nightly run must not find the level forgotten (${PACE_IDLE_MS} ms)`);
});

test('one good chapter never brings a level down; a steady run, held an hour, takes ONE step off', () => {
  // The site let a chapter through at the slower pace, which says the slower pace works, not that the faster one would.
  // Reintroduce the step without the run (`p.run < PACE_STEADY_RUN ||` dropped): the `one chapter is not a run`
  // assertion reads 1. Reintroduce it without the hour (`now - p.since < PACE_HOLD_MS ||` dropped): the run inside the
  // hour after the first step takes a second, and `no second step inside the hour` reads 0.
  noteRateLimited(plain.id);
  noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), 2);
  now += PACE_HOLD_MS;
  noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 2, 'one chapter is not a run');
  for (let i = 1; i < PACE_STEADY_RUN - 1; i++) noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 2, `${PACE_STEADY_RUN - 1} in a row are not a run either`);
  noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 1, `the ${PACE_STEADY_RUN}th steps it down, one level`);
  // The next step needs its own hour: chapters landing at the new level count towards it, and step nothing before it.
  for (let i = 0; i < 2 * PACE_STEADY_RUN; i++) noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 1, 'no second step inside the hour after the first, however many land');
  now += PACE_HOLD_MS;
  noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 0, 'a run at this level and its own hour take the last step');
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: 250, workers: 1, level: 0 }, 'back to the declaration');
  noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 0, 'nothing at level 0');
});

test('a step spends its run: the next one needs a run of its own', () => {
  // Reintroduce by leaving `run` as it was on a step: the chapters before the first step count again for the second,
  // and the `starts again` assertion reads 0.
  for (let i = 0; i < 2; i++) noteRateLimited(plain.id);
  now += PACE_HOLD_MS;
  for (let i = 0; i < PACE_STEADY_RUN; i++) noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 1);
  now += PACE_HOLD_MS;
  for (let i = 0; i < PACE_STEADY_RUN - 1; i++) noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 1, 'the run starts again from nothing after a step');
  noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 0);
});

test('a run that is held long enough but too short, or a run with a 429 in it, takes nothing off', () => {
  // Reintroduce by carrying the run over a 429 (`run: p?.run ?? 0` in noteRateLimited): the nine chapters before the
  // refusal count after it, the tenth steps the level down, and the `a 429 starts the run again` assertion reads 1.
  noteRateLimited(plain.id);
  now += PACE_HOLD_MS;
  for (let i = 0; i < PACE_STEADY_RUN - 1; i++) noteDownloaded(plain.id);
  noteRateLimited(plain.id); // the site said no again: level 2, held from now
  assert.equal(paceLevel(plain.id), 2);
  now += PACE_HOLD_MS;
  noteDownloaded(plain.id);
  assert.equal(paceLevel(plain.id), 2, 'a 429 starts the run again');
});

test('a level nothing changes for PACE_IDLE_MS loses a step, and the stamp advances rather than resets', () => {
  // A source refused once and never asked again is not slow for good. Reintroduce `return p` in current() without the
  // idle steps: the level never comes off without downloads, and the `one step` assertion reads 4. Reintroduce
  // `p.since = clock()` on decay: a day short of the second step reads as three days from scratch.
  for (let i = 0; i < 4; i++) noteRateLimited(plain.id);
  now += PACE_IDLE_MS - 1;
  assert.equal(paceLevel(plain.id), 4, 'not a full step yet');
  now += 1;
  assert.equal(paceLevel(plain.id), 3, 'one step');
  now += PACE_IDLE_MS + 5 * 3600_000; // two steps, five hours into the third
  assert.equal(paceLevel(plain.id), 2);
  now += PACE_IDLE_MS - 5 * 3600_000;
  assert.equal(paceLevel(plain.id), 1, 'the third step lands three idle periods in, not three and five hours');
  noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), 2, 'a new hit raises the DECAYED level, not the original one');
  now += 2 * PACE_IDLE_MS;
  assert.equal(paceLevel(plain.id), 0, 'and it reaches zero');
  assert.deepEqual(paceFor(plain, DEFAULTS), { gap: 250, workers: 1, level: 0 }, 'back to the declaration');
});

test('a 429 is a rest every chapter on the key waits out, the longest asked for', () => {
  // Reintroduce by dropping `restUntil` from noteRateLimited (or restLeft's answer): a neighbour on the key reads no
  // rest and asks the refusing server again at once, and `the rest the refused chapter waits` reads 0.
  assert.equal(restLeft(plain.id), 0, 'no rest before a 429');
  noteRateLimited(plain.id, 5000);
  assert.equal(restLeft(plain.id), 5000, 'the rest the refused chapter waits');
  now += 2000;
  assert.equal(restLeft(plain.id), 3000);
  noteRateLimited(plain.id, 1000);
  assert.equal(restLeft(plain.id), 3000, 'a shorter rest never cuts a longer one');
  noteRateLimited(plain.id, 10_000);
  assert.equal(restLeft(plain.id), 10_000, 'a longer one extends it');
  now += 10_000;
  assert.equal(restLeft(plain.id), 0);
  assert.equal(restLeft(ext.id), 0, 'per key: the other source never rests');
});

test('refused lately: an hour after the 429, whatever the level says', () => {
  // The slow archive waits on this (lib/archivePlan.ts sourceWait), no longer on the level, which is held for hours and
  // comes off only as chapters land -- chapters a waiting archive would never add.
  assert.equal(refusedLately(plain.id), false);
  noteRateLimited(plain.id);
  assert.equal(refusedLately(plain.id), true);
  now += PACE_HOLD_MS - 1;
  assert.equal(refusedLately(plain.id), true);
  now += 1;
  assert.equal(refusedLately(plain.id), false, 'an hour on, no longer');
  assert.equal(paceLevel(plain.id), 1, 'while the level stays raised');
});

test('nothing but a run, the idle days and the tests lowers a level', () => {
  // The API surface: noteDownloaded is the one way down besides the clock, and it counts runs, never one success.
  // (withSlowPace only ever slows a download further, and only inside its own scope; rateKeyOf only says whose level it
  // is; notePageHosts only says which sources share one.)
  noteRateLimited(plain.id);
  assert.equal(paceLevel(plain.id), 1);
  const exported = Object.keys(require('../src/lib/pace')).sort();
  assert.deepEqual(exported, [
    'MAX_PAGE_GAP_MS', 'PACE_HOLD_MS', 'PACE_IDLE_MS', 'PACE_MAX_LEVEL', 'PACE_STEADY_RUN', 'clearPace', 'noteDownloaded',
    'notePageHosts', 'noteRateLimited', 'paceFor', 'paceLevel', 'pagePace', 'rateKeyOf', 'refusedLately', 'restLeft',
    'resumePace', 'serverOf', 'setPaceClock', 'slowPace', 'withSlowPace',
  ]);
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

// ── one image server, one key (v0.55.3) ───────────────────────────────────────────────────────────────────────────

test('an image server is its registrable domain; addresses, private names and shared hosts are none', () => {
  // The owner's two sites: Mangakakalot's pages on imgs-2.2xstorage.com, Natomanga's on img-r1.2xstorage.com and
  // storage.waitst.com (measured 2026-09-02). Reintroduce the host name itself (`return host`): the two read apart.
  assert.equal(serverOf('https://imgs-2.2xstorage.com/a/1.jpg'), '2xstorage.com', 'one CDN read as two hosts');
  assert.equal(serverOf('https://img-r1.2xstorage.com/b/2.webp'), '2xstorage.com');
  assert.equal(serverOf('https://storage.waitst.com/c/3.jpg'), 'waitst.com');
  assert.equal(serverOf('https://IMG.Site.co.uk./p.png'), 'site.co.uk', 'a country second level is a suffix; case and a trailing dot fold');
  assert.equal(serverOf('https://img.site.de:8443/p.png'), 'site.de');
  // Nothing that says whose limit it is: an image proxy or a host many sites share, an address or a container's name (the
  // walks' fake sites), a test or home domain, anything that is not a web address.
  for (const u of ['https://i0.wp.com/site.com/p.png', 'https://blogger.googleusercontent.com/img/p.png', 'https://i.imgur.com/p.png',
    'https://d1abc.cloudfront.net/p.png', 'http://127.0.0.1:18150/img/c/1', 'http://e2e-fake-a:18150/img/c/1', 'http://[::1]:80/p.png',
    'https://example.invalid/p.png', 'https://img.nas.local/p.png', 'data:image/png;base64,AAAA', 'not a url']) {
    assert.equal(serverOf(u), null, u);
  }
});

test('two sources whose pages come from one image server share one key, one level and one rest', () => {
  // Natomanga and Mangakakalot: two sites, one CDN, and each was asked at full speed while the other was being refused.
  // Reintroduce by returning `g` from rateKeyOf (no joins): the two are two keys, and `one key` fails.
  notePageHosts({ id: 'nato' }, ['https://img-r1.2xstorage.com/x/1.jpg', 'https://storage.waitst.com/x/2.jpg']);
  noteRateLimited('nato', 5000);
  assert.equal(paceLevel('kakalot'), 0, 'not joined before its pages were seen');
  notePageHosts({ id: 'kakalot' }, ['https://imgs-2.2xstorage.com/y/1.jpg', 'https://imgs-2.2xstorage.com/y/2.jpg']);
  assert.equal(rateKeyOf('nato'), rateKeyOf('kakalot'), 'one key');
  assert.equal(rateKeyOf('nato'), 'kakalot', 'the smaller of the two');
  assert.equal(paceLevel('kakalot'), 1, "Natomanga's 429 slows Mangakakalot from now on");
  assert.equal(restLeft('kakalot'), 5000, 'and rests it with Natomanga');
  noteRateLimited('kakalot');
  assert.equal(paceLevel('nato'), 2, 'and the other way round');
  // A source on another server keeps its own key and its own pace.
  notePageHosts({ id: 'other' }, ['https://cdn.othersite.com/1.jpg']);
  assert.equal(rateKeyOf('other'), 'other');
  assert.equal(paceLevel('other'), 0);
  // So does one on a host many sites share, beside one of its own.
  notePageHosts({ id: 'wp-site' }, ['https://i0.wp.com/a.com/1.jpg', 'https://cdn.othersite.com/2.jpg']);
  assert.equal(rateKeyOf('wp-site'), 'other', 'its own server joins it to the other');
  notePageHosts({ id: 'wp-two' }, ['https://i1.wp.com/b.com/1.jpg']);
  assert.equal(rateKeyOf('wp-two'), 'wp-two', 'the shared host joins nothing');
});

test('a key that joins another brings its level: the slower of the two, held from the later change', () => {
  // Reintroduce by dropping the move in joined() (`paces.delete(g)` and the merge): a-src's level 3 stays under its old
  // key, which nothing reads any more, and the joint key reads b-src's level 1.
  for (let i = 0; i < 3; i++) noteRateLimited('a-src');
  now += 30 * 60_000;
  noteRateLimited('b-src');
  notePageHosts({ id: 'a-src' }, ['https://p.sharedcdn.net/1.jpg']);
  notePageHosts({ id: 'b-src' }, ['https://q.sharedcdn.net/1.jpg']);
  assert.equal(paceLevel('b-src'), 3, 'the slower of the two');
  assert.equal(paceLevel('a-src'), 3);
  now += PACE_HOLD_MS - 1;
  for (let i = 0; i < PACE_STEADY_RUN; i++) noteDownloaded('a-src');
  assert.equal(paceLevel('a-src'), 3, "held from b-src's 429, the later of the two");
  now += 1;
  noteDownloaded('a-src');
  assert.equal(paceLevel('a-src'), 2);
});

test("a proxy's pages join nothing: every extension's pages are on the engine", () => {
  // Reintroduce by dropping the `pagesProxied` return in notePageHosts: two extensions on one engine address join, and a
  // 429 to one slows every extension.
  notePageHosts({ id: 'sw:1', pagesProxied: true }, ['https://engine.myhost.com/api/v1/manga/1/chapter/1/page/0']);
  notePageHosts({ id: 'sw:2', pagesProxied: true }, ['https://engine.myhost.com/api/v1/manga/2/chapter/1/page/0']);
  noteRateLimited('sw:1');
  assert.equal(rateKeyOf('sw:2'), 'sw:2', "the engine's address joined two extensions");
  assert.equal(paceLevel('sw:2'), 0);
});
