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

/** The source answered 429: one level slower, up to PACE_MAX_LEVEL, and the decay clock restarts. */
export function noteRateLimited(sourceId: string): void {
  const p = current(sourceId);
  paces.set(sourceId, { level: Math.min(PACE_MAX_LEVEL, (p?.level ?? 0) + 1), lastHitAt: clock() });
}

/** 0 = full speed. Read by downloadChapter for the chapter gate and by the sources list for its badge. */
export function paceLevel(sourceId: string): number {
  return current(sourceId)?.level ?? 0;
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

/** Tests only: forget every source's level, so one file's 429 does not slow the next file's chapters. */
export function clearPace(): void { paces.clear(); }
