// What a removed source leaves behind.
//
// A source followed by mistake (the wrong series on the site, often one with MORE chapters than the real one) fetched
// chapters this series never had. Taking the source off used to leave them all: the files, their rows, their
// tombstones once deleted, and everyone's read marks. Each such row kept its number in the updater's have-set
// (lib/updater.ts reads it by number, from any source), so when the real series reached that number the sweep took it
// as held and never fetched it, and a reader's mark on the wrong chapter carried onto the real one.
//
// So removing a source takes with it every chapter ONLY it lists, as though it had never been fetched:
//  - WHICH: rows of this series stamped with that source (lib_books.source_id, written when its file landed) whose
//    number -- the file's own and an admin's override, and every number of a range -- no source the series still
//    follows lists (series_listing, every copy of every row). Live chapters and tombstones alike: a tombstone is what
//    blocks the fetch. Only in the download folder; a library somebody assembled by hand is theirs.
//  - NOTHING when no other source is left (the admin's call: detaching a series' only source keeps its chapters, as a
//    site going down must not empty a shelf).
//  - WHAT GOES: the file (and a set-aside refetch copy), the row (book_overrides, page_hashes, comments, reactions,
//    spread marks and translations cascade), its reading progress, bookmarks and offline-download rows, and the
//    by-number read marks and failure entries of every number only that source listed. reading_events stays: it is
//    the append-only record of what was read (lib/migrate.ts), and counts nothing the sweep looks at.
//  - A row whose file cannot be removed (unreadable, its folder missing: an unmounted share) is left as it is.
//
// leftoversOf is the preview (the Sources sheet asks it before the ×); purgeLeftovers does it. The caller holds the
// series' writer claim (routes/admin.ts claimSeriesWriter).
import type { FastifyRequest } from 'fastify';
import { rm, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { q, one, tx } from './db';
import { DL_ROOT } from './library';
import { allWritable, containedPath, realContainedPath, statOrGone } from './fsGuard';
import { REFETCH_BAK } from './fsAtomic';
import { logAudit } from './audit';
import { heldBy } from './chapterRanges';
import { numKey } from './postingOrder';
import { MAX_RANGE } from './naming';

/** One chapter row a removed source supplied and nothing else lists. */
export interface LeftoverBook {
  id: string;
  /** The file's own number. */
  number: number;
  /** An admin's number for it, when there is one. */
  override: number | null;
  /** The end of the file's range, when it holds several chapters. */
  end: number | null;
  root: string;
  file: string;
  pruned: boolean;
}

export interface Leftovers {
  /** The sources the series keeps: main and followers, less the one going. Empty: nothing is purged. */
  others: string[];
  /** The rows that go. */
  books: LeftoverBook[];
  /** Every number only the removed source listed or held: read marks and failure entries on these go too. */
  numbers: number[];
  /** Readers with progress on a row that goes, or a read mark on a number that goes. */
  readers: number;
}

const none = (others: string[] = []): Leftovers => ({ others, books: [], numbers: [], readers: 0 });

/** The sources a series follows: its main and every follower. */
async function sourcesOf(seriesId: string): Promise<string[]> {
  const s = await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [seriesId]);
  const f = await q<{ source_id: string }>('SELECT source_id FROM series_sources WHERE series_id = $1', [seriesId]);
  return [...new Set([...(s?.source_id ? [s.source_id] : []), ...f.map((r) => r.source_id)])];
}

/** Every number listed for the series by a source in `sources`: each copy of each row, or the row's own source. */
async function listedBy(seriesId: string, sources: readonly string[]): Promise<number[]> {
  if (!sources.length) return [];
  const rows = await q<{ number: number }>(
    `SELECT DISTINCT l.number::float8 AS number
       FROM series_listing l
       CROSS JOIN LATERAL (SELECT e ->> 'source' AS source
                             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.copies) = 'array' THEN l.copies ELSE '[]'::jsonb END) e
                           UNION SELECT l.source_id) c
      WHERE l.series_id = $1 AND c.source = ANY($2::text[])`, [seriesId, sources]);
  return rows.map((r) => Number(r.number)).filter(Number.isFinite);
}

/** Is any of `listed` (a held-by test over numbers) one of the numbers this book holds? */
function listedFor(b: LeftoverBook, listed: Set<number>, sorted: number[]): boolean {
  if (listed.has(numKey(b.number))) return true;
  if (b.override != null && listed.has(numKey(b.override))) return true;
  if (b.override == null && b.end != null && b.end > b.number && b.end - b.number <= MAX_RANGE) {
    return sorted.some((n) => n >= b.number && n <= b.end!);
  }
  return false;
}

/**
 * What removing `sourceId` from the series would take with it (see the header). Read-only. `sourceId` may already be
 * off the series (the route asks after a detach promoted a follower): the remaining sources are everything else.
 */
export async function leftoversOf(seriesId: string, sourceId: string): Promise<Leftovers> {
  const others = (await sourcesOf(seriesId)).filter((s) => s !== sourceId);
  if (!others.length) return none();
  const elsewhere = await listedBy(seriesId, others);
  const listed = new Set(elsewhere.map(numKey));
  const sorted = [...elsewhere].sort((a, b) => a - b);
  const rows = await q<{ id: string; number: number; override: number | null; end: number | null; root: string | null; file: string; pruned: boolean }>(
    `SELECT b.id, b.number::float8 AS number, ov.number::float8 AS override, b.number_end::float8 AS end,
            b.root, b.file, (b.pruned_at IS NOT NULL) AS pruned
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND b.source_id = $2
      ORDER BY b.number, b.file`, [seriesId, sourceId]);
  const books: LeftoverBook[] = rows
    // The download folder only: a file anywhere else arrived some other way, and is not this server's to delete.
    .filter((r) => r.root === DL_ROOT)
    .map((r) => ({
      id: r.id, number: Number(r.number), override: r.override == null ? null : Number(r.override),
      end: r.end == null ? null : Number(r.end), root: r.root as string, file: r.file, pruned: !!r.pruned,
    }))
    .filter((b) => !listedFor(b, listed, sorted));
  const goingIds = new Set(books.map((b) => b.id));
  // The numbers that go: what only this source lists, and what the going rows hold -- less anything another row keeps.
  const here = await listedBy(seriesId, [sourceId]);
  const stays = await q<{ number: number; end: number | null }>(
    `SELECT COALESCE(ov.number, b.number)::float8 AS number,
            CASE WHEN ov.number IS NULL AND b.number_end > b.number AND b.number_end <= b.number + ${MAX_RANGE} THEN b.number_end::float8 END AS end
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND NOT (b.id = ANY($2::text[]))`, [seriesId, [...goingIds]]);
  const kept = heldBy(stays);
  const numbers = new Map<number, number>();
  for (const n of here) if (!listed.has(numKey(n))) numbers.set(numKey(n), n);
  for (const b of books) {
    const n = b.override ?? b.number;
    numbers.set(numKey(n), n);
  }
  for (const k of [...numbers.keys()]) if (kept.has(numbers.get(k)!)) numbers.delete(k);
  const nums = [...numbers.values()].sort((a, b) => a - b);
  if (!books.length && !nums.length) return none(others);
  const readers = await one<{ n: number }>(
    `SELECT count(DISTINCT user_id)::int AS n FROM (
       SELECT user_id FROM read_progress WHERE book_id = ANY($2::text[])
       UNION SELECT user_id FROM listing_progress WHERE series_id = $1 AND number = ANY($3::real[])
     ) u`, [seriesId, [...goingIds], nums]);
  return { others, books, numbers: nums, readers: Number(readers?.n) || 0 };
}

/** What purgeLeftovers did. */
export interface PurgeResult {
  /** Rows taken off the list. */
  removed: number;
  /** Bytes of the files deleted with them. */
  bytes: number;
  /** Rows left as they are, and why. */
  left: Array<{ id: string; reason: 'unlink_failed' | 'outside_root' | 'unreachable' }>;
}

/** Whether the download folder may be written, when any of `books` still has a file. Null: yes, or nothing to write. */
export async function purgeRefusal(books: readonly LeftoverBook[]): Promise<{ reason: string; fix?: string } | null> {
  if (!books.some((b) => !b.pruned)) return null;
  const w = await allWritable([DL_ROOT]);
  return w.ok ? null : { reason: w.reason, fix: w.fix };
}

/**
 * Take the leftovers off the series (see the header). The file first, then the row: a file that could not be removed
 * keeps its row, so nothing on disk is ever unlisted. One audit line, `series.source_leftovers`.
 */
export async function purgeLeftovers(
  seriesId: string, sourceId: string, left: Leftovers, o: { userId: string | null; req?: FastifyRequest },
): Promise<PurgeResult> {
  const out: PurgeResult = { removed: 0, bytes: 0, left: [] };
  if (!left.books.length && !left.numbers.length) return out;
  const root = resolve(DL_ROOT);
  const gone: string[] = [];
  for (const b of left.books) {
    const abs = containedPath(DL_ROOT, b.file);
    if (!abs || abs === root) { out.left.push({ id: b.id, reason: 'outside_root' }); continue; }
    if (!b.pruned) {
      const looked = await statOrGone(abs);
      if (typeof looked === 'string') { out.left.push({ id: b.id, reason: 'unlink_failed' }); continue; }
      if (await realContainedPath(DL_ROOT, b.file) !== abs) { out.left.push({ id: b.id, reason: 'outside_root' }); continue; }
      if (looked) {
        try { await rm(abs, { recursive: true, force: true }); }
        catch { out.left.push({ id: b.id, reason: 'unlink_failed' }); continue; }
        out.bytes += looked.size;
      } else if (!(await stat(dirname(abs)).catch(() => null))) {
        // The file and its folder both absent: the volume is not there, not a chapter gone (deleteChapterFiles says why).
        out.left.push({ id: b.id, reason: 'unreachable' });
        continue;
      }
    }
    // A set-aside copy from a refetch the process died in must not come back at boot as this chapter.
    await rm(`${abs}${REFETCH_BAK}`, { force: true }).catch(() => {});
    gone.push(b.id);
  }
  const keptIds = new Set(out.left.map((l) => l.id));
  // A number whose row could not go keeps its marks: they are still that row's.
  const keptNumbers = new Set(left.books.filter((b) => keptIds.has(b.id)).map((b) => numKey(b.override ?? b.number)));
  const numbers = left.numbers.filter((n) => !keptNumbers.has(numKey(n)));
  await tx(async (qq) => {
    if (gone.length) {
      // read_progress.book_id is ON DELETE RESTRICT (lib/migrate.ts): a read row would refuse the DELETE below.
      await qq('DELETE FROM read_progress WHERE book_id = ANY($1::text[])', [gone]);
      await qq('DELETE FROM bookmarks WHERE book_id = ANY($1::text[])', [gone]);
      await qq('DELETE FROM offline_downloads WHERE book_id = ANY($1::text[])', [gone]);
      const del = await qq<{ id: string }>('DELETE FROM lib_books WHERE series_id = $1 AND id = ANY($2::text[]) RETURNING id', [seriesId, gone]);
      out.removed = del.length;
    }
    if (numbers.length) {
      await qq('DELETE FROM listing_progress WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, numbers]);
      await qq('DELETE FROM chapter_failures WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, numbers]);
    }
  });
  if (out.removed) {
    // The rollups as a merge's clean-up puts them right (lib/extraCopies.ts): count, newest, and the lowest live cover.
    await q(
      `UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
         FROM (SELECT count(*) n, max(mtime) mt FROM lib_books WHERE series_id = $1) c
        WHERE s.id = $1`, [seriesId]);
    await q(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
       ) WHERE id = $1`, [seriesId]);
  }
  const title = (await one<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [seriesId]).catch(() => null))?.title ?? null;
  await logAudit('series.source_leftovers', {
    userId: o.userId,
    detail: {
      id: seriesId, title, source: sourceId, removed: out.removed, bytes: out.bytes, left: out.left.length,
      numbers: numbers.slice(0, 50),
    },
    req: o.req,
  });
  return out;
}

/**
 * Of the chosen chapters of a series, the ones no source it follows lists (series_listing, any copy): once deleted,
 * nothing can fetch them again. For the Delete from server confirmation's warning.
 */
export async function unlistedOf(seriesId: string, bookIds: readonly string[]): Promise<string[]> {
  if (!bookIds.length) return [];
  const sources = await sourcesOf(seriesId);
  const elsewhere = await listedBy(seriesId, sources);
  const listed = new Set(elsewhere.map(numKey));
  const sorted = [...elsewhere].sort((a, b) => a - b);
  const rows = await q<{ id: string; number: number; override: number | null; end: number | null }>(
    `SELECT b.id, b.number::float8 AS number, ov.number::float8 AS override, b.number_end::float8 AS end
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND b.id = ANY($2::text[])`, [seriesId, [...new Set(bookIds)]]);
  return rows
    .map((r) => ({
      id: r.id, number: Number(r.number), override: r.override == null ? null : Number(r.override),
      end: r.end == null ? null : Number(r.end), root: '', file: '', pruned: false,
    }))
    .filter((b) => !listedFor(b, listed, sorted))
    .map((b) => b.id);
}
