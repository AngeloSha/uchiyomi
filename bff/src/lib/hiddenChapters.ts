// Hiding a chapter number from a series (#240 by @Squeaks72, rebuilt to hide only).
//
// A source sometimes lists a chapter that is not part of the work -- a 0.5 from an unrelated title, a number a wrong
// match brought in -- and nothing on the source side takes it away: the grey row stays on the series page, the sweep
// tries it every night, Health counts the hole it leaves. #240 deleted the number's file and recorded the number; this
// keeps the second half only. An admin hides the number from the series, for everyone (lib_series.hidden_numbers, by
// the effective number):
//   - every surface leaves it out, through the hide fragments of lib/noticeChapters.ts -- the chapter list and its grey
//     rows, the reader's next and previous, Continue, the unread counts and badges, Updates, history, OPDS, the
//     Komga-compatible API and what the trackers are told;
//   - it is neither held nor missing for Health, the repair and Fill (lib/libraryNumbers.ts);
//   - the sweep, Check, Fetch newest and the slow archive never fetch it (lib/updater.ts, the archive's work list), and
//     a download already queued when it was hidden stops at the source's door (lib/chapterFallback.ts);
//   - nothing deletes it. No file, no row and no reading history is touched, and the read-chapter cleanup and Fix
//     everything leave a hidden chapter's file alone.
// Restore takes the number off the list and everything is as it was, at once: its rows were never touched, its grey
// row is still in the listing, and the next sweep fetches it if it is missing.
//
// A hide writes no file, so it takes no hold on the series folder; what #240's missing hold let through -- the sweep
// fetching the number while it was being taken out -- is closed at the download itself, which reads the hidden numbers
// again just before it asks the source. The series row is locked instead, because the number is the numbering's: a
// merge carries the absorbed series' hidden numbers to the survivor (lib/libraryAdmin.ts mergeSeries), a renumber moves
// each with its post (lib/numbering.ts commit), and either waits for a hide, or a hide for it. Rescan everything's opt-in
// renumber reads file names again and moves no number-keyed state, read marks included: a hidden file it renumbers
// shows under its new number, to be hidden again if it should be.
import type { FastifyRequest } from 'fastify';
import { q, one, tx } from './db';
import { logAudit } from './audit';
import { hiddenNumbersActive, setHiddenNumbersActive } from './noticeChapters';
import { refreshNoticesActive } from './noticeSettings';
import { numKey } from './postingOrder';
import { rangeEnd } from './chapterRanges';

/** The most numbers one request may hide or restore: what the select bar's Delete from server takes. */
export const HIDE_MAX = 500;

type Run = <R = any>(text: string, params?: any[]) => Promise<R[]>;

/**
 * A series' hidden numbers, as comparison keys (lib/postingOrder.ts numKey), for code that works on lists in memory: the
 * sweep. Empty, without asking, while no series hides one.
 */
export async function hiddenNumbersOf(seriesId: string): Promise<Set<number>> {
  if (!hiddenNumbersActive()) return new Set();
  const r = await one<{ hidden: number[] | null }>('SELECT hidden_numbers AS hidden FROM lib_series WHERE id = $1', [seriesId]);
  return new Set((r?.hidden ?? []).map(Number).filter(Number.isFinite).map(numKey));
}

/** Is this number hidden in this series right now? The download's last check. A failed read throws: the caller decides. */
export async function numberHiddenNow(seriesId: string, n: number): Promise<boolean> {
  return (await hiddenNumbersOf(seriesId)).has(numKey(n));
}

export type HideRefusal = 'not_found' | 'merged';

/**
 * Hide numbers from a series. Answers the ones that were not hidden already. Their failure ledger rows go with them: a
 * hidden number is never tried again, so Health's failures card would otherwise carry it for good (and a restored one
 * starts with a clean slate, as a renumber leaves every number).
 */
export async function hideNumbers(
  seriesId: string, numbers: readonly number[], o: { userId: string | null; req?: FastifyRequest },
): Promise<{ hidden: number[] } | { refused: HideRefusal }> {
  const want = [...new Map(numbers.filter(Number.isFinite).map((n) => [numKey(n), n])).values()];
  const r = await tx(async (qq) => {
    const [s] = await qq<{ merged_into: string | null; hidden: number[] | null }>(
      'SELECT merged_into, hidden_numbers AS hidden FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!s) return { refused: 'not_found' as const };
    // Its chapters are the survivor's now, and so are its hidden numbers (mergeSeries carried them).
    if (s.merged_into) return { refused: 'merged' as const };
    const had = new Set((s.hidden ?? []).map((n) => numKey(Number(n))));
    const fresh = want.filter((n) => !had.has(numKey(n))).sort((a, b) => a - b);
    if (fresh.length) {
      await qq('UPDATE lib_series SET hidden_numbers = hidden_numbers || $2::real[] WHERE id = $1', [seriesId, fresh]);
      await qq('DELETE FROM chapter_failures WHERE series_id = $1 AND number = ANY($2::real[])', [seriesId, fresh]);
    }
    return { hidden: fresh };
  });
  if ('refused' in r) return r;
  if (r.hidden.length) {
    // At once, before anyone reads: a query built before this would still show it (lib/noticeChapters.ts handActive).
    setHiddenNumbersActive(true);
    await logAudit('series.chapters_hide', { userId: o.userId, detail: { id: seriesId, numbers: r.hidden }, req: o.req });
  }
  return r;
}

/** Show hidden numbers again: the ones named, or every one (`'all'`). Answers the ones that were hidden. */
export async function unhideNumbers(
  seriesId: string, numbers: readonly number[] | 'all', o: { userId: string | null; req?: FastifyRequest },
): Promise<{ restored: number[] } | { refused: 'not_found' }> {
  const r = await tx(async (qq) => {
    const [s] = await qq<{ hidden: number[] | null }>('SELECT hidden_numbers AS hidden FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!s) return { refused: 'not_found' as const };
    const had = (s.hidden ?? []).map(Number);
    const drop = numbers === 'all' ? null : new Set(numbers.map(numKey));
    const restored = drop ? had.filter((n) => drop.has(numKey(n))) : had;
    if (restored.length) {
      // NULL, never an empty array, once nothing is hidden (lib/migrate.ts says why).
      const left = drop ? had.filter((n) => !drop.has(numKey(n))) : [];
      await qq('UPDATE lib_series SET hidden_numbers = $2::real[] WHERE id = $1', [seriesId, left.length ? left : null]);
    }
    return { restored: restored.sort((a, b) => a - b) };
  });
  if ('refused' in r) return r;
  if (r.restored.length) {
    // The flag drops only here, once nothing hides a number any more (and on a failed read keeps what it knew).
    await refreshNoticesActive().catch(() => {});
    await logAudit('series.chapters_unhide', { userId: o.userId, detail: { id: seriesId, numbers: r.restored }, req: o.req });
  }
  return r;
}

/** One hidden number, as Show hidden chapters lists it. */
export interface HiddenChapter {
  number: number;
  /** Chapter rows this server has at the number: a file, or a deleted one's row. Kept, all of them. */
  onServer: number;
  /** A source the series follows lists it. */
  listed: boolean;
  /** What the chapter is called: its source's name for it, else the file's title. */
  title: string | null;
}

/** A series' hidden numbers, lowest first, with what each one is. */
export async function hiddenChapters(seriesId: string): Promise<HiddenChapter[]> {
  const rows = await q<{ number: number; books: number; listed: boolean; title: string | null }>(
    `SELECT h.number,
            (SELECT count(*) FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
              WHERE b.series_id = s.id AND COALESCE(ov.number, b.number) = h.number AND ${rangeEnd('b', 'ov')} IS NULL)::int AS books,
            EXISTS (SELECT 1 FROM series_listing l WHERE l.series_id = s.id AND l.number = h.number) AS listed,
            COALESCE(
              (SELECT l.title FROM series_listing l WHERE l.series_id = s.id AND l.number = h.number LIMIT 1),
              (SELECT COALESCE(b.chapter_name, ov.title, b.title) FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
                WHERE b.series_id = s.id AND COALESCE(ov.number, b.number) = h.number ORDER BY b.pruned_at IS NOT NULL, b.id LIMIT 1)) AS title
       FROM lib_series s CROSS JOIN LATERAL unnest(s.hidden_numbers) AS h(number)
      WHERE s.id = $1
      ORDER BY h.number`, [seriesId]);
  return rows.map((r) => ({ number: Number(r.number), onServer: Number(r.books), listed: r.listed === true, title: r.title?.trim() || null }));
}

/**
 * Inside mergeSeries' transaction, both rows locked: the absorbed series' hidden numbers are hidden in the survivor too.
 * Its chapters move there with the numbers they had, and an admin who hid a number of the work has said it is no
 * chapter of the work. Reintroduce by dropping the call: "a merged series keeps the hide" in hiddenChapters.int.test.ts
 * lists the absorbed series' hidden chapter under the survivor.
 */
export async function carryHidden(qq: Run, fromId: string, intoId: string): Promise<void> {
  await qq(
    `UPDATE lib_series s SET hidden_numbers = (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(s.hidden_numbers || f.hidden_numbers) AS x)
       FROM lib_series f WHERE f.id = $1 AND s.id = $2 AND f.hidden_numbers IS NOT NULL`, [fromId, intoId]);
}

/**
 * Inside a renumber's commit (lib/numbering.ts), through the map the read marks follow: each hidden number moves with its
 * post, and one with no place in the new numbering is shown again -- left where it was, it would hide whatever chapter
 * takes its old number now. The row is read FOR UPDATE, so a hide waits for the commit or the commit for it.
 * Reintroduce by dropping the call: "an admin's confirmation renumbers it in place" in numbering.int.test.ts finds the
 * old numbers hidden, which are other posts now, and the chapter hidden as 6 shown as 110.
 */
export async function moveHidden(qq: Run, seriesId: string, map: ReadonlyMap<number, number>): Promise<void> {
  const [s] = await qq<{ hidden: number[] | null }>('SELECT hidden_numbers AS hidden FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
  const had = (s?.hidden ?? []).map(Number);
  if (!had.length) return;
  const moved = [...new Set(had.map((n) => map.get(numKey(n))).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
  await qq('UPDATE lib_series SET hidden_numbers = $2::real[] WHERE id = $1', [seriesId, moved.length ? moved : null]);
}
