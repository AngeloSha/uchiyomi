/**
 * Make main (v0.54.0): a series' main source, switched to one it already follows (POST
 * /api/admin/series/:id/main-source) -- the part with no React in it, so a test can hold the words and the rules.
 *
 * Until v0.54.0 nothing could change a series' main source. Find other sources only ADDED followers, so after a full
 * run aqua was still the main source of all 189 of the owner's series: every count, Library filter and sweep queue
 * still grouped them under a site that had been offline for a week. The Sources sheet now offers Make main on a
 * follower that works, and Replace does it for a whole source (components/ReplaceDialog.tsx).
 */
import { t as tr } from './i18n';
import type { SeriesSource } from './types';

/** A follower updates can use: working, or only cooling down for a while. */
export const usableStanding = (s: Pick<SeriesSource, 'standing'>): boolean => s.standing === 'usable' || s.standing === 'cooling';

/**
 * Whether a source row of the Sources sheet offers Make main: a followed source (never the main one) that works. A
 * server older than v0.54.0 sends no `standing`, and its sheet offers nothing it could not do.
 */
export const mayMakeMain = (s: Pick<SeriesSource, 'primary' | 'standing' | 'registered'>): boolean =>
  !s.primary && s.registered !== false && usableStanding(s);

/**
 * A refused Make main is said in the server's own words: its 409 carries the refusal as a code (`messageSaid`, bff
 * lib/said.ts `main.*`, the follow route's language sentences, 'renumber.checking' for a series being checked), which
 * `msgOf` words in the reader's language -- the Sources sheet's key and a Replace review's Make main alike.
 *
 * What Make main asks first, in one sentence: the new main source, and what becomes of the old one. The server keeps
 * the old main as a backup while it works (`old: 'auto'`) and drops it when it is switched off, failing or gone, so
 * the sentence says what the press will do.
 */
export function makeMainQuestion(next: Pick<SeriesSource, 'name'>, old: Pick<SeriesSource, 'name' | 'standing'> | null | undefined): string {
  const name = `⁨${next.name}⁩`;
  if (!old) return tr('Make {name} this series’ main source?', { name });
  const was = `⁨${old.name}⁩`;
  return usableStanding(old)
    ? tr('Make {name} this series’ main source? {old} is kept as a backup.', { name, old: was })
    : tr('Make {name} this series’ main source? {old} is dropped.', { name, old: was });
}
