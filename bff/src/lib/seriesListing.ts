// What the sources list for a series, kept so the series page can show the chapters this server lacks.
//
// Everything the sweep knew about a missing chapter -- held for a preferred group, failed three times,
// released only by a blocked group, below the Latest-N floor -- died with the sweep's stack frame. The
// series page could count "3 behind" from the stamps on lib_series and say nothing about which three, or
// why. This module persists the last listing (one row per number, whether or not the chapter is on disk)
// and turns it into "ghosts": the numbers with no lib_books row, each with the reason it is not here.
//
// The listing is written by the updater, not fetched when the page opens. Asking the sources from a page
// load would put every series-page visit on the sites' rate limits, and "as of the last check" is the
// honest answer anyway: the reason a chapter is missing is a property of the last sweep, not of now.
//
// EVERY listed number is stored, not only the missing ones. "Fetch again" needs the chosen copy of a
// number that IS on disk, and the known-group picker needs to count what a group released, held or not.
// A number's row is also the authorisation for a manual fetch: a client names numbers, and only a number
// the sources listed at the last check can be asked for -- the same footing as the fill plan, and the
// same reason (a chapter URL never crosses the wire).
import { q, one, tx } from './db';
import { getSource, type SourceChapter } from './sources';
import { groupsOf, normGroup } from './releases';
import { CHAPTER_RETRY_CAP } from './updater';
import { chapterName } from './library';
import { HEALED_NAME } from './naming';
import { holds, isRange } from './chapterRanges';
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';

/**
 * `covered` (v0.50.0, lib/partAlias.ts R2): another site's split of a chapter on disk -- its 78.1 ... 78.9 where 78
 * is here as one file. Listed, so the series page can show it and a person can fetch it; never fetched by the
 * sweep or the slow archive (both take `available` only), never counted as missing, not a Komga ghost.
 */
export type ListingStatus = 'available' | 'held' | 'blocked' | 'covered';

/**
 * One copy of a number as the listing stores it: what the versions view shows, what the group panel
 * counts, and what a pick on a fetch is authorised against. `groups` is already split (groupsOf), so a
 * reader never has to know which source hands over structured groups and which a display string.
 */
export interface ListingCopy {
  sourceId: string;
  source: string;
  groups: string[];
  scanlator: string | null;
  lang: string | null;
  pages: number | null;
  publishedAt: string | null;
  /**
   * The copy's OWN title (v0.49.0, #116). Copies of one number used to share the row's title, which is right for
   * three groups' "Chapter 5" and wrong for the case #116 is about: posts that share a number and are different
   * chapters, whose versions sheet read twenty identical lines. Absent on rows written before v0.49.0, where the
   * row's title stands in, as it always did.
   */
  title?: string | null;
  /** The number the source gave the copy, when Uchiyomi renumbered it (posting order). */
  sourceNumber?: number;
}

export interface ListingRow {
  number: number;
  title: string | null;
  publishedAt: string | null;
  scanlator: string | null;
  /** Every group that released ANY copy of the number, deduped by normGroup, first spelling kept. */
  groups: string[];
  sourceId: string;
  /** The copy the release rules chose; for a blocked number, the first copy, kept only for display. */
  chosen: SourceChapter;
  /** EVERY copy of the number, the chosen one first, the rest as the release rules would rank them. */
  copies: ListingCopy[];
  status: ListingStatus;
}

/**
 * One row per finite chapter number out of everything the followed sources listed.
 *
 * `releases` is chooseReleases' pick per number and `held` its waiting set; a number in `tagged` with no
 * release is one whose every copy was dropped because only blocked groups released it, and it is kept as
 * `blocked` with its first copy so the page can still say who. `groups` is the union over ALL copies,
 * chosen or not: a group that released a copy the rules did not pick still released it, and the picker
 * has to be able to name it. The chosen copy's own source wins for `sourceId`; `fallbackSource` is for a
 * copy an adapter tagged with nothing, which inside updateSeries cannot happen (it stamps every copy) but
 * costs nothing to guard.
 *
 * Every copy is kept in `copies`, not only the chosen one. The chapter-versions list shows each with its
 * group, language, page count and date; the "who scanlates this" panel counts releases per group from
 * them; and a pick -- a person asking for THAT copy by source and id -- is authorised by finding it here,
 * the same footing the row gives a plain fetch. The chosen copy goes first so a reader of `copies[0]`
 * reads what the sweep would take; the rest follow in `order`, the release rules' own ranking, so the
 * list reads "best first" the way the sweep sees it rather than in whatever order the sites listed. With
 * no `order` the listing order stands.
 *
 * `covered` is lib/partAlias.ts's: numbers that are another split of a chapter on disk. A blocked number stays
 * blocked (nothing could be fetched for it either way); a covered one is never `held`, since nothing waits for it.
 */
export function listingRows(
  tagged: SourceChapter[], releases: SourceChapter[], held: Set<number>, fallbackSource: string,
  order?: (a: SourceChapter, b: SourceChapter) => number, covered: ReadonlySet<number> = new Set(),
): ListingRow[] {
  const chosenOf = new Map<number, SourceChapter>();
  for (const r of releases) if (Number.isFinite(r.number)) chosenOf.set(r.number, r);
  const byNumber = new Map<number, SourceChapter[]>();
  for (const c of tagged) {
    if (!Number.isFinite(c.number)) continue;
    const list = byNumber.get(c.number);
    if (list) list.push(c);
    else byNumber.set(c.number, [c]);
  }
  const out: ListingRow[] = [];
  for (const number of [...byNumber.keys()].sort((a, b) => a - b)) {
    const copies = byNumber.get(number)!;
    const chosen = chosenOf.get(number);
    const shown = chosen ?? copies[0];
    const groups: string[] = [];
    const seen = new Set<string>();
    for (const c of copies) {
      for (const name of groupsOf(c)) {
        const key = normGroup(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        groups.push(name);
      }
    }
    // By identity: chooseReleases returns the very objects it was given, and a number listed twice by one
    // group (a re-upload) must not have both entries read as chosen.
    const others = copies.filter((c) => c !== shown);
    if (order) others.sort(order);
    // Reintroduce by dropping `title`: "every copy keeps its own title" in seriesListing.test.ts reads undefined.
    const toCopy = (c: SourceChapter): ListingCopy => ({
      sourceId: c.sourceId,
      source: c.source ?? fallbackSource,
      groups: groupsOf(c),
      scanlator: c.scanlator ?? null,
      lang: c.lang ?? null,
      pages: typeof c.pages === 'number' && Number.isFinite(c.pages) ? c.pages : null,
      publishedAt: c.publishedAt && Number.isFinite(Date.parse(c.publishedAt)) ? c.publishedAt : null,
      title: c.title ?? null,
      ...(typeof c.sourceNumber === 'number' && Number.isFinite(c.sourceNumber) ? { sourceNumber: c.sourceNumber } : {}),
    });
    out.push({
      number,
      title: shown.title ?? null,
      publishedAt: shown.publishedAt ?? null,
      scanlator: shown.scanlator ?? null,
      groups,
      sourceId: shown.source ?? fallbackSource,
      chosen: shown,
      copies: [shown, ...others].map(toCopy),
      status: !chosen ? 'blocked' : covered.has(number) ? 'covered' : held.has(number) ? 'held' : 'available',
    });
  }
  return out;
}

/** Rows per INSERT statement. Parameters are 10 per row, and Postgres takes 65,535 per statement. */
const CHUNK = 500;

/**
 * Replace a series' listing whole, in one transaction, so a reader of the table never sees half of a
 * listing: the DELETE and the INSERTs commit together or not at all. Chunked because a long-running series
 * lists a thousand numbers and one VALUES list of that size is past what the driver should be handed.
 */
export async function replaceListing(seriesId: string, rows: ListingRow[]): Promise<void> {
  await tx(async (qq) => {
    // ⚠️ The series row first, then its listing rows: the order a delete of the series takes them in (the row,
    // then the cascade; Forget's FOR UPDATE, then its table-by-table deletes). Taken the other way round -- the
    // DELETE below locked the listing rows, and the INSERT's foreign-key check then waited on the series row --
    // a series deleted while a listing refresh was mid-write deadlocked with it, and Postgres could pick the
    // delete as the victim. The follow route starts exactly such a refresh in the background, and a test that
    // dropped its series a moment later failed at random with "deadlock detected". KEY SHARE is the lock that
    // foreign-key check takes anyway, so the sweep's own updates of the row never wait on it. A series deleted
    // first is gone once its delete commits, and there is nothing left to list.
    // Reintroduce by dropping this SELECT: "a series deleted while its listing is written" in
    // seriesListing.int.test.ts reads "deadlock detected".
    if (!(await qq('SELECT 1 FROM lib_series WHERE id = $1 FOR KEY SHARE', [seriesId])).length) return;
    await qq('DELETE FROM series_listing WHERE series_id = $1', [seriesId]);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const params: any[] = [seriesId];
      const tuples: string[] = [];
      for (const r of rows.slice(i, i + CHUNK)) {
        const b = params.length;
        tuples.push(`($1, $${b + 1}::real, $${b + 2}, $${b + 3}::timestamptz, $${b + 4}, $${b + 5}::text[], $${b + 6}, $${b + 7}::jsonb, $${b + 8}, $${b + 9}::jsonb)`);
        // An unparsable date is stored as no date rather than failing the whole listing: the source's
        // string is best-effort on scraped sites, and setBookDates already treats it that way.
        const at = r.publishedAt && Number.isFinite(Date.parse(r.publishedAt)) ? r.publishedAt : null;
        params.push(r.number, r.title, at, r.scanlator, r.groups, r.sourceId, JSON.stringify(r.chosen), r.status, JSON.stringify(r.copies));
      }
      await qq(
        `INSERT INTO series_listing (series_id, number, title, published_at, scanlator, groups, source_id, chosen, status, copies)
         VALUES ${tuples.join(',')}`,
        params,
      );
    }

    /**
     * Give a chapter its own name, when the listing knows one and the book has none yet.
     *
     * Every chapter fetched before the downloader recorded the source's name has none, and the listing being
     * written right here is the same data, for the same chapters, already in hand -- so the repair costs a
     * statement per check rather than a migration that can only run once. The name is worked out by the same
     * rule the downloader's stamp uses (library.ts chapterName, which knows "Vol.3 Chapter 12" and "第12話"
     * for the number again), in JavaScript, and written to `chapter_name` only -- never to `title`, the
     * filename's. A name already there is kept: the copy on disk named it -- unless it was BORROWED from
     * another source (lib/borrowNames.ts, `chapter_name_source`), which the chapter's own source outranks.
     *
     * ⚠️ And a healed name is MARKED as one (v0.49.0, `chapter_name_source` = HEALED_NAME): it is the name of the
     * copy the listing chose for the number, which need not be the copy on disk -- for a book downloaded before
     * names were stamped, it is the listing's guess, like the release date every sweep stamps (#116). Unmarked,
     * a renumber took it for the file's own name and a plan built on it read clean. A name a landing stamps later
     * (library.ts setBookMeta) is the file's own and clears the mark; the borrowed-name cleanup leaves it alone.
     * Reintroduce by writing NULL: "the chapter's own name is never replaced" in borrowNames.int.test.ts finds no
     * mark on the healed name.
     * The number is the override-aware one under posting order, as setBookMeta's (lib/library.ts BOOK_NUMBER):
     * the listing's numbers are posts' there, and a book the renumber could not rename keeps another post's
     * number as its raw one.
     * ⚠️ Nothing is healed while the series' numbering is in question (a change pending, or a renumber's journal):
     * the listing is then in numbers its files may not be in -- an add from another source writes the source's raw
     * numbers over files in posting numbers, a changed extension setting moves every number under the files -- so
     * a name healed now is another post's, and the renumber's plan would take it as evidence. Reintroduce by
     * healing regardless: "the raw listing vouches for no book" in numbering.int.test.ts finds a book moved to the
     * post whose name the heal gave it.
     */
    const named = new Map<number, string>();
    for (const r of rows) {
      const name = Number.isFinite(r.number) ? chapterName(r.title, r.number) : null;
      if (name && !named.has(r.number)) named.set(r.number, name);
    }
    const all = [...named];
    for (let i = 0; i < all.length; i += 1000) {        // well inside Postgres's 65 535 parameters
      const params: unknown[] = [seriesId, HEALED_NAME];
      const values = all.slice(i, i + 1000).map(([n, name]) => {
        params.push(n, name);
        return `($${params.length - 1}::real, $${params.length}::text)`;
      });
      await qq(
        `UPDATE lib_books b SET chapter_name = v.name, chapter_name_source = $2, updated_at = now()
           FROM (VALUES ${values.join(',')}) AS v(n, name), lib_series s
          WHERE b.series_id = $1 AND s.id = b.series_id
            AND (CASE WHEN s.numbering = 'posting_order'
                      THEN COALESCE((SELECT o.number FROM book_overrides o WHERE o.book_id = b.id), b.number) ELSE b.number END) = v.n
            -- A file holding a range (lib/chapterRanges.ts) is not the chapter its start lists: no name of one
            -- (chapterRanges.int.test.ts: "a range file took the name of the chapter its start lists").
            AND NOT ${isRange('b')}
            AND (b.chapter_name IS NULL OR (b.chapter_name_source IS NOT NULL AND b.chapter_name_source <> $2))
            AND s.numbering_pending IS NULL AND s.renumber_plan IS NULL`,
        params,
      );
    }
  });
}

/**
 * A stored copy as the downloader takes it. `groups` is the already-split list, which groupsOf reads back
 * identically (an array is authoritative), so the file's Translator tag and the lib_books.scanlator stamp
 * come out as they would have from the live listing. The title is the copy's own when it has one (v0.49.0):
 * a pick or a Replace… of one post must stamp THAT post's name, not the chosen copy's -- the row's title
 * stands in for copies stored before copies had titles.
 * Reintroduce by returning `row.title`: "a pick is stamped with the picked copy's title" in
 * seriesListing.test.ts reads the row's.
 */
export function copyToChapter(copy: ListingCopy, row: { number: number; title: string | null }): SourceChapter {
  return {
    sourceId: copy.sourceId,
    number: row.number,
    title: copy.title ?? row.title ?? undefined,
    pages: copy.pages ?? undefined,
    publishedAt: copy.publishedAt ?? undefined,
    scanlator: copy.scanlator ?? undefined,
    groups: copy.groups,
    lang: copy.lang ?? undefined,
    source: copy.source,
  };
}

export type GhostWhy = 'missing' | 'held' | 'blocked' | 'failed' | 'floor' | 'archive' | 'covered';

export interface Ghost {
  number: number;
  title: string | null;
  publishedAt: string | null;
  scanlator: string | null;
  groups: string[];
  sourceId: string;
  sourceName: string;
  why: GhostWhy;
  /** Only when the chapter has failed at least once: how many times. */
  attempts?: number;
  /** The downloader's last error text. Admins only: it names hosts and paths. */
  reason?: string;
  /**
   * Only when `why` is `held`, and only when a priority group survives the blocklist: the effective first
   * choice the number is being held for, so the row can say "waiting for Asura Scans" rather than
   * "waiting for a preferred group". Spelt as the preference names it.
   */
  waitingFor?: string;
  /** Only with `waitingFor`: whole days (never below 0) until the patience window closes and the sweep settles. */
  waitDaysLeft?: number;
  /**
   * Only when true: the viewer marked this number read although the server does not hold it (#69,
   * lib/listingProgress). Absent rather than false, so the answer for anyone with no marks is unchanged.
   */
  read?: true;
}

/**
 * Why a listed number is not on this server, one reason per ghost, in a fixed precedence.
 *
 * Floor first: a chapter below the Latest-N floor is out of the sweep's scope whatever else is true of it,
 * and the page collapses a run of those into one line, so nothing more specific may leak out of the run.
 * Blocked next: no copy the rules would take exists, so neither the retry cap nor the hold applies to
 * anything. Failed before held: a number the sweep has given up on is not "waiting" for anyone -- and a
 * failure count is the one reason with a number attached that the page shows in amber. Held, then plain
 * missing, which is the sweep simply not having got to it yet.
 *
 * Archive before all of them (#117): a number an active slow archive will fetch -- available, under the retry
 * cap, below its boundary -- is on its way, which is neither "older than where it was added" (a floor-less
 * series has no such place) nor missing. Only those: a capped, held or blocked number below the boundary keeps
 * its own reason, since the archive will not fetch it either. `archiveBoundary` is null with no active archive.
 * Reintroduce by testing the boundary after the cap: "the series page's reason for a number an active archive
 * will fetch" in archivePlan.test.ts reads archive for a capped number.
 *
 * Covered (v0.50.0) before the floor and everything after it: another split of a chapter on disk is neither an older
 * chapter not here yet -- folded into the floor's run, its row lost its words and the run's "Fetch all" took it --
 * nor missing, and a failure count from before the sweep knew that says nothing about it now. The archive never
 * takes a covered number (it fetches `available` only), so it cannot come first. Reintroduce by testing the floor
 * first: "another split below the floor" in seriesListing.test.ts reads floor.
 */
export function whyOf(status: ListingStatus, number: number, floor: number | null, attempts: number, archiveBoundary: number | null = null): GhostWhy {
  if (archiveBoundary != null && number < archiveBoundary && status === 'available' && attempts < CHAPTER_RETRY_CAP) return 'archive';
  if (status === 'covered') return 'covered';
  if (floor != null && number < floor) return 'floor';
  if (status === 'blocked') return 'blocked';
  if (attempts >= CHAPTER_RETRY_CAP) return 'failed';
  if (status === 'held') return 'held';
  return 'missing';
}

interface GhostRow {
  number: number; title: string | null; published_at: Date | null; scanlator: string | null;
  groups: string[]; source_id: string; status: ListingStatus; attempts: number | null; reason: string | null;
  copies: ListingCopy[] | null; marked: boolean;
}

const DAY_MS = 86_400_000;

/**
 * How many whole days a held number has left to wait, by the rule chooseReleases holds it under: the
 * OLDEST hosted copy's date plus the patience window, against the clock. Hosted only -- an external link
 * (pages === 0) is not a release anyone could read here, and the chooser ignores it for the same reason.
 * Null when no hosted copy is dated, which is a row the chooser could never have held; the caller then
 * says nothing rather than inventing a count. Never negative: the window can have closed since the last
 * sweep decided `held`, and "0 days left" is the honest reading until the next check settles the number.
 */
export function waitDaysLeftOf(copies: ListingCopy[], patienceMs: number, now = Date.now()): number | null {
  const dates = copies
    .filter((c) => c.pages !== 0 && c.publishedAt)
    .map((c) => Date.parse(c.publishedAt!))
    .filter((t) => Number.isFinite(t));
  if (!dates.length) return null;
  const oldest = Math.min(...dates);
  return Math.max(0, Math.ceil((oldest + patienceMs - now) / DAY_MS));
}

/**
 * The numbers the sources listed that this library has no row for, with the reason each is absent.
 *
 * A tombstone is a lib_books row and so is never a ghost: the chapter WAS here, somebody read it, and the
 * cleanup let the bytes go on purpose -- the series page shows that row with its badge, and "fetch again"
 * is the action on it, not "fetch". Only a number with no row at all is missing in the sense this list
 * means.
 *
 * ⚠️ THE ANTI-JOIN COMPARES THE OVERRIDE-AWARE NUMBER, `COALESCE(book_overrides.number, lib_books.number)`,
 * exactly as lib/komgaGhosts does. It used to compare the raw number, and a duplicate row was only cosmetic
 * then; since a ghost row carries read state (#69) it is not. A chapter whose filename parsed as 0 and that an
 * admin renumbered to 105 was a ghost at 105 here and a real row at 105 on the Komga surface, and
 * reconciliation (override-aware) moved the mark to the book while this page kept drawing an unmarked ghost.
 * Reintroduce by comparing `b.number = l.number`: "a renumbered chapter is not a ghost on the series page" in
 * listingProgress.int.test.ts finds 105 in the list. A number inside a file holding a range is that file's
 * (lib/chapterRanges.ts `holds`); reintroduce the plain equality and "a range file's numbers are no ghosts (the
 * series page)" in chapterRanges.int.test.ts finds 2 to 7.
 *
 * `userId` names whose marks set `read`; without it no row is marked.
 */
export async function listingFor(seriesId: string, opts: { floor: number | null; admin: boolean; userId?: string; archiveBoundary?: number | null }): Promise<{ checkedAt: string | null; content: Ghost[] }> {
  const s = await one<{ source_checked_at: Date | null }>('SELECT source_checked_at FROM lib_series WHERE id = $1', [seriesId]);
  const rows = await q<GhostRow>(
    `SELECT l.number, l.title, l.published_at, l.scanlator, l.groups, l.source_id, l.status, l.copies, f.attempts, f.reason,
            (lp.user_id IS NOT NULL) AS marked
       FROM series_listing l
       LEFT JOIN chapter_failures f ON f.series_id = l.series_id AND f.number = l.number
       LEFT JOIN listing_progress lp ON lp.user_id = $2 AND lp.series_id = l.series_id AND lp.number = l.number
      WHERE l.series_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM lib_books b
            LEFT JOIN book_overrides ov ON ov.book_id = b.id
           WHERE b.series_id = l.series_id AND ${holds('b', 'ov', 'l.number')})
      ORDER BY l.number`,
    [seriesId, opts.userId ?? null],
  );
  // The effective preferences, read once per listing and not per row: who a held number is waiting for
  // is the first priority group the blocklist leaves standing (priorityKeys in releases.ts drops a blocked
  // group from the priority list before the chooser ever ranks by it, so naming one here would promise a
  // group the sweep will never take). Read NOW rather than stored with the row, because a preference
  // change should show on the page at once and the row's `held` was decided at the last sweep. Absent
  // when nothing survives, and the page falls back to "waiting for a preferred group".
  const prefs = await effectivePrefsFor(await readSeriesPrefs(seriesId));
  const blocked = new Set(prefs.blocked.map(normGroup).filter(Boolean));
  const waitingFor = prefs.priority.find((p) => normGroup(p) && !blocked.has(normGroup(p)));
  const now = Date.now();
  const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
  return {
    checkedAt: iso(s?.source_checked_at ?? null),
    content: rows.map((r) => {
      const attempts = Number(r.attempts ?? 0);
      const g: Ghost = {
        number: Number(r.number),
        title: r.title,
        publishedAt: iso(r.published_at),
        scanlator: r.scanlator,
        groups: r.groups ?? [],
        sourceId: r.source_id,
        sourceName: getSource(r.source_id)?.name ?? r.source_id,
        why: whyOf(r.status, Number(r.number), opts.floor, attempts, opts.archiveBoundary ?? null),
      };
      if (attempts > 0) g.attempts = attempts;
      if (opts.admin && r.reason) g.reason = r.reason;
      if (r.marked) g.read = true;
      // Both fields or neither: a name with no end date, or a count with no name, is half a caption.
      if (g.why === 'held' && waitingFor) {
        // ⚠️ Only the copies the chooser RANKS. `copies` holds every copy of the number, blocked groups'
        // included (listingRows keeps them so the page can name who released what), but chooseReleases
        // drops a copy whose every known group is blocked before it takes the oldest date. Counted from
        // all of them, the caption undercounted: the blocked group is typically the fast MTL group that
        // posts first, so its copy is usually the oldest, and a row the sweep would hold for two more
        // days read "0 days left". A copy naming no group is never blocked, as in the chooser, and the
        // keys are taken through groupsOf as the chooser takes them, so the two agree on every spelling.
        const ranked = (r.copies ?? []).filter((c) => {
          const keys = groupsOf({ groups: c.groups, scanlator: c.scanlator ?? undefined }).map(normGroup);
          return !(keys.length && keys.every((k) => blocked.has(k)));
        });
        const days = waitDaysLeftOf(ranked, prefs.patienceMs, now);
        if (days != null) { g.waitingFor = waitingFor; g.waitDaysLeft = days; }
      }
      return g;
    }),
  };
}
