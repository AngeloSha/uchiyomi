/**
 * Is a library root there, judged by the files the catalog says are under it?
 *
 * The background jobs that write what they saw into the catalog -- the nightly page count (lib/repair.ts), the
 * fingerprint pass (lib/fingerprintJob.ts) and the page-hash pass (lib/pageHashJob.ts) -- stamp a chapter whose file
 * they could not read as done for good. Run over a network share or removable drive that isn't mounted, they would
 * stamp every waiting chapter of it. rootUnavailable (lib/fsGuard.ts) catches a root that is gone or empty, but a bare
 * mount point is often NOT empty: a chapter sweep that ran while the share was down writes new downloads onto it, and
 * a stray file there makes it look mounted. So only a file the catalog knows is proof, and one in ten is not enough:
 * the same two whole-root rules as Verify chapter files (lib/verifyFiles.ts) and the read-chapter cleanup
 * (lib/chapterCleanup.ts) -- no catalogued file present, or more than 90 % of them missing, is a root that is not there.
 *
 * Every live row under the root may be asked, including the ones the job has already processed: the queue alone is
 * usually a handful of new files, and a handful missing says nothing about the root. A root that is there stops early,
 * though (ENOUGH_PRESENT): the rows are asked in a random order, and once enough are found the rule is passed. Rows a renumber is moving are
 * left out, as Verify leaves them. A stat that fails with anything but ENOENT/ENOTDIR (EACCES, an I/O error) says
 * nothing about whether the file is there, and is left out of both counts.
 */
import { stat } from 'fs/promises';
import { resolve } from 'path';
import { q } from './db';
import { containedPath, rootUnavailable } from './fsGuard';

/** How many stats are in flight at once (Verify's figure). */
const CONCURRENCY = 16;
/** More than this share of a root's catalogued files missing reads as the root not being there (Verify's 90 % rule). */
const REFUSE_ABOVE = 0.9;
/**
 * Enough proof that a root is there: this many of its catalogued files present, with no more than nine missing for
 * each (the 90 % rule, passed), in a random sample of its rows. A root that is there then costs a few dozen stats
 * rather than one per chapter -- 18,000 on the owner's download folder, asked by several passes a day, and on a NAS
 * each stat is a network round trip that can wake a sleeping disk. A root that is not there never gets here, and still
 * walks every row, so what the cleanup says it found ("26 of 27 missing") is exact. Reintroduce by walking every row:
 * "a root that is there is judged on a sample" in catalogRootGuard.int.test.ts counts every file.
 */
const ENOUGH_PRESENT = 32;

export interface CatalogFileCounts { present: number; missing: number; unchecked: number }

/**
 * How many of the live chapter files the catalog records under `root` are there, how many are not, and how many could
 * not be looked at. `defaultRoot` stands in for a row whose root is unset, as the jobs that read those rows treat it.
 */
export async function catalogFileCounts(root: string, defaultRoot = root): Promise<CatalogFileCounts> {
  const rows = await q<{ file: string }>(
    `SELECT b.file FROM lib_books b WHERE COALESCE(b.root, $2) = $1 AND b.pruned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM lib_series s WHERE s.id = b.series_id AND s.renumber_plan IS NOT NULL)
      ORDER BY random()`,
    [root, defaultRoot],
  );
  const base = resolve(root);
  let present = 0;
  let missing = 0;
  let unchecked = 0;
  let next = 0;
  const proven = () => present >= ENOUGH_PRESENT && missing <= present * 9;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length && !proven()) {
      const abs = containedPath(root, rows[next++].file);
      // A path that escapes its root, or the root itself, is no chapter file and no evidence either way.
      if (!abs || abs === base) continue;
      await stat(abs).then(() => { present++; }, (e: NodeJS.ErrnoException) => {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') missing++;
        else unchecked++;
      });
    }
  }));
  return { present, missing, unchecked };
}

/** True when `missing` of `present + missing` catalogued files reads as a root that is not there. */
export const looksUnmounted = (c: { present: number; missing: number }): boolean =>
  !c.present || c.missing > (c.present + c.missing) * REFUSE_ABOVE;

/**
 * Why a job must not stamp anything under `root` right now, or null when it may. A root with no live rows at all
 * passes when it opens and holds something: there is nothing the catalog could be wrong about. One whose rows could
 * not be looked at, every one of them, does not: nothing proves the share is there.
 * Reintroduce by returning rootUnavailable alone: "... leaves a populated bare mount unmarked" in
 * libraryRootGone.int.test.ts finds the chapters stamped.
 */
export async function catalogRootUnavailable(root: string, defaultRoot = root): Promise<string | null> {
  const why = await rootUnavailable(root);
  if (why) return why;
  const c = await catalogFileCounts(root, defaultRoot);
  if (!c.present && !c.missing && !c.unchecked) return null;
  if (!c.present) return 'no catalogued chapter file is there';
  return looksUnmounted(c) ? `${c.missing} of ${c.present + c.missing} catalogued chapter files missing` : null;
}
