// Which missing chapters to download, chosen in the Find missing chapters dialog (v0.48.3).
//
// The owner: "it just gives me the option to follow a source ... I don't see it automatically start
// downloading the rest of the missing chapters -- care to offer as well which one we wanna download". So each
// source that has chapters the series lacks offers them as a picker, everything selected, and one press
// downloads the selection now. Pure, so the rules are tested without a browser.

/** A run of consecutive chapter numbers: one chip, "Ch. 12–40". */
export interface Run { lo: number; hi: number; nums: number[] }

/** Consecutive whole numbers as runs. The fill scan compares whole numbers (bff lib/fill.ts), so these are. */
export function runsOf(nums: readonly number[]): Run[] {
  const out: Run[] = [];
  for (const n of [...new Set(nums)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last.hi + 1) { last.hi = n; last.nums.push(n); }
    else out.push({ lo: n, hi: n, nums: [n] });
  }
  return out;
}

/** Whether a run's chip reads as selected, partly, or not at all. */
export function runState(r: Run, selected: ReadonlySet<number>): 'all' | 'some' | 'none' {
  const n = r.nums.filter((x) => selected.has(x)).length;
  return n === r.nums.length ? 'all' : n ? 'some' : 'none';
}

/** A tap on a run: a run that is wholly selected is cleared, anything else is selected whole. */
export function toggleRun(selected: ReadonlySet<number>, r: Run): Set<number> {
  const next = new Set(selected);
  if (runState(r, selected) === 'all') for (const n of r.nums) next.delete(n);
  else for (const n of r.nums) next.add(n);
  return next;
}

/** A tap on one chapter. */
export function toggleOne(selected: ReadonlySet<number>, n: number): Set<number> {
  const next = new Set(selected);
  if (next.has(n)) next.delete(n); else next.add(n);
  return next;
}

/**
 * What one source can be asked for, and how.
 * - `fetch`: the series' own source, or one it already follows. The fetch route reads the series' listing,
 *   which holds exactly these sources, and picks the best copy of each chapter across them.
 * - `follow`: an admin, a source whose numbering matches ours (the same bar as following it), not yet followed.
 *   It is followed first, then fetched the same way -- following is what makes it part of the listing.
 * - `fill`: a source nobody follows, for the holes it brackets on both sides; the fill plan authorises it
 *   without a follow, and a member can use it.
 * - `none`: nothing this person can take from it.
 */
export type OfferMode = 'fetch' | 'follow' | 'fill' | 'none';
export interface OfferCandidate { source: string; pinned: boolean; why: string; coverage: number; fillable: number[]; newer: number[] }

export function offerOf(
  c: OfferCandidate,
  opts: { following: ReadonlySet<string>; isAdmin: boolean; followable: (c: OfferCandidate) => boolean },
): { mode: OfferMode; numbers: number[] } {
  const both = [...new Set([...c.fillable, ...c.newer])].sort((a, b) => a - b);
  if (c.pinned || opts.following.has(c.source)) return both.length ? { mode: 'fetch', numbers: both } : { mode: 'none', numbers: [] };
  if (opts.isAdmin && opts.followable(c) && both.length) return { mode: 'follow', numbers: both };
  if (c.why === 'ok' && c.fillable.length) return { mode: 'fill', numbers: [...c.fillable].sort((a, b) => a - b) };
  return { mode: 'none', numbers: [] };
}
