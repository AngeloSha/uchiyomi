import { q } from './db';
import { junkHashes } from './pageHash';
import { sourceGifPages } from './sourcePageRules';

/**
 * Which pages of a chapter are furniture rather than story.
 *
 * The evidence is gathered from the whole SERIES -- a credit page is only recognisable as one because it
 * recurs across chapters -- and then applied to the single chapter being read. See `pageHash.ts` for why
 * the scope is one series and why the threshold is three chapters.
 *
 * ⚠️ A person's decision wins, in both directions, and is never recomputed away. `override = true` marks a
 * page junk that the count never reached (a one-off advert, which by definition appears once and so can
 * never repeat); `override = false` rescues a page the count got wrong. That is the escape hatch that makes
 * an automatic skip safe to turn on: anything it gets wrong can be corrected permanently, by hand, in one
 * tap. Reintroduce by applying the heuristic after the override instead of before, and a page you
 * un-flagged is silently re-flagged on the next run of the hash job.
 */
export async function junkPagesFor(bookId: string): Promise<Set<number>> {
  const bySource = await sourceGifPages(bookId);
  const rows = await q<{ book_id: string; page: number; hash: string | null; override: boolean | null }>(
    `SELECT p.book_id, p.page, p.hash, p.override
       FROM page_hashes p
       JOIN lib_books b ON b.id = p.book_id
      WHERE b.series_id = (SELECT series_id FROM lib_books WHERE id = $1)`,
    [bookId],
  ).catch(() => []);
  if (!rows.length) return bySource;

  const junk = junkHashes(
    rows.filter((r) => r.hash).map((r) => ({ bookId: r.book_id, page: r.page, hash: r.hash as string })),
  );

  const byHand = new Set<number>();
  const rescued = new Set<number>();
  const byRule = new Set<number>();
  let pages = 0;
  for (const r of rows) {
    if (r.book_id !== bookId) continue;
    if (r.page > 0) pages++;                          // page 0 is the job's "looked at it" mark, not a page
    if (r.override === false) { rescued.add(r.page); continue; } // rescued by hand: never skip
    if (r.override === true) byHand.add(r.page);
    else if (r.hash && junk.has(r.hash)) byRule.add(r.page);
  }

  /**
   * ⚠️ If the rule wants to hide most of a chapter, the rule is wrong about that chapter.
   *
   * Furniture is a credit page and maybe an advert -- on a real library the average is 1.4 pages, and under
   * 6% of all pages. Measured against 7,000 hashed chapters, 3.4% of the chapters that skip anything wanted
   * to skip MORE THAN HALF, and the worst wanted 68 of 88. Those are duplicate and phantom chapters, where
   * the same file is filed several times over, so every page legitimately "recurs across chapters" and the
   * arithmetic is correct while the conclusion is nonsense.
   *
   * There is no way to tell those apart from inside the rule, so the chapter's own shape is the check: a
   * chapter that is mostly furniture is not a chapter. Above a third, the heuristic is discarded entirely
   * and the chapter reads as it always did -- fewer skips, which is the direction this feature is always
   * wrong in. A third is far above any genuine case and well below every misfire measured.
   *
   * A decision made BY HAND is never capped. That is the one source that is not arithmetic, and the whole
   * point of it is that it outranks the rule.
   *
   * Reintroduce by dropping the guard: a chapter whose file is duplicated across the series loses most of
   * its pages, which is the one failure this feature must never have.
   */
  const out = new Set(byHand);
  if (pages === 0 || byRule.size * 3 <= pages) for (const p of byRule) out.add(p);
  for (const p of bySource) if (!rescued.has(p)) out.add(p);
  return out;
}

/** Mark or un-mark one page by hand. `null` hands it back to the heuristic. */
export async function setPageOverride(bookId: string, page: number, override: boolean | null): Promise<void> {
  await q(
    `INSERT INTO page_hashes (book_id, page, override) VALUES ($1, $2, $3)
     ON CONFLICT (book_id, page) DO UPDATE SET override = EXCLUDED.override`,
    [bookId, page, override],
  );
}
