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

export type ListingStatus = 'available' | 'held' | 'blocked';

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
 */
export function listingRows(tagged: SourceChapter[], releases: SourceChapter[], held: Set<number>, fallbackSource: string): ListingRow[] {
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
    out.push({
      number,
      title: shown.title ?? null,
      publishedAt: shown.publishedAt ?? null,
      scanlator: shown.scanlator ?? null,
      groups,
      sourceId: shown.source ?? fallbackSource,
      chosen: shown,
      status: !chosen ? 'blocked' : held.has(number) ? 'held' : 'available',
    });
  }
  return out;
}

/** Rows per INSERT statement. Parameters are 9 per row, and Postgres takes 65,535 per statement. */
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
        tuples.push(`($1, $${b + 1}::real, $${b + 2}, $${b + 3}::timestamptz, $${b + 4}, $${b + 5}::text[], $${b + 6}, $${b + 7}::jsonb, $${b + 8})`);
        // An unparsable date is stored as no date rather than failing the whole listing: the source's
        // string is best-effort on scraped sites, and setBookDates already treats it that way.
        const at = r.publishedAt && Number.isFinite(Date.parse(r.publishedAt)) ? r.publishedAt : null;
        params.push(r.number, r.title, at, r.scanlator, r.groups, r.sourceId, JSON.stringify(r.chosen), r.status);
      }
      await qq(
        `INSERT INTO series_listing (series_id, number, title, published_at, scanlator, groups, source_id, chosen, status)
         VALUES ${tuples.join(',')}`,
        params,
      );
    }
  });
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
}

/**
 * The numbers the sources listed that this library has no row for, with the reason each is absent.
 *
 * A tombstone is a lib_books row and so is never a ghost: the chapter WAS here, somebody read it, and the
 * cleanup let the bytes go on purpose -- the series page shows that row with its badge, and "fetch again"
 * is the action on it, not "fetch". Only a number with no row at all is missing in the sense this list
 * means. The anti-join is on the raw number, which is the source's, like every stamp the updater writes.
 */
export async function listingFor(seriesId: string, opts: { floor: number | null; admin: boolean }): Promise<{ checkedAt: string | null; content: Ghost[] }> {
  const s = await one<{ source_checked_at: Date | null }>('SELECT source_checked_at FROM lib_series WHERE id = $1', [seriesId]);
  const rows = await q<GhostRow>(
    `SELECT l.number, l.title, l.published_at, l.scanlator, l.groups, l.source_id, l.status, f.attempts, f.reason
       FROM series_listing l
       LEFT JOIN chapter_failures f ON f.series_id = l.series_id AND f.number = l.number
      WHERE l.series_id = $1
        AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = l.series_id AND b.number = l.number)
      ORDER BY l.number`,
    [seriesId],
  );
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
      return g;
    }),
  };
}
