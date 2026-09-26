// Every chapter file in the downloads folder, held up against the library (#109).
//
// v0.48.0 fixed the one way #109 was understood to happen -- a folder the database refused ended the whole scan
// -- and reported that one way. The reporters were still missing downloads: the walk itself dropped folders
// before any of that reporting ran (lib/library.ts, findSeriesDirs), and nothing compared what is ON DISK with
// what is IN THE LIBRARY. This does, from the other end, so whatever drops a download next can't do it
// quietly: it lists every chapter file under the downloads folder that the library does not hold, and says why
// when it can.
//
// Deliberately NOT the scanner's walk: no disk-id guard, no series detection, no claiming of folders. It
// descends every folder the scanner would look in (SKIP_DIR still applies: `.Trash-99` is not a download)
// and collects files. Sharing the scanner's rules would share its blind spots.
import { join, posix } from 'path';
import { stat, statfs } from 'fs/promises';
import { q } from './db';
import { DL_ROOT, SKIP_DIR, SCAN_MAX_DEPTH, listDir, nodeFs, lastScanReport, type WalkFs, type ScanReport, type WalkReason } from './library';
import { chapterFileRel } from './downloader';
import { visibleToAll } from './visibility';

/** What the downloader writes and the scanner reads as a chapter file (EPUBs need opening, and are not ours). */
const CHAPTER_FILE = /\.(cbz|cbr|zip|rar|pdf)$/i;
/** The downloader's own name for a chapter (lib/downloader.ts chapterFileRel). A #109 loss is always one of these. */
const OURS = /^Chapter -?\d+(?:\.\d+)?\.cbz$/;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 500_000;
const CACHE_MS = 5 * 60_000;
/**
 * A file this much older than the last scan's start may still have landed during it: a NAS stamps a file's
 * mtime with its OWN clock, which need not agree with this server's. Counting it as waiting for the next scan
 * for two minutes too long is harmless; calling a file missing that the scan simply had not reached is not.
 */
const SKEW_MS = ((): number => {
  // CENSUS_CLOCK_SKEW_MS=0 for the tests, whose files land seconds before a scan and must still count.
  const raw = process.env.CENSUS_CLOCK_SKEW_MS;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2 * 60_000;
})();
/** Files stat'ed to tell "landed after the last scan began" from "missing". Past this, the rest count as missing. */
const MAX_PENDING_STATS = 2000;

/**
 * Why a folder's files are not in the library, as far as can be said.
 * - `layout`: where the files sit means the scan never reads them as chapters -- straight in the downloads
 *   folder, deeper than it looks, or inside a folder it already reads as a series.
 * - `scan`: the last scan said why -- it could not read the folder (or one above it), or the database refused it.
 * - `deleted`: the library still marks these chapters deleted, and no scan has read the files since.
 * - `unexplained`: nothing says why. The case this check exists for.
 */
export type MissingKind = 'layout' | 'scan' | 'deleted' | 'unexplained';
export interface MissingFolder {
  /** Relative to the downloads folder; '' is the folder itself. */
  folder: string;
  /** Chapter file names in it that are not in the library. */
  files: string[];
  reason: string | null;
  kind: MissingKind;
  /**
   * At least one file is named the way the downloader names a chapter, so this app wrote it. A stray `.zip` or
   * `.pdf` of someone's own, somewhere the scan never reads chapters from, is listed but never turns Health red:
   * the only way to clear that would be to move the person's own file.
   */
  ours: boolean;
  /** The series this folder belongs to, when there is a row for it. */
  seriesId?: string;
}
export interface Census {
  at: string;
  root: string;
  /** e.g. "FUSE (Unraid user share, mergerfs, rclone…)". Null when the platform cannot say. */
  fsType: string | null;
  /** Chapter files under the downloads folder. */
  files: number;
  missing: MissingFolder[];
  missingFiles: number;
  /** Chapter files of series someone removed: on purpose, so counted, not listed. */
  removed: number;
  /** Chapter files newer than the last scan's start (less the clock margin): not scanned YET, so not missing. */
  pending: number;
  /** Folders this could not read, or entries in them it could not check: nothing in them can be counted. */
  unreadable: Array<{ folder: string; error: string }>;
  /** No library scan has finished since the server started, so nothing here has been through one yet. */
  noScan: boolean;
  /** The last scan stopped at its folder cap: some folders were never looked into. */
  scanCapped: boolean;
  /** Stopped at MAX_ENTRIES: the counts are a floor. */
  truncated: boolean;
}

/** statfs magic numbers, for the one fact every support thread about a missing folder needs first. */
const FS_NAMES: Record<number, string> = {
  0x65735546: 'FUSE (Unraid user share, mergerfs, rclone…)',
  0x58465342: 'xfs',
  0x9123683e: 'btrfs',
  0x2fc12fc1: 'zfs',
  0xef53: 'ext4',
  0x794c7630: 'overlay',
  0x01021994: 'tmpfs',
  0x6969: 'NFS',
  0xff534d42: 'SMB',
  0xfe534d42: 'SMB',
  0x5346544e: 'NTFS',
};
export async function fsTypeOf(path: string): Promise<string | null> {
  try {
    const t = Number((await statfs(path)).type);
    if (!t) return null; // Windows answers 0: nothing to say
    return FS_NAMES[t] ?? `type 0x${t.toString(16)}`;
  } catch {
    return null;
  }
}

/** Is `a` the folder `b`, or inside it? '' contains everything. */
const within = (a: string, b: string) => !b || a === b || a.startsWith(`${b}/`);

/**
 * The walk findings that hide a folder and EVERYTHING below it. Entries a listing could not check (`unchecked`)
 * are not one of them: the census reads folders with the same listing and cannot see those entries either, so
 * they never explain a file it did find. The folder cap is a note, not a reason for any one folder.
 */
const HIDES_SUBTREE: ReadonlySet<WalkReason> = new Set<WalkReason>(['unreadable', 'stat', 'loop']);

/**
 * Why the last scan left this downloads folder out, when it said: the database refusing the folder itself, or
 * a folder the walk could not read -- this one, or one above it. Null when the scan said nothing about it, which
 * includes when no scan has run.
 */
export function scanReasonFor(folder: string, report: ScanReport | null = lastScanReport()): string | null {
  if (!report) return null;
  const skip = report.skipped.find((s) => s.root === 'downloads' && s.folder === folder);
  if (skip) return `the library refused it: ${skip.error}`;
  const walk = report.walk.find((w) => w.root === 'downloads' && HIDES_SUBTREE.has(w.reason) && within(folder, w.folder));
  if (!walk) return null;
  const where = walk.folder === folder ? 'the folder' : `"${walk.folder || 'the downloads folder'}", above it,`;
  switch (walk.reason) {
    case 'unreadable': return `the scan could not read ${where}: ${walk.detail}`;
    case 'stat': return `the scan could not check ${where}: ${walk.detail}`;
    default: return `the scan took ${where} for a loop: ${walk.detail}`;
  }
}

let cached: { at: number; root: string; scanAt: string | null; census: Census } | null = null;
let inflight: { root: string; scanAt: string | null; census: Promise<Census> } | null = null;
/** For the tests, and for anything that has just changed the folder on purpose. */
export function clearCensusCache(): void { cached = null; }

/**
 * The census. Kept until a scan finishes or five minutes pass, whichever is first -- a scan that fixed things
 * must not leave the Health page and the header saying otherwise -- and one at a time: the Health page, the
 * admin overview and the six-hourly summary share a census that is still running rather than each walking the
 * folder again. `fsx` is a parameter for the test.
 */
export function downloadCensus(opts: { root?: string; fsx?: WalkFs; force?: boolean } = {}): Promise<Census> {
  const root = opts.root ?? DL_ROOT;
  const scanAt = lastScanReport()?.at ?? null;
  if (!opts.force && cached && cached.root === root && cached.scanAt === scanAt && Date.now() - cached.at < CACHE_MS) {
    return Promise.resolve(cached.census);
  }
  if (!opts.force && inflight && inflight.root === root && inflight.scanAt === scanAt) return inflight.census;
  const census = takeCensus(root, opts.fsx ?? nodeFs).then((c) => {
    cached = { at: Date.now(), root, scanAt, census: c };
    return c;
  }).finally(() => { if (inflight?.census === census) inflight = null; });
  inflight = { root, scanAt, census };
  return census;
}

async function takeCensus(root: string, fsx: WalkFs): Promise<Census> {
  const found: string[] = [];
  const unreadable: Census['unreadable'] = [];
  let entries = 0;
  let truncated = false;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || truncated) return;
    const listing = await listDir(abs, fsx);
    if (listing.error) {
      if (listing.error !== 'ENOENT') unreadable.push({ folder: rel, error: listing.error });
      return;
    }
    if (listing.unchecked?.length) unreadable.push({ folder: rel, error: `${listing.unchecked.length} entries could not be checked` });
    for (const e of listing.entries) {
      if (++entries > MAX_ENTRIES) { truncated = true; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.kind === 'dir') { if (!SKIP_DIR.test(e.name)) await walk(join(abs, e.name), r, depth + 1); }
      else if (e.kind === 'file' && CHAPTER_FILE.test(e.name)) found.push(r);
    }
  };
  await walk(root, '', 0);

  // Every row under this root. A row on a live series counts only while it is not a tombstone: a chapter marked
  // deleted whose file is back on disk is one no scan has read since (the scan clears the mark when it does).
  const rows = await q<{ file: string; removed: boolean; pruned: boolean }>(
    `SELECT b.file, (s.deleted_at IS NOT NULL) AS removed, (b.pruned_at IS NOT NULL) AS pruned
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.root = $1`,
    [root],
  );
  const row = new Map(rows.map((r) => [r.file, r]));
  // Folders the library holds chapters from: a file below one of them sits inside something the scan read as a
  // series, and a series' subfolders are never looked into.
  const indexedFolders = new Set(rows.filter((r) => !r.removed).map((r) => posix.dirname(r.file)));
  // Folders every row of which is removed: the scan passes over them on purpose (lib/library.ts, `removed`), so
  // what is in them -- a job that was still downloading when the series was removed, say -- is not missing.
  const removedFolders = (await q<{ folder: string }>(
    `SELECT folder FROM lib_series GROUP BY folder HAVING bool_and(deleted_at IS NOT NULL)`,
  ).catch(() => [] as Array<{ folder: string }>)).map((r) => r.folder);

  const report = lastScanReport();
  const scannedFrom = report ? Date.parse(report.startedAt) - SKEW_MS : null;
  const folderOf = (rel: string) => (rel.includes('/') ? posix.dirname(rel) : '');
  let removed = 0;
  const candidates = new Map<string, Array<{ name: string; pruned: boolean }>>();
  for (const rel of found) {
    const r = row.get(rel);
    if (r?.removed) { removed++; continue; }
    if (r && !r.pruned) continue;
    const folder = folderOf(rel);
    if (removedFolders.some((f) => within(folder, f))) { removed++; continue; }
    (candidates.get(folder) ?? candidates.set(folder, []).get(folder)!).push({ name: posix.basename(rel), pruned: !!r?.pruned });
  }

  // Not in the library. Landed after the last scan began? Then it has not been looked at yet. A folder's own
  // mtime moves whenever a file lands in it, so a folder older than that holds nothing newer, and only the files
  // of a newer folder are stat'ed -- bounded, because this runs on the Health page.
  let pending = 0;
  let stats = 0;
  const byFolder = new Map<string, Array<{ name: string; pruned: boolean }>>();
  for (const [folder, files] of candidates) {
    let keep = files;
    if (scannedFrom !== null && stats < MAX_PENDING_STATS) {
      stats++;
      const dirTime = await stat(join(root, folder)).then((s) => s.mtimeMs, () => null);
      if (dirTime !== null && dirTime >= scannedFrom) {
        keep = [];
        for (const f of files) {
          let m: number | null = null;
          if (stats < MAX_PENDING_STATS) {
            stats++;
            m = await stat(join(root, folder, f.name)).then((s) => s.mtimeMs, () => null);
          }
          if (m !== null && m >= scannedFrom) pending++;
          else keep.push(f);
        }
      }
    }
    if (keep.length) byFolder.set(folder, keep);
  }

  const folders = [...byFolder.keys()].sort();
  const ids = folders.length
    ? await q<{ id: string; folder: string }>(`SELECT id, folder FROM lib_series s WHERE s.folder = ANY($1) AND ${visibleToAll('s')}`, [folders])
    : [];
  const idOf = new Map(ids.map((r) => [r.folder, r.id]));
  const missing: MissingFolder[] = folders.map((folder) => {
    const files = byFolder.get(folder)!;
    const names = files.map((f) => f.name).sort();
    const ours = names.some((n) => OURS.test(n));
    // Where the files sit comes first: it is true whatever the scan did, and no rescan changes it.
    const holder = [...indexedFolders].find((f) => f !== folder && within(folder, f));
    let reason: string | null = !folder
      ? 'chapter files straight in the downloads folder: only a folder can be a series'
      : folder.split('/').length > SCAN_MAX_DEPTH
        ? `more than ${SCAN_MAX_DEPTH} folders deep, and the scan looks no deeper (LIBRARY_MAX_DEPTH)`
        : holder
          ? `inside "${holder}", which the scan reads as a series, and a series' subfolders are not looked into`
          : null;
    let kind: MissingKind = reason ? 'layout' : 'unexplained';
    if (!reason) {
      reason = scanReasonFor(folder, report);
      if (reason) kind = 'scan';
    }
    const pruned = files.filter((f) => f.pruned).length;
    if (!reason && pruned === files.length) {
      reason = `the library still marks ${pruned === 1 ? 'it' : `these ${pruned}`} deleted, and no scan has read ${pruned === 1 ? 'the file' : 'the files'} since`;
      kind = 'deleted';
    }
    return { folder, files: names, reason, kind, ours, ...(idOf.has(folder) ? { seriesId: idOf.get(folder)! } : {}) };
  });

  return {
    at: new Date().toISOString(), root, fsType: await fsTypeOf(root),
    files: found.length, missing, missingFiles: missing.reduce((n, m) => n + m.files.length, 0),
    removed, pending, unreadable, noScan: !report,
    scanCapped: !!report?.walk.some((w) => w.root === 'downloads' && w.reason === 'limit'),
    truncated,
  };
}

/** Does this finding need someone to act? Anything but a stray file of the person's own where no chapter is read. */
export const countsAsMissing = (m: MissingFolder): boolean => m.ours || m.kind !== 'layout';

/**
 * Of these chapter numbers, the ones whose file in the downloads folder did not reach the library.
 *
 * What an add or a Fetch checks after its last scan (#109): "done" has to mean the chapters are readable, and a
 * chapter the scan could not index is on disk and nowhere else. By FILE -- the downloader's own name for it,
 * under the downloads root -- and not by series and number: a number the library holds from another folder, or
 * another root, says nothing about the file this job wrote. And only a LIVE row counts: a tombstone at the same
 * path (Fetch again renames the old file aside and marks it deleted before downloading the new one) is cleared
 * by the scan that reads the new file, so a tombstone still there means no scan did.
 */
export async function notInLibrary(folder: string, numbers: number[]): Promise<number[]> {
  const uniq = [...new Set(numbers)];
  if (!uniq.length) return [];
  const files = uniq.map((n) => chapterFileRel(folder, n));
  const rows = await q<{ file: string }>(
    `SELECT b.file FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.root = $1 AND b.file = ANY($2) AND b.pruned_at IS NULL AND ${visibleToAll('s')}`,
    [DL_ROOT, files],
  );
  const have = new Set(rows.map((r) => r.file));
  return uniq.filter((n) => !have.has(chapterFileRel(folder, n)));
}

/** The job card's words for chapters that landed on disk and not in the library. */
export function notInLibraryReason(folder: string, numbers: number[]): string {
  const list = numbers.slice(0, 5).join(', ') + (numbers.length > 5 ? ` and ${numbers.length - 5} more` : '');
  const one = numbers.length === 1;
  const why = scanReasonFor(folder);
  return `Chapter${one ? '' : 's'} ${list} ${one ? 'is' : 'are'} on disk, but the library scan could not add ${one ? 'it' : 'them'}`
    + `${why ? ` (${why})` : ''}. Admin → Health → Downloads missing from the library has the details.`;
}
