// Which copy of a chapter the sweep downloads when several sources a series follows carry the same release (v0.81.0).
//
// The release rules choose a number's copy by its group, its language and the source order, and between equal copies
// they take the series' main source first. That is the right copy, but not always the right moment for its site: the
// main may be slowed after a 429 (lib/pace.ts), busy with other series' chapters (lib/gate.ts), or the very site that
// failed this chapter last time, while a follower carries the identical release at full speed on an idle image server.
// The Fetch job rotates over such copies since v0.55.4 (routes/sources.ts pickCopy); this is the sweep's turn.
//
// "The same release" is lib/seriesListing.ts sameRelease, unchanged: the same groups (or, naming none, the same page
// count) and the same language. So nothing here can take a copy the release rules rank lower for its group, and a
// copy a person picked, a series with a source order (its own or the server's) and a series numbered by posting order
// are never routed (the caller's rule, lib/updater.ts).
import { rateKeyOf, paceLevel, restLeft } from './pace';
import { gateDepth } from './gate';
import { sameRelease, declaredLang, type ListingCopy } from './seriesListing';
import type { SourceChapter } from './sources/types';

/** A chapter as sameRelease reads a stored copy. */
const asCopy = (c: SourceChapter): ListingCopy => ({
  sourceId: c.sourceId, source: c.source ?? '', groups: c.groups ?? [], scanlator: c.scanlator ?? null, lang: c.lang ?? null,
  pages: c.pages ?? null, publishedAt: null,
});

/** The copies among `all` that are the same release as `chosen` on another followed source, one per source. */
export function sameReleaseChapters<T extends SourceChapter>(chosen: T, all: readonly T[], followed: Iterable<string>): T[] {
  const key = (c: { source?: string; sourceId: string }) => `${c.source ?? ''}\u0000${c.sourceId}`;
  const byKey = new Map(all.map((c) => [key(c), c] as const));
  return sameRelease(asCopy(chosen), all.map(asCopy), { followed, langOf: declaredLang })
    .slice(1)
    .map((c) => byKey.get(key(c)))
    .filter((c): c is T => !!c);
}

export interface RouteFacts {
  /** May this source be asked now: loaded, allowed, switched on, not cooling, not refusing this run. */
  may: (source: string) => boolean;
  /** The source the ledger last blamed for this number (chapter_failures.source_id), asked last among equals. */
  blamed?: string | null;
  /** Chapters running and queued on an image server, every job's (lib/gate.ts). Tests pass their own. */
  load?: (key: string) => number;
  /** A source downloading at a raised pace or resting after a 429 (lib/pace.ts). Tests pass their own. */
  slowed?: (source: string) => boolean;
  /**
   * A backup extension's source (v0.82.0, lib/backupExtensions.ts). Asked after the others among equals: the owner's
   * "when there is new chapters it will just use main until it rate limits or fail again". A backup's copy beats the
   * main's only when the main's is slowed or failed this chapter last -- never because the main's image server is
   * busier, which would keep a backup in use, and installed, for good. Absent: none is.
   */
  backup?: (source: string) => boolean;
}

/**
 * Of a chapter's chosen copy and the same release elsewhere, the one to download: one that may be asked, at full speed
 * before slowed, not the source that failed it last time before that one, not a backup extension's before one (v0.82.0),
 * then the image server with the least on it, then the chosen copy. Pure but for the pace and gate it reads by default.
 * Reintroduce the backup's turn by dropping it: "the main at full speed wins over a backup on a quieter server" in
 * copyRouter.test.ts takes the backup.
 *
 * The chosen copy, untouched, when its own source may not be asked (refusing this run, cooling, switched off): that is
 * the fallback helper's case (lib/chapterFallback.ts), which takes the number from another followed source and says
 * so on the card as a switch. Routing is for a source that can answer, only not best. Reintroduce by routing past it:
 * "a refusing primary costs one strike" in updater.int.test.ts counts one switch, not two.
 */
export function routeCopy<T extends { source?: string }>(own: T, others: readonly T[], f: RouteFacts): T {
  if (!own.source || !f.may(own.source)) return own;
  const load = f.load ?? ((key: string) => { const d = gateDepth(key); return d.active + d.queued; });
  const slowed = f.slowed ?? ((s: string) => paceLevel(s) > 0 || restLeft(s) > 0);
  const backup = f.backup ?? (() => false);
  const open = [own, ...others]
    .map((c, i) => ({ c, i, s: c.source ?? '' }))
    .filter((x) => x.s && f.may(x.s))
    .map((x) => ({ ...x, slow: slowed(x.s) ? 1 : 0, blamed: x.s === f.blamed ? 1 : 0, spare: backup(x.s) ? 1 : 0, load: load(rateKeyOf(x.s)) }));
  if (!open.length) return own;
  open.sort((a, b) => a.slow - b.slow || a.blamed - b.blamed || a.spare - b.spare || a.load - b.load || a.i - b.i);
  return open[0].c;
}
