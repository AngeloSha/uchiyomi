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
import { effectivePrefsFor, readSeriesPrefs } from './scanlatorPrefs';

export type ListingStatus = 'available' | 'held' | 'blocked';

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
 */
export function listingRows(
  tagged: SourceChapter[], releases: SourceChapter[], held: Set<number>, fallbackSource: string,
  order?: (a: SourceChapter, b: SourceChapter) => number,
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
    const toCopy = (c: SourceChapter): ListingCopy => ({
      sourceId: c.sourceId,
      source: c.source ?? fallbackSource,
      groups: groupsOf(c),
      scanlator: c.scanlator ?? null,
      lang: c.lang ?? null,
      pages: typeof c.pages === 'number' && Number.isFinite(c.pages) ? c.pages : null,
      publishedAt: c.publishedAt && Number.isFinite(Date.parse(c.publishedAt)) ? c.publishedAt : null,
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
      status: !chosen ? 'blocked' : held.has(number) ? 'held' : 'available',
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
     * Give a chapter its own name, when the listing knows one and the book does not.
     *
     * A downloaded file is named from its NUMBER alone (lib/downloader.ts explains why), so the title the
     * scanner derives from the filename is the number said twice, and every chapter fetched before the
     * downloader learned to record the source's name is stuck that way. The listing being written right
     * here is the same data, for the same chapters, already in hand -- so the repair costs one statement
     * per check rather than a migration that can only run once.
     *
     * Only rows whose title is still a bare restatement of the number are touched, and only from a listing
     * title that is not itself one: many sources genuinely call every chapter "Chapter 12", and replacing
     * one restatement with another would be churn. Nothing an admin set by hand matches that pattern, so
     * an overridden title is never overwritten.
     */
    await qq(
      `UPDATE lib_books b
          SET title = l.title, updated_at = now()
         FROM series_listing l
        WHERE l.series_id = $1 AND b.series_id = $1
          AND abs(l.number - b.number) < 0.001
          AND l.title IS NOT NULL AND btrim(l.title) <> ''
          AND l.title !~* ('^(ch(apter|\\.)?|episode|ep\\.?)?\\s*0*' || l.number || '\\s*$')
          AND b.title ~* ('^(ch(apter|\\.)?|episode|ep\\.?)?\\s*0*' || b.number || '\\s*$')`,
      [seriesId],
    );
  });
}

/**
 * A stored copy as the downloader takes it. `groups` is the already-split list, which groupsOf reads back
 * identically (an array is authoritative), so the file's Translator tag and the lib_books.scanlator stamp
 * come out as they would have from the live listing. The title is the row's: a copy stores none of its
 * own, and the number's title is the same whichever group released it.
 */
export function copyToChapter(copy: ListingCopy, row: { number: number; title: string | null }): SourceChapter {
  return {
    sourceId: copy.sourceId,
    number: row.number,
    title: row.title ?? undefined,
    pages: copy.pages ?? undefined,
    publishedAt: copy.publishedAt ?? undefined,
    scanlator: copy.scanlator ?? undefined,
    groups: copy.groups,
    lang: copy.lang ?? undefined,
    source: copy.source,
  };
}

export type GhostWhy = 'missing' | 'held' | 'blocked' | 'failed' | 'floor';

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
 */
export function whyOf(status: ListingStatus, number: number, floor: number | null, attempts: number): GhostWhy {
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
 * listingProgress.int.test.ts finds 105 in the list.
 *
 * `userId` names whose marks set `read`; without it no row is marked.
 */
export async function listingFor(seriesId: string, opts: { floor: number | null; admin: boolean; userId?: string }): Promise<{ checkedAt: string | null; content: Ghost[] }> {
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
           WHERE b.series_id = l.series_id AND COALESCE(ov.number, b.number) = l.number)
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
        why: whyOf(r.status, Number(r.number), opts.floor, attempts),
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
