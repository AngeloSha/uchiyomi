// Which sources are worth fetching for the Discover wall, and in what order.
//
// Split out of SourcePicker so it can be tested: the component is a client component that pulls in
// react-query and JSX, and this is arithmetic on a list of rows. `components/SourcePicker.tsx` re-exports
// everything here, so nothing else had to change.
//
// This used to also group sources by declared language and render a chip per language. That is gone. The
// grouping was the trigger for a stall -- switching group mid-load left the wall counting sources it had
// forgotten, so its skeletons never resolved -- and thrashing the chips fired abandoned scrapes that each
// cost the server a full timeout and then wrote a multi-minute cooldown against the source. Ranking survived
// the removal because ranking was the useful half.

export interface Src {
  id: string;
  name: string;
  /** Retained on the row; nothing reads it since the language grouping was removed. */
  lang: string | null;
  latest?: boolean;
  status?: 'ok' | 'disabled' | 'rate_limited' | 'blocked' | 'down';
  blockedUntil?: string | null;
  /** How many series in the library came from this source. See `budgetFor`. */
  used?: number;
}

export type SrcState = 'loading' | 'ok' | 'empty' | 'idle' | 'blocked' | 'off';

/**
 * Which sources to actually fetch, and in what order.
 *
 * The page that fetched every registered source opened forty-five concurrent scrapes. Six, best-first:
 *   1. healthy before rate-limited or blocked, because a blocked source is a guaranteed timeout for a
 *      guaranteed nothing;
 *   2. what the library actually came from;
 *   3. registry order after that, which puts the preferred adapters first (Array.sort is stable).
 *
 * (2) sits there on evidence, not taste. On one real install the wall was fetching MangaDex and five adult
 * extension sources with no series behind any of them, while Aqua Manga -- 189 of that library's 214 series,
 * answering in 2.5s -- was never among the six. Ranking by what someone demonstrably reads from fixed it.
 */
export function budgetFor(sources: Src[], max = 6): Src[] {
  return sources
    .filter((s) => s.latest && s.status !== 'disabled')
    .sort((a, b) =>
      Number(a.status !== 'ok') - Number(b.status !== 'ok') ||
      (b.used ?? 0) - (a.used ?? 0))
    .slice(0, max);
}
