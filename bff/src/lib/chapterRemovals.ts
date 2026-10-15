/**
 * "Remove from library" on one chapter number of a series: the number is deleted from disk (the download folder
 * only, through deleteChapterFiles, so the bookmark veto and the root checks apply) and written to
 * series_chapter_removals, which hides it everywhere the base book view and the listing are read and which the
 * sweep filters out of what it fetches. Meant for a chapter a follower source listed that is not part of the
 * work (a 0.5 from an unrelated title). Restore deletes the row; the number then reappears as a ghost on the
 * next listing refresh, and the sweep may fetch it again.
 */
import type { FastifyRequest } from 'fastify';
import { q } from './db';
import { DL_ROOT } from './library';
import { deleteChapterFiles } from './libraryAdmin';
import { logAudit } from './audit';

export type RemoveResult =
  | { removed: number[]; skipped: Array<{ number: number; reason: string }>; applied: number; bytes: number }
  | { refused: { reason: string; fix?: string } };

export async function removedNumbers(seriesId: string): Promise<number[]> {
  const rows = await q<{ number: number }>('SELECT number FROM series_chapter_removals WHERE series_id = $1 ORDER BY number', [seriesId]);
  return rows.map((r) => Number(r.number));
}

export async function removeChapters(
  seriesId: string, numbers: readonly number[], o: { userId: string | null; req?: FastifyRequest },
): Promise<RemoveResult> {
  const nums = [...new Set(numbers)];
  const rows = await q<{ id: string; root: string | null; number: number; pruned_at: string | null }>(
    `SELECT b.id, b.root, COALESCE(ov.number, b.number) AS number, b.pruned_at
       FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
      WHERE b.series_id = $1 AND COALESCE(ov.number, b.number) = ANY($2::real[])`, [seriesId, nums]);
  const skipped: Array<{ number: number; reason: string }> = [];
  const refused = new Set<number>();
  const toDelete: string[] = [];
  const idsOf = new Map<number, string[]>();
  for (const r of rows) {
    const n = Number(r.number);
    if (r.pruned_at) continue;
    if (r.root !== DL_ROOT) { refused.add(n); skipped.push({ number: n, reason: 'not_owned' }); continue; }
    toDelete.push(r.id);
    idsOf.set(n, [...(idsOf.get(n) ?? []), r.id]);
  }
  let applied = 0;
  let bytes = 0;
  if (toDelete.length) {
    const d = await deleteChapterFiles(seriesId, toDelete, { userId: o.userId, req: o.req });
    if ('refused' in d) return d;
    applied = d.applied;
    bytes = d.bytes;
    const failed = new Map(d.skipped.map((s) => [s.id, s.reason]));
    for (const [n, ids] of idsOf) {
      const why = ids.map((i) => failed.get(i)).find((x) => x && x !== 'already_pruned');
      if (why) { refused.add(n); skipped.push({ number: n, reason: why }); }
    }
  }
  const removed = nums.filter((n) => !refused.has(n));
  if (removed.length) {
    await q(
      `INSERT INTO series_chapter_removals (series_id, number, removed_by)
       SELECT $1, n, $3 FROM unnest($2::real[]) AS n ON CONFLICT (series_id, number) DO NOTHING`,
      [seriesId, removed, o.userId]);
    await q('DELETE FROM series_listing WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, removed]);
    await q('DELETE FROM chapter_failures WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, removed]);
  }
  await logAudit('series.chapters_remove', { userId: o.userId, detail: { id: seriesId, removed, skipped, applied, bytes }, req: o.req });
  return { removed, skipped, applied, bytes };
}

export async function restoreRemoved(
  seriesId: string, numbers: readonly number[] | 'all', o: { userId: string | null; req?: FastifyRequest },
): Promise<number[]> {
  const rows = numbers === 'all'
    ? await q<{ number: number }>('DELETE FROM series_chapter_removals WHERE series_id = $1 RETURNING number', [seriesId])
    : await q<{ number: number }>('DELETE FROM series_chapter_removals WHERE series_id = $1 AND number = ANY($2::real[]) RETURNING number', [seriesId, [...numbers]]);
  const restored = rows.map((r) => Number(r.number)).sort((a, b) => a - b);
  if (restored.length) await logAudit('series.chapters_restore', { userId: o.userId, detail: { id: seriesId, restored }, req: o.req });
  return restored;
}
