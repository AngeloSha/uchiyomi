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

// `t as tr`, as every component does: the string extractor scans for `tr(` with a literal, and a bare `t(`
// would leave this key out of every locale file while the app compiled and rendered it in English.
import { t as tr } from './i18n';

export interface Src {
  id: string;
  name: string;
  /** Retained on the row; nothing reads it since the language grouping was removed. */
  lang: string | null;
  latest?: boolean;
  /** Whether this source can answer "what is popular" as well as "what is new". */
  popular?: boolean;
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
 *
 * Every amber dot comes with a sentence. A request that FAILED (`blocked`) used to carry the server's note
 * or nothing, and "nothing" was common: a 429 written this minute has a cooldown but no note yet. The sheet
 * then lit an amber dot with no line under it, and the chip's "{n} with issues" -- which counted sentences --
 * said two while three rows glowed. The default here is what makes the dot and the count agree.
 */
export function noteFor(src: Src, state: SrcState): { dot: 'ok' | 'warn' | 'idle' | 'quiet'; note: string | null } {
  if (state === 'ok') return { dot: 'ok', note: null };
  if (state === 'blocked') return { dot: 'warn', note: src.note ?? tr('Could not be reached right now.') };
  // The case this exists for: the request succeeded and came back empty. Only the server knows whether that
  // means "nothing new" or "I could not read the page", and `note` is how it says so.
  if (state === 'empty') return src.note ? { dot: 'warn', note: src.note } : { dot: 'quiet', note: null };
  return { dot: 'idle', note: null };
}

/**
 * "back in ~12 min", or null when there is no cooldown to wait out.
 *
 * Translated here rather than by the caller because the caller renders it as a whole: it used to be the one
 * hardcoded English sentence on a Discover page that was otherwise translated, and the string extractor
 * cannot see a template literal.
 */
export function retryIn(src: Src, now = Date.now()): string | null {
  if (!src.blockedUntil) return null;
  const mins = Math.ceil((new Date(src.blockedUntil).getTime() - now) / 60000);
  return mins > 0 ? tr('back in ~{n} min', { n: mins }) : null;
}

/**
 * What the empty card says when ONE source is being browsed alone and it produced nothing.
 *
 * The page's sentence for the whole wall ("nothing new from these sources") is wrong for a single source
 * that is rate-limited: before v0.34.0 the note lines under the chip wall said "Rate-limited … · back in
 * ~12 min" on the page itself; those lines went into the sheet, and browsing that source alone then read as
 * "nothing new" while the sheet, one tap away, said why. So the card says what the sheet row says --
 * `warn` is the caller's cue to paint it amber -- and only a source with nothing wrong falls through to the
 * quiet sentence. The reached-nothing branch is for a failure `noteFor` gives no sentence to; today it
 * always gives one, but the card must never read "nothing new" for a request that did not succeed.
 */
export function aloneEmpty(src: Src, state: SrcState, now = Date.now()): { text: string; warn: boolean } {
  const { note } = noteFor(src, state);
  if (note) {
    const when = retryIn(src, now);
    return { text: when ? `${note} · ${when}` : note, warn: true };
  }
  if (state === 'blocked') return { text: tr('No source could be reached right now.'), warn: true };
  return { text: tr('Nothing new from these sources right now.'), warn: false };
}

/** Which listing the wall is showing. The source's own ranking, never one we compute. */
export type ListMode = 'newest' | 'popular';

/**
 * Sources worth asking for the mode currently selected.
 *
 * A source that cannot answer the chosen listing drops out entirely, the same way one without `latest`
 * already does -- showing a chip that can never fill would be worse than showing one fewer chip.
 */
export function budgetForMode(sources: Src[], mode: ListMode, max = 6): Src[] {
  return budgetFor(mode === 'popular' ? sources.filter((s) => s.popular) : sources, max);
}

/** Where the browser can find a source's icon. The route answers 404 when there is none; the tile covers it. */
export const sourceIcon = (id: string) => `/img/sources/icon/${encodeURIComponent(id)}`;

/**
 * A stable colour for a source with no icon, so the lettered tile still looks chosen rather than random.
 * Mirrors the hash in lib/art.ts's `genreGradient`, so the two palettes belong to the same app.
 */
export function iconTint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 30%), hsl(${(h + 40) % 360} 45% 18%))`;
}
