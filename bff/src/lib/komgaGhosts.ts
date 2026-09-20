// The chapters this server does NOT hold, listed to the Komga-compatible API so the trackers behind it can
// count. Opt-in, off by default (server_settings.komga_ghost_chapters).
//
// WHY THIS EXISTS. Mihon derives a series' chapter total from the chapter list this API answers, and the
// Komga tracker turns those counts into UNREAD / READING / COMPLETED and a "last chapter read" it pushes on
// to AniList and MAL. A library running the read-chapter cleanup lists only what is still on disk, so a
// thousand-chapter manhwa read up to 1000 and pruned behind the reader reported a total of one, and the
// trackers followed it down. The numbers are all there -- series_listing holds what the sources listed and
// lib_books holds a tombstone for every pruned file -- they were simply never surfaced here.
//
// Two kinds of absent chapter, one presentation:
//
//   tombstone  a lib_books row whose file the cleanup deleted (pruned_at). It was here, somebody read it,
//              and its read_progress row is still keyed to it. Already counted correctly by every progress
//              path; it was hidden from the LIST only, by the extension's `media_status=READY` filter.
//   ghost      a series_listing number with no lib_books row at all. Never downloaded: below the chapter
//              floor, held for a preferred group, blocked, failed, or simply not got to yet.
//
// Neither can be opened, and both say so in the row itself rather than only when tapped -- the extension's
// default chapter name is `{number} - {title} ({size})` and pastes `size` in verbatim, so a ghost reads
// "1041 - Chapter 1041 (not downloaded)" in the list (lib/komgaDto.ts komgaGhostBook).
//
// ⚠️ NO PLACEHOLDER PAGE. It is tempting to answer one image saying "not downloaded". Mihon marks a chapter
// read when it is viewed, which would push the tracker progress this whole feature exists to repair. A ghost
// answers an empty page list, exactly as a tombstone already does (lib/ownedCatalog bookPages).
//
// ⚠️ NOT listingFor(). The web app's ghost rows carry why a chapter is absent, how many times it failed, who
// it is waiting for, and -- for admins -- the downloader's error text, which names hosts and paths. None of
// that belongs on a phone credential. This module reads the same table and takes five columns.
import { q, one } from './db';
import { seriesVisible, type ViewCtx } from './visibility';

/**
 * Is the opt-in on?
 *
 * Re-read per request and never cached, like every other setting in this codebase (lib/chapterCleanup's
 * cleanupSettings says why): an admin turning it off must see it take effect without a restart. Defaults to
 * OFF on an unreadable row -- the narrower answer is the one that cannot surprise a paired phone.
 */
export async function ghostsEnabled(): Promise<boolean> {
  const row = await one<{ on: boolean }>(
    'SELECT komga_ghost_chapters AS on FROM server_settings WHERE id = 1',
  ).catch(() => null);
  return row?.on === true;
}

/**
 * A ghost's synthetic book id: `g_<series id>~<number>`, e.g. `g_s_1f3c…~10.5`.
 *
 * ⚠️ THE SEPARATOR IS `~`, AND IT HAS TO BE SOMETHING LIKE IT. The obvious `g_<series>_<number>` is
 * ambiguous: `g_s_x_1_5` reads equally as series `s_x` chapter 1.5 and as series `s_x_1` chapter 5, and a
 * parser has to guess. `~` cannot occur in either half -- a series id is `s_` and hex (lib/ids.ts) and a
 * number is digits, a sign and a point -- so the split is exact. It is also RFC 3986 *unreserved*, like the
 * `.` kept for the decimal, so both survive a URL path segment unencoded; the extension pastes this id into
 * an image URL by hand.
 *
 * Deliberately NOT validated against the `s_[0-9a-f]{20}` shape. Nothing here needs to know what a series id
 * looks like, and pinning it would mean a future id format silently breaking every ghost link. The id is a
 * claim, not an authorisation: `ghostBookById` proves it by looking the series up through `seriesVisible`.
 */
const GHOST_RE = /^g_(.+)~(-?\d+(?:\.\d+)?)$/;

/**
 * Mint the id for a ghost.
 *
 * The series id is IN the id, and that is the point: a ghost has no row, so there is nothing to look up to
 * find out whose chapter it is. Carrying it means the read side can put it through the ordinary
 * `seriesVisible` gate instead of trusting the caller.
 */
export function ghostId(seriesId: string, number: number): string {
  return `g_${seriesId}~${number}`;
}

/** Read a ghost id back, or null if it is not one. Shape only -- it proves nothing about visibility. */
export function parseGhostId(id: string): { seriesId: string; number: number } | null {
  const m = GHOST_RE.exec(id);
  if (!m) return null;
  const number = Number(m[2]);
  return Number.isFinite(number) ? { seriesId: m[1], number } : null;
}

/** Cheap enough to run before a database round trip, and the routes do. */
export const isGhostId = (id: string): boolean => GHOST_RE.test(id);

/** A listed chapter with no file, shaped like the subset of a book DTO that komgaGhostBook reads. */
export interface GhostBook {
  id: string;
  seriesId: string;
  seriesTitle: string;
  number: number;
  title: string | null;
  releaseDate: string | null;
  scanlator: string | null;
}

interface Row {
  number: string | number;
  title: string | null;
  published_at: Date | null;
  scanlator: string | null;
}

const iso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/**
 * Every number the sources listed for this series that has no lib_books row.
 *
 * The anti-join is lib/seriesListing's, on the raw number, which is the source's -- the same quantity the
 * updater stamps and the same one lib_books.number carries, so a chapter that IS on disk can never also
 * appear as a ghost. Tombstones are lib_books rows and so are excluded here by construction; they reach the
 * list from the ordinary query, which is what keeps their read_progress attached.
 *
 * No floor filter. A chapter below lib_series.chapter_floor is one this server chose not to fetch, but it is
 * still a chapter of the series, and the tracker total is wrong without it -- which is the whole reason this
 * function exists.
 *
 * The series title comes from the JOIN rather than from the caller's first book row: the series this matters
 * most for is the one with NO books -- followed, never fetched, every chapter a ghost -- and there is no row
 * there to take a title from. `seriesTitle` is a required string in the Kotlin DTO.
 *
 * ⚠️ VISIBILITY IS THE CALLER'S. This takes a series id and reads a table with no library column; it is safe
 * only because every caller has already put the series through `seriesVisible`. Keeping the gate in the
 * routes rather than here means there is exactly one place per route to check, next to the 404 it produces.
 */
export async function ghostBooksFor(seriesId: string): Promise<GhostBook[]> {
  const rows = await q<Row & { series_title: string | null }>(
    `SELECT l.number, l.title, l.published_at, l.scanlator, s.title AS series_title
       FROM series_listing l
       JOIN lib_series s ON s.id = l.series_id
      WHERE l.series_id = $1
        AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = l.series_id AND b.number = l.number)
      ORDER BY l.number`,
    [seriesId],
  );
  return rows.map((r) => {
    const number = Number(r.number);
    return {
      id: ghostId(seriesId, number),
      seriesId,
      seriesTitle: r.series_title ?? '',
      number,
      title: r.title,
      releaseDate: iso(r.published_at),
      scanlator: r.scanlator,
    };
  });
}

/**
 * One ghost by id, for the single-book and page routes.
 *
 * Unlike ghostBooksFor this DOES gate: the id names its own series, so a caller handing one in has not
 * necessarily proved anything about it, and the routes that take a book id have no other series to check.
 * Answers null for a series this viewer cannot open and for a number the listing no longer has -- both
 * become the same 404, so a ghost id cannot be used to probe for series or chapters.
 */
export async function ghostBookById(id: string, ctx: ViewCtx): Promise<GhostBook | null> {
  const parsed = parseGhostId(id);
  if (!parsed) return null;
  if (!(await seriesVisible(parsed.seriesId, ctx))) return null;
  const row = await one<Row & { series_title: string }>(
    `SELECT l.number, l.title, l.published_at, l.scanlator, s.title AS series_title
       FROM series_listing l
       JOIN lib_series s ON s.id = l.series_id
      WHERE l.series_id = $1 AND l.number = $2::real
        AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = l.series_id AND b.number = l.number)`,
    [parsed.seriesId, parsed.number],
  );
  if (!row) return null;
  const number = Number(row.number);
  return {
    id: ghostId(parsed.seriesId, number),
    seriesId: parsed.seriesId,
    seriesTitle: row.series_title ?? '',
    number,
    title: row.title,
    releaseDate: iso(row.published_at),
    scanlator: row.scanlator,
  };
}

/**
 * The ghost numbers of a series, for the progress endpoint's totals.
 *
 * Numbers only: readProgressV2 counts them and compares them, and never shows them.
 */
export async function ghostNumbers(seriesId: string): Promise<number[]> {
  const rows = await q<{ number: string | number }>(
    `SELECT l.number
       FROM series_listing l
      WHERE l.series_id = $1
        AND NOT EXISTS (SELECT 1 FROM lib_books b WHERE b.series_id = l.series_id AND b.number = l.number)
      ORDER BY l.number`,
    [seriesId],
  );
  return rows.map((r) => Number(r.number));
}
