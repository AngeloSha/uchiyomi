// How hard the downloader may hit a source right now, remembered PER SOURCE across chapters.
//
// A 429 used to slow down exactly one chapter: the resume loop in downloader.ts doubled the page gap and
// narrowed the pool to one worker, both of them locals of fetchChapter, and the very next chapter started
// again at full speed against a site that had just said no. Live, that read as a source being rate-limited
// five times in 74 seconds, each strike widening the cooldown, until the person's own manual retry was
// refused too. The owner's ask was the obvious one: "if we get rate limited, continue from the same source
// with slower pulling" -- which needs the slow-down to outlive the chapter that earned it.
//
// So the pace is a small in-memory table: a level per source, raised by every 429 and lowered by nothing
// but time. Level 1 doubles every gap, level 4 is sixteen times slower between chapters and the page-gap
// ceiling inside one. A successful download does NOT reset it -- the site let one chapter through at the
// slower pace, which is evidence the slower pace works, not that the fast one does. Ten quiet minutes take
// one level off. Nothing persists: a restart starts fast, and the first 429 teaches it again.
//
// One caller also asks to be slower than any of that on purpose: the slow archive (#117), through
// withSlowPace below.
//
// A level belongs to a source's RATE GROUP (v0.52.0, rateKeyOf below): every MangaDex language is an adapter of its
// own, and all of them are one API that limits one address. A 429 earned in Spanish slows Portuguese as well.
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSource } from './sources/loader';

/** The slowest we ever go: sixteen times the declared gap between chapters, and MAX_PAGE_GAP_MS inside one. */
export const PACE_MAX_LEVEL = 4;
/** Ten quiet minutes lower the level by one step. Quiet means no 429, not no downloads. */
export const PACE_DECAY_MS = 10 * 60_000;
/**
 * Ceiling for the page gap inside a chapter, at any level. Four seconds a page is 8 minutes for a 120-page
 * chapter, which is slow enough that no site mistakes it for a burst and fast enough to finish tonight.
 * Was 2000 when it only lasted one chapter; a pace that persists has to be allowed to go slower.
 */
export const MAX_PAGE_GAP_MS = 4000;

interface Pace { level: number; lastHitAt: number }
const paces = new Map<string, Pace>();

/**
 * The key a source's pace level and its download gate are kept under: its rate group when it declares one (every
 * MangaDex language says 'mangadex', types.ts `rateGroup`), else its own id. An id that is not registered is its
 * own key. The downloader's gate (downloader.ts underGate) and the slow archive's reads of the gate use it too.
 */
export const rateKeyOf = (sourceId: string): string => getSource(sourceId)?.rateGroup ?? sourceId;

let clock: () => number = () => Date.now();
/** Tests only: replace the clock so decay can be exercised without waiting ten minutes. `null` restores it. */
export function setPaceClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }

/** Current level after the lazy decay: one step off per PACE_DECAY_MS since the last 429. */
function current(sourceId: string): Pace | null {
  const p = paces.get(sourceId);
  if (!p) return null;
  const steps = Math.floor((clock() - p.lastHitAt) / PACE_DECAY_MS);
  if (steps <= 0) return p;
  const level = p.level - steps;
  if (level <= 0) { paces.delete(sourceId); return null; }
  // Decay is applied by advancing the stamp, not by resetting it: a level-4 source that has been quiet for
  // 25 minutes is at level 2 with 5 minutes already served towards level 1, not at level 2 from scratch.
  const decayed = { level, lastHitAt: p.lastHitAt + steps * PACE_DECAY_MS };
  paces.set(sourceId, decayed);
  return decayed;
}

/** The source answered 429: one level slower, up to PACE_MAX_LEVEL, and the decay clock restarts -- for its whole rate group. */
export function noteRateLimited(sourceId: string): void {
  const key = rateKeyOf(sourceId);
  const p = current(key);
  paces.set(key, { level: Math.min(PACE_MAX_LEVEL, (p?.level ?? 0) + 1), lastHitAt: clock() });
}

/** 0 = full speed: the level of the source's rate group. Read by downloadChapter for the chapter gate and by the sources list for its badge. */
export function paceLevel(sourceId: string): number {
  return current(rateKeyOf(sourceId))?.level ?? 0;
}

/** Pool width as the adapter declared it, clamped and NaN-proof (see the comment in downloader.ts). */
function declaredWorkers(pageConcurrency: number | undefined): number {
  const declared = Number(pageConcurrency);
  return Number.isFinite(declared) ? Math.min(8, Math.max(1, Math.floor(declared))) : 1;
}

/**
 * The page gap and pool width fetchChapter starts a chapter with.
 *
 * At level 0 this is exactly what the adapter declared, or the server default for one that declares
 * nothing. Slowed, the pool is one wide (the burst is what was refused) and the gap doubles per level up to
 * the ceiling. ⚠️ A declared gap of 0 (the Suwayomi adapter: the engine paces the site) is `||`-ed back to
 * the server default before doubling, because 0 × 16 is still 0 and a slowed source with no gap at all is
 * not slowed.
 */
export function paceFor(
  src: { id: string; pageGapMs?: number; pageConcurrency?: number },
  defaults: { gapMs: number },
): { gap: number; workers: number; level: number } {
  const level = paceLevel(src.id);
  if (!level) return { gap: src.pageGapMs ?? defaults.gapMs, workers: declaredWorkers(src.pageConcurrency), level };
  const base = src.pageGapMs || defaults.gapMs;
  return { gap: Math.min(MAX_PAGE_GAP_MS, base * 2 ** level), workers: 1, level };
}

/**
 * A caller's own slower pace, for every page it downloads however deep: the slow archive (#117,
 * lib/archive.ts) runs each of its chapters inside one.
 *
 * It travels in an AsyncLocalStorage, the way withOrigin carries who started a download
 * (lib/downloadActivity.ts), so nothing between the archive and fetchPages grows a parameter -- and so it is
 * scoped: a person's own download from the same source a minute later runs at exactly paceFor, as before.
 * The archive is the one caller that WANTS to be slower than its adapter asks. A fixed gap sustained for
 * days reads as a script, and Suwayomi's declared gap 0 and wider pool (issue #37) are tuned for someone
 * waiting on one chapter, not for a thousand-chapter back catalogue fetched over ten days.
 */
export interface SlowPace {
  /** Each page waits a fresh uniform draw from [min, max] ms after the previous one came back. */
  pageGapMs: [number, number];
  /** One page at a time, whatever the adapter declares. */
  workers: 1;
  /** Tests only: where the draws come from. Default Math.random. */
  rand?: () => number;
}
const slow = new AsyncLocalStorage<SlowPace>();

/** Run `fn` with every page it downloads, however deep, at the slow pace. */
export function withSlowPace<T>(p: { pageGapMs: [number, number]; rand?: () => number }, fn: () => T): T {
  return slow.run({ pageGapMs: p.pageGapMs, workers: 1, rand: p.rand }, fn);
}
/** The slow pace in force here, or undefined for every ordinary download. */
export const slowPace = (): SlowPace | undefined => slow.getStore();

/**
 * What fetchPages starts a chapter with. Outside withSlowPace this IS paceFor, unchanged. Inside it the
 * pool is one wide and each page draws its gap from the slow range, whose ends never go below the gap
 * paceFor would have used: an adapter's own gap, or the doubled gap of a pace level a 429 earned, stays a
 * floor. What it does override is a declared gap of 0 and a declared pool -- the Suwayomi adapter's, which
 * would otherwise fetch the archive's pages four at a time with no pause at all.
 */
export function pagePace(
  src: { id: string; pageGapMs?: number; pageConcurrency?: number },
  defaults: { gapMs: number },
): { gap: number; workers: number; level: number; jitter?: [number, number]; rand?: () => number } {
  const pace = paceFor(src, defaults);
  const s = slowPace();
  if (!s) return pace;
  const lo = Math.max(s.pageGapMs[0], pace.gap);
  const jitter: [number, number] = [lo, Math.max(s.pageGapMs[1], lo)];
  return { gap: lo, workers: s.workers, level: pace.level, jitter, ...(s.rand ? { rand: s.rand } : {}) };
}

/**
 * The pace a chapter resumes at after a 429 inside it (fetchPages' resume loop): each gap doubled, up to
 * MAX_PAGE_GAP_MS, and never below where it was. A gap that already sat above the ceiling -- an adapter's own
 * 6 s, an ARCHIVE_PAGE_GAP_MS of 5-8 s -- stays where it was: `min(g x 2, ceiling)` alone would cut it to 4 s,
 * and the resume after a refusal may not be the fast part. A declared gap of 0 stays 0 inside this chapter (the
 * engine paces the site); the NEXT chapter gets the server default doubled (paceFor).
 *
 * A slow pace's range (withSlowPace) backs off at both ends the same way, and keeps a spread: doubling alone
 * takes the default [1500, 4000] to [3000, 4000] and then to [4000, 4000], every page exactly 4 s apart for the
 * rest of the chapter. The low end stays at least a quarter of the top below it (or the range's own width, when
 * that is narrower), so [3000, 4000] is where it settles. A range that was one value to begin with stays one.
 *
 * ⚠️ With a range, `gap` is the low end, never doubled on its own. Every page is drawGap(jitter, gap): the gap is
 * a floor under the draw, so a gap doubled to 4000 beside a range kept at [3000, 4000] drew exactly 4000 for
 * every page, the metronome the spread was kept to avoid. It still never drops below where it was.
 */
export function resumePace(
  p: { gap: number; jitter?: [number, number] },
  ceiling: number = MAX_PAGE_GAP_MS,
): { gap: number; jitter?: [number, number] } {
  const up = (g: number): number => Math.max(g, Math.min(g * 2, ceiling));
  if (!p.jitter) return { gap: p.gap ? up(p.gap) : 0 };
  const [lo, hi] = p.jitter;
  const top = up(hi);
  const low = Math.min(up(lo), top - Math.min(hi - lo, top / 4));
  return { gap: Math.max(p.gap, low), jitter: [low, top] };
}

/** Tests only: forget every source's level, so one file's 429 does not slow the next file's chapters. */
export function clearPace(): void { paces.clear(); }
