/**
 * Finding the chapters a series is missing, and deciding who may supply them.
 *
 * The engine fix in v0.11.3 covered the common cause of a short series (a source listing only its newest
 * fifty). This covers the rest: a source that genuinely does not have the early chapters, where the only way
 * to complete the series is to take them from a different one.
 *
 * That is a far more dangerous operation than it looks. `downloadChapter` names its output purely from the
 * chapter number -- `Chapter 47.cbz` -- so a chapter fetched from the wrong series lands exactly where the
 * right one should be, is indistinguishable from it in every listing, and is only discovered by opening it.
 * Everything here exists to make that hard: the pure decisions live in this file so they can be tested
 * without a network, every refusal has a name that is shown to the person rather than swallowed, and no
 * candidate is ever filled from without a human confirming which source and which title they picked.
 *
 * The honest limit, stated here because it should not be discovered later: no rule that looks only at
 * chapter numbers can tell "the same series" from "a different series whose numbering happens to overlap".
 * A dense 1..N library is covered by any other long series. The gates below drop the obviously wrong and
 * catch renumbering; they do not prove identity, and that is exactly why the confirmation step is mandatory
 * rather than a convenience.
 */
import { randomBytes } from 'node:crypto';
import type { SourceChapter } from './sources';
import type { SourceStatus } from './sourceHealth';

/** A run of consecutive numbers this library does not have. */
export interface Gap {
  lo: number;
  hi: number;
  count: number;
  /**
   * Both sides of the hole are chapters we hold. An unanchored run is one that trails off the end of what we
   * have, where "missing" is really "we never got that far" -- filling it is extrapolation rather than repair.
   */
  anchored: boolean;
}

/** How well a candidate lines up with what we already hold. */
export interface Assessment {
  /** Of the chapters we hold, the share the candidate also lists. The renumbering detector. */
  coverage: number;
  matched: number;
  /** Numbers it could supply that sit inside our anchored gaps. */
  fillable: number[];
  /** Numbers above everything we hold. Reported, never filled by default: that is what "check for new" does. */
  newer: number[];
  /**
   * Numbers BELOW the lowest we hold: the run a "Latest N" add left behind on purpose. Empty unless the
   * caller says the series has a chapter floor, and only ever asked of the series' own source -- same
   * source, same series id, so there is no numbering to second-guess. From any other source the same run
   * is the unanchored extrapolation the rest of this file refuses.
   */
  older: number[];
}

export const MIN_HAVE = 3;
export const MIN_COVERAGE = 0.9;

/**
 * The holes in a set of chapter numbers.
 *
 * Whole numbers only. A source that publishes 12.5 between 12 and 13 must not make 13 look missing, and a
 * library holding 12.5 must not report a gap at 13 because 12.5 broke the run.
 */
export function gapsOf(have: number[]): Gap[] {
  const whole = [...new Set(have.map((n) => Math.floor(n)))].sort((a, b) => a - b);
  const out: Gap[] = [];
  for (let i = 1; i < whole.length; i++) {
    const lo = whole[i - 1] + 1;
    const hi = whole[i] - 1;
    if (hi >= lo) out.push({ lo, hi, count: hi - lo + 1, anchored: true });
  }
  return out;
}

/**
 * What a candidate could do for us.
 *
 * `coverage` is measured against the chapters we ALREADY HAVE, not against the gap. A source that carries our
 * numbering will list nearly all of them; one that restarts numbering per season, or is offset by an arc,
 * will not, and collapses here rather than quietly filling a hole with the wrong instalments.
 */
export function assess(have: number[], theirs: number[], opts: { older?: boolean } = {}): Assessment {
  const ours = new Set(have.map((n) => Math.floor(n)));
  const them = new Set(theirs.map((n) => Math.floor(n)));
  let matched = 0;
  for (const n of ours) if (them.has(n)) matched++;
  const coverage = ours.size ? matched / ours.size : 0;

  const max = have.length ? Math.max(...have) : 0;
  const fillable: number[] = [];
  for (const g of gapsOf(have)) {
    // Anchored by construction (gapsOf only emits interior runs), but assert the candidate holds BOTH
    // brackets: the two sides agreeing on the chapters either side of the hole is the whole claim being made.
    if (!them.has(g.lo - 1) || !them.has(g.hi + 1)) continue;
    for (let n = g.lo; n <= g.hi; n++) if (them.has(n)) fillable.push(n);
  }
  const newer = [...them].filter((n) => n > max).sort((a, b) => a - b);
  const min = have.length ? Math.min(...have) : 0;
  const older = opts.older ? [...them].filter((n) => n < min).sort((a, b) => a - b) : [];
  return { coverage, matched, fillable: fillable.sort((a, b) => a - b), newer, older };
}

/** Why a candidate is not offered. Shown to the person, never swallowed. */
export type Refusal =
  | 'ok'
  | 'no_chapters'
  | 'numbering_mismatch'
  | 'nothing_to_fill'
  | 'not_allowed'
  | 'disabled'
  | 'blocked'
  | 'no_match'
  /**
   * The search never answered: it threw, or it outran its timeout.
   *
   * This used to be a bare `catch {}`, so a source that could not be reached was indistinguishable from one
   * that does not carry the title. Live, `aqua` -- which holds 192 of 224 series -- was dropped from EVERY
   * fill scan by a 63-second Cloudflare challenge against a 20-second budget, and nothing said so.
   */
  | 'unreachable'
  /**
   * Never asked, because enough sources already listed the title. Not a failure and not "does not have it":
   * the old scan called every source it did not reach `unreachable`, which on an install with 35 sources
   * and a four-slot solver was most of them, every time.
   */
  | 'not_tried';

export function verdict(a: Assessment, theirsCount: number): Refusal {
  if (!theirsCount) return 'no_chapters';
  if (a.coverage < MIN_COVERAGE) return 'numbering_mismatch';
  if (!a.fillable.length && !a.older.length) return 'nothing_to_fill';
  return 'ok';
}

// ---- the plan store ---------------------------------------------------------
//
// A scan hands out a plan id; a fill quotes it back. The chapter URLs live ONLY here, never in a response and
// never in a request, so the client can name a chapter NUMBER and nothing else. A confused or hostile client
// cannot point the downloader at arbitrary content, and a fill can only ever do what a person was shown and
// agreed to.

export interface PlanCandidate {
  source: string;
  name: string;
  sourceSeriesId: string;
  title: string;
  coverUrl?: string;
  count: number;
  first: number | null;
  last: number | null;
  coverage: number;
  matched: number;
  fillable: number[];
  newer: number[];
  older: number[];
  why: Refusal;
  /** The series' own source. Offered first, and the one case that involves no cross-source guessing at all. */
  pinned: boolean;
  /**
   * The source's standing record, when it is not clean. Present on OFFERED candidates too, and that is the
   * point: a lapsed cooldown clears `blocked_until` but not the streak, so a source with consecutive=19 that
   * has never once completed a download was offered as a clean `why='ok'` -- WeebCentral, 403 on every image
   * byte since June, rendered as a confident "Fetch 12 chapters" button. Filtering on this would deadlock the
   * source: `consecutive` is cleared only by reportOk, which fires only after a successful download, which is
   * the very thing being refused. So this warns and never gates. `last_error` is deliberately absent: this
   * route is `authenticate`, not `requireAdmin`, and that field carries internal hostnames and ports.
   */
  health?: { status: SourceStatus; consecutive: number; lastFailAt: string | null; lastOkAt: string | null } | null;
}

interface StoredPlan {
  id: string;
  seriesId: string;
  folder: string;
  at: number;
  /** keyed `${source}${sourceSeriesId}` */
  chapters: Map<string, SourceChapter[]>;
  candidates: PlanCandidate[];
}

/** Long enough to read a dialog, short enough that the source's list has not drifted underneath it. */
export const PLAN_TTL = 5 * 60_000;
const plans = new Map<string, StoredPlan>();

export const planKey = (source: string, sourceSeriesId: string) => `${source}${sourceSeriesId}`;

export function putPlan(p: Omit<StoredPlan, 'id' | 'at'>): StoredPlan {
  sweepPlans();
  const stored: StoredPlan = { ...p, id: `fp_${randomBytes(9).toString('hex')}`, at: Date.now() };
  plans.set(stored.id, stored);
  return stored;
}

export function getPlan(id: string, now = Date.now()): StoredPlan | null {
  const p = plans.get(id);
  if (!p) return null;
  if (now - p.at > PLAN_TTL) { plans.delete(id); return null; }
  return p;
}

export function sweepPlans(now = Date.now()): void {
  for (const [id, p] of plans) if (now - p.at > PLAN_TTL) plans.delete(id);
}

/** Test seam. */
export function _clearPlans(): void { plans.clear(); }

/**
 * The chapters a fill is allowed to fetch, or a refusal.
 *
 * Every number is checked against what THIS plan offered for THIS candidate. Trusting the request body would
 * hand a client the ability to fetch any number from any source it could name -- including numbers a human
 * was never shown and never agreed to.
 */
export function authorise(
  plan: StoredPlan,
  source: string,
  sourceSeriesId: string,
  numbers: number[],
  max: number,
): { ok: true; chapters: SourceChapter[] } | { ok: false; error: string; message: string } {
  const cand = plan.candidates.find((c) => c.source === source && c.sourceSeriesId === sourceSeriesId);
  if (!cand) return { ok: false, error: 'not_in_plan', message: 'That source was not one of the options.' };
  if (cand.why !== 'ok') return { ok: false, error: 'not_in_plan', message: 'That source was not offered.' };

  const offered = new Set([...cand.fillable, ...cand.newer, ...cand.older]);
  const bad = numbers.filter((n) => !offered.has(n));
  if (bad.length) {
    return { ok: false, error: 'not_offered', message: `Chapter ${bad[0]} was not part of what you were shown.` };
  }
  if (!numbers.length) return { ok: false, error: 'not_offered', message: 'No chapters selected.' };
  if (numbers.length > max) {
    return { ok: false, error: 'too_many', message: `That is more than ${max} chapters in one go.` };
  }

  const all = plan.chapters.get(planKey(source, sourceSeriesId)) || [];
  const want = new Set(numbers);
  const chapters = all.filter((c) => want.has(c.number)).sort((a, b) => a.number - b.number);
  if (!chapters.length) return { ok: false, error: 'plan_stale', message: 'That list has moved on. Scan again.' };
  return { ok: true, chapters };
}
