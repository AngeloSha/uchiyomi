// How long to wait for a source, depending on how it answers.
//
// A plain HTTP source answers in a second or two. A source behind Cloudflare answers only after the solver
// has driven a real browser through a challenge, which on this install takes about a minute for aqua -- and
// aqua holds 192 of 226 series. Every budget in the codebase was a single number that ignored the difference:
// the updater gave a listing 20 seconds and lost 15 aqua series per scheduled sweep to it; the fill scan gave
// a search 45 seconds and lost aqua at exactly the moment it mattered. A 60-second challenge against a
// 20-second timeout is a structural loss, not a flaky site.
export const SOLVER_BUDGET_MS = Number(process.env.SOLVER_BUDGET_MS) || 90_000;

/** The larger of the caller's own budget and the solver budget, when the source needs the solver. */
export function budgetFor(src: { requiresCloudflare?: boolean } | null | undefined, base: number): number {
  return src?.requiresCloudflare ? Math.max(base, SOLVER_BUDGET_MS) : base;
}
