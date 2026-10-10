// One copy of each chapter after a merge (v0.57.0).
//
// The owner, merging two copies of a series: every chapter of the absorbed one moved across, so a chapter both had was
// listed twice -- "not needed, I don't want that". Until v0.57.0 a merge left it so on purpose (lib/libraryAdmin.ts):
// removing a copy means folding what people read of two rows into one, and getting that wrong marks chapters unread and
// syncs it outward. This does it, and carefully:
//
//  - WHICH NUMBERS. One the kept series held exactly one live copy of and the absorbed series exactly one, and nothing
//    else holds. A number either side held twice or more -- an extra filed under its chapter's number (Gachiakuta 17
//    beside 17e), a chapter's parts (One Piece 1053a-d), two versions -- is never touched, nor a series numbered by
//    posting order or with a renumbering pending. Never by page count: two sites cut one strip into 6 pages or into 165
//    (measured on the owner's library before release: 573 of 1,365 such pairs differ by more than half).
//  - WHICH COPY STAYS. The kept series' -- the one the admin chose -- unless its copy has placeholder pages and the other
//    is whole, or its file is not there and the other's is. A pair whose file is not reachable at all (the folder gone:
//    an unmounted share, not a deleted chapter) is left exactly as it is.
//  - THE OTHER COPY LEAVES THE LIST. A tombstone would not do: a deleted chapter is still listed ("Deleted from the
//    server" on the series page, a second chapter 12 in Mihon; lib/ownedCatalog.ts bookDto `pruned`). What was filed
//    under it moves to the copy that stays (removeCopy), its row goes, and its file is deleted when it is in the download
//    folder -- the only place this server deletes from -- and set aside anywhere else (lib/setAside.ts).
//  - A COPY SOMEBODY BOOKMARKED STAYS: a bookmark names a page inside that file, and the copy that stays has other pages.
//
// Two callers: a merge, for the numbers it just brought together (removeMergeDuplicates, from mergeSeries), and the
// one-time clean-up of the merges made before v0.57.0 (lib/mergeLeftovers.ts), by folder. Both hold the series' folders.
import type { FastifyRequest } from 'fastify';
import { rm, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { q, one, tx } from './db';
import { DL_ROOT } from './library';
import { allWritable, containedPath, realContainedPath } from './fsGuard';
import { REFETCH_BAK } from './fsAtomic';
import { logAudit } from './audit';
import { visibleToAll } from './visibility';

/** One live chapter row, as this module weighs it. `number` is the effective one (an admin's override first). */
export interface Copy {
  id: string;
  seriesId: string;
  root: string;
  file: string;
  number: number;
  /** It has placeholder pages (lib_books.missing_pages): a partial copy. */
  partial: boolean;
  /** Its page count when known (lib_books.pages; 0 when never opened). */
  pages: number;
}

/** A number the two sides each held once: `kept` is the kept series' copy, `other` the absorbed series'. */
export interface CopyPair { number: number; kept: Copy; other: Copy }

/** Why a pair was left with both copies. */
export type LeftWhy = 'bookmarked' | 'unreachable' | 'busy';

/** What removing a series' extra copies did. */
export interface ExtraCopiesResult {
  /** Copies taken off the list. */
  removed: number;
  /** Of those, the files deleted from the download folder, and their bytes. */
  deleted: number;
  bytes: number;
  /** Of those, the files left on disk, set aside (lib/setAside.ts). */
  setAside: number;
  /** Numbers still held twice, and why. */
  left: Partial<Record<LeftWhy, number>>;
  /** The numbers removed, for the audit line (the first 50). */
  numbers: number[];
}

const empty = (): ExtraCopiesResult => ({ removed: 0, deleted: 0, bytes: 0, setAside: 0, left: {}, numbers: [] });

/** Every live chapter row of a series, with its effective number. */
export async function liveCopies(seriesId: string): Promise<Copy[]> {
  const rows = await q<{ id: string; series_id: string; root: string | null; file: string; number: number; partial: boolean; pages: number | null }>(
    `SELECT b.id, b.series_id, COALESCE(b.root, '') AS root, b.file, COALESCE(o.number, b.number)::float8 AS number,
            (b.missing_pages IS NOT NULL) AS partial, b.pages
       FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id
      WHERE b.series_id = $1 AND b.pruned_at IS NULL`, [seriesId]);
  return rows.map((r) => ({
    id: r.id, seriesId: r.series_id, root: r.root ?? '', file: r.file, number: Number(r.number),
    partial: !!r.partial, pages: Number(r.pages) || 0,
  }));
}

/**
 * The numbers held exactly twice: once on the kept side, once on the other, and by nothing else. Every number held any
 * other way -- twice on one side (an extra beside its chapter, a chapter's parts), three times -- is not a pair.
 */
export function pairUp(copies: readonly Copy[], isKept: (c: Copy) => boolean, isOther: (c: Copy) => boolean): CopyPair[] {
  const byNumber = new Map<number, Copy[]>();
  for (const c of copies) {
    if (!Number.isFinite(c.number)) continue;
    const list = byNumber.get(c.number);
    if (list) list.push(c);
    else byNumber.set(c.number, [c]);
  }
  const out: CopyPair[] = [];
  for (const [number, list] of byNumber) {
    if (list.length !== 2) continue;
    const kept = list.filter(isKept);
    const other = list.filter(isOther);
    if (kept.length !== 1 || other.length !== 1 || kept[0] === other[0]) continue;
    out.push({ number, kept: kept[0], other: other[0] });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Where a copy's file stands: there, gone (its folder is there), or not reachable (its folder is not: a missing mount). */
export type FileState = { kind: 'present'; mtime: number; size: number } | { kind: 'gone' } | { kind: 'unreachable' };

/** Exported for a read-only dry run over a real library (what removeExtraCopies would do, without doing it). */
export async function fileState(c: Copy): Promise<FileState> {
  const abs = c.root ? containedPath(c.root, c.file) : null;
  if (!abs) return { kind: 'unreachable' };
  const st = await stat(abs).catch(() => null);
  if (st) return { kind: 'present', mtime: Math.floor(st.mtimeMs), size: st.size };
  return (await stat(dirname(abs)).catch(() => null)) ? { kind: 'gone' } : { kind: 'unreachable' };
}

/**
 * Which copy of a pair stays, given where their files stand: the kept series' copy, unless it is partial and the other
 * whole, or its file is gone and the other's is there. Null when the pair is better left as it is: either file not
 * reachable, or neither there.
 */
export function chooseCopy(pair: CopyPair, kept: FileState, other: FileState): { keep: Copy; drop: Copy } | null {
  if (kept.kind === 'unreachable' || other.kind === 'unreachable') return null;
  if (kept.kind === 'gone' && other.kind === 'gone') return null;
  if (kept.kind === 'gone') return { keep: pair.other, drop: pair.kept };
  if (pair.kept.partial && !pair.other.partial && other.kind === 'present') return { keep: pair.other, drop: pair.kept };
  return { keep: pair.kept, drop: pair.other };
}

/**
 * Take one copy off the list, the copy that stays inheriting what was filed under it. In one transaction: progress
 * (completed when either was; the newer page, scaled to the kept copy's page count when both are known -- two sites cut
 * one chapter into different pages), reading history and notes re-pointed, the dropped copy's offline-download rows
 * dropped (a device's saved pages are of the other copy), its file named in set_aside_files when it is still on disk,
 * and its row deleted (book_overrides and page_hashes go with it). Refused -- nothing changes -- when a bookmark points
 * into it. The file itself is dealt with after the commit (removeExtraCopies), so a crash in between leaves a set-aside
 * file, never a chapter listed twice.
 */
async function removeCopy(keep: Copy, drop: Copy, dropFile: FileState): Promise<'removed' | 'bookmarked'> {
  return tx(async (qq) => {
    const marked = await qq<{ n: number }>('SELECT count(*)::int AS n FROM bookmarks WHERE book_id = $1', [drop.id]);
    if (Number(marked[0]?.n) > 0) return 'bookmarked' as const;
    await qq(
      `INSERT INTO read_progress (user_id, book_id, series_id, page, completed, updated_at)
       SELECT user_id, $2, $3,
              CASE WHEN $4::int > 0 AND $5::int > 0 THEN LEAST($5::int - 1, (page * $5::int) / $4::int) ELSE page END,
              completed, updated_at
         FROM read_progress WHERE book_id = $1
       ON CONFLICT (user_id, book_id) DO UPDATE SET
         completed = read_progress.completed OR EXCLUDED.completed,
         page = CASE WHEN EXCLUDED.updated_at > read_progress.updated_at THEN EXCLUDED.page ELSE read_progress.page END,
         updated_at = GREATEST(read_progress.updated_at, EXCLUDED.updated_at)`,
      [drop.id, keep.id, keep.seriesId, drop.pages, keep.pages]);
    await qq('DELETE FROM read_progress WHERE book_id = $1', [drop.id]);
    await qq('UPDATE reading_events SET book_id = $2, series_id = $3 WHERE book_id = $1', [drop.id, keep.id, keep.seriesId]);
    await qq('UPDATE notes SET book_id = $2 WHERE book_id = $1', [drop.id, keep.id]);
    await qq('DELETE FROM offline_downloads WHERE book_id = $1', [drop.id]);
    if (dropFile.kind === 'present') {
      await qq(
        `INSERT INTO set_aside_files (root, file, series_id, number, kept_book_id, reason, mtime, size)
         VALUES ($1, $2, $3, $4, $5, 'duplicate', $6, $7)
         ON CONFLICT (root, file) DO UPDATE SET series_id = EXCLUDED.series_id, number = EXCLUDED.number,
           kept_book_id = EXCLUDED.kept_book_id, reason = EXCLUDED.reason, mtime = EXCLUDED.mtime, size = EXCLUDED.size,
           created_at = now()`,
        [drop.root, drop.file, keep.seriesId, drop.number, keep.id, dropFile.mtime, dropFile.size]);
    }
    await qq('DELETE FROM lib_books WHERE id = $1', [drop.id]);
    return 'removed' as const;
  });
}

/**
 * Delete a set-aside file the server may delete: one in the download folder, resolved inside it at the moment of the
 * unlink (deleteChapterFiles' rule, lib/libraryAdmin.ts), never the folder itself. Its set-aside row goes with it. False
 * -- the file stays set aside -- anywhere else, or when the unlink fails.
 */
async function deleteSetAside(c: Copy): Promise<boolean> {
  if (c.root !== DL_ROOT) return false;
  const abs = containedPath(DL_ROOT, c.file);
  if (!abs || abs === resolve(DL_ROOT)) return false;
  if (await realContainedPath(DL_ROOT, c.file) !== abs) return false;
  try { await rm(abs, { force: true }); } catch { return false; }
  // A set-aside copy from a refetch the process died in (deleteChapterFiles says why): it must not come back at boot.
  await rm(`${abs}${REFETCH_BAK}`, { force: true }).catch(() => {});
  await q('DELETE FROM set_aside_files WHERE root = $1 AND file = $2', [c.root, c.file]).catch(() => {});
  return true;
}

/**
 * Remove the extra copy of every pair, then put the series' rollups right (count, newest, cover -- as mergeSeries does)
 * and write one audit line. The caller holds the series' folders.
 */
export async function removeExtraCopies(
  seriesId: string, pairs: readonly CopyPair[],
  o: { userId: string | null; via?: string; runId?: string; req?: FastifyRequest },
): Promise<ExtraCopiesResult> {
  const out = empty();
  if (!pairs.length) return out;
  const writable = (await allWritable([DL_ROOT]).catch(() => ({ ok: false }))).ok;
  for (const pair of pairs) {
    const [k, x] = await Promise.all([fileState(pair.kept), fileState(pair.other)]);
    const choice = chooseCopy(pair, k, x);
    if (!choice) { out.left.unreachable = (out.left.unreachable ?? 0) + 1; continue; }
    const dropFile = choice.drop === pair.kept ? k : x;
    const done = await removeCopy(choice.keep, choice.drop, dropFile);
    if (done === 'bookmarked') { out.left.bookmarked = (out.left.bookmarked ?? 0) + 1; continue; }
    out.removed++;
    if (out.numbers.length < 50) out.numbers.push(pair.number);
    if (dropFile.kind !== 'present') continue;
    if (writable && await deleteSetAside(choice.drop)) { out.deleted++; out.bytes += dropFile.size; }
    else out.setAside++;
  }
  if (out.removed) {
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
  await logAudit('series.extra_copies', {
    userId: o.userId,
    detail: { id: seriesId, title, ...out, ...(o.via ? { via: o.via } : {}), ...(o.runId ? { runId: o.runId } : {}) },
    req: o.req,
  });
  return out;
}

/**
 * The series a copy count is not safe to read numbers in: numbered by posting order (two posts may share a number on
 * purpose), or half-way through a renumbering. Hidden or merged-away series are not touched either.
 */
async function numbersSettled(seriesId: string): Promise<boolean> {
  const s = await one<{ ok: boolean }>(
    `SELECT (${visibleToAll('s')} AND s.numbering IS DISTINCT FROM 'posting_order'
             AND s.numbering_pending IS NULL AND s.renumber_plan IS NULL) AS ok
       FROM lib_series s WHERE s.id = $1`, [seriesId]).catch(() => null);
  return !!s?.ok;
}

/**
 * After a merge: the numbers it brought together -- the books it moved (`moved`) against the survivor's own -- each kept
 * once. Called by mergeSeries after its transaction commits, with the merge's folder claim still held by its caller.
 */
export async function removeMergeDuplicates(
  intoId: string, moved: readonly string[],
  o: { userId: string | null; via?: string; runId?: string; req?: FastifyRequest },
): Promise<ExtraCopiesResult> {
  if (!moved.length || !(await numbersSettled(intoId))) return empty();
  const came = new Set(moved);
  const pairs = pairUp(await liveCopies(intoId), (c) => !came.has(c.id), (c) => came.has(c.id));
  return removeExtraCopies(intoId, pairs, o);
}

/**
 * A survivor of merges made before v0.57.0: the copies in its own folder against the copies in the folders of the series
 * it absorbed (lib_series.merged_into). Its files keep their paths through a merge, so the folder says which side a copy
 * came from. Empty when its numbers are not settled.
 */
export async function leftoverPairs(seriesId: string): Promise<CopyPair[]> {
  if (!(await numbersSettled(seriesId))) return [];
  const own = await one<{ folder: string }>('SELECT folder FROM lib_series WHERE id = $1', [seriesId]);
  if (!own?.folder) return [];
  const absorbed = (await q<{ folder: string }>('SELECT folder FROM lib_series WHERE merged_into = $1', [seriesId]))
    .map((r) => r.folder).filter((f) => f && f !== own.folder);
  if (!absorbed.length) return [];
  const under = (folder: string) => (c: Copy) => c.file.startsWith(`${folder}/`);
  const inOwn = under(own.folder);
  const inAbsorbed = (c: Copy) => !inOwn(c) && absorbed.some((f) => under(f)(c));
  return pairUp(await liveCopies(seriesId), inOwn, inAbsorbed);
}
