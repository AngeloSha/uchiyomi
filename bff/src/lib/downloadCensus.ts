// Every chapter file in the downloads folder, held up against the library (#109).
//
// v0.48.0 fixed the one way #109 was understood to happen -- a folder the database refused ended the whole scan
// -- and reported that one way. The reporters were still missing downloads: the walk itself dropped folders
// before any of that reporting ran (lib/library.ts, findSeriesDirs), and nothing compared what is ON DISK with
// what is IN THE LIBRARY. This does, from the other end, so whatever drops a download next can't do it
// quietly: it lists every chapter file under the downloads folder with no `lib_books` row, and says why when
// the last scan knows.
//
// Deliberately NOT the scanner's walk: no disk-id guard, no series detection, no claiming of folders. It
// descends every folder the scanner would look in (SKIP_DIR still applies: `.Trash-99` is not a download)
// and collects files. Sharing the scanner's rules would share its blind spots.
import { join, posix } from 'path';
import { stat, statfs } from 'fs/promises';
import { q } from './db';
import { DL_ROOT, SKIP_DIR, SCAN_MAX_DEPTH, listDir, nodeFs, lastScanReport, type WalkFs, type ScanReport } from './library';
import { chapterFileRel } from './downloader';
import { visibleToAll } from './visibility';

/** What the downloader writes and the scanner reads as a chapter file (EPUBs need opening, and are not ours). */
const CHAPTER_FILE = /\.(cbz|cbr|zip|rar|pdf)$/i;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 500_000;
const CACHE_MS = 5 * 60_000;

export interface MissingFolder {
  /** Relative to the downloads folder; '' is the folder itself. */
  folder: string;
  /** Chapter file names in it that are not in the library. */
  files: string[];
  /** Why, when the last scan said, or when the layout does. */
  reason: string | null;
  /** The series this folder belongs to, when there is a row for it. */
  seriesId?: string;
}
export interface Census {
  at: string;
  root: string;
  /** e.g. "FUSE (Unraid user share, mergerfs)". Null when the platform cannot say. */
  fsType: string | null;
  /** Chapter files under the downloads folder. */
  files: number;
  missing: MissingFolder[];
  missingFiles: number;
  /** Chapter files of series someone removed: on purpose, so counted, not listed. */
  removed: number;
  /** Chapter files newer than the last scan's start: not scanned YET, so not missing. */
  pending: number;
  /** Folders this could not read: whatever is inside them cannot be in the library either. */
  unreadable: Array<{ folder: string; error: string }>;
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
 * Why the last scan left this downloads folder out, when it knows. The scan's own words: a walk finding on the
 * folder or on one of the folders above it, or the database refusing the folder.
 */
export function scanReasonFor(folder: string, report: ScanReport | null = lastScanReport()): string | null {
  if (!report) return 'no library scan has run since the server started';
  const walk = report.walk.find((w) => w.root === 'downloads' && w.reason !== 'depth' && within(folder, w.folder));
  if (walk) {
    const where = walk.folder === folder ? '' : ` ("${walk.folder || 'the downloads folder'}" above it)`;
    switch (walk.reason) {
      case 'unreadable': return `the scan could not read the folder${where}: ${walk.detail}`;
      case 'unchecked': return `the scan could not check some entries${where}: ${walk.detail}`;
      case 'stat': return `the scan could not check the folder${where}: ${walk.detail}`;
      case 'loop': return `the scan took the folder${where} for a loop: ${walk.detail}`;
      default: return walk.detail;
    }
  }
  const skip = report.skipped.find((s) => s.root === 'downloads' && s.folder === folder);
  if (skip) return `the library refused it: ${skip.error}`;
  return null;
}

let cached: { at: number; root: string; census: Census } | null = null;
/** For the tests, and for anything that has just changed the folder on purpose. */
export function clearCensusCache(): void { cached = null; }

/**
 * The census. Cached for a few minutes: it reads every folder under the downloads folder, and the Health page
 * and the six-hourly summary both ask. `fsx` is a parameter for the test.
 */
export async function downloadCensus(opts: { root?: string; fsx?: WalkFs; force?: boolean } = {}): Promise<Census> {
  const root = opts.root ?? DL_ROOT;
  if (!opts.force && cached && cached.root === root && Date.now() - cached.at < CACHE_MS) return cached.census;
  const fsx = opts.fsx ?? nodeFs;

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

  // Every row under this root, whatever its series' state: a removed series' files are accounted for, not missing.
  const rows = await q<{ file: string; removed: boolean }>(
    `SELECT b.file, (s.deleted_at IS NOT NULL) AS removed FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.root = $1`,
    [root],
  );
  const row = new Map(rows.map((r) => [r.file, r.removed]));
  // Folders the library holds chapters from: a file below one of them sits inside something the scan read
  // as a series, and a series' subfolders are never looked into.
  const indexedFolders = new Set(rows.filter((r) => !r.removed).map((r) => posix.dirname(r.file)));

  const report = lastScanReport();
  const scannedFrom = report ? Date.parse(report.startedAt) : null;
  let removed = 0;
  let pending = 0;
  const byFolder = new Map<string, string[]>();
  for (const rel of found) {
    const r = row.get(rel);
    if (r === true) { removed++; continue; }
    if (r === false) continue;
    // Not in the library. Landed after the last scan began? Then it has not been looked at yet.
    if (scannedFrom !== null) {
      const m = await stat(join(root, rel)).then((s) => s.mtimeMs, () => null);
      if (m !== null && m >= scannedFrom) { pending++; continue; }
    }
    const folder = rel.includes('/') ? posix.dirname(rel) : '';
    (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(posix.basename(rel));
  }

  const folders = [...byFolder.keys()];
  const ids = folders.length
    ? await q<{ id: string; folder: string }>(`SELECT id, folder FROM lib_series s WHERE s.folder = ANY($1) AND ${visibleToAll('s')}`, [folders])
    : [];
  const idOf = new Map(ids.map((r) => [r.folder, r.id]));
  const missing: MissingFolder[] = folders.sort().map((folder) => {
    let reason = scanReasonFor(folder, report);
    if (!reason && !folder) reason = 'chapter files straight in the downloads folder: only a folder can be a series';
    if (!reason && folder.split('/').length > SCAN_MAX_DEPTH) reason = `more than ${SCAN_MAX_DEPTH} folders deep, and the scan looks no deeper (LIBRARY_MAX_DEPTH)`;
    if (!reason) {
      const holder = [...indexedFolders].find((f) => f !== folder && within(folder, f));
      if (holder) reason = `inside "${holder}", which the scan reads as a series, and a series' subfolders are not looked into`;
    }
    return { folder, files: byFolder.get(folder)!.sort(), reason, ...(idOf.has(folder) ? { seriesId: idOf.get(folder)! } : {}) };
  });

  const census: Census = {
    at: new Date().toISOString(), root, fsType: await fsTypeOf(root),
    files: found.length, missing, missingFiles: missing.reduce((n, m) => n + m.files.length, 0),
    removed, pending, unreadable, truncated,
  };
  cached = { at: Date.now(), root, census };
  return census;
}

/**
 * Of these chapter numbers, the ones whose file in the downloads folder did not reach the library.
 *
 * What an add or a Fetch checks after its last scan (#109): "done" has to mean the chapters are readable, and a
 * chapter the scan could not index is on disk and nowhere else. By FILE -- the downloader's own name for it,
 * under the downloads root -- and not by series and number: a number the library holds from another folder, or
 * another root, says nothing about the file this job wrote.
 */
export async function notInLibrary(folder: string, numbers: number[]): Promise<number[]> {
  const uniq = [...new Set(numbers)];
  if (!uniq.length) return [];
  const files = uniq.map((n) => chapterFileRel(folder, n));
  const rows = await q<{ file: string }>(
    `SELECT b.file FROM lib_books b JOIN lib_series s ON s.id = b.series_id WHERE b.root = $1 AND b.file = ANY($2) AND ${visibleToAll('s')}`,
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
