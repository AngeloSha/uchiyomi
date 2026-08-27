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
  /**
   * `quiet` is the server saying "this answers without error and returns nothing". It used to be
   * unrepresentable: a source whose listing had drifted threw nothing, so it never earned a cooldown, kept
   * `ok` forever, and `budgetFor` therefore kept fetching it ahead of sources that work.
   */
  status?: 'ok' | 'disabled' | 'rate_limited' | 'blocked' | 'down' | 'quiet';
  blockedUntil?: string | null;
  /**
   * Why this source is unhappy, in one sentence, written by the server. Public by construction: the server
   * sends the reader-safe half of the diagnosis and keeps the admin half (which names containers and config
   * files) on the admin routes. Null when nothing is wrong.
   */
  note?: string | null;
  /** How many series in the library came from this source. See `budgetFor`. */
  used?: number;
}

/**
 * How one source answered on this visit.
 *
 * `loading` and `off` used to be members and nothing ever assigned either of them, so a source being
 * fetched right now was indistinguishable from one that had never been asked. Removed rather than wired up:
 * the wall's own progress hairline already shows that work is in flight.
 */
export type SrcState = 'ok' | 'empty' | 'idle' | 'blocked';

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

/**
 * What the chip should say and how its dot should look.
 *
 * This is the whole point of the feature. "Answered with nothing" and "is broken and could not answer" were
 * the same grey dot, and on a real install four of ten sources sat in the second case for weeks while
 * looking exactly like the first. The server now says which is which; this turns that into a colour.
 *
 * Amber, not red: a source in a cooldown heals by itself, and the sources here are third-party websites
 * whose being down is ordinary rather than alarming.
 */
export function noteFor(src: Src, state: SrcState): { dot: 'ok' | 'warn' | 'idle' | 'quiet'; note: string | null } {
  if (state === 'ok') return { dot: 'ok', note: null };
  if (state === 'blocked') return { dot: 'warn', note: src.note ?? null };
  // The case this exists for: the request succeeded and came back empty. Only the server knows whether that
  // means "nothing new" or "I could not read the page", and `note` is how it says so.
  if (state === 'empty') return src.note ? { dot: 'warn', note: src.note } : { dot: 'quiet', note: null };
  return { dot: 'idle', note: null };
}

/** "back in ~12 min", or null when there is no cooldown to wait out. */
export function retryIn(src: Src, now = Date.now()): string | null {
  if (!src.blockedUntil) return null;
  const mins = Math.ceil((new Date(src.blockedUntil).getTime() - now) / 60000);
  return mins > 0 ? `back in ~${mins} min` : null;
}
