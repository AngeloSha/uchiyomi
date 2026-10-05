/**
 * "Rescan everything" (v0.55.4, discussion #150): the chapters whose files are gone from your own folders, found and
 * shown first, then marked on Apply.
 *
 * WHY IT EXISTS
 *   @Kedryn on #150: "What if I want to rescan everything from scratch, removing from library what is no more on
 *   disk?" He keeps hand-collected US and IT comics in a library of his own, and a scan never removes anything:
 *   persistScan only inserts or updates the files it finds (lib/library.ts), so a chapter whose file he deleted,
 *   moved out or renamed stays live for good -- listed, counted, opening onto "Chapter deleted". Verify chapter files
 *   (lib/verifyFiles.ts) finds those as well, and marks only the download folder's, for the sweep to fetch again:
 *   a file in a library you built by hand is counted and left, because Uchiyomi cannot fetch it back.
 *
 * WHAT IT DOES
 *   The preview (startRescan, detached like Verify): one scan first, so every file on disk has its row and a renamed
 *   file is the new row it will be; then one stat per live row's OWN file, root by root -- never the series folder,
 *   because a merge survivor's rows sit in the folder it absorbed; then a plan, kept in memory with its id and its
 *   time, saying what Apply would do. Nothing in the plan is changed by the preview.
 *   Apply (startApply, detached too): refused for a stale plan and beside any job that changes the library, then,
 *   with every scan held off (withScansHeld), each planned row is asked again -- the same id at the same file, still
 *   live, its series still looked at, its file still not there, its fingerprint still no live row's -- and marked
 *   pruned with reason 'deleted' (tombstoneBooks), the mark Delete files leaves on a file it removed: HELD, so the
 *   sweep never fetches it back, and "File no longer on disk" on the series page. Then the cover and the counts of
 *   every series it touched, an audit entry, and the result, kept in server_settings for the Tasks line.
 *
 * ⚠️ A ROW IS NEVER ERASED. read_progress.book_id is ON DELETE RESTRICT and the row IS everyone's reading history of
 *   the chapter; erasing it would also turn its number into a ghost the sweep downloads again (lib/komgaGhosts.ts),
 *   and flip a tracker's "finished" (trackers.ts counts every row). The tombstone keeps all of it, and a file that
 *   comes back is picked up again: the scan clears the mark on the same row (lib/library.ts persistScan).
 *   Reintroduce by erasing the rows: "Apply marks your own folder's gone chapters and nothing else" finds rows gone.
 *
 * ⚠️ ONLY YOUR OWN LIBRARY FOLDER IS MARKED (LIBRARY_ROOT). The download folder's gone rows are Verify chapter
 *   files' to mark 'missing', the one reason the sweep fetches again onto the same rows; here they are counted, and
 *   the panel points at Verify. Rows under any other root are not a scan's, so not a rescan's. Nothing else is
 *   touched: no file on disk, no row already pruned (Verify's 'missing' above all keeps its mark), no series hidden
 *   or forgotten -- a series with nothing left is listed with a link, for the admin -- and no tracker floor, read
 *   mark, favourite or rating.
 *
 * ⚠️ THE WHOLE-ROOT RULES, PER ROOT, ARE VERIFY'S (lib/verifyFiles.ts says why at length). An unmounted share is an
 *   empty, readable mount point, and from in here it looks exactly like a library whose every file is gone: a root
 *   where no looked-at row's FILE is present (a folder is no proof -- the downloader creates folders on a bare mount
 *   point), or that cannot be read, plans nothing and is reported; and so is a root where more than nine rows in ten
 *   have no file, with the share in the entry, so one stray file cannot turn "unmounted" into "mark the rest".
 *   Reintroduce by dropping the present-file test: "an empty library folder looks unmounted and plans nothing" in
 *   rescan.int.test.ts finds the root reported by the 90 % rule instead (the second net over the same hole); by
 *   dropping REFUSE_ABOVE: "a folder with almost every file gone is refused, with the share of it" finds the rows
 *   planned.
 *
 * ⚠️ ONLY "NOT THERE" IS GONE. Verify reads any failed stat as a missing file. Here only ENOENT and ENOTDIR are: a
 *   folder the server may not read (EACCES), a NAS that answers with an I/O error or a stale handle, says nothing
 *   about whether the file is there, and a plan built on it would mark files that are fine. Those rows are counted
 *   as `unchecked` and left out of both whole-root rules. Reintroduce by reading every failed stat as gone: "a file
 *   that cannot be checked is not a gone file" finds the unreadable folder's chapters planned.
 *
 * ⚠️ MOVED OR RENAMED IS PAIRED BEFORE ANYTHING IS MARKED. A file renamed in place, or moved into another folder,
 *   is a new row to the scan (rows are keyed on (root, file)) and its old row reads as gone. That old row holds the
 *   chapter's whole reading history, so a gone row whose fingerprint (lib/fingerprint.ts, the archive's own entry
 *   table) matches a live row's is "moved or renamed" and KEPT, never planned. It has to happen before any mark: a
 *   tombstone forgets its fingerprint (tombstoneBooks). The scan has just made the new row, and the background
 *   backfill has not reached it yet, so the live rows that were never fingerprinted are fingerprinted here, newest
 *   first, at most PAIR_MAX per preview. Reintroduce by planning every gone row: "a moved or renamed file is paired
 *   before anything is planned" finds the renamed chapter's old row in the plan.
 *
 * ⚠️ APPLY LOOKS AGAIN, UNDER THE SCAN HOLD. Minutes can pass between the preview and the press: a file comes back,
 *   a renumber or a rename moves a row to another file, Verify or a cleanup marks one, a share is unmounted. So a
 *   planned row is marked only if it is still the row that was looked at and its file is still not there, the folder
 *   still holds the files the preview saw (`samples`), and no live row has its fingerprint by now. With scans held,
 *   no scan can bring a row back between the look and the mark. Reintroduce by marking the plan as it stands: "Apply
 *   asks every row again, with scans held" finds the file that came back marked.
 *
 * ⚠️ NEVER AT BOOT, NEVER ON A SCHEDULE, for Verify's reason: a boot with the share not yet mounted is the empty
 *   mount point on every start. The one caller is the admin's Tasks panel (routes/admin.ts, routes/rescan.ts).
 *   "rescan never runs at boot or on a schedule" in rescan.int.test.ts pins the callers.
 *
 * THE OPT-IN: CHAPTER NUMBERS BY THE NEWER FILE-NAME RULES (v0.55.2's rule 2, lib/naming.ts). A row is read by the rule
 *   it was first scanned with, for good -- so a library collected before v0.55.2 keeps "Vol 2 Ch 5" as chapter 2 and
 *   "Batman (1987) #12" as 1987, behind the readers' backs of nobody, because a completed chapter's number is what the
 *   trackers were told (the book_overrides note in lib/migrate.ts). Re-reading every name was refused on purpose. Here
 *   it is asked for, per series, with the cost in front of the admin: the preview lists each series whose numbers
 *   rule 2 would change (`numberByRule(name, 2)` against the stored number and range), with how many readers finished
 *   one of those chapters, how many carry a number set by hand (those keep it), and for a series linked to a tracker
 *   how many finished chapters would go up -- told next time, irreversibly -- or down, which the tracker floor
 *   refuses. A series numbered by posting order, or in the middle of a renumber, is left out: its numbers are not its
 *   file names'. Apply sets name_rule, number and number_end for the ticked series only, in one transaction under the
 *   same scan hold, writes an audit entry, and pushes NOTHING to a tracker. "From scratch" never means erase and
 *   insert again: new ids would strand every row's history, and turn every row into a rule-2 row unasked.
 *
 * It is DETACHED from its route like Verify and the sweep: a scan and one stat per chapter over a network share is
 * minutes on a large library, and a request that long dies at the reverse proxy. The route answers `started`, and
 * the Tasks panel polls GET /api/admin/tasks/rescan/status for the phase, the progress and the plan.
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'fs/promises';
import type { FastifyRequest } from 'fastify';
import { q, one, tx } from './db';
import { DL_ROOT, LIBRARY_ROOT, persistScan, scanRunning, withScansHeld } from './library';
import { containedPath } from './fsGuard';
import { runtime } from './runtime';
import { visibleToAll } from './visibility';
import { fingerprintOne } from './fingerprintJob';
import { tombstoneBooks } from './chapterCleanup';
import { verifyState } from './verifyFiles';
import { renumberRunning } from './numbering';
import { logAudit } from './audit';
import { scheduleHealthSummaryRefresh } from './healthSummary';
import { numberByRule } from './naming';
import { numberText } from './chapterRanges';

/** How many stats are in flight at once: a NAS answers a handful in parallel well and thousands badly (Verify's). */
const CONCURRENCY = 16;
/** Rows read per query per root; the ids of what is gone are what stays in memory. */
const PAGE = 2000;
/** More than this share of a root's looked-at rows gone is refused, not planned (the header's 90 % rule). */
const REFUSE_ABOVE = 0.9;
/** Live files fingerprinted at most per preview, newest first, to pair the gone ones with (the header). */
const PAIR_MAX = 5000;
/** How many fingerprints are read at once: each is one open and a small read of an archive's entry table. */
const PAIR_CONCURRENCY = 4;
/** Present files kept per root, for Apply to see the folder is still there before it marks anything under it. */
const SAMPLES = 20;
/** How long a preview may be applied for. Older, Apply asks for a new one: the library has had time to change. */
export const PLAN_TTL_MS = 30 * 60_000;
/** Example changes the opt-in shows per series. */
const EXAMPLES = 3;

export type RescanPhase = 'scan' | 'look' | 'pair' | 'numbers' | 'mark' | 'renumber';

/** A root the whole-root rules refused: no present file at all, or `missing` of the `of` rows looked at (the 90 % rule). */
export interface Unmounted { root: string; missing?: number; of?: number }

/** A chapter row the plan is about: its id, its series and the file it named when it was looked at. */
export interface PlanRow { id: string; seriesId: string; file: string }

/** A series whose chapter numbers the newer file-name rules would change (the header's opt-in). */
export interface NumberSeries {
  seriesId: string;
  /** Chapters whose number, or range, changes. */
  chapters: number;
  /** Readers who finished one of them. */
  readers: number;
  /** Chapters it would change that carry a number set by hand (Edit number & title): they keep it, untouched. */
  overrides: number;
  /** Linked to a tracker -- and of the changed chapters someone finished, how many go up, and how many down. */
  tracked: boolean;
  up: number;
  down: number;
  /** The first few changes, by file name: the number now and by the new rules ("2" -> "5", "1" -> "1–7"). */
  examples: Array<{ file: string; from: string; to: string }>;
}

export interface RescanPlan {
  id: string;
  /** When the preview finished, and when its scan did (epoch ms). */
  at: number;
  scannedAt: number;
  ms: number;
  /** Live rows whose file was looked for, under roots that were not refused. */
  looked: number;
  /** Rows whose file could not be checked at all (not "not there": EACCES, EIO, ...): left out, and left alone. */
  unchecked: number;
  unmounted: Unmounted[];
  /** Rows in your own library folder whose file is gone, with no live twin: what Apply marks. */
  mark: PlanRow[];
  /** Gone rows in your own folder whose file is another live row's now: kept, never marked. `to` is that row. */
  moved: Array<PlanRow & { to: PlanRow }>;
  /** Rows in the download folder whose file is gone: Verify chapter files' to mark, counted here only. */
  downloads: number;
  /** Series with a live row and every live row's file gone (marked, moved or in the download folder). */
  emptied: Array<{ seriesId: string; chapters: number }>;
  /** Files present under the library folder at the preview, for Apply's look before it marks there. */
  samples: string[];
  /** The opt-in: every series the newer file-name rules would renumber. */
  numbers: NumberSeries[];
  applied: boolean;
}

/** What one Apply did: the Tasks line, the panel's result and the audit entry. Persisted in server_settings. */
export interface RescanApplied {
  ok: true;
  /** The preview it applied. */
  plan: string;
  /** Rows in your own folder marked pruned with reason 'deleted': their file is no longer on disk. */
  marked: number;
  /** Planned rows whose file was back on disk at Apply: left as they are. */
  back: number;
  /**
   * Planned rows that were no longer the row looked at -- pruned since, moved to another file by a rename or a
   * renumber, their series hidden, merged or being renumbered -- or whose file could not be checked at Apply.
   */
  changed: number;
  /** Gone rows kept because their file is another live row's: the preview's pairs, and any found at Apply. */
  moved: number;
  /** The preview's counts, carried for the line: gone from the download folder (Verify's), series with nothing left. */
  downloads: number;
  emptied: number;
  /** The library folder, when it no longer held the files the preview saw: nothing under it was marked. */
  unmounted: Unmounted[];
  /** The opt-in: the ticked series renumbered by the newer rules, and their chapters whose number changed. */
  renumbered: { series: number; chapters: number };
  ms: number;
  /** A shutdown stopped it between batches: what it had marked stays marked, because it was true. */
  stopped?: 'shutdown';
}

export interface RescanState {
  running: 'preview' | 'apply' | null;
  phase: RescanPhase | null;
  done: number;
  of: number | null;
  startedAt: number | null;
  /** The newest preview, while there is one: a new preview replaces it. */
  plan: RescanPlan | null;
  /** How the last preview or Apply ended when it did not end well. */
  error: 'failed' | 'stopped' | null;
  /** When this process last finished an Apply, and what it did (null after one that threw). */
  appliedAt: number | null;
  lastApplied: RescanApplied | null;
}

export const rescanState: RescanState = {
  running: null, phase: null, done: 0, of: null, startedAt: null, plan: null, error: null, appliedAt: null, lastApplied: null,
};

const setPhase = (phase: RescanPhase, of: number | null = null): void => {
  rescanState.phase = phase;
  rescanState.done = 0;
  rescanState.of = of;
};

/** The two roots a scan walks, the library first. Rows under any other root are not a scan's, so not a rescan's. */
const rootsWalked = (): string[] => [...new Set([LIBRARY_ROOT, DL_ROOT])];

type Look = 'present' | 'gone' | 'unchecked';

/** One row's own file. Null for a path that escapes its root: something for Health, not a gone chapter. */
async function look(root: string, file: string): Promise<Look | null> {
  const abs = containedPath(root, file);
  if (!abs) return null;
  try {
    await stat(abs);
    return 'present';
  } catch (e) {
    // ⚠️ Only "not there" is gone (the header).
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unchecked';
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

interface Row { id: string; series_id: string; file: string; fingerprint: string | null }
interface Gone extends PlanRow { fingerprint: string | null }

/**
 * The rows a rescan looks at: live chapters of a series that is neither hidden nor merged away, nor in the middle of
 * a renumber (#116) -- between a renumber's first rename and its commit its rows name files that sit at temporary or
 * new names, and every one of them would read as gone (Verify's own exclusion, lib/verifyFiles.ts).
 */
const LOOKED_AT = `b.pruned_at IS NULL AND ${visibleToAll('s')} AND s.renumber_plan IS NULL`;

/**
 * The preview: scan, look, pair, plan. Exported for the tests; the route goes through startRescan. Null when a
 * shutdown stopped it between pages: a half-looked root says nothing the whole-root rules can stand on.
 */
export async function previewRescan(): Promise<RescanPlan | null> {
  const t0 = Date.now();
  // The scan first: every file on disk gets its row before anything is called gone, and a file renamed by hand is the
  // new row it is going to be, for the pairing below. A scan already running is shared, as every caller's is.
  // Reintroduce by dropping it: "the preview scans first" in rescan.int.test.ts finds the new file without a row.
  setPhase('scan');
  runtime.lastScan = Date.now();
  await persistScan();
  const scannedAt = Date.now();

  const roots = rootsWalked();
  const counts = new Map((await q<{ root: string; n: number }>(
    `SELECT b.root, count(*)::int AS n FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.root = ANY($1) AND ${LOOKED_AT} GROUP BY b.root`, [roots])).map((r) => [r.root, r.n]));
  setPhase('look', [...counts.values()].reduce((a, b) => a + b, 0));

  const unmounted: Unmounted[] = [];
  const own: Gone[] = [];
  let downloads = 0;
  let looked = 0;
  let unchecked = 0;
  let samples: string[] = [];
  /** Every gone row's id, any root: no gone row is anybody's live twin. */
  const goneIds = new Set<string>();
  const goneBySeries = new Map<string, number>();

  for (const root of roots) {
    const total = counts.get(root) ?? 0;
    // A root with nothing to look at is not a finding: an install with no library of its own has an empty one.
    if (!total) continue;
    // The root itself first: an unreadable root is the unmounted case before a single row is read.
    if (!(await stat(root).catch(() => null))) { unmounted.push({ root }); rescanState.done += total; continue; }

    const gone: Gone[] = [];
    let seen = 0;
    let present = 0;
    let uncheckedHere = 0;
    const kept: string[] = [];
    let after = '';
    for (;;) {
      if (runtime.stopping) return null;
      const page = await q<Row>(
        `SELECT b.id, b.series_id, b.file, b.fingerprint FROM lib_books b JOIN lib_series s ON s.id = b.series_id
          WHERE b.root = $1 AND b.id > $2 AND ${LOOKED_AT}
          ORDER BY b.id LIMIT $3`,
        [root, after, PAGE],
      );
      if (!page.length) break;
      after = page[page.length - 1].id;
      const looks = await mapLimit(page, CONCURRENCY, (r) => look(root, r.file));
      page.forEach((r, i) => {
        const l = looks[i];
        if (!l) return;
        if (l === 'unchecked') { uncheckedHere++; return; }
        seen++;
        if (l === 'gone') { gone.push({ id: r.id, seriesId: r.series_id, file: r.file, fingerprint: r.fingerprint }); return; }
        // A handful of present files spread over the whole root (a reservoir), for Apply's look at the root.
        present++;
        if (kept.length < SAMPLES) kept.push(r.file);
        else {
          const j = Math.floor(Math.random() * present);
          if (j < SAMPLES) kept[j] = r.file;
        }
      });
      rescanState.done += page.length;
    }
    // Asked again before anything is decided, as Verify asks: a renumber that began after a row was read renames its
    // file away from the name looked at, and one that committed since moved the row to a new name. Neither is
    // evidence either way, and both are left out of the whole-root rules as well as the plan.
    const still = gone.length ? new Set((await q<{ id: string }>(
      `SELECT b.id FROM lib_books b JOIN unnest($1::text[], $2::text[]) AS x(id, file) ON b.id = x.id AND b.file = x.file
         JOIN lib_series s ON s.id = b.series_id
        WHERE ${LOOKED_AT}`,
      [gone.map((g) => g.id), gone.map((g) => g.file)])).map((r) => r.id)) : new Set<string>();
    const goneHere = gone.filter((g) => still.has(g.id));
    seen -= gone.length - goneHere.length;
    if (!seen) continue;
    // ⚠️ The whole-root rules (the header): no file present is a volume that is not there, or a disk with nothing on
    // it, and neither is evidence about any one chapter; nine in ten gone is the admin's call, not the task's.
    if (!present) { unmounted.push({ root }); continue; }
    if (goneHere.length > seen * REFUSE_ABOVE) { unmounted.push({ root, missing: goneHere.length, of: seen }); continue; }
    looked += seen;
    unchecked += uncheckedHere;
    for (const g of goneHere) {
      goneIds.add(g.id);
      goneBySeries.set(g.seriesId, (goneBySeries.get(g.seriesId) ?? 0) + 1);
    }
    // ⚠️ Only your own folder's rows are planned. The download folder's are Verify's: it marks them 'missing', the
    // one reason the sweep fetches again, onto the same rows.
    if (root === DL_ROOT) downloads += goneHere.length;
    else { own.push(...goneHere); samples = kept; }
  }

  const moved = await pairMoved(own, goneIds, roots);
  const movedIds = new Set(moved.map((m) => m.id));
  const mark = own.filter((g) => !movedIds.has(g.id)).map(({ id, seriesId, file }) => ({ id, seriesId, file }));

  // A series with nothing left: every live row it has is gone, whichever way. Listed for the admin, never hidden.
  const emptied: RescanPlan['emptied'] = [];
  if (goneBySeries.size) {
    const live = await q<{ id: string; n: number }>(
      `SELECT series_id AS id, count(*)::int AS n FROM lib_books WHERE series_id = ANY($1) AND pruned_at IS NULL GROUP BY series_id`,
      [[...goneBySeries.keys()]]);
    for (const r of live) if ((goneBySeries.get(r.id) ?? 0) >= r.n) emptied.push({ seriesId: r.id, chapters: r.n });
  }

  const numbers = await numberChanges();

  return {
    id: randomUUID(), at: Date.now(), scannedAt, ms: Date.now() - t0, looked, unchecked, unmounted,
    mark, moved, downloads, emptied, samples, numbers, applied: false,
  };
}

/**
 * The series the opt-in may renumber: live, not in the middle of a renumber, and numbered by their files -- a series
 * numbered by posting order (#116) carries its posts' numbers, which no file name says.
 */
const RENUMBERABLE = `${visibleToAll('s')} AND s.renumber_plan IS NULL AND s.numbering IS DISTINCT FROM 'posting_order'`;
/**
 * The rows the opt-in reads again: every row of such a series still read by an older rule, but a row Verify marked
 * 'missing' -- it keeps everything it had, for the sweep that fetches it back onto the same row -- and a row an admin
 * numbered by hand, which keeps that number (book_overrides).
 */
const REREAD = `b.name_rule <> 2 AND (b.pruned_at IS NULL OR b.pruned_reason IS DISTINCT FROM 'missing')`;

/** A file's own name, from a row's file: what the scanner hands numberByRule (lib/library.ts persistScan). */
const baseName = (file: string): string => file.split('/').pop() || file;
/** Two stored-or-read numbers alike, as the `real` column holds them (a null end is no range). */
const sameNumber = (a: number | null, b: number | null): boolean =>
  (a == null || b == null ? a == null && b == null : Math.fround(Number(a)) === Math.fround(Number(b)));
/** The number a tracker is told for a finished book: a range's end, else its number (lib/chapterRanges.ts). */
const told = (n: number, end: number | null): number => (end != null && end > n ? end : n);

interface Reading { id: string; seriesId: string; file: string; from: { n: number; e: number | null }; to: { n: number; e: number | null } }

/**
 * Every row the opt-in would change, read by rule 2 from its file's name: the rows whose number or range differs from
 * what is stored, and, apart, the rows with a number set by hand that would (they keep theirs). `ids` narrows it to
 * some series (Apply's), with the queryer of its transaction.
 */
async function readAgain(
  qq: <T = any>(sql: string, params?: any[]) => Promise<T[]>, ids: string[] | null,
): Promise<{ changed: Reading[]; overrides: Map<string, number>; rule1: string[] }> {
  const changed: Reading[] = [];
  const overrides = new Map<string, number>();
  const rule1: string[] = [];
  let after = '';
  for (;;) {
    const page = await qq<{ id: string; series_id: string; file: string; number: number; number_end: number | null; ov: number | null }>(
      `SELECT b.id, b.series_id, b.file, b.number, b.number_end, ov.number AS ov
         FROM lib_books b JOIN lib_series s ON s.id = b.series_id LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE ${REREAD} AND ${RENUMBERABLE} AND b.id > $1 ${ids ? 'AND b.series_id = ANY($3)' : ''}
        ORDER BY b.id LIMIT $2`,
      ids ? [after, PAGE, ids] : [after, PAGE]);
    if (!page.length) break;
    after = page[page.length - 1].id;
    for (const r of page) {
      const read = numberByRule(baseName(r.file), 2);
      const from = { n: Number(r.number), e: r.number_end == null ? null : Number(r.number_end) };
      const same = sameNumber(from.n, read.number) && sameNumber(from.e, read.end);
      if (r.ov != null) {
        // ⚠️ An admin's number is a decision about the chapter: it is neither read again nor moved to rule 2.
        if (!same) overrides.set(r.series_id, (overrides.get(r.series_id) ?? 0) + 1);
        continue;
      }
      rule1.push(r.id);
      if (!same) changed.push({ id: r.id, seriesId: r.series_id, file: r.file, from, to: { n: read.number, e: read.end } });
    }
  }
  return { changed, overrides, rule1 };
}

/** The opt-in's half of the preview: each series rule 2 would renumber, and what that costs (the header). */
async function numberChanges(): Promise<NumberSeries[]> {
  setPhase('numbers');
  const { changed, overrides } = await readAgain(q, null);
  if (!changed.length) return [];
  const ids = changed.map((c) => c.id);
  const series = [...new Set(changed.map((c) => c.seriesId))];
  const [readers, finished, tracked] = await Promise.all([
    q<{ series_id: string; n: number }>(
      `SELECT b.series_id, count(DISTINCT rp.user_id)::int AS n FROM read_progress rp JOIN lib_books b ON b.id = rp.book_id
        WHERE rp.completed AND rp.book_id = ANY($1) GROUP BY b.series_id`, [ids]),
    q<{ book_id: string }>(`SELECT DISTINCT book_id FROM read_progress WHERE completed AND book_id = ANY($1)`, [ids]),
    q<{ series_id: string }>(`SELECT DISTINCT series_id FROM series_trackers WHERE series_id = ANY($1)`, [series]),
  ]);
  const readersOf = new Map(readers.map((r) => [r.series_id, r.n]));
  const done = new Set(finished.map((r) => r.book_id));
  const linked = new Set(tracked.map((r) => r.series_id));
  const out = new Map<string, NumberSeries>();
  for (const c of changed.sort((a, b) => a.file.localeCompare(b.file))) {
    let e = out.get(c.seriesId);
    if (!e) {
      e = { seriesId: c.seriesId, chapters: 0, readers: readersOf.get(c.seriesId) ?? 0, overrides: overrides.get(c.seriesId) ?? 0,
        tracked: linked.has(c.seriesId), up: 0, down: 0, examples: [] };
      out.set(c.seriesId, e);
    }
    e.chapters++;
    if (done.has(c.id)) {
      const was = told(c.from.n, c.from.e);
      const will = told(c.to.n, c.to.e);
      if (will > was) e.up++;
      else if (will < was) e.down++;
    }
    if (e.examples.length < EXAMPLES) e.examples.push({ file: c.file, from: numberText(c.from.n, c.from.e), to: numberText(c.to.n, c.to.e) });
  }
  return [...out.values()];
}

/**
 * The gone rows of your own folder whose file lives on as another live row (the header): renamed in place, or moved
 * to another folder. The live rows that were never fingerprinted are fingerprinted first, newest first -- the scan
 * that just ran made the new row, and the background backfill has not reached it.
 */
async function pairMoved(own: Gone[], goneIds: Set<string>, roots: string[]): Promise<RescanPlan['moved']> {
  if (!own.some((g) => g.fingerprint)) return [];
  const ids = [...goneIds];
  const todo = await q<{ id: string; root: string; file: string }>(
    `SELECT b.id, b.root, b.file FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.fp_at IS NULL AND b.root = ANY($1) AND ${LOOKED_AT} AND NOT (b.id = ANY($2::text[]))
      ORDER BY b.created_at DESC, b.id LIMIT $3`,
    [roots, ids, PAIR_MAX]);
  setPhase('pair', todo.length);
  await mapLimit(todo, PAIR_CONCURRENCY, async (b) => {
    if (runtime.stopping) return;
    await fingerprintOne(b).catch(() => false);
    rescanState.done++;
  });
  const twins = new Map((await q<{ fingerprint: string; id: string; series_id: string; file: string }>(
    `SELECT DISTINCT ON (b.fingerprint) b.fingerprint, b.id, b.series_id, b.file FROM lib_books b
      WHERE b.pruned_at IS NULL AND b.fingerprint = ANY($1::text[]) AND NOT (b.id = ANY($2::text[]))
      ORDER BY b.fingerprint, b.created_at DESC, b.id`,
    [[...new Set(own.map((g) => g.fingerprint).filter((f): f is string => !!f))], ids])).map((r) => [r.fingerprint, r]));
  const out: RescanPlan['moved'] = [];
  for (const g of own) {
    const t = g.fingerprint ? twins.get(g.fingerprint) : undefined;
    if (t) out.push({ id: g.id, seriesId: g.seriesId, file: g.file, to: { id: t.id, seriesId: t.series_id, file: t.file } });
  }
  return out;
}

type Log = { info: (m: string) => void; warn: (m: string) => void; error?: (e: any) => void };

/**
 * Start a preview, the way the Tasks panel does: one at a time, detached, its plan kept for Apply. Same contract as
 * runVerify -- `false` while one is running, otherwise the promise, which the route does not await (the header).
 * A new preview replaces the plan before it: an Apply of the older one is refused.
 */
export function startRescan(log?: Log): Promise<RescanPlan | null> | false {
  if (rescanState.running) return false;
  rescanState.running = 'preview';
  rescanState.startedAt = Date.now();
  rescanState.plan = null;
  rescanState.error = null;
  setPhase('scan');
  return (async () => {
    try {
      const plan = await previewRescan();
      rescanState.plan = plan;
      if (!plan) rescanState.error = 'stopped';
      else {
        log?.info(`rescan: ${plan.looked} chapter file(s) looked for; ${plan.mark.length} gone from the library folder, `
          + `${plan.moved.length} moved or renamed, ${plan.downloads} gone from the download folder, ${plan.emptied.length} series with nothing left`);
        for (const u of plan.unmounted) log?.warn(`rescan: ${u.root}: no file (or almost none) behind its chapter rows -- is the volume mounted? Nothing under it is planned`);
      }
      return plan;
    } catch (e) {
      rescanState.plan = null;
      rescanState.error = 'failed';
      log?.error?.(e);
      throw e;
    } finally {
      rescanState.running = null;
      rescanState.phase = null;
    }
  })();
}

// ---- Apply ------------------------------------------------------------------------------------------------------

/** Why an Apply was not started. Every job named here changes the library, or looks at it to change it. */
export type ApplyRefusal =
  | 'busy' | 'no_plan' | 'stale' | 'applied' | 'not_in_plan'
  | 'sweep_running' | 'autofix_running' | 'repair_running' | 'verify_running' | 'cleanup_running' | 'scan_running';

/** Who pressed Apply, for the audit entry. */
export interface ApplyWho { userId: string | null; req?: FastifyRequest; log?: Log }
/**
 * Tests only: `held` runs inside the scan hold, before anything is looked at again -- the moment a scan is asked for;
 * `renumbered` inside the opt-in's transaction, after its writes -- the moment a failure must take them all back.
 */
export interface ApplyOpts { held?: () => Promise<void>; renumbered?: () => Promise<void> }

/**
 * The job that is changing the library right now, if one is. A plan is a picture of the library at its preview, and
 * every one of these redraws it: a sweep or a repair lands and scans files, Fix everything merges and deletes,
 * Verify and the cleanup mark rows, a scan writes them. Answered by name, as the repair and the sweep answer each
 * other, so the panel can say which. Reintroduce by dropping a line: "Apply is refused for a stale preview, an
 * applied one, and beside another job" in rescan.int.test.ts names the job that was let through.
 */
function clashing(): ApplyRefusal | null {
  if (runtime.updating) return 'sweep_running';
  if (runtime.autofixing) return 'autofix_running';
  if (runtime.repairing) return 'repair_running';
  if (verifyState.running) return 'verify_running';
  if (runtime.cleaning) return 'cleanup_running';
  if (scanRunning()) return 'scan_running';
  return null;
}

/**
 * Start an Apply of the plan the admin saw, or say why not. Same contract as the preview: detached, the route
 * answers `started`, the panel polls the status route, and the result is kept in memory and in server_settings.
 * `plan` must be the newest preview's id, not yet applied, and younger than PLAN_TTL_MS; `renumber` the series the
 * admin ticked in its opt-in, every one of them in the plan.
 */
export function startApply(
  input: { plan: string; renumber?: string[] },
  who: ApplyWho,
  opts: ApplyOpts = {},
): { ok: true; run: Promise<RescanApplied> } | { ok: false; error: ApplyRefusal } {
  if (rescanState.running) return { ok: false, error: 'busy' };
  const plan = rescanState.plan;
  if (!plan) return { ok: false, error: 'no_plan' };
  // A newer preview replaced it, or it is older than its time: the library has had time to change under it.
  if (plan.id !== input.plan || Date.now() - plan.at > PLAN_TTL_MS) return { ok: false, error: 'stale' };
  if (plan.applied) return { ok: false, error: 'applied' };
  // Only a series the admin was shown: its cost was in front of them. Reintroduce by dropping this: "Apply renumbers
  // only the series ticked" in rescan.int.test.ts renumbers a series the preview never listed.
  const listed = new Set(plan.numbers.map((n) => n.seriesId));
  const renumber = [...new Set(input.renumber ?? [])];
  if (renumber.some((id) => !listed.has(id))) return { ok: false, error: 'not_in_plan' };
  const clash = clashing();
  if (clash) return { ok: false, error: clash };
  // Taken now, in the same turn as the checks: a second press is `busy`, and a plan is applied once whatever happens.
  plan.applied = true;
  rescanState.running = 'apply';
  rescanState.startedAt = Date.now();
  rescanState.error = null;
  setPhase('mark', plan.mark.length);
  const run = (async () => {
    try {
      const r = await applyPlan(plan, renumber, opts);
      rescanState.appliedAt = Date.now();
      rescanState.lastApplied = r;
      if (r.stopped) rescanState.error = 'stopped';
      // Persisted as Verify's is: the Tasks line keeps the last Apply across a restart.
      // Reintroduce by dropping this UPDATE: "the Apply answers started ... a restart keeps the result" in
      // rescan.int.test.ts finds the Tasks row empty after the simulated restart.
      await q('UPDATE server_settings SET rescan_last_run = now(), rescan_last_result = $1::jsonb WHERE id = 1', [JSON.stringify(r)]).catch(() => {});
      // A library-wide change, so the Activity feed says who made it and what it did.
      await logAudit('library.rescan', {
        userId: who.userId,
        detail: { plan: r.plan, marked: r.marked, back: r.back, changed: r.changed, moved: r.moved, downloads: r.downloads, emptied: r.emptied, unmounted: r.unmounted, ms: r.ms, ...(r.stopped ? { stopped: r.stopped } : {}) },
        req: who.req,
      });
      // The opt-in, an entry of its own: chapter numbers are what a tracker is told, and the feed must say who changed
      // them, in which series, even though nothing was sent anywhere.
      if (r.renumbered.series) {
        await logAudit('library.rescan_numbers', {
          userId: who.userId, detail: { plan: r.plan, series: r.renumbered.series, chapters: r.renumbered.chapters, ids: renumber.slice(0, 100) }, req: who.req,
        });
      }
      scheduleHealthSummaryRefresh();
      who.log?.info(`rescan: ${r.marked} chapter(s) marked as no longer on disk; ${r.back} back on disk and ${r.changed} changed since the preview, left alone`
        + (r.renumbered.series ? `; ${r.renumbered.chapters} chapter(s) of ${r.renumbered.series} series renumbered by the new file-name rules` : '')
        + (r.stopped ? ' (stopped for shutdown)' : ''));
      for (const u of r.unmounted) who.log?.warn(`rescan: ${u.root} no longer holds the files the preview saw -- is the volume mounted? Nothing under it was marked`);
      return r;
    } catch (e) {
      // Never leave an older healthy result standing after an Apply that threw (Verify's rule), in memory or the row.
      rescanState.appliedAt = Date.now();
      rescanState.lastApplied = null;
      rescanState.error = 'failed';
      await q('UPDATE server_settings SET rescan_last_run = now(), rescan_last_result = NULL WHERE id = 1').catch(() => {});
      who.log?.error?.(e);
      throw e;
    } finally {
      rescanState.running = null;
      rescanState.phase = null;
    }
  })();
  return { ok: true, run };
}

/** Is the library folder still the one the preview looked at: readable, and holding a file it saw there? */
async function stillMounted(root: string, samples: string[]): Promise<boolean> {
  if (!(await stat(root).catch(() => null))) return false;
  for (const f of samples) if ((await look(root, f)) === 'present') return true;
  return false;
}

/** Marked per statement: a shutdown is honoured between batches, and no statement names thousands of ids. */
const MARK_BATCH = 500;

async function applyPlan(plan: RescanPlan, renumber: string[], opts: ApplyOpts): Promise<RescanApplied> {
  const t0 = Date.now();
  const out: RescanApplied = {
    ok: true, plan: plan.id, marked: 0, back: 0, changed: 0, moved: plan.moved.length,
    downloads: plan.downloads, emptied: plan.emptied.length, unmounted: [], renumbered: { series: 0, chapters: 0 }, ms: 0,
  };
  // ⚠️ With every scan held off (the header): a scan between the look below and the mark could bring a row back, or
  // move it, and the mark would land on a chapter whose file is there -- and one between the opt-in's read and its
  // write would re-read a row by its old rule under the new one's number.
  // Reintroduce by running this outside withScansHeld: "Apply asks every row again, with scans held" sees a scan
  // start inside the Apply.
  await withScansHeld(async () => {
    await opts.held?.();
    await markGone(plan, out);
    if (renumber.length && !out.stopped) {
      setPhase('renumber', renumber.length);
      out.renumbered = await renumberSeries(renumber, opts);
    }
  });
  out.ms = Date.now() - t0;
  return out;
}

/** Apply's marking: every planned row asked again, then marked (the header). Inside applyPlan's scan hold. */
async function markGone(plan: RescanPlan, out: RescanApplied): Promise<void> {
  if (!plan.mark.length) return;
  // The folder first: one that no longer holds the files the preview saw is unmounted now, whatever it held then.
  if (!(await stillMounted(LIBRARY_ROOT, plan.samples))) {
    out.unmounted.push({ root: LIBRARY_ROOT });
    return;
  }
  const now = new Map((await q<{ id: string; file: string; root: string; pruned_at: string | null; fingerprint: string | null; series_id: string; looked: boolean }>(
    `SELECT b.id, b.file, b.root, b.pruned_at, b.fingerprint, b.series_id, (${visibleToAll('s')} AND s.renumber_plan IS NULL) AS looked
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.id = ANY($1)`,
    [plan.mark.map((m) => m.id)])).map((r) => [r.id, r]));
  const gone: Array<{ id: string; seriesId: string; fingerprint: string | null }> = [];
  await mapLimit(plan.mark, CONCURRENCY, async (m) => {
    const c = now.get(m.id);
    // ⚠️ Still the row that was looked at: never one pruned since (Verify's 'missing' keeps its mark), moved to
    // another file or root, or of a series hidden, merged away or being renumbered meanwhile.
    if (!c || c.pruned_at || c.file !== m.file || c.root !== LIBRARY_ROOT || !c.looked || renumberRunning(c.series_id)) out.changed++;
    else {
      const l = await look(LIBRARY_ROOT, m.file);
      if (l === 'present') out.back++;
      else if (l === 'gone') gone.push({ id: m.id, seriesId: c.series_id, fingerprint: c.fingerprint });
      else out.changed++;
    }
    rescanState.done++;
  });
  // ⚠️ Paired again, before the mark wipes the fingerprint: the backfill may have fingerprinted a moved file's new
  // row since the preview. Reintroduce by dropping this: "a file paired since the preview is kept" finds it marked.
  const fps = [...new Set(gone.map((g) => g.fingerprint).filter((f): f is string => !!f))];
  const twinned = fps.length ? new Set((await q<{ fingerprint: string }>(
    `SELECT DISTINCT fingerprint FROM lib_books WHERE pruned_at IS NULL AND fingerprint = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`,
    [fps, gone.map((g) => g.id)])).map((r) => r.fingerprint)) : new Set<string>();
  const todo = gone.filter((g) => !(g.fingerprint && twinned.has(g.fingerprint)));
  out.moved += gone.length - todo.length;
  const touched = new Set<string>();
  for (let i = 0; i < todo.length; i += MARK_BATCH) {
    if (runtime.stopping) { out.stopped = 'shutdown'; break; }
    const batch = todo.slice(i, i + MARK_BATCH);
    // 'deleted': held, as Delete files' mark -- the sweep never fetches these back (chapterCleanup.ts heldBooks).
    await tombstoneBooks(batch.map((g) => g.id), 'deleted');
    out.marked += batch.length;
    for (const g of batch) touched.add(g.seriesId);
  }
  if (touched.size) await refreshSeries([...touched]);
}

/**
 * The opt-in's write (the header): the ticked series' rows read again by rule 2 -- name_rule, number and number_end
 * -- in ONE transaction, inside Apply's scan hold, and nothing told to any tracker. Each series is taken as it stands
 * now: one hidden, merged, put into posting order or being renumbered since the preview is left alone. A row with a
 * number set by hand keeps it, and its rule; a row Verify marked 'missing' keeps everything (REREAD). Rows that read
 * the same move to rule 2 as well, so the series is read one way from here on.
 * Reintroduce by writing outside the transaction (q in place of qq): "an opt-in that fails part way changes no
 * number" in rescan.int.test.ts finds the series renumbered after the Apply threw.
 */
async function renumberSeries(ids: string[], opts: ApplyOpts): Promise<{ series: number; chapters: number }> {
  return tx(async (qq) => {
    const ok = (await qq<{ id: string }>(
      `SELECT s.id FROM lib_series s WHERE s.id = ANY($1) AND ${RENUMBERABLE} FOR UPDATE`, [ids]))
      .map((r) => r.id).filter((id) => !renumberRunning(id));
    if (!ok.length) return { series: 0, chapters: 0 };
    const { changed, rule1 } = await readAgain(qq, ok);
    await qq(
      `UPDATE lib_books b SET name_rule = 2, number = v.n, number_end = v.e, updated_at = now()
         FROM unnest($1::text[], $2::real[], $3::real[]) AS v(id, n, e) WHERE b.id = v.id`,
      [changed.map((c) => c.id), changed.map((c) => c.to.n), changed.map((c) => c.to.e)]);
    // The rows that read the same by both rules: rule 2 from here on, their numbers as they are.
    await qq('UPDATE lib_books SET name_rule = 2 WHERE id = ANY($1) AND name_rule <> 2', [rule1]);
    await opts.renumbered?.();
    // The cover is the lowest live chapter by number, and the numbers just moved.
    await qq(
      `UPDATE lib_series s SET cover_book_id = c.id FROM (
         SELECT DISTINCT ON (series_id) series_id, id FROM lib_books WHERE series_id = ANY($1)
          ORDER BY series_id, (pruned_at IS NOT NULL), number ASC, file ASC) c
        WHERE s.id = c.series_id AND s.cover_book_id IS DISTINCT FROM c.id`, [ok]);
    rescanState.done = ok.length;
    return { series: new Set(changed.map((c) => c.seriesId)).size, chapters: changed.length };
  });
}

/**
 * The cover and the counts of the series an Apply touched, the way the scan writes them: the cover is the lowest
 * LIVE chapter (every thumbnail falls back to the cover chapter's first page, and a tombstone has none), and
 * books_count and latest_mtime are over every row, tombstones included -- "read" is every row read, as the trackers
 * count it. A series with nothing left keeps a tombstone as its cover: the dashed placeholder is the honest one.
 */
async function refreshSeries(ids: string[]): Promise<void> {
  await q(
    `UPDATE lib_series s SET cover_book_id = c.id FROM (
       SELECT DISTINCT ON (series_id) series_id, id FROM lib_books WHERE series_id = ANY($1)
        ORDER BY series_id, (pruned_at IS NOT NULL), number ASC, file ASC) c
      WHERE s.id = c.series_id AND s.cover_book_id IS DISTINCT FROM c.id`, [ids]).catch(() => {});
  await q(
    `UPDATE lib_series s SET books_count = c.n, latest_mtime = COALESCE(c.mt, 0)
       FROM (SELECT series_id, count(*) AS n, max(mtime) AS mt FROM lib_books WHERE series_id = ANY($1) GROUP BY series_id) c
      WHERE c.series_id = s.id`, [ids]).catch(() => {});
}

/** The last Apply: this process's, else the one a restart kept in server_settings. */
export async function lastApplied(): Promise<{ at: number | null; result: RescanApplied | null }> {
  if (rescanState.appliedAt) return { at: rescanState.appliedAt, result: rescanState.lastApplied };
  const r = await one<{ at: string | null; result: RescanApplied | null }>(
    'SELECT rescan_last_run AS at, rescan_last_result AS result FROM server_settings WHERE id = 1').catch(() => null);
  return { at: r?.at ? new Date(r.at).getTime() : null, result: r?.result ?? null };
}

/** A plan as the Tasks panel reads it: the counts, and the lists by series id (the route names them). */
export interface PlanView {
  id: string;
  at: number;
  scannedAt: number;
  ms: number;
  /** Older than PLAN_TTL_MS: Apply refuses it. */
  stale: boolean;
  applied: boolean;
  looked: number;
  unchecked: number;
  unmounted: Unmounted[];
  /** The headline's four counts: gone from your folders, moved or renamed, in the download folder, series emptied. */
  gone: number;
  moved: number;
  downloads: number;
  emptied: number;
  /** How many series lose a chapter to Apply. */
  goneSeries: number;
  emptiedList: Array<{ seriesId: string; chapters: number }>;
  movedList: Array<{ seriesId: string; file: string; to: { seriesId: string; file: string } }>;
  /** The opt-in: every series the newer rules would renumber, and how many in all. */
  numbers: NumberSeries[];
  numbersTotal: number;
}

export function planView(p: RescanPlan, now = Date.now()): PlanView {
  return {
    id: p.id, at: p.at, scannedAt: p.scannedAt, ms: p.ms, stale: now - p.at > PLAN_TTL_MS, applied: p.applied,
    looked: p.looked, unchecked: p.unchecked, unmounted: p.unmounted,
    gone: p.mark.length, moved: p.moved.length, downloads: p.downloads, emptied: p.emptied.length,
    goneSeries: new Set(p.mark.map((m) => m.seriesId)).size,
    emptiedList: p.emptied,
    movedList: p.moved.map((m) => ({ seriesId: m.seriesId, file: m.file, to: { seriesId: m.to.seriesId, file: m.to.file } })),
    numbers: p.numbers,
    numbersTotal: p.numbers.length,
  };
}
