// The chapters a series is missing, as the reader says them when it moves on to the next chapter (#236).
//
// ONE rule, the Health page's (lib/health.ts chapterGaps), never a second one in the browser: the numbers the series
// HOLDS (lib/libraryNumbers.ts haveNumbers -- every number a range file holds, a chapter deleted on purpose, a post its
// source deleted under posting-order numbering, a hidden notice), without the impossible ones (health.ts
// plausibleNumbers), and the whole numbers between them (lib/fill.ts gapsOf). Less the runs an admin ignored on that
// card (lib/healthIgnore.ts), run by run: an ignored run is no news to a reader either, and a run missing since is.
//
// The reader used to count from its own chapter list, plain numbers: a file holding 1 to 7 read as "2-7 missing", and a
// run the cleanup deleted after everyone read it as a hole, every time someone re-read across it.
//
// Holes below a series' Latest-N start are kept: nothing fetches them (fill.ts splitAtFloor), but the chapters are not
// here, and a reader crossing one is skipping them all the same.
import { haveNumbers } from './libraryNumbers';
import { gapsOf } from './fill';
import { plausibleNumbers } from './health';
import { ignoredGapRuns } from './healthIgnore';

export interface GapRun { lo: number; hi: number }

/** `gaps` less every run that lies inside one of `ignored` (each [lo, hi]), as the Health card counts an ignore. */
export function notIgnored(gaps: GapRun[], ignored: Array<[number, number]>): GapRun[] {
  return gaps.filter((g) => !ignored.some(([lo, hi]) => g.lo >= lo && g.hi <= hi));
}

/** One series' missing runs, lowest first. */
export async function seriesGaps(seriesId: string): Promise<GapRun[]> {
  const [have, ignored] = await Promise.all([haveNumbers(seriesId), ignoredGapRuns(seriesId)]);
  return notIgnored(gapsOf(plausibleNumbers(have)).map(({ lo, hi }) => ({ lo, hi })), ignored);
}
