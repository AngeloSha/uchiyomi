// Health: "Chapter files" (v0.72.0, rebuilt from @Squeaks72's #252).
//
// The nightly repair's count step opens every chapter file once (lib/repair.ts stepCount, up to 2,000 a night) and
// stamps what it found: `pages`, and `pages_checked_at` even when the answer is 0 -- a file that is empty, cut short by a
// download nobody finished, damaged, an archive with no pages in it, or gone (lib/pageCount.ts). Nothing read those
// zeros: the short-chapter card starts at one page, so a chapter nobody can open was invisible to Health and to every
// repair step. #252 saw that gap. This card lists those chapters, by series, from the stamps alone.
//
// ⚠️ ZERO NEW I/O. #252 looked at up to 3,000 files on every run of the card -- some 190 MB of reads every six hours
// and after every scan -- to learn what the count had already stamped. Here it is one query on a partial index
// (lib/migrate.ts lib_books_unreadable_idx). A file that changes is counted again: lib/library.ts persistScan clears
// the stamp when the mtime moves, so a chapter fetched again leaves the card at once and comes back only if the new
// copy cannot be read either. Reintroduce a file read: "the card opens no file" in healthFiles.int.test.ts finds the
// planted file's change noticed.
//
// ⚠️ NO DELETE, here or in Fix everything. #252's Fix everything step removed such files unattended -- the bad-file
// delete the owner had already turned down. The way out is Fetch again, per row, through the series page's own route
// (POST /api/admin/series/{id}/chapters/refetch): it sets the old file aside until the new copy lands and puts it back
// when it does not, and it only takes a file Uchiyomi downloaded and named itself (`owned`, the short-chapter card's
// rule). A file in a library somebody built is theirs to replace. Fix everything lists the card under Needs you.
import { q } from './db';
import { visibleToAll } from './visibility';
import { DL_ROOT } from './library';
import { chapterFileRel } from './downloader';
import { numKey } from './postingOrder';
import { atHiddenNumber } from './noticeChapters';
import { applyIgnores, noIgnores, type IgnoreCtx } from './healthIgnore';
import { MAX_BOOK_IDS, hiddenPart, ignoredPart, truncate, verdict, withAll } from './healthKit';
import { detailOf, noteOf, say, summaryOf } from './said';
import type { HealthAction, HealthCheck, HealthItem } from './health';

/** The numbers a row names before "and 3 more". */
const NAMED = 5;

interface Unreadable { id: string; series_id: string; title: string; folder: string; number: number; root: string | null; file: string }

export async function chapterFiles(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const rows = await q<Unreadable>(
    `SELECT b.id, b.series_id, s.title, s.folder, b.number::float8 AS number, b.root, b.file
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id AND ${visibleToAll('s')}
      WHERE b.pages = 0 AND b.pages_checked_at IS NOT NULL AND b.pruned_at IS NULL
        -- Not a chapter at a number an admin hid (#240): no chapter here, and its Fetch again would be refused.
        AND NOT ${atHiddenNumber('b')}
      ORDER BY s.title, b.number`,
  );
  const bySeries = new Map<string, Unreadable[]>();
  for (const r of rows) bySeries.set(r.series_id, [...(bySeries.get(r.series_id) ?? []), r]);
  const all: Array<HealthItem & { members?: string[] }> = [...bySeries.values()]
    .sort((a, b) => b.length - a.length || a[0].title.localeCompare(b[0].title))
    .map((books) => {
      const s = books[0];
      // Fetch again replaces the file, so it is offered ONLY for a file this server downloaded and named itself: the
      // download root, under exactly the name chapterFileRel writes -- what the refetch route itself refuses otherwise.
      const owned = books.filter((b) => b.root === DL_ROOT && b.file === chapterFileRel(b.folder, Number(b.number)));
      const others = books.length - owned.length;
      return {
        seriesId: s.series_id,
        title: s.title,
        ...detailOf([
          say('files.detail', {
            n: books.length, numbers: books.slice(0, NAMED).map((b) => numKey(Number(b.number))), more: Math.max(0, books.length - NAMED),
          }),
          others > 0 && say('files.notOurs', { n: others }),
        ]),
        ...(owned.length ? {
          bookIds: owned.slice(0, MAX_BOOK_IDS).map((b) => b.id),
          numbers: owned.slice(0, MAX_BOOK_IDS).map((b) => numKey(Number(b.number))),
          actions: ['refetch'] as HealthAction[],
        } : {}),
        // Ignored while these are the chapters: another one that cannot be read is a new finding.
        key: `series:${s.series_id}`,
        members: books.map((b) => b.id).sort(),
      };
    });
  const ignored = applyIgnores('files', all, ctx);
  const live = all.filter((i) => !i.info);
  const chapters = live.reduce((n, i) => n + (bySeries.get(i.seriesId!)?.length ?? 0), 0);
  const { items, hidden } = truncate(all);
  return withAll({
    id: 'files',
    title: 'Chapter files',
    status: verdict(all),
    ...summaryOf([
      live.length ? say('files.live', { n: chapters, m: live.length }) : say('files.none'),
      ignoredPart(ignored),
    ]),
    ...noteOf([say('files.note'), hiddenPart(hidden)]),
    items,
  }, all);
}
