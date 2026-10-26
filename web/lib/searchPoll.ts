/**
 * Polling a `/api/sources/search-all` answer until every source has answered (#353), for the import review's manual
 * search and Add more sources: the same rules as Discover's search (app/discover/page.tsx), the React-free half, so a
 * test can hold them without a browser.
 *
 * Why: the server answers within `wait` with whatever has landed and says how many sources it is still asking
 * (`pending`). Discover polled; the two sheets asked once and kept that first answer, so a source slower than the
 * server's grace never showed there at all -- "only 5 sources" in #353, on an install with many more.
 */
import { t as tr } from '@/lib/i18n';

/**
 * How long the server may hold the FIRST answer to a search while the sources are still being asked. The
 * server clamps it to its own ceiling; six seconds is the owner's "a few seconds", and a Cloudflare source
 * that needs longer fills in afterwards. Every later poll asks for a short wait only: by then the server
 * answers from the entry it is still filling, so the poll is a cheap join, not a second search.
 */
export const SEARCH_FIRST_WAIT_MS = 6000;
export const SEARCH_POLL_WAIT_MS = 1500;
/** How often to poll while the answer says some sources are still pending. */
export const SEARCH_POLL_MS = 1500;
/** How many pending sources the progress line names before "and N more". */
export const SEARCH_NAMES_SHOWN = 3;

/** The progress half of a search answer; every field optional, so an older server's answer still reads. */
export interface SearchProgress {
  sources?: { name: string; state: string }[];
  pending?: number;
  asked?: number;
}

/**
 * The `wait` to ask for, from how many answers this query already has. ⚠️ Only the first request may wait the long
 * wait. A poll that also waited six seconds would hold its answer until the server's grace expired, so the results
 * would fill in six seconds late every time.
 */
export function searchWait(answers: number): number {
  return answers === 0 ? SEARCH_FIRST_WAIT_MS : SEARCH_POLL_WAIT_MS;
}

/** TanStack Query's `refetchInterval`: poll while the latest answer says some sources are still being asked. */
export function searchPoll(data: SearchProgress | undefined): number | false {
  return data?.pending ? SEARCH_POLL_MS : false;
}

/**
 * "3 of 8 sources answered · still asking MangaDex, Aqua Manga, Bato and 2 more": the results are usable from the first
 * answer, and this is what says the rest is coming and who is slow. Three names, then a count, so the line stays one
 * line on a phone; one name gets the singular sentence. Null once everyone has answered.
 */
export function searchProgressLine(d: SearchProgress | undefined): string | null {
  if (!d?.pending || !d.sources) return null;
  const m = d.asked ?? d.sources.filter((s) => s.state !== 'skipped').length;
  const n = Math.max(0, m - d.pending);
  const waiting = d.sources.filter((s) => s.state === 'pending').map((s) => s.name);
  if (waiting.length === 1) return tr('{n} of {m} sources answered · still asking {name}', { n, m, name: waiting[0] });
  const shown = waiting.slice(0, SEARCH_NAMES_SHOWN).join(', ');
  const more = waiting.length - SEARCH_NAMES_SHOWN;
  // A singular key for one: "et 1 autres" is not French, and a plural key cannot know.
  const names = more > 1 ? `${shown} ${tr('and {n} more', { n: more })}` : more === 1 ? `${shown} ${tr('and 1 more')}` : shown;
  return tr('{n} of {m} sources answered · still asking {names}', { n, m, names });
}
