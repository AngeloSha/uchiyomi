// How long to wait for a source, depending on how it answers.
//
// A plain HTTP source answers in a second or two. A source behind Cloudflare answers only after the solver
// has driven a real browser through a challenge, which on this install takes about a minute for aqua -- and
// aqua holds 192 of 226 series. Every budget in the codebase was a single number that ignored the difference:
// the updater gave a listing 20 seconds and lost 15 aqua series per scheduled sweep to it; the fill scan gave
// a search 45 seconds and lost aqua at exactly the moment it mattered. A 60-second challenge against a
// 20-second timeout is a structural loss, not a flaky site.
import { env } from '../../env';

export const SOLVER_BUDGET_MS = Number(process.env.SOLVER_BUDGET_MS) || 90_000;

/**
 * A listing page's budget (v0.59.0): SOURCE_LATEST_TIMEOUT_MS, and for a source behind the Cloudflare solver
 * SOURCE_LATEST_SOLVER_TIMEOUT_MS, never less. A cold solve took 15-25 s on the owner's install (Natomanga 15.2 s,
 * Mangakakalot 14.7 s, ManhuaUS 24.2 s), warm calls 0.6-3 s -- against a bare 15 s, the first Discover visit of the day
 * lost exactly the sites the library comes from, and counted them slow. Discover's listings run out of it, and the
 * Test button and Health name it in their "too slow" sentence, so all three say the same number. Reintroduce the bare
 * budget: "a source behind the solver gets the solver's time on Newest" in discoverSources.int.test.ts times out.
 */
export function listBudgetFor(src: { requiresCloudflare?: boolean } | null | undefined): number {
  return src?.requiresCloudflare ? Math.max(env.SOURCE_LATEST_TIMEOUT_MS, env.SOURCE_LATEST_SOLVER_TIMEOUT_MS) : env.SOURCE_LATEST_TIMEOUT_MS;
}

/** The larger of the caller's own budget and the solver budget, when the source needs the solver. */
export function budgetFor(src: { requiresCloudflare?: boolean } | null | undefined, base: number): number {
  return src?.requiresCloudflare ? Math.max(base, SOLVER_BUDGET_MS) : base;
}
