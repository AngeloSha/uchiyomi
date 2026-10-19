// A chapter held twice inside one series, and Keep one of each.
//
// The owner's library, read on 19 Oct 2026: 29 of 303 series held a chapter number more than once, 194 extra files.
// 170 were one chapter saved twice: a second full set of one series that Suwayomi wrote nine minutes after the first,
// re-downloads it kept beside the first copy (`Chapter 3197-fixed`, `Chapter 75 RESUMED`), three chapters it filed under
// the wrong number, ten `Chapter -1.cbz` that were chapter 1 again (lib/sources/loader.ts fileableChapters), and one
// chapter saved under two spellings of its number (lib/downloader.ts spelledOtherwise). 23 were a chapter's parts and
// extras, which share their chapter's number on purpose. Nothing showed any of it: a merge keeps one copy of what the two
// series brought together (lib/extraCopies.ts), and Health's other saved-twice rows are two SOURCES' splits of a chapter,
// of files stamped with where they came from -- 373 of those 375 files had no source at all.
//
//  - WHICH NUMBERS. Exactly two live files at one number (an admin's number first), in a series whose numbers are
//    settled (lib/extraCopies.ts numbersSettled), where neither name says it is something else (lib/naming.ts
//    nameSaysMore): a part or an extra (`17e`, `1053a`, `47-5`, `175.8.1`), another chapter (`Ch. 6 - Chapter 86`), or no
//    chapter word at all. Never a file holding a range, a number an admin hid (#240), a number held three times or more.
//    Never by page count: two sites cut one strip into 6 pages or into 165 (lib/extraCopies.ts says how that was measured).
//  - WHICH COPY STAYS. The one in the download folder under the downloader's own name for the number (the file Fetch
//    again and the repair recognise as ours), else the first one saved; lib/extraCopies.ts chooseCopy then keeps a whole
//    copy over a partial one, and a file that is there over one that is gone.
//  - THE OTHER COPY. lib/extraCopies.ts removeExtraCopies, as a merge runs it: reading progress moves to the copy that
//    stays, a copy somebody bookmarked stays, and the file is deleted in the download folder and set aside anywhere else
//    (the scan and the census skip it; it stays on disk).
//  - NOTHING RUNS ON ITS OWN. Health lists the series (lib/health.ts, "The same chapter saved twice") and an admin presses
//    Keep one of each, for one series or for the card. Not the nightly repair, not Fix everything.
import type { FastifyRequest } from 'fastify';
import { posix } from 'path';
import { q } from './db';
import { DL_ROOT } from './library';
import { visibleToAll } from './visibility';
import { isRange } from './chapterRanges';
import { atHiddenNumber } from './noticeChapters';
import { nameSaysMore } from './naming';
import { numKey } from './postingOrder';
import { numbersSettled, removeExtraCopies, type Copy, type CopyPair, type ExtraCopiesResult } from './extraCopies';

/** One file of a chapter held twice: lib/extraCopies.ts's Copy, and when it was saved. */
interface Held extends Copy { mtime: number }

/** The chapters one series holds twice; in each pair `kept` is the copy that stays. */
export interface HeldTwice { seriesId: string; title: string; pairs: CopyPair[] }

/** The live one-chapter files at a number held exactly twice: of one series (`$1`), or of every series. */
const heldSql = (oneSeries: boolean) => `
  WITH held AS (
    SELECT b.id, b.series_id, s.title, COALESCE(b.root, '') AS root, b.file, COALESCE(o.number, b.number)::float8 AS number,
           (b.missing_pages IS NOT NULL) AS partial, b.pages, b.mtime
      FROM lib_books b LEFT JOIN book_overrides o ON o.book_id = b.id JOIN lib_series s ON s.id = b.series_id
     WHERE b.pruned_at IS NULL AND NOT ${isRange('b')} AND NOT ${atHiddenNumber('b')} AND ${visibleToAll('s')}
       AND s.numbering IS DISTINCT FROM 'posting_order' AND s.numbering_pending IS NULL AND s.renumber_plan IS NULL
       ${oneSeries ? 'AND b.series_id = $1' : ''})
  SELECT held.* FROM held
    JOIN (SELECT series_id, number FROM held GROUP BY series_id, number HAVING count(*) = 2) twice USING (series_id, number)
   ORDER BY held.title, held.series_id`;

type HeldRow = { id: string; series_id: string; title: string; root: string | null; file: string; number: number; partial: boolean; pages: number | null; mtime: string | number };

const toHeld = (r: HeldRow): Held => ({
  id: r.id, seriesId: r.series_id, root: r.root ?? '', file: r.file, number: Number(r.number),
  partial: !!r.partial, pages: Number(r.pages) || 0, mtime: Number(r.mtime) || 0,
});

/** The downloader's own file for its number, in the download folder (lib/downloader.ts chapterFileRel). */
const ownFile = (c: Held): boolean => c.root === DL_ROOT && posix.basename(c.file) === `Chapter ${numKey(c.number)}.cbz`;

/** The copy that stays first: the downloader's own file, else the first one saved, else by name (a stable choice). */
const stays = (a: Held, b: Held): number => Number(ownFile(b)) - Number(ownFile(a)) || a.mtime - b.mtime || a.file.localeCompare(b.file);

/** One series' files at numbers held twice, as pairs: the copy that stays as `kept`, the other as `other`. */
function pairsOf(rows: readonly Held[]): CopyPair[] {
  const byNumber = new Map<number, Held[]>();
  for (const r of rows) {
    const k = numKey(r.number);
    const list = byNumber.get(k);
    if (list) list.push(r);
    else byNumber.set(k, [r]);
  }
  const out: CopyPair[] = [];
  for (const [number, list] of byNumber) {
    if (list.length !== 2 || list.some((c) => nameSaysMore(posix.basename(c.file), number) !== null)) continue;
    const [kept, other] = [...list].sort(stays);
    out.push({ number, kept, other });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Every series that holds a chapter twice, by title, for Health. Reads the database only. */
export async function heldTwiceSeries(): Promise<HeldTwice[]> {
  const bySeries = new Map<string, { title: string; rows: Held[] }>();
  for (const r of await q<HeldRow>(heldSql(false))) {
    const s = bySeries.get(r.series_id);
    if (s) s.rows.push(toHeld(r));
    else bySeries.set(r.series_id, { title: r.title, rows: [toHeld(r)] });
  }
  const out: HeldTwice[] = [];
  for (const [seriesId, s] of bySeries) {
    const pairs = pairsOf(s.rows);
    if (pairs.length) out.push({ seriesId, title: s.title, pairs });
  }
  return out;
}

/** The chapters one series holds twice, paired as Keep one of each would take them now. */
export async function heldTwicePairs(seriesId: string): Promise<CopyPair[]> {
  if (!(await numbersSettled(seriesId))) return [];
  return pairsOf((await q<HeldRow>(heldSql(true), [seriesId])).map(toHeld));
}

/** Keep one of each: every chapter the series holds twice, kept once. The caller holds the series' folder. */
export async function keepOneOfEach(seriesId: string, o: { userId: string | null; req?: FastifyRequest }): Promise<ExtraCopiesResult> {
  return removeExtraCopies(seriesId, await heldTwicePairs(seriesId), { userId: o.userId, via: 'held-twice', req: o.req });
}
