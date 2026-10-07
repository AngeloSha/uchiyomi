// Destructive library operations: hide a series, restore it, and merge one into another.
//
// Deleting HIDES rather than erases. The id survives, so favourites, ratings, notes and -- above all --
// reading history stay attached to something real, the action is undoable, and we never have to choose
// between erasing someone's reading events (which silently rewrites their stats, streaks and Wrapped) and
// leaving a dead series in Trending. persistScan() knows to skip a hidden folder, or the next scan would
// simply bring it back under a new id.
//
// Merging does NOT de-duplicate chapters, deliberately. Every chapter row and every progress row survives
// exactly as it is. The moment you delete a chapter because it looks like a duplicate, you have to fold two
// read_progress rows into one, and getting that wrong silently marks chapters unread -- which then syncs
// outward to the user's AniList account and cannot be undone. Duplicate chapter numbers are a tidiness
// problem the health page can surface; lost reading progress is not recoverable.
import type { FastifyRequest } from 'fastify';
import { rm, rename, realpath, stat, readdir } from 'fs/promises';
import { q, one, tx } from './db';
import { artFile } from './seriesArt';
import { allWritable, containedPath, realContainedPath } from './fsGuard';
import { tombstoneBooks } from './chapterCleanup';
import { LIBRARY_ROOT, DL_ROOT, listChapters } from './library';
import { reconcileListingProgress } from './listingProgress';
import { carryAltTitles } from './altTitles';
import { dissolveLoneWork } from './editions';
import { join, dirname, relative, resolve, sep, isAbsolute } from 'path';
import { isDesktop } from './desktop';
import { toStoredRel, dirnameRel } from './relPath';
import { REFETCH_BAK } from './fsAtomic';
import { logAudit } from './audit';
import { carries, standingsOf } from './sourceStanding';
import { followGuard } from './seriesLang';
import { MAX_FOLLOWERS } from './autoFollow';

export interface SeriesRow {
  id: string;
  title: string;
  folder: string;
  deleted_at: string | null;
  merged_into: string | null;
}

export const getSeriesRow = (id: string) =>
  one<SeriesRow>(`SELECT id, title, folder, deleted_at, merged_into FROM lib_series WHERE id = $1`, [id]);

/** Remove the derived, per-series art: the DB row and the two files nothing else ever sweeps. */
async function dropArt(id: string): Promise<void> {
  await q(`DELETE FROM series_art WHERE series_id = $1`, [id]).catch(() => {});
  await q(`DELETE FROM series_overrides WHERE series_id = $1`, [id]).catch(() => {});
  for (const kind of ['cover', 'banner'] as const) {
    await rm(artFile(id, kind), { force: true }).catch(() => {});
  }
}

/**
 * Hide a series. Its chapters, and everything a user owns about it, stay in place.
 *
 * The tracker link goes, because it is what the duplicate-series health check matches on: leaving it means
 * the check reports the pair forever, and a later re-add flags as a duplicate of something invisible.
 */
export async function deleteSeries(id: string): Promise<{ ok: true; books: number }> {
  const books = await one<{ n: number }>(`SELECT count(*)::int n FROM lib_books WHERE series_id = $1`, [id]);
  await tx(async (qq) => {
    await qq(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [id]);
    await qq(`DELETE FROM series_trackers WHERE series_id = $1`, [id]);
    // A slow archive (#117) goes with it: re-added later, the series starts from what is there then, never from
    // a boundary it had in an earlier life. The row's FK cascades only on a hard delete, and this is a soft one.
    await qq(`DELETE FROM archive_queue WHERE series_id = $1`, [id]);
  });
  return { ok: true, books: books?.n ?? 0 };
}

export async function restoreSeries(id: string): Promise<{ ok: true }> {
  await q(`UPDATE lib_series SET deleted_at = NULL WHERE id = $1`, [id]);
  return { ok: true };
}

/** Why one series cannot be merged into another (mergeRefusal). The admin route answers each with its own status. */
export type MergeRefusal =
  | { refused: 'same_series' | 'not_found' | 'same_work' }
  | { refused: 'deleted' | 'merged'; which: 'source' | 'target' };

/**
 * The merge route's checks, before anything moves: POST /api/admin/series/:id/merge and, since v0.55.0, Fix everything's
 * duplicates phase (lib/autofix.ts) both ask them. Null when `fromId` may be merged into `intoId`: two different series,
 * both there, neither hidden nor merged away, and not two language editions of one work (their chapters are two
 * languages: merged, the list would hold both under one number each).
 */
export async function mergeRefusal(fromId: string, intoId: string): Promise<MergeRefusal | null> {
  if (fromId === intoId) return { refused: 'same_series' };
  const from = await getSeriesRow(fromId);
  const into = await getSeriesRow(intoId);
  if (!from || !into) return { refused: 'not_found' };
  for (const [row, which] of [[from, 'source'], [into, 'target']] as const) {
    if (row.deleted_at) return { refused: 'deleted', which };
    if (row.merged_into) return { refused: 'merged', which };
  }
  const works = await q<{ work_id: string | null }>('SELECT work_id FROM lib_series WHERE id = ANY($1)', [[fromId, intoId]]);
  if (works.length === 2 && works[0].work_id && works[0].work_id === works[1].work_id) return { refused: 'same_work' };
  return null;
}

export interface MergeResult {
  ok: true;
  moved: number;
  favorites: number;
  ratings: number;
  collections: number;
  /** v0.55.0: the absorbed copy's main source, now a source the survivor follows; null when it was not carried. */
  carried: string | null;
}

/**
 * The optimistic route/autofix check is only an explanation for the caller. The merge repeats it after taking both
 * series-row locks; this error means another process changed one end before those locks were acquired.
 */
export class MergeConflictError extends Error {
  constructor(readonly refusal: MergeRefusal) {
    super(`merge no longer allowed: ${refusal.refused}`);
    this.name = 'MergeConflictError';
  }
}

/**
 * The absorbed copy's main source, when the survivor can follow it (v0.55.0): it still carries a series -- usable, or
 * only cooling down (lib/sourceStanding.ts) -- it is not the survivor's own main source, it is in the survivor's
 * language (the follow guard every automatic follow passes), and the survivor is not numbered by posting order, whose
 * followers are never merged. Null otherwise. The follower cap is the INSERT's own, inside the merge.
 */
async function carryable(fromId: string, intoId: string): Promise<{ sourceId: string; ref: string; title: string } | null> {
  const rows = await q<{ id: string; title: string; source_id: string | null; source_series_id: string | null; numbering: string | null }>(
    'SELECT id, title, source_id, source_series_id, numbering FROM lib_series WHERE id = ANY($1::text[])', [[fromId, intoId]]);
  const from = rows.find((r) => r.id === fromId);
  const into = rows.find((r) => r.id === intoId);
  if (!from?.source_id || !from.source_series_id || !into) return null;
  if (from.source_id === into.source_id || into.numbering === 'posting_order') return null;
  const standing = (await standingsOf([from.source_id])).get(from.source_id);
  if (!standing || !carries(standing)) return null;
  if (!(await followGuard(intoId))(from.source_id)) return null;
  return { sourceId: from.source_id, ref: from.source_series_id, title: from.title };
}

/**
 * Fold `fromId` into `intoId`. Everything the absorbed series held moves; nothing is deleted.
 *
 * The tables keyed `(user_id, series_id)` are the awkward ones: a user who had BOTH series favourited would
 * violate the primary key on a plain UPDATE, so those are insert-if-absent then drop. series_seen's counter
 * is recomputed rather than carried over -- summing two "how many chapters had you seen" values would give
 * everyone a phantom NEW badge, or hide one.
 */
export async function mergeSeries(fromId: string, intoId: string): Promise<MergeResult> {
  // The standing/language checks use several ordinary pool reads. Do them before opening the transaction so a burst
  // of unrelated merges cannot occupy every pool client and then deadlock waiting for another one. Core source facts
  // are compared again under the row locks below before this candidate may be carried.
  const carryCandidate = await carryable(fromId, intoId).catch(() => null);
  return tx(async (qq) => {
    if (fromId === intoId) throw new MergeConflictError({ refused: 'same_series' });
    // Stable lock order prevents two opposite/crossing merges from deadlocking. More importantly, the visibility and
    // edition checks happen again *under* the locks: two BFF processes can both pass mergeRefusal(), but only the first
    // may move rows. The second observes the first one's merged_into (or a concurrent hide) and refuses.
    const locked = await qq<SeriesRow & { work_id: string | null; source_id: string | null; source_series_id: string | null; numbering: string | null }>(
      `SELECT id, title, folder, deleted_at, merged_into, work_id, source_id, source_series_id, numbering
         FROM lib_series WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [[fromId, intoId]],
    );
    const from = locked.find((r) => r.id === fromId);
    const into = locked.find((r) => r.id === intoId);
    if (!from || !into) throw new MergeConflictError({ refused: 'not_found' });
    if (from.deleted_at) throw new MergeConflictError({ refused: 'deleted', which: 'source' });
    if (into.deleted_at) throw new MergeConflictError({ refused: 'deleted', which: 'target' });
    if (from.merged_into) throw new MergeConflictError({ refused: 'merged', which: 'source' });
    if (into.merged_into) throw new MergeConflictError({ refused: 'merged', which: 'target' });
    if (from.work_id && from.work_id === into.work_id) throw new MergeConflictError({ refused: 'same_work' });

    const carry = carryCandidate
      && from.source_id === carryCandidate.sourceId && from.source_series_id === carryCandidate.ref
      && into.source_id !== carryCandidate.sourceId && into.numbering !== 'posting_order'
      ? { ...carryCandidate, title: from.title } : null;
    const moved = await qq<{ id: string }>(
      `UPDATE lib_books SET series_id = $2 WHERE series_id = $1 RETURNING id`,
      [fromId, intoId],
    );

    // (user_id, series_id) — union, keeping whatever the survivor already had
    const favs = await qq<{ user_id: string }>(
      `INSERT INTO favorites (user_id, series_id, created_at)
       SELECT user_id, $2, created_at FROM favorites WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING RETURNING user_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM favorites WHERE series_id = $1`, [fromId]);

    const rates = await qq<{ user_id: string }>(
      `INSERT INTO ratings (user_id, series_id, stars, updated_at)
       SELECT user_id, $2, stars, updated_at FROM ratings WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING RETURNING user_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM ratings WHERE series_id = $1`, [fromId]);

    const cols = await qq<{ collection_id: string }>(
      `INSERT INTO collection_items (collection_id, series_id, position)
       SELECT collection_id, $2, position FROM collection_items WHERE series_id = $1
       ON CONFLICT (collection_id, series_id) DO NOTHING RETURNING collection_id`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM collection_items WHERE series_id = $1`, [fromId]);

    // NEW badges: recompute against the merged size rather than carrying a stale count across
    await qq(
      `INSERT INTO series_seen (user_id, series_id, seen_books_count, seen_at)
       SELECT user_id, $2, 0, seen_at FROM series_seen WHERE series_id = $1
       ON CONFLICT (user_id, series_id) DO NOTHING`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM series_seen WHERE series_id = $1`, [fromId]);
    // The absorbed series' slow archive (#117) ends here: its boundary was in its own numbers, and the survivor
    // is queued, or not, as itself.
    await qq(`DELETE FROM archive_queue WHERE series_id = $1`, [fromId]);

    // Keyed on book_id, so the books moving is enough — no collision is possible, and every progress row
    // and every reading event survives untouched. This is the whole reason merge does not de-duplicate.
    // ⚠️ bookmarks belong in this list. Until v0.38.0 they were left behind with the absorbed id: the
    // bookmark itself still resolved (the bookmarks route joins lib_books, whose row had moved), but
    // anything keyed on the series -- and above all Forget, which erases everything filed under an
    // absorbed id -- saw a live bookmark on a chapter the reader could still open as belonging to a dead
    // series. Reintroduce by dropping 'bookmarks' here: "merge: a bookmark follows its chapter to the
    // survivor" in forgetSeries.int.test.ts finds it still filed under the absorbed id.
    for (const t of ['read_progress', 'reading_events', 'notes', 'offline_downloads', 'bookmarks']) {
      await qq(`UPDATE ${t} SET series_id = $2 WHERE series_id = $1`, [fromId, intoId]);
    }
    // The tracker high-water mark is keyed (user, series, provider) with no book to follow, so it carries
    // over like a favourite: insert if absent, and where both series had one the survivor keeps the HIGHER
    // count -- the mark only ever moves forward, because a lower one silently rewinds someone's real
    // AniList entry on the next push (the column's note in lib/migrate.ts). Reintroduce by dropping the
    // GREATEST (or this whole statement): "merge: the tracker floor carries to the survivor and never goes
    // backwards" in forgetSeries.int.test.ts reads the smaller count, or none.
    await qq(
      `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
       SELECT user_id, $2, provider, chapters, pushed_at FROM tracker_progress WHERE series_id = $1
       ON CONFLICT (user_id, series_id, provider) DO UPDATE
         SET chapters = GREATEST(tracker_progress.chapters, EXCLUDED.chapters)`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM tracker_progress WHERE series_id = $1`, [fromId]);
    // Read marks on chapters neither series held (#69, lib/listingProgress) are keyed (user, series, number)
    // with no book to follow, so they carry like the floor above: insert if absent, and where both series had
    // a mark on the same number the EARLIER time wins -- reconciliation stamps read_progress with it, and the
    // earliest claim is the one that can never make a fetched file look read after it landed. Then the
    // survivor is reconciled at once: the absorbed series' chapters now sit under it, and a mark on a number
    // the survivor now holds would otherwise stay inert (and the Komga run would drop below the marks) until
    // some later scan. Reintroduce by dropping the reconcile: "merge: marks carry to the survivor, the earliest
    // time wins, and the chapters it now holds are reconciled" in forgetSeries.int.test.ts finds the mark
    // still a mark and the run at 0.
    await qq(
      `INSERT INTO listing_progress (user_id, series_id, number, completed_at, source)
       SELECT user_id, $2, number, completed_at, source FROM listing_progress WHERE series_id = $1
       ON CONFLICT (user_id, series_id, number) DO UPDATE
         SET completed_at = LEAST(listing_progress.completed_at, EXCLUDED.completed_at)`,
      [fromId, intoId],
    );
    await qq(`DELETE FROM listing_progress WHERE series_id = $1`, [fromId]);
    await reconcileListingProgress({ run: qq, seriesId: intoId });
    // The other names (v0.49.1, lib/altTitles.ts) go with the chapters: an admin who merged two rows has said they
    // are one work, and the absorbed row's names are that work's names -- a search for another source asks under
    // them. The survivor keeps its own row where both had a name. Reintroduce by dropping this: "a merge carries
    // the other names to the survivor" in altTitles.int.test.ts finds them still on the absorbed row.
    await carryAltTitles(qq, fromId, intoId);

    // Point the absorbed row at its survivor instead of deleting it: its folder still exists on disk, and
    // persistScan needs this to keep putting those files under the merged series.
    // A row merged away is no language edition of anything any more (v0.52.0, lib/editions.ts): it leaves its work --
    // or it would keep holding its language's slot there -- and a work it leaves with one edition dissolves. The route
    // refuses a merge inside one work (`same_work`). Reintroduce by dropping the work_id clear: "a row merged away is
    // no edition" in editions.int.test.ts fails; by dropping the dissolve: "the edition a merge leaves alone stands on
    // its own" does.
    const [gone] = await qq<{ work_id: string | null }>('SELECT work_id FROM lib_series WHERE id = $1', [fromId]);
    await qq(`UPDATE lib_series SET merged_into = $2, work_id = NULL WHERE id = $1`, [fromId, intoId]);
    await dissolveLoneWork(qq, gone?.work_id);
    // Flatten the chain: anything `fromId` had absorbed EARLIER now points at the final survivor too. Both
    // readers of `merged_into` follow exactly one hop and stop -- persistScan (lib/library.ts) files a
    // merged folder's chapters under `known.merged_into`, and the batch importer's `have` map joins the
    // absorbed title to its survivor `WHERE visibleToAll(survivor)`. After m→t then t→u, a chain left as
    // m→t→u has m's chapters rescanned under the now-invisible t, and m's title reads "not in your
    // library" so /run adds a second copy of a series the admin folded together twice. ⚠️ The merge route
    // refuses a source or target that is itself merged, but not a target that has absorbed others, so the
    // chain is reachable from the UI. Reintroduce by dropping this UPDATE: "a title absorbed two merges ago
    // still reads owned by the final survivor" in importBatch.int.test.ts finds m still pointing at t.
    await qq(`UPDATE lib_series SET merged_into = $2 WHERE merged_into = $1`, [fromId, intoId]);
    await qq(`DELETE FROM series_trackers WHERE series_id = $1`, [fromId]);
    // v0.55.0: the absorbed copy's working main source becomes a source the survivor follows, under the follower cap
    // (the count autoFollow.ts followJudged writes under, the survivor's row locked). The merge used to leave it on the
    // absorbed row, which nothing updates any more: a duplicate merged into the copy on a dead source took the one
    // source that worked with it. A source the survivor follows already is left as it is. Reintroduce by dropping it:
    // "merge: the absorbed copy's working main source" in libraryAdmin.int.test.ts finds the survivor following nothing.
    let carried: string | null = null;
    if (carry) {
      await qq('SELECT id FROM lib_series WHERE id = $1 FOR UPDATE', [intoId]);
      const got = await qq<{ source_id: string }>(
        `INSERT INTO series_sources (series_id, source_id, source_series_id, title)
         SELECT $1::text, $2::text, $3::text, $4::text
          WHERE (SELECT count(*) FROM series_sources WHERE series_id = $1 AND source_id <> $2) < $5::int
         ON CONFLICT (series_id, source_id) DO NOTHING
         RETURNING source_id`,
        [intoId, carry.sourceId, carry.ref, carry.title, MAX_FOLLOWERS]);
      carried = got[0]?.source_id ?? null;
    }

    // The survivor's rollups are now wrong
    await qq(
      `UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
         FROM (SELECT count(*) n, max(mtime) mt FROM lib_books WHERE series_id = $1) c
        WHERE s.id = $1`,
      [intoId],
    );
    // The lowest LIVE chapter, the same way persistScan picks it: a tombstone (lib/chapterCleanup.ts) has
    // no first page for the thumbnails to fall back to.
    await qq(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
       ) WHERE id = $1`,
      [intoId],
    );

    return {
      ok: true as const,
      moved: moved.length,
      favorites: favs.length,
      ratings: rates.length,
      collections: cols.length,
      carried,
    };
  }).then(async (r) => {
    // outside the transaction: filesystem work must not hold it open
    await dropArt(fromId);
    return r;
  });
}

/** What deleteChapterFiles answers: what it did, what it passed over and why, or the folder refusing writes. */
export type DeletedChapters =
  | { applied: number; bytes: number; skipped: Array<{ id: string; reason: string }> }
  | { refused: { reason: string; fix?: string } };

/** Durable progress hooks used by the detached bulk job. Direct/admin-autofix deletes do not need a journal. */
export type ChapterDeleteJournalItem = {
  id: string;
  root: string;
  file: string;
  position: number;
  bytes: number;
};
export type ChapterDeleteJournal = {
  /** Must commit before the first unlink. */
  beforeUnlink: (item: ChapterDeleteJournalItem) => Promise<void>;
  /** Test scheduling and observability point: the file is gone but its row is not a tombstone yet. */
  afterUnlink?: (item: ChapterDeleteJournalItem) => Promise<void>;
  /** Commits the terminal disposition of every requested chapter. */
  settled: (item: ChapterDeleteJournalItem & { outcome: 'applied' | 'skipped'; reason?: string }) => Promise<void>;
};

/**
 * Delete the files of chosen chapters of one series and keep their rows as tombstones, so reading history survives and
 * the updater's have-set still contains the number (the same reasoning as the cleanup's, on the column's note in
 * lib/migrate.ts). Delete-then-mark per file, so a failed unlink leaves an honest row. POST
 * /api/admin/series/:id/chapters/delete, and since v0.55.0 Fix everything's files phase (lib/autofix.ts, `via:
 * 'autofix'`), both run it: a bookmarked chapter, a file outside the download folder and the root itself are never
 * touched, whoever asks. Audited as `series.chapters_delete`.
 */
export async function deleteChapterFiles(
  id: string, bookIds: readonly string[], o: {
    userId: string | null;
    req?: FastifyRequest;
    via?: 'autofix';
    runId?: string;
    journal?: ChapterDeleteJournal;
  },
): Promise<DeletedChapters> {
  const row = await getSeriesRow(id);
  const ids = [...new Set(bookIds)];
  const rows = new Map((await q<{ id: string; root: string | null; file: string; number: number; pruned_at: string | null }>(
    'SELECT id, root, file, number, pruned_at FROM lib_books WHERE series_id = $1 AND id = ANY($2)', [id, ids])).map((r) => [r.id, r]));
  // The same veto the cleanup applies, for the same reason: a bookmark names a page number INSIDE the
  // file, so deleting the pages turns it into a pointer at nothing. Progress survives a delete (it is a
  // count); a bookmark does not, and the admin clicking Delete cannot see whose it is.
  // Reintroduce by dropping this lookup: "a bookmarked chapter is skipped, and says so" in
  // chapterActions.int.test.ts finds the file gone.
  const bookmarked = new Set((await q<{ book_id: string }>(
    'SELECT DISTINCT book_id FROM bookmarks WHERE book_id = ANY($1)', [ids])).map((r) => r.book_id));

  const skipped: Array<{ id: string; reason: string }> = [];
  const todo: Array<{ id: string; abs: string; rel: string; position: number }> = [];
  const root = resolve(DL_ROOT);
  const recordSkip = async (
    bid: string, reason: string, position: number,
    book?: { root: string | null; file: string }, bytes = 0,
  ) => {
    skipped.push({ id: bid, reason });
    await o.journal?.settled({
      id: bid, root: book?.root ?? '', file: book?.file ?? '', position, bytes, outcome: 'skipped', reason,
    });
  };
  for (let position = 0; position < ids.length; position++) {
    const bid = ids[position];
    const r = rows.get(bid);
    if (!r) { await recordSkip(bid, 'not_found', position); continue; }
    // Reintroduce by dropping this check: "delete removes the file, keeps the row and the progress, skips
    // the read library" in chapterActions.int.test.ts fails -- the read library's file is gone.
    if (r.root !== DL_ROOT) { await recordSkip(bid, 'not_owned', position, r); continue; }
    if (r.pruned_at) { await recordSkip(bid, 'already_pruned', position, r); continue; }
    if (bookmarked.has(bid)) { await recordSkip(bid, 'bookmarked', position, r); continue; }
    const abs = containedPath(DL_ROOT, r.file);
    // A path that escapes its root is refused, never "cleaned up" -- the health page can argue about it.
    // So is the root ITSELF: containedPath accepts it, the rm below is recursive, and a row whose file
    // resolves to `.` (a hand-edited row is the only way today) would take the whole download directory.
    // Reintroduce by dropping the `abs === root` half: "the download root itself is never a chapter" in
    // chapterActions.int.test.ts finds the directory gone.
    if (!abs || abs === root) { await recordSkip(bid, 'outside_root', position, r); continue; }
    todo.push({ id: bid, abs, rel: r.file, position });
  }
  if (todo.length) {
    const w = await allWritable([DL_ROOT]);
    if (!w.ok) return { refused: { reason: w.reason, fix: w.fix } };
  }
  let applied = 0;
  let bytes = 0;
  for (const t of todo) {
    // Re-resolve at the destructive boundary. A lexically contained row can still walk through an
    // intermediate (or final) symlink to an unrelated file; an absent final file is safe only when its
    // nearest existing parent resolves under the real download root.
    if (await realContainedPath(DL_ROOT, t.rel) !== t.abs) {
      await recordSkip(t.id, 'outside_root', t.position, { root: DL_ROOT, file: t.rel });
      continue;
    }
    const st = await stat(t.abs).catch(() => null);
    const item: ChapterDeleteJournalItem = {
      id: t.id, root: DL_ROOT, file: t.rel, position: t.position, bytes: st?.size ?? 0,
    };
    if (st) {
      // This commit is the recovery boundary: after it, a new process knows this exact owned row/path may have been
      // unlinked. If the process dies before tombstoneBooks, startup reconciles the intent against disk and the row.
      await o.journal?.beforeUnlink(item);
      try { await rm(t.abs, { recursive: true, force: true }); }
      catch {
        await recordSkip(t.id, 'unlink_failed', t.position, { root: DL_ROOT, file: t.rel }, st.size);
        continue;
      }
      // A set-aside copy from a refetch the process died in (`<file>.refetch-bak` beside the landed file,
      // which reapStaleTemp deliberately leaves alone) must not outlive a deliberate delete of the file:
      // at the next boot the reaper would see a bak with no original, put it back, and the chapter the
      // admin deleted would be on disk again, un-marked by the next scan, its space never reclaimed.
      // Reintroduce by dropping this rm: "a stray set-aside copy goes with the file" in
      // chapterActions.int.test.ts finds the bak still there.
      await rm(`${t.abs}${REFETCH_BAK}`, { force: true }).catch(() => {});
      await o.journal?.afterUnlink?.(item);
    } else if (!(await stat(dirname(t.abs)).catch(() => null))) {
      // ⚠️ The file is missing AND so is its folder: that is the volume not being there (an unmounted
      // share whose empty mount point passed the preflight), not a chapter somebody removed by hand.
      // Marking on that evidence would tombstone a chapter whose file is fine on the unmounted disk and
      // throw away everything measured about it; the row is left as it is and the answer says why.
      // Reintroduce by dropping this branch: "a missing download folder is not a deleted chapter" in
      // chapterActions.int.test.ts finds pruned_at set.
      await recordSkip(t.id, 'unlink_failed', t.position, { root: DL_ROOT, file: t.rel });
      continue;
    } else {
      // The folder is mounted and the file is already absent. The intent still precedes the destructive database
      // mark, so a crash during tombstoning has the same deterministic recovery path as a completed unlink.
      await o.journal?.beforeUnlink(item);
    }
    // A file already gone -- its folder still there -- is still marked: the row was claiming bytes that
    // do not exist.
    await tombstoneBooks([t.id], 'deleted');
    bytes += item.bytes;
    applied++;
    await o.journal?.settled({ ...item, outcome: 'applied' });
  }
  // The cover follows the lowest LIVE chapter, the way persistScan and mergeSeries pick it: every
  // thumbnail falls back to the cover chapter's first page, and a tombstone has none.
  if (applied) {
    await q(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
       ) WHERE id = $1`, [id]);
  }
  await logAudit('series.chapters_delete', {
    userId: o.userId,
    detail: {
      id, title: row?.title ?? null, bookIds: ids, applied, bytes,
      ...(o.via ? { via: o.via } : {}),
      ...(o.runId ? { runId: o.runId } : {}),
    },
    req: o.req,
  });
  return { applied, bytes, skipped };
}

// ---- forget ----
//
// The third step, after Remove (hides, undoable) and Delete files (the bytes go, the rows and everyone's
// history stay). Forget is the only code path in the app that hard-deletes a series row, and with it the
// only one that erases reading history across users: progress, events, bookmarks, notes, ratings,
// favourites, tracker floors. That retroactively rewrites stats, streaks, the leaderboard and Wrapped for
// everyone who read it, which is why it is a separate, typed-confirmation step and never a shortcut.
//
// Two invariants the preconditions protect:
//   1. Nothing forgotten may come back. persistScan skips a folder only while a deleted_at / merged_into row
//      exists for it (lib/library.ts), so once the row is gone any folder still on disk is rescanned as a
//      brand-new series under a new id -- with no history, next to the history that was just erased. So
//      the folder must be absent on every root, and no chapter row may still claim a file.
//   2. Nothing that lives on may be erased. After a merge the absorbed row's chapters belong to the survivor,
//      while rows keyed by (book, series) can still carry the absorbed series_id (older merges left
//      bookmarks and tracker floors behind; an offline outbox replays whatever series_id the phone had). Every
//      per-user table is therefore re-pointed to the book's CURRENT series before anything is deleted, deletes
//      are keyed on the book ids this series actually owns, and an assertion refuses the whole transaction if
//      a progress row or bookmark on someone else's chapter is still filed here.

/** Every table with a per-user row keyed on a book, and so re-pointed to the book's current series first. */
const BOOK_KEYED_USER_TABLES = ['read_progress', 'reading_events', 'bookmarks', 'notes', 'offline_downloads'] as const;
/** Every table with a per-book row, deleted strictly by the ids of the books this series owns. */
const BOOK_KEYED_TABLES = [...BOOK_KEYED_USER_TABLES, 'book_overrides', 'page_hashes'] as const;
/** Every table keyed on the series id. lib_books and lib_series themselves come last, on their own. */
const SERIES_KEYED_TABLES = [
  'favorites', 'collection_items', 'ratings', 'series_colors', 'series_art', 'series_seen', 'series_trackers',
  'series_overrides', 'notes', 'series_sources', 'series_listing', 'chapter_failures', 'tracker_progress',
  'reading_events', 'offline_downloads', 'bookmarks', 'listing_progress',
  // v0.49.0: a series' posting-order numbers (#116) and its slow archive (#117). Both cascade from lib_series,
  // but naming them gives the audit its counts, like every other table here.
  'series_post_numbers', 'archive_queue',
  // v0.49.1: the other names a series goes by (lib/altTitles.ts). Cascades too; named for the same count.
  'series_alt_titles',
  // v0.51.0: its automatic banner's seed and state (lib/autoHero.ts). Cascades too; named for the same count.
  'series_hero',
] as const;

export interface ForgetRefusal {
  ok: false;
  refused: 'not_found' | 'live' | 'live_books' | 'missing_files' | 'folder_present' | 'stranded';
  message: string;
  fix?: string;
}
export interface ForgetResult {
  ok: true;
  /** Chapter rows erased, the absorbed rows' included (they own none after a merge, but the count is honest). */
  books: number;
  /** Rows that had been merged INTO this one and went with it. */
  absorbed: number;
  /** Distinct members who lost something: a progress row, an event, a bookmark, a note, a rating, a favourite, a tracker floor. */
  users: number;
  /** Rows erased per table, for the audit entry. */
  rowsByTable: Record<string, number>;
  title: string;
  folder: string;
  /** The absorbed rows' ids, so the caller can name them and the art sweep can reach them. */
  absorbedIds: string[];
}

/** Carries the assertion's refusal out of the transaction so it rolls back instead of committing. */
class Stranded extends Error {
  constructor(public readonly refusal: ForgetRefusal) { super(refusal.message); }
}

/** Roots a folder could sit under: the two the scanner walks, plus any root a chapter row recorded. */
async function allRoots(seriesIds: string[]): Promise<string[]> {
  const rows = await q<{ root: string }>(
    'SELECT DISTINCT root FROM lib_books WHERE series_id = ANY($1) AND root IS NOT NULL', [seriesIds],
  );
  return [...new Set([LIBRARY_ROOT, DL_ROOT, ...rows.map((r) => r.root)].filter(Boolean))];
}

/**
 * Erase a series, and everything anyone ever recorded about it, for good.
 *
 * Refuses (the caller answers 409 with `message` + `fix`) while the row is live, while any chapter row still
 * claims a file, while a root cannot be stat'ed, or while the folder still holds chapters on any root.
 *
 * ⚠️ An unmounted share is caught by the LIVE-ROW refusal, not by a tombstone. Nothing in the app marks a
 * row whose file it cannot see: the verify task refuses a root with no present file (its whole-batch rule)
 * and deleteSeriesFiles reconciles only under the same proof, so a share that is not there leaves every row
 * live, and live rows refuse here. A 'missing' tombstone is the opposite case -- verify PROVED the root was
 * mounted and the file was not on it -- so it must not refuse: until v0.38.0's fix pass it did, and a series
 * whose files a restore had lost dead-ended on "mount the library" with the library mounted (R3's probe P3).
 * "a series whose chapters went missing on a mounted share can be forgotten" in forgetSeries.int.test.ts
 * pins that; "forget refuses while a root it would have to check is not there" pins the stat refusal.
 *
 * ⚠️ "The folder exists" means "the folder has chapters", the scanner's own rule: findSeriesDirs
 * (lib/library.ts) lists a directory only when listChapters finds something in it, and descends otherwise,
 * so an empty directory cannot be rescanned into a series. Delete files unlinks every chapter and then
 * rm's the folder, but a merge survivor's Delete files ran the per-book loop over the absorbed row's files
 * (they moved to the survivor) while only rm'ing the survivor's folder, and the absorbed folder -- empty --
 * refused Forget forever with the Delete files chip already hidden (R3's probe P2). Both ends are fixed:
 * deleteSeriesFiles rm's the absorbed folders too, and this check ignores a folder with no chapters.
 * Reintroduce by refusing on `realpath` alone: "forget of a survivor after Delete files is not refused on
 * the absorbed row's empty folder" in forgetSeries.int.test.ts reads folder_present.
 *
 * Rows this series absorbed (`merged_into = id`) go with it in the same transaction, under the same rules.
 * Leaving them would be worse than deleting them: `merged_into` is ON DELETE SET NULL, so deleting only the
 * survivor flips every absorbed row to live -- a series with no books, a stale books_count and a folder the
 * next scan repopulates under its old id, next to history that was just purged.
 */
export async function forgetSeries(id: string): Promise<ForgetResult | ForgetRefusal> {
  const result = await tx(async (qq): Promise<ForgetResult | ForgetRefusal> => {
    const [row] = await qq<SeriesRow>(
      'SELECT id, title, folder, deleted_at, merged_into FROM lib_series WHERE id = $1 FOR UPDATE', [id],
    );
    if (!row) return { ok: false, refused: 'not_found', message: 'That series no longer exists.' };
    if (!row.deleted_at && !row.merged_into) {
      return {
        ok: false,
        refused: 'live',
        message: 'Remove the series first. Forgetting it is a third, separate step.',
        fix: 'Content → Library → Remove, then Delete files, then Forget.',
      };
    }

    // The closure of rows merged into this one (mergeSeries flattens chains, so one hop is the norm; the
    // loop is for a chain a scan or an older version left behind). Locked, so a concurrent merge cannot
    // point a new row at a series that is about to vanish from under it.
    const absorbed: SeriesRow[] = [];
    let frontier = [id];
    while (frontier.length) {
      const more = await qq<SeriesRow>(
        `SELECT id, title, folder, deleted_at, merged_into FROM lib_series
          WHERE merged_into = ANY($1) AND id <> ALL($2) FOR UPDATE`,
        [frontier, [id, ...absorbed.map((a) => a.id)]],
      );
      absorbed.push(...more);
      frontier = more.map((m) => m.id);
    }
    const ids = [id, ...absorbed.map((a) => a.id)];

    // Precondition over every chapter row of every id being erased: a live row is a file we have not seen
    // go -- deleted on purpose, or sitting on a share that is not mounted right now; the message says
    // "claims", because the row is the only witness either way. Delete files settles it on a mounted root
    // (the header of deleteSeriesFiles); on an unmounted one it leaves the rows live, and this refusal is
    // what stops the forget.
    const books = await qq<{ id: string; pruned_at: string | null }>(
      'SELECT id, pruned_at FROM lib_books WHERE series_id = ANY($1)', [ids],
    );
    const live = books.filter((b) => !b.pruned_at).length;
    if (live) {
      return {
        ok: false,
        refused: 'live_books',
        message: `${live} chapter row${live === 1 ? ' still claims' : 's still claim'} a file on disk. Delete the files ` +
                 'first, or the next scan brings the series back under a new id with none of its history.',
        fix: 'Delete files, then Forget.',
      };
    }

    // The folder must hold no chapters on any root, checked the way deleteSeriesFiles resolves it
    // (contained, then realpath), for this row and every absorbed one: a merged folder is still filed under
    // the survivor by the scanner, so it too would come back. A root that cannot be stat'ed at all is the
    // unmounted case, and "absent" is not an answer it can give.
    const roots = await allRoots(ids);
    for (const root of roots) {
      if (!(await stat(root).catch(() => null))) {
        return {
          ok: false,
          refused: 'missing_files',
          message: `${root} is not there right now, so nothing can be checked against it.`,
          fix: 'Mount the library and delete the files first.',
        };
      }
      for (const r of [row, ...absorbed]) {
        const target = containedPath(root, r.folder);
        if (!target) continue; // a folder that resolves outside the library cannot be rescanned from it
        const real = await realpath(target).catch(() => null);
        if (!real) continue;
        // The scanner's rule (the header): only a folder with chapters in it is a series to persistScan.
        if (!(await listChapters(real)).length) continue;
        return {
          ok: false,
          refused: 'folder_present',
          message: `The folder "${r.folder}" still holds chapters under ${root}. Forgetting the series now would only ` +
                   'have the next scan bring it back under a new id, with none of its history.',
          fix: 'Delete files first, or remove the folder by hand and rescan.',
        };
      }
    }

    const bookIds = books.map((b) => b.id);
    const rowsByTable: Record<string, number> = {};
    const count = (t: string, n: number) => { rowsByTable[t] = (rowsByTable[t] ?? 0) + n; };

    // (1) Re-point before deleting. A row keyed on a book that now belongs to another series is someone's
    // live history filed under a dead id; it moves to where the book is. ⚠️ Ordering is the guard: a delete
    // keyed on series_id before this step erases it. Reintroduce by moving the series-keyed deletes above
    // this loop, or by deleting bookmarks by series_id: "forget keeps a bookmark and progress on a chapter
    // that moved to the survivor" in forgetSeries.int.test.ts finds them gone.
    for (const t of BOOK_KEYED_USER_TABLES) {
      const moved = await qq(
        `UPDATE ${t} t SET series_id = b.series_id FROM lib_books b
          WHERE t.book_id = b.id AND t.series_id = ANY($1) AND b.series_id <> ALL($1) RETURNING 1`,
        [ids],
      );
      if (moved.length) count(`${t}:repointed`, moved.length);
    }
    // A tracker floor has no book to follow. For a row merged away it carries to the survivor, the higher
    // count winning (a lower one would rewind someone's AniList entry on the next push); a hidden row's
    // floor has nowhere to go and is erased with the rest. `uncarried` is the second kind, for the count
    // below.
    const uncarried: string[] = [];
    for (const r of [row, ...absorbed]) {
      if (!r.merged_into || ids.includes(r.merged_into)) { uncarried.push(r.id); continue; }
      await qq(
        `INSERT INTO tracker_progress (user_id, series_id, provider, chapters, pushed_at)
         SELECT user_id, $2, provider, chapters, pushed_at FROM tracker_progress WHERE series_id = $1
         ON CONFLICT (user_id, series_id, provider) DO UPDATE
           SET chapters = GREATEST(tracker_progress.chapters, EXCLUDED.chapters)`,
        [r.id, r.merged_into],
      );
    }

    // Who loses HISTORY, counted before anything goes and after the re-point, so a row that just moved to
    // the survivor is not "lost". ⚠️ Not series_seen: it is the NEW-badge counter ("how many chapters had
    // you seen on the shelf"), so a member who only ever opened the series page was toasted as "1 member's
    // history on it is gone" (R3's probe P8). And a tracker floor only for the rows whose floor is erased
    // -- an absorbed row's floor was carried to its survivor two statements up, not lost. Reintroduce by
    // adding series_seen back, or by counting tracker_progress over every id: "users counts members who
    // lose history, not a NEW badge or a carried tracker floor" in forgetSeries.int.test.ts reads 1 too many.
    // A read mark on a chapter the server never held (#69) IS history -- "I read chapter 57" -- and goes with
    // the series. Reintroduce by dropping its arm: "forget deletes read marks and counts their owner" in
    // forgetSeries.int.test.ts reads 0 members.
    const [{ n: users }] = await qq<{ n: number }>(
      `SELECT count(DISTINCT user_id)::int AS n FROM (
         SELECT user_id FROM read_progress     WHERE book_id = ANY($2)
         UNION SELECT user_id FROM reading_events   WHERE book_id = ANY($2) OR series_id = ANY($1)
         UNION SELECT user_id FROM bookmarks        WHERE book_id = ANY($2) OR series_id = ANY($1)
         UNION SELECT user_id FROM notes            WHERE book_id = ANY($2) OR series_id = ANY($1)
         UNION SELECT user_id FROM offline_downloads WHERE book_id = ANY($2) OR series_id = ANY($1)
         UNION SELECT user_id FROM favorites        WHERE series_id = ANY($1)
         UNION SELECT user_id FROM ratings          WHERE series_id = ANY($1)
         UNION SELECT user_id FROM tracker_progress WHERE series_id = ANY($3)
         UNION SELECT user_id FROM listing_progress WHERE series_id = ANY($1)
         UNION SELECT c.user_id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
                WHERE ci.series_id = ANY($1)
       ) u`,
      [ids, bookIds, uncarried],
    );

    // (2) Per-book rows, strictly by the books this series owns. Never by series_id here: that is the
    // clause that erased live bookmarks on a survivor's chapters.
    if (bookIds.length) {
      for (const t of BOOK_KEYED_TABLES) {
        const gone = await qq(`DELETE FROM ${t} WHERE book_id = ANY($1) RETURNING 1`, [bookIds]);
        count(t, gone.length);
      }
    }
    // (4) The assertion, before any series-keyed delete can touch the two tables that matter most: a
    // progress row or bookmark still filed here whose chapter belongs to ANOTHER series is history step (1)
    // failed to carry, and read_progress.series_id CASCADEs from lib_series, so going on would erase it
    // silently. Refuse the whole thing instead. (A row whose book no longer exists at all is a dangling
    // leftover of this series and is swept below.)
    for (const t of ['read_progress', 'bookmarks']) {
      const stranded = await qq(
        `SELECT 1 FROM ${t} t JOIN lib_books b ON b.id = t.book_id
          WHERE t.series_id = ANY($1) AND b.series_id <> ALL($1) LIMIT 1`,
        [ids],
      );
      if (stranded.length) {
        // ⚠️ Thrown, not returned: a value returned from the tx callback COMMITS, and step (2) has already
        // deleted this series' own per-book rows. The throw rolls those back and forgetSeries turns it into
        // the refusal below the transaction. Unreachable while step (1) runs in the same transaction (it
        // re-points exactly these rows), so no data test can trip it; "the assertion leaves the transaction
        // by throwing" in forgetSeries.int.test.ts pins the shape instead. Reintroduce by `return`ing here.
        throw new Stranded({
          ok: false,
          refused: 'stranded',
          message: `Someone's ${t === 'bookmarks' ? 'bookmark' : 'reading progress'} on a chapter that now belongs ` +
                   'to another series is still filed under this one. Nothing was changed.',
          fix: 'Report this: it means a merge left history behind.',
        });
      }
    }
    // (3) Series-keyed rows. Everything with an FK would cascade anyway; deleting explicitly gives the
    // audit its counts and covers the tables that deliberately have none.
    for (const t of SERIES_KEYED_TABLES) {
      const gone = await qq(`DELETE FROM ${t} WHERE series_id = ANY($1) RETURNING 1`, [ids]);
      count(t, gone.length);
    }
    // (5) The rows themselves. One statement for every id: `merged_into` is ON DELETE SET NULL, and an
    // absorbed row left standing for even one statement would be flipped live by its survivor's delete.
    const b = await qq('DELETE FROM lib_books WHERE series_id = ANY($1) RETURNING 1', [ids]);
    count('lib_books', b.length);
    const s = await qq<{ work_id: string | null }>('DELETE FROM lib_series WHERE id = ANY($1) RETURNING work_id', [ids]);
    count('lib_series', s.length);
    // A forgotten edition frees its language, and the edition it leaves alone stands on its own again (v0.52.0).
    // Reintroduce by dropping this: "forgetting an edition dissolves the work" in editions.int.test.ts finds the
    // other edition still in a work of one.
    for (const w of new Set(s.map((r) => r.work_id))) await dissolveLoneWork(qq, w);

    return {
      ok: true as const,
      books: b.length,
      absorbed: absorbed.length,
      users,
      rowsByTable,
      title: row.title,
      folder: row.folder,
      absorbedIds: absorbed.map((a) => a.id),
    };
  }).catch((e: unknown) => {
    if (e instanceof Stranded) return e.refusal;
    throw e;
  });
  if (!result.ok) return result;
  // Outside the transaction: filesystem work must not hold it open, and the art files are the one thing on
  // disk nothing else ever sweeps.
  for (const sid of [id, ...result.absorbedIds]) await dropArt(sid);
  return result;
}


// ---- file operations ----
//
// These are the only code paths in the app that write to the user's own library, and they are why the
// mount is no longer read-only. Both are deliberately narrow: one series at a time, explicitly confirmed,
// and refusing outright rather than half-applying.

/** Every distinct root a series' chapters live under. Usually two: the read library and the download dir. */
async function rootsOf(seriesId: string): Promise<string[]> {
  const rows = await q<{ root: string }>(
    'SELECT DISTINCT root FROM lib_books WHERE series_id = $1 AND root IS NOT NULL', [seriesId],
  );
  return rows.map((r) => r.root).filter(Boolean);
}

export interface FileOpRefusal { ok: false; reason: string; fix?: string }

/**
 * Delete a hidden series' files from disk.
 *
 * Requires the series to be hidden already, so the reversible step always happens first: "Remove" hides,
 * and only then can you also delete the files. It is an escalation, never a shortcut past the undo.
 *
 * The chapter ROWS and everyone's read_progress stay. read_progress.book_id is ON DELETE RESTRICT precisely
 * so that removing a chapter cannot silently delete what someone read of it, which is the one loss with no
 * undo and which syncs outward to AniList. A later scan neither resurrects them (the folder is gone) nor
 * prunes them (there is no prune path).
 *
 * The rows whose file this removed are marked pruned with reason 'deleted' (tombstoneBooks, the same mark
 * the chapter-level delete leaves). Until v0.37.0 they were left as live rows claiming bytes that were
 * gone: Put back then listed every chapter as openable and each one 404'd, the updater's have-set counted
 * them as held so nothing was ever fetched again, and a second Delete files reported "Deleted N file(s)"
 * for rows it had not touched (`files` counted rows, not unlinks). With the mark, a series put back after
 * this shows its chapters as "Deleted from the server", which is the truth, and Fetch again works on them.
 *
 * ⚠️ A ROW WHOSE FILE IS ALREADY ABSENT IS RECONCILED ONLY UNDER PROOF THAT THE ROOT IS MOUNTED. On an
 * unmounted share every stat fails and every file is fine on the disk that is not there, and "Delete files"
 * must not turn that into a library of tombstones -- but a series whose folder the admin rm -rf'd on the NAS
 * (#55's own scenario) has live rows and no files, nothing else in the app ever marks a read-library row,
 * and until v0.38.0's fix pass it could never be forgotten: Delete files did nothing, the Removed row never
 * offered Forget, and the route said "2 chapter files are still on disk" while nothing was (R3's probe P11).
 * The proof is the verify task's own (lib/verifyFiles.ts, the whole-batch rule): a root is mounted when
 * stat(root) works AND at least one chapter file of ANY series is present under it -- a present file, never
 * a folder, because the downloader mkdir -p's series folders on a bare mount point -- and not when more than
 * nine looked-at rows in ten have no file, verify's 90 % rule against the one stray download that landed in
 * the overlay while the share was down. The rows this series has on the root are what we stat anyway; when
 * none of them is present, up to `PROOF_SAMPLE` live rows of other series on the same root are stat'ed too,
 * so a one-series scratch root can never be proven (that is the test's "empty readable root"). Under proof,
 * a live row whose file is absent is marked 'deleted', and a 'missing' tombstone (verify's mark) becomes
 * 'deleted' too -- the file is not coming back by itself and the sweep must stop trying to fetch it. On an
 * unproven root every row is left exactly as it was, which is what keeps Forget's live-row refusal standing
 * for a share that is merely not here. Reintroduce by tombstoning the absent rows without the proof (or by
 * counting a present FOLDER as proof): "Delete files on an empty readable root marks nothing" in
 * fileOps.int.test.ts finds the rows marked; "a read-library series whose folder was removed by hand can be
 * forgotten after Delete files" in forgetSeries.int.test.ts is the other half.
 *
 * ⚠️ The folders of rows merged INTO this series are removed as well. Their chapter rows moved to the
 * survivor at merge time, so the per-book loop unlinks their files, but the directories used to be left
 * standing (empty) and Forget refused on them forever with the Delete files chip already hidden (R3's probe
 * P2). Reintroduce by rm'ing `row.folder` only: "delete files removes the folder of a row merged into the
 * series" in fileOps.int.test.ts finds the absorbed directory still there.
 */
export async function deleteSeriesFiles(id: string): Promise<{
  ok: true;
  files: number;
  bytes: number;
  /** Exact rows this invocation deliberately made (or reclassified as) tombstones; for the audit, not the API. */
  deletedBookIds: string[];
} | FileOpRefusal> {
  const row = await one<{ folder: string; deleted_at: string | null }>(
    'SELECT folder, deleted_at FROM lib_series WHERE id = $1', [id],
  );
  if (!row) return { ok: false, reason: 'That series no longer exists.' };
  if (!row.deleted_at) {
    return { ok: false, reason: 'Remove the series first. Deleting its files is a second, separate step.' };
  }

  const roots = await rootsOf(id);
  if (!roots.length) return { ok: false, reason: 'That series has no files on disk.' };

  const w = await allWritable(roots);
  if (!w.ok) return { ok: false, reason: w.reason, fix: w.fix };

  // This row's folder and every absorbed row's: the scanner files a merged folder under the survivor, so
  // the survivor's Delete files owns it.
  const absorbed = await q<{ folder: string }>('SELECT folder FROM lib_series WHERE merged_into = $1', [id]);
  const folders = [row.folder, ...absorbed.map((a) => a.folder)];

  // Every folder resolved on every root BEFORE anything is unlinked, so a refusal is a refusal and not a
  // half-applied delete. Containment, then realpath, then compare again: a symlinked folder inside a
  // library is not hypothetical on a NAS, and a lexical check alone would follow it out of the tree.
  const targets: Array<{ root: string; abs: string }> = [];
  for (const root of roots) {
    for (const folder of folders) {
      const target = containedPath(root, folder);
      if (!target) return { ok: false, reason: 'That folder path is not inside the library.' };
      const real = await realpath(target).catch(() => null);
      // ⚠️ Desktop: `real.slice(root.length + 1)` assumes realpath kept the root's spelling, and on a PC it
      // often does not -- a macOS folder under /tmp is really /private/tmp, and Windows answers with the
      // on-disk case and long names for 8.3 short ones -- so the slice cut the path in the wrong place and
      // a folder inside the library read as outside it. There the answer is path.relative against the
      // root's own realpath. The server keeps the slice (its roots are the mount points realpath returns).
      if (!real || !(isDesktop() ? await insideRealRoot(root, real) : containedPath(root, real.slice(root.length + 1) || '.'))) {
        if (real && real !== target) return { ok: false, reason: 'That folder resolves outside the library.' };
      }
      targets.push({ root, abs: target });
    }
  }

  let files = 0;
  let bytes = 0;
  const removed: string[] = [];
  const reconciled: string[] = [];
  const reclassified: string[] = [];
  for (const root of roots) {
    const rows = await q<{ id: string; file: string; pruned_at: string | null; pruned_reason: string | null }>(
      'SELECT id, file, pruned_at, pruned_reason FROM lib_books WHERE series_id = $1 AND root = $2', [id, root],
    );
    let present = 0;
    let absent = 0;
    const absentLive: string[] = [];
    for (const b of rows) {
      const abs = containedPath(root, b.file);
      if (!abs) continue;
      const st = await stat(abs).catch(() => null);
      if (!st) {
        absent++;
        if (!b.pruned_at) absentLive.push(b.id);
        continue;
      }
      present++;
      // Unlink first, mark second: a row marked for a file that is still on disk is an invisible leak,
      // the same order the read-chapter cleanup keeps.
      try { await rm(abs, { recursive: true, force: true }); } catch { continue; }
      bytes += st.size;
      files++;
      removed.push(b.id);
    }
    for (const t of targets) if (t.root === root) await rm(t.abs, { recursive: true, force: true }).catch(() => {});

    // The reconciliation, under the proof (the header). Nothing to reconcile is the common case and costs
    // no extra stat.
    const stale = rows.some((b) => b.pruned_reason === 'missing');
    if (!absentLive.length && !stale) continue;
    if (!(await rootProven(root, id, present, absent))) continue;
    reconciled.push(...absentLive);
    if (stale) {
      const changed = await q<{ id: string }>(
        `UPDATE lib_books SET pruned_reason = 'deleted'
          WHERE series_id = $1 AND root = $2 AND pruned_reason = 'missing'
          RETURNING id`,
        [id, root],
      );
      reclassified.push(...changed.map((b) => b.id));
    }
  }
  await tombstoneBooks([...removed, ...reconciled], 'deleted');
  // The cover follows the lowest LIVE chapter, the way persistScan and the chapter delete pick it: every
  // thumbnail falls back to the cover chapter's first page, and a tombstone has none. With every row marked
  // this still lands on a tombstone, and the series page's dashed placeholder is the honest rendering.
  if (removed.length || reconciled.length) {
    await q(
      `UPDATE lib_series SET cover_book_id = (
         SELECT id FROM lib_books WHERE series_id = $1 ORDER BY (pruned_at IS NOT NULL), number ASC, file ASC LIMIT 1
       ) WHERE id = $1`, [id]);
  }
  return { ok: true, files, bytes, deletedBookIds: [...new Set([...removed, ...reconciled, ...reclassified])] };
}

/** How many live rows of OTHER series are stat'ed for the mount proof when none of this series' own is present. */
const PROOF_SAMPLE = 200;
/** verify's threshold (lib/verifyFiles.ts REFUSE_ABOVE): above this share of absent files a root is not proof of anything. */
const PROOF_REFUSE_ABOVE = 0.9;

/**
 * Is `root` demonstrably mounted? `present` / `absent` are what deleteSeriesFiles already stat'ed of this
 * series' own rows on it; when none was present, a bounded sample of other series' live rows is looked at.
 * A file that is there is proof; a folder is not (the header of deleteSeriesFiles); and a root where more
 * than 90 % of what was looked at is gone is refused the way the verify task refuses it.
 */
async function rootProven(root: string, seriesId: string, present: number, absent: number): Promise<boolean> {
  if (!present) {
    const others = await q<{ file: string }>(
      `SELECT file FROM lib_books WHERE root = $1 AND series_id <> $2 AND pruned_at IS NULL ORDER BY random() LIMIT $3`,
      [root, seriesId, PROOF_SAMPLE],
    );
    for (const o of others) {
      const abs = containedPath(root, o.file);
      if (!abs) continue;
      if (await stat(abs).catch(() => null)) present++;
      else absent++;
    }
  }
  return present > 0 && absent <= (present + absent) * PROOF_REFUSE_ABOVE;
}

/**
 * Rename a series' folder on disk, in every root it occupies.
 *
 * The failure this guards against: renaming only the writable half. persistScan merges identical folderRel
 * across roots, so the old name stays live under the untouched root and the next scan splits the series in
 * two, stranding half of everyone's progress on a row they cannot find. There is no scan-free window --
 * scans run on every add, every updater sweep and the admin button -- so the rule is all roots or none.
 *
 * The database is updated directly rather than left to fingerprint rematch. LIBRARY_REMATCH is off by
 * default and is a deliberate-refusal guesser (two chapters minimum, ambiguity refuses); when Uchiyomi
 * performs the rename it knows the mapping exactly, so guessing it back would be strictly worse.
 */
export async function renameSeriesFolder(id: string, newFolder: string): Promise<{ ok: true } | FileOpRefusal> {
  const row = await one<{ folder: string; library_id: string }>(
    'SELECT folder, library_id FROM lib_series WHERE id = $1', [id],
  );
  if (!row) return { ok: false, reason: 'That series no longer exists.' };

  const typed = toStoredRel(newFolder).replace(/^\/+|\/+$/g, '').trim();
  if (!typed || typed === row.folder) return { ok: false, reason: 'Choose a different folder name.' };

  const roots = await rootsOf(id);
  if (!roots.length) return { ok: false, reason: 'That series has no files on disk.' };
  // Desktop: the folders ABOVE the new name spelled the way the disk spells them. On NTFS and APFS
  // `mangadex/Title` lands inside the existing `MangaDex`, and a folder stored with the typed case would
  // never match what the scanner reads back -- the series would split in two on the next scan. The new
  // name itself keeps the case typed, which is the point of a case-only rename.
  const dest = isDesktop() && typed.includes('/')
    ? `${await diskSpelling(roots, dirnameRel(typed))}/${typed.slice(typed.lastIndexOf('/') + 1)}`
    : typed;
  if (dest === row.folder) return { ok: false, reason: 'Choose a different folder name.' };

  const w = await allWritable(roots);
  if (!w.ok) return { ok: false, reason: w.reason, fix: w.fix };

  // Verify the destination is free in EVERY root first. rename() into an existing directory merges under
  // one filesystem and fails under another, so checking as we go would leave a half-applied move.
  for (const root of roots) {
    const to = containedPath(root, dest);
    const from = containedPath(root, row.folder);
    if (!to || !from) return { ok: false, reason: 'That folder path is not inside the library.' };
    if (await stat(to).then(() => true).catch(() => false)) {
      // ⚠️ Desktop, case-insensitive disks: `Title` -> `title` finds `title` already there, because it IS
      // the folder being renamed, and a case-only rename was refused as a clash with itself. Allowed only
      // when both names are the same directory (same device and inode, compared as bigints: NTFS ids do not
      // fit a double), so two real folders differing only in case on a case-SENSITIVE volume still refuse.
      // Reintroduce by removing this line: desktopSwitchHygiene.test.ts "the desktop-only filesystem rules"
      // finds it gone; desktopPaths.test.ts "sameDir" proves the comparison itself.
      if (isDesktop() && await sameDir(from, to)) continue;
      return { ok: false, reason: `Something already exists at "${dest}".` };
    }
  }

  const done: Array<{ root: string; from: string; to: string }> = [];
  for (const root of roots) {
    const from = containedPath(root, row.folder)!;
    const to = containedPath(root, dest)!;
    try {
      await mkdirp(dirname(to));
      await rename(from, to);
      done.push({ root, from, to });
    } catch (e) {
      // Roll back what already moved. Two renames on two filesystems cannot be made atomic, so the honest
      // design is: verify hard, roll back, and if the rollback itself fails, say exactly what is now
      // inconsistent rather than pretending otherwise.
      for (const d of done.reverse()) {
        try { await rename(d.to, d.from); } catch {
          return {
            ok: false,
            reason: `The rename failed partway and could not be undone. "${d.to}" should be "${d.from}". ` +
                    'Nothing in the database was changed, so fix the folder names on disk and rescan.',
          };
        }
      }
      return { ok: false, reason: `Could not rename the folder: ${(e as Error).message}` };
    }
  }

  await tx(async (qq) => {
    await qq('UPDATE lib_series SET folder_prev = folder, folder = $2 WHERE id = $1', [id, dest]);
    await qq(
      `UPDATE lib_books SET file = $2 || substring(file from length($3) + 1), updated_at = now()
        WHERE series_id = $1 AND file LIKE $3 || '/%'`,
      [id, dest, row.folder],
    );
  });
  return { ok: true };
}

/** Is `real` inside `root` once the root is resolved the same way (realpath) the path was? */
export async function insideRealRoot(root: string, real: string): Promise<boolean> {
  const base = await realpath(root).catch(() => resolve(root));
  const rel = relative(base, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Are these two paths, which differ at most in case, one and the same directory? Case alone is checked
 * first so a path elsewhere on the disk can never qualify, and the ids decide (a zero id is no answer).
 */
export async function sameDir(a: string, b: string): Promise<boolean> {
  if (a.normalize('NFC').toLowerCase() !== b.normalize('NFC').toLowerCase()) return false;
  const [x, y] = await Promise.all([stat(a, { bigint: true }).catch(() => null), stat(b, { bigint: true }).catch(() => null)]);
  return !!x && !!y && x.isDirectory() && x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
}

/**
 * Desktop: a typed relative folder path, respelled segment by segment the way the disk already spells it.
 *
 * NTFS and APFS find `mangadex/title` when the folder is `MangaDex/Title`, but everything this app stores
 * (lib_series.folder, libraries.path) is compared as an exact string with what the scanner reads back
 * from readdir, which is always the on-disk spelling. So a path somebody types has to be put into that
 * spelling before it is stored, or it silently matches nothing. Segments that do not exist yet are kept as
 * typed. The root with the longest existing match wins. Unicode is compared NFC, because macOS keeps the
 * decomposed form some names were created with. On the server this returns `rel` untouched.
 */
export async function diskSpelling(roots: string[], rel: string): Promise<string> {
  if (!isDesktop() || !rel) return rel;
  const segs = rel.split('/');
  const fold = (x: string) => x.normalize('NFC').toLowerCase();
  let best: string[] = [];
  for (const root of roots) {
    const got: string[] = [];
    let dir = root;
    for (const seg of segs) {
      const names = await readdir(dir).catch(() => null);
      const hit = names?.includes(seg) ? seg : names?.find((n) => fold(n) === fold(seg));
      if (!hit) break;
      got.push(hit);
      dir = join(dir, hit);
    }
    if (got.length > best.length) best = got;
  }
  return [...best, ...segs.slice(best.length)].join('/');
}

/** mkdir -p without pulling in another import at the top of this file. */
async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('fs/promises');
  await mkdir(dir, { recursive: true }).catch(() => {});
}
