// Health: "Disk space and folders" (v0.72.0, from @Squeaks72's #253).
//
// Two things went unsaid until downloads had already stopped:
//  * Free space. The downloader refuses to start a chapter under MIN_FREE_GB (lib/downloader.ts assertFreeSpace) and
//    the slow archive waits under its own floor (Admin → Settings → Downloads, lib/archive.ts), and each said so only
//    in a download's error or the archive's wait. This card reads the same disk the same way and turns red at the very
//    floor the downloader refuses at -- never green while downloads are being refused -- and amber under the archive's
//    floor while the archive has a series queued, because that is when it waits. The draft in #253 had a floor of its
//    own (5 GB), so between 5 and 10 GB Health said fine while every download failed. Reintroduce a floor of its own:
//    "red at the downloader's own floor" in healthDisk.test.ts fails.
//  * A library or download folder that is not there. A NAS share that is not mounted leaves an empty, readable mount
//    point behind (the image itself ships /library and /library-dl as empty folders, lib/verifyFiles.ts), and a scan
//    then reads an empty library. A root that holds nothing while the library still records chapters under it is that
//    case. ⚠️ ONE ENTRY is read, never the whole folder: a readdir of a library's top level is tens of thousands of
//    names on a NAS and spins up every disk of an Unraid array, and this card runs every six hours and after every
//    scan, repair and source test (lib/healthSummary.ts). The chapters are counted only when the folder is empty.
//    Reintroduce a readdir: "the folder check reads one entry" in healthDisk.test.ts counts the reads.
//
// Ignoring a finding records its level as well (`levelMembers`): an ignored warning stays quiet while it is a warning,
// and a problem is news. Reintroduce empty members: "ignoring the warning does not silence the problem" in
// healthDisk.int.test.ts finds the problem quiet.
import { opendir, statfs } from 'fs/promises';
import { one } from './db';
import { visibleToAll } from './visibility';
import { DL_ROOT, LIBRARY_ROOT } from './library';
import { MIN_FREE_GB } from './downloader';
import { applyIgnores, noIgnores, type IgnoreCtx } from './healthIgnore';
import { ignoredPart, truncate } from './healthKit';
import { detailOf, joined, noteOf, say, saidOf, summaryOf } from './said';
import type { HealthCheck, HealthItem, HealthStatus } from './health';

const GB = 2 ** 30;
/** One decimal of a GB (2^30 bytes), as Admin → Settings → Downloads says free space (lib/archive.ts archiveFreeGb). */
const gb = (bytes: number): number => Math.round((bytes / GB) * 10) / 10;

/** The calls the card makes on the disk. A test hands in its own, to count them and to stand in for a share. */
export interface DiskFs {
  statfs(p: string): Promise<{ bavail: number | bigint; bsize: number | bigint; blocks: number | bigint }>;
  opendir(p: string, o: { bufferSize: number }): Promise<{ read(): Promise<unknown>; close(): Promise<void> }>;
}
const nodeFs: DiskFs = { statfs, opendir };

export interface Floors {
  /** The downloader's MIN_FREE_GB: new downloads stop under it. 0 is no floor. */
  download: number;
  /** The slow archive's floor, 0 when it has none or is paused. */
  archive: number;
  /** Whether the archive has a series waiting to be fetched: under its floor, that is what waits. */
  archiveQueued: boolean;
}

/** How the downloads disk stands: red under the downloader's floor, amber under the archive's while it has work. Pure. */
export function spaceLevel(free: number, f: Floors): HealthStatus {
  if (f.download > 0 && free < f.download * GB) return 'problem';
  if (f.archive > 0 && f.archiveQueued && free < f.archive * GB) return 'warn';
  return 'ok';
}

/**
 * What an ignore of a level records (lib/healthIgnore.ts: an ignore covers a finding while every member is one it
 * recorded). A problem carries the warning's member too, so an ignored problem that eases to a warning stays quiet,
 * while an ignored warning that becomes a problem is news.
 */
export const levelMembers = (level: HealthStatus): string[] => (level === 'problem' ? ['warn', 'problem'] : [level]);

/** A folder's first entry, or that it has none, or why it could not be opened. Never more than one read. */
async function firstEntry(fsx: DiskFs, dir: string): Promise<'entry' | 'empty' | NodeJS.ErrnoException> {
  try {
    const d = await fsx.opendir(dir, { bufferSize: 1 });
    try {
      return (await d.read()) ? 'entry' : 'empty';
    } finally {
      await d.close().catch(() => {});
    }
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
}

/** Chapters the library records under a root: asked only when the root looks empty or cannot be read. */
async function chaptersUnder(root: string): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.root = $1 AND b.pruned_at IS NULL AND ${visibleToAll('s')}`, [root],
  ).catch(() => null);
  return r?.n ?? 0;
}

/**
 * The slow archive's floor and whether it is paused, as lib/archive.ts archiveSettings reads them -- from the row itself:
 * importing the archive here would close a loop of modules (archive → sourceWatchdog → healthSummary → health) that
 * leaves one of them half loaded. Null when it cannot be read: no floor to keep.
 */
async function archiveFloor(): Promise<{ paused: boolean; minFreeGb: number } | null> {
  const r = await one<{ paused: boolean; min_free: number | null }>(
    'SELECT archive_paused AS paused, archive_min_free_gb AS min_free FROM server_settings WHERE id = 1',
  ).catch(() => null);
  return r ? { paused: r.paused === true, minFreeGb: Number(r.min_free) || 0 } : null;
}

/** Whether the slow archive has a series to fetch: what makes its floor matter (lib/archive.ts tickOnce's queue). */
async function archiveQueued(): Promise<boolean> {
  const r = await one<{ queued: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM archive_queue a JOIN lib_series s ON s.id = a.series_id
                     WHERE a.state = 'queued' AND s.auto_update AND ${visibleToAll('s')}) AS queued`,
  ).catch(() => null);
  return r?.queued === true;
}

export async function diskAndFolders(ctx: IgnoreCtx = noIgnores(), fsx: DiskFs = nodeFs): Promise<HealthCheck> {
  const rows: Array<HealthItem & { members?: string[] }> = [];
  const levels = new Map<string, HealthStatus>();

  // The folders: there, and not empty while the library records chapters under them. One root when the two are one.
  const roots = [
    { root: 'library' as const, dir: LIBRARY_ROOT },
    ...(DL_ROOT !== LIBRARY_ROOT ? [{ root: 'downloads' as const, dir: DL_ROOT }] : []),
  ];
  for (const r of roots) {
    const first = await firstEntry(fsx, r.dir);
    if (first === 'entry') continue;
    const books = await chaptersUnder(r.dir);
    // Nothing recorded under it: an install without that folder, or a library not filled yet -- not a finding.
    if (!books && (first === 'empty' || first.code === 'ENOENT')) continue;
    const t = say('folder', { root: r.root, folder: '' });
    const key = `folder:${r.root}`;
    rows.push({
      title: t.text, titleSaid: saidOf(t),
      ...detailOf([first === 'empty'
        ? say('disk.empty', { n: books })
        : say('missing.folderUnreadable', { error: String(first.code || first.message).slice(0, 160) })]),
      key, members: [first === 'empty' ? 'empty' : 'unreadable'],
    });
    levels.set(key, 'problem');
  }

  // Free space where downloads land: the disk the downloader and the archive measure (lib/downloader.ts freeBytes).
  const set = await archiveFloor();
  const floor = set?.minFreeGb ?? 0;
  const fs = await fsx.statfs(DL_ROOT).catch(() => null);
  const total = fs ? Number(fs.blocks) * Number(fs.bsize) : 0;
  const free = fs ? Number(fs.bavail) * Number(fs.bsize) : 0;
  const measured = total > 0;
  if (measured) {
    const archive = set && !set.paused ? floor : 0;
    // The queue is read only when it could matter: under a floor the archive keeps.
    const queued = archive > 0 && free < archive * GB ? await archiveQueued() : false;
    const level = spaceLevel(free, { download: MIN_FREE_GB, archive, archiveQueued: queued });
    const t = say('disk.title');
    const at = { free: gb(free), total: gb(total) };
    rows.push({
      title: t.text, titleSaid: saidOf(t),
      ...detailOf([level === 'problem' ? say('disk.full', { ...at, floor: MIN_FREE_GB })
        : level === 'warn' ? say('disk.archiveWaits', { ...at, floor: archive })
        : say('disk.free', at)]),
      // Only a finding can be ignored: the free space on a fine disk is a statement.
      ...(level === 'ok' ? { info: true } : { key: 'space:downloads', members: levelMembers(level) }),
    });
    if (level !== 'ok') levels.set('space:downloads', level);
  }

  const ignored = applyIgnores('disk', rows, ctx);
  const live = rows.filter((r) => !r.info);
  const status: HealthStatus = live.some((r) => levels.get(r.key ?? '') === 'problem') ? 'problem' : live.length ? 'warn' : 'ok';
  const { items } = truncate(rows);
  return {
    id: 'disk',
    title: 'Disk space and folders',
    status,
    ...summaryOf([
      live.length ? say('disk.live', { n: live.length }) : measured ? say('disk.fine', { free: gb(free) }) : say('disk.unmeasured'),
      ignoredPart(ignored),
    ]),
    ...noteOf([
      MIN_FREE_GB > 0 ? say('disk.noteFloor', { floor: MIN_FREE_GB }) : say('disk.noteNoFloor'),
      floor > 0 && joined('sentence', say('disk.noteArchive', { floor })),
      joined('sentence', say('disk.noteFolders')),
    ]),
    items,
  };
}
