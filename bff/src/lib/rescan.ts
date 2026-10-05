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
 * ⚠️ NEVER AT BOOT, NEVER ON A SCHEDULE, for Verify's reason: a boot with the share not yet mounted is the empty
 *   mount point on every start. The one caller is the admin's Tasks panel (routes/admin.ts, routes/rescan.ts).
 *   "rescan never runs at boot or on a schedule" in rescan.int.test.ts pins the callers.
 *
 * It is DETACHED from its route like Verify and the sweep: a scan and one stat per chapter over a network share is
 * minutes on a large library, and a request that long dies at the reverse proxy. The route answers `started`, and
 * the Tasks panel polls GET /api/admin/tasks/rescan/status for the phase, the progress and the plan.
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'fs/promises';
import { q } from './db';
import { DL_ROOT, LIBRARY_ROOT, persistScan } from './library';
import { containedPath } from './fsGuard';
import { runtime } from './runtime';
import { visibleToAll } from './visibility';
import { fingerprintOne } from './fingerprintJob';

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

export type RescanPhase = 'scan' | 'look' | 'pair';

/** A root the whole-root rules refused: no present file at all, or `missing` of the `of` rows looked at (the 90 % rule). */
export interface Unmounted { root: string; missing?: number; of?: number }

/** A chapter row the plan is about: its id, its series and the file it named when it was looked at. */
export interface PlanRow { id: string; seriesId: string; file: string }

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
  applied: boolean;
}

export interface RescanState {
  running: 'preview' | null;
  phase: RescanPhase | null;
  done: number;
  of: number | null;
  startedAt: number | null;
  /** The newest preview, while there is one: a new preview replaces it. */
  plan: RescanPlan | null;
  /** How the last preview ended when it did not end with a plan. */
  error: 'failed' | 'stopped' | null;
}

export const rescanState: RescanState = { running: null, phase: null, done: 0, of: null, startedAt: null, plan: null, error: null };

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

  return {
    id: randomUUID(), at: Date.now(), scannedAt, ms: Date.now() - t0, looked, unchecked, unmounted,
    mark, moved, downloads, emptied, samples, applied: false,
  };
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
}

export function planView(p: RescanPlan, now = Date.now()): PlanView {
  return {
    id: p.id, at: p.at, scannedAt: p.scannedAt, ms: p.ms, stale: now - p.at > PLAN_TTL_MS, applied: p.applied,
    looked: p.looked, unchecked: p.unchecked, unmounted: p.unmounted,
    gone: p.mark.length, moved: p.moved.length, downloads: p.downloads, emptied: p.emptied.length,
    goneSeries: new Set(p.mark.map((m) => m.seriesId)).size,
    emptiedList: p.emptied,
    movedList: p.moved.map((m) => ({ seriesId: m.seriesId, file: m.file, to: { seriesId: m.to.seriesId, file: m.to.file } })),
  };
}
