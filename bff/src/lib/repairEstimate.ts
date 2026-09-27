/**
 * How long a repair run can take, from the code's own constants (v0.49.0). Pure: the limits come in.
 *
 * The Health page shows two numbers before anyone presses anything: "usually about 4 min" (the median of the
 * last runs of the same kind, lib/repairRuns.ts) and "at most about 12 min of searching and waiting" -- this.
 * The second one is a sum of the waits the code bounds: a page list under its timeout, a listing under the
 * updater's, a search under the hunt's wall. Every one of them is a named constant in lib/repair.ts,
 * lib/updater.ts, lib/sourceHunt.ts or lib/sources/budget.ts, and several can be changed by environment
 * (REPAIR_SHORT_MAX, SOLVER_BUDGET_MS, REPAIR_PACE_MS...), which is why the route passes the REAL values in
 * rather than this file copying them.
 *
 * ⚠️ Downloads are never folded into the time. How long a chapter takes to download has no bound in the code
 * (a page is retried, a source paces itself), so a minute count that included them would be invented. They
 * are stated as a count instead: "plus up to 20 chapter downloads".
 * ⚠️ A step with no formula (the page count, group upgrades, names, directions) makes the whole estimate
 * unknown (`boundedMs: null`) rather than quietly leaving its time out: those are "usually" only.
 */
export interface EstimateLimits {
  shortMax: number;
  gapsMax: number;
  huntBudget: number;
  shortHuntMax: number;
  gapChapters: number;
  retrySeries: number;
  shortCopies: number;
  paceMs: number;
  pageListMs: number;
  listingRefreshMs: number;
  listTimeoutMs: number;
  huntWallMs: number;
  solverBudgetMs: number;
}

export interface WorstCase {
  /** The most the run can spend waiting on sources and searches, or null when a planned step has no bound. */
  boundedMs: number | null;
  /** The most chapters it can download on top of that. */
  downloads: number;
}

/** The solver step: one ping (5 s timeout, lib/sources/flaresolverr.ts) and some database work. */
export const SOLVER_STEP_MS = 10_000;

/** One step's share: its waits outside any search, the searches it may start, and its downloads. */
type Share = { ms: number | null; hunts: number; afterHunt: number; downloads: number };

/**
 * The worst case for a run kind (lib/repairRuns.ts kindOf): `full`, `fix_short`, `fill`, `retry`, or
 * `steps:<a+b...>[:now]`. `n` is how many candidates the step would take, when the caller knows (absent: at
 * the cap). `solver` is whether any source sits behind Cloudflare, which stretches a page list and a listing
 * to the solver's budget -- the conservative reading, since the run cannot know in advance which sources a
 * series will be asked on.
 */
export function worstCase(kind: string, L: EstimateLimits, opts: { n?: number; solver?: boolean } = {}): WorstCase {
  const P = opts.solver ? Math.max(L.pageListMs, L.solverBudgetMs) : L.pageListMs;
  const Lst = opts.solver ? Math.max(L.listTimeoutMs, L.solverBudgetMs) : L.listTimeoutMs;
  const H = L.huntWallMs;
  const cap = (max: number) => Math.min(max, opts.n ?? max);

  // The three Health chips, each on one target.
  if (kind === 'fix_short') {
    return { boundedMs: L.listingRefreshMs + L.shortCopies * P + H + P, downloads: 1 };
  }
  if (kind === 'fill') return { boundedMs: H + Lst, downloads: L.gapChapters };
  if (kind === 'retry') {
    return { boundedMs: L.retrySeries * (Lst + L.paceMs) + L.huntBudget * H, downloads: L.retrySeries * 10 };
  }

  const m = /^steps:([a-z+]+)(:now)?$/.exec(kind);
  const steps = kind === 'full'
    ? ['solver', 'count', 'failures', 'short', 'gaps', 'groups', 'names', 'directions']
    : m ? m[1].split('+') : null;
  if (!steps) return { boundedMs: null, downloads: 0 };
  const now = !!m?.[2];

  const share = (step: string): Share => {
    switch (step) {
      case 'solver': return { ms: SOLVER_STEP_MS, hunts: 0, afterHunt: 0, downloads: 0 };
      case 'short': {
        const k = cap(L.shortMax);
        // A listing refresh and up to shortCopies page lists per chapter; then a search, and one more page
        // list for what the search found, at most shortHuntMax times in the run.
        return { ms: k * (L.listingRefreshMs + L.shortCopies * P), hunts: Math.min(L.shortHuntMax, k), afterHunt: P, downloads: k };
      }
      case 'gaps': {
        const k = cap(L.gapsMax);
        return { ms: k * Lst, hunts: L.huntBudget, afterHunt: 0, downloads: k * L.gapChapters };
      }
      case 'failures':
        // Without `now` the nightly's failures step only resets ledger rows: database work, no source asked.
        return now
          ? { ms: L.retrySeries * (Lst + L.paceMs), hunts: 0, afterHunt: 0, downloads: L.retrySeries * 10 }
          : { ms: 0, hunts: 0, afterHunt: 0, downloads: 0 };
      default:
        // count, groups, names, directions: bounded by their caps, not by a wait the code names.
        return { ms: null, hunts: 0, afterHunt: 0, downloads: 0 };
    }
  };

  let ms: number | null = 0;
  let hunts = 0, afterHunts = 0, downloads = 0;
  for (const s of steps) {
    const x = share(s);
    ms = ms === null || x.ms === null ? null : ms + x.ms;
    hunts += x.hunts;
    afterHunts += x.hunts * x.afterHunt;
    downloads += x.downloads;
  }
  // The run shares ONE search budget between its steps (lib/repair.ts REPAIR_HUNT_BUDGET), so two hunting
  // steps together can never search more than that, however their own shares add up. The page list after a
  // short step's search is counted in full: the short step's searches are already capped by its reserve.
  const huntMs = Math.min(hunts, L.huntBudget) * H + afterHunts;
  return { boundedMs: ms === null ? null : ms + huntMs, downloads };
}
