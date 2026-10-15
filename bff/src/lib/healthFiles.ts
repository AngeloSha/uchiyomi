// Health: "Chapter files" -- chapters whose file is gone, empty or cut short.
//
// Verify chapter files and Rescan everything (Admin -> Tasks) already find a missing file, but only when someone
// runs them. This is the passive view: a few thousand files are looked at on every run of the page, the ones never
// seen or last found wrong first, so the whole library is covered over several runs, and a chapter that went bad
// since the last look turns up on its own. A zip is also checked for its end record, which is what a download cut
// short in the middle lacks; a chapter whose file is there and complete is not opened.
//
// The whole-root rules are the rescan's: a folder where NO file is found is a share that is not mounted (the disk
// check says so), never a library whose every chapter was deleted, and only "no such file" counts as gone -- any
// other error is "could not look", which is not a finding.
import { open, rm, stat } from 'fs/promises';
import path from 'path';
import { q } from './db';
import { visibleToAll } from './visibility';
import { allWritable, containedPath } from './fsGuard';
import { tombstoneBooks } from './chapterCleanup';
import { REFETCH_BAK } from './fsAtomic';
import { logAudit } from './audit';
import { DL_ROOT, LIBRARY_ROOT } from './library';
import { applyIgnores, noIgnores, type IgnoreCtx } from './healthIgnore';
import { DAY_MS, hiddenPart, ignoredPart, truncate } from './healthKit';
import { detailOf, noteOf, say, summaryOf } from './said';
import type { HealthCheck, HealthItem } from './health';

export type FileState = 'ok' | 'missing' | 'empty' | 'broken' | 'unchecked';

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
/** An end-of-central-directory record is 22 bytes and may be followed by a comment of up to 65535. */
const TAIL = 22 + 65535;

/** Whether the tail of a zip holds its end record. Pure, for the tests. */
export const hasZipEnd = (tail: Buffer): boolean => tail.length >= 22 && tail.lastIndexOf(EOCD) >= 0;

const isZip = (file: string): boolean => /\.(cbz|zip)$/i.test(file);

/** One file, looked at: present and non-empty, and for a zip, ending the way a zip ends. */
export async function inspectFile(abs: string): Promise<FileState> {
  let size: number;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return 'unchecked';
    size = st.size;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unchecked';
  }
  if (size === 0) return 'empty';
  if (!isZip(abs)) return 'ok';
  try {
    const fh = await open(abs, 'r');
    try {
      const len = Math.min(size, TAIL);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, size - len);
      return hasZipEnd(buf.subarray(0, bytesRead)) ? 'ok' : 'broken';
    } finally {
      await fh.close();
    }
  } catch {
    return 'unchecked';
  }
}

interface Seen { at: number; state: FileState; mtime: number }
const seen = new Map<string, Seen>();

/** How long a file found fine is trusted before it is looked at again. */
const STALE_MS = 7 * DAY_MS;
const CONCURRENCY = 16;
/** A normal run looks at most this many files, and for at most this long; a full look (Fix everything's) goes on until everything is seen. */
const RUN_FILES = 3000;
const RUN_MS = 6000;
const FULL_MS = 45000;
/** More than this share of a root's files gone at once is a share that went away, not chapters deleted. */
const GONE_SHARE = 0.9;

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export interface BookRow { id: string; series_id: string; title: string; root: string; file: string; mtime: string | null }

export interface FileCounts { missing: number; empty: number; broken: number }

/** A series' bad chapters from the states seen, pure for the tests. Unmounted roots and `unchecked` are never findings. */
export function badOf(rows: BookRow[], states: ReadonlyMap<string, FileState>, skipRoots: ReadonlySet<string>) {
  const by = new Map<string, { title: string; counts: FileCounts; ids: string[] }>();
  for (const r of rows) {
    if (skipRoots.has(r.root)) continue;
    const st = states.get(r.id);
    if (st !== 'missing' && st !== 'empty' && st !== 'broken') continue;
    const e = by.get(r.series_id) ?? { title: r.title, counts: { missing: 0, empty: 0, broken: 0 }, ids: [] };
    e.counts[st]++;
    e.ids.push(r.id);
    by.set(r.series_id, e);
  }
  return by;
}

/** The roots whose "missing" files are a share that is not there, not deleted chapters. Pure, for the tests. */
export function goneRoots(rows: BookRow[], states: ReadonlyMap<string, FileState>, roots: string[]): Set<string> {
  const skip = new Set<string>();
  for (const root of roots) {
    const mine = rows.filter((r) => r.root === root && states.has(r.id));
    if (!mine.length) continue;
    const gone = mine.filter((r) => states.get(r.id) === 'missing').length;
    const present = mine.filter((r) => { const s = states.get(r.id); return s !== 'missing' && s !== 'unchecked'; }).length;
    if (gone && !present) skip.add(root);
    else if (mine.length >= 20 && gone > mine.length * GONE_SHARE) skip.add(root);
  }
  return skip;
}

/** Look at the files the way a run of the page does (a slice) or Fix everything does (all of them), and say what was seen. */
async function scan(opts: { full?: boolean }) {
  const roots = [...new Set([LIBRARY_ROOT, DL_ROOT])];
  const rows = await q<BookRow>(
    `SELECT b.id, b.series_id, s.title, b.root, b.file, b.mtime::text AS mtime
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.root = ANY($1) AND b.pruned_at IS NULL AND ${visibleToAll('s')} AND s.renumber_plan IS NULL`,
    [roots],
  );
  const live = new Set(rows.map((r) => r.id));
  for (const id of seen.keys()) if (!live.has(id)) seen.delete(id);

  const now = Date.now();
  const rank = (r: BookRow): number => {
    const e = seen.get(r.id);
    if (!e || e.mtime !== Number(r.mtime ?? 0)) return 0;
    if (e.state !== 'ok') return 1;
    return now - e.at > STALE_MS ? 2 : 3;
  };
  const todo = rows
    .filter((r) => rank(r) < 3)
    .sort((a, b) => rank(a) - rank(b) || (seen.get(a.id)?.at ?? 0) - (seen.get(b.id)?.at ?? 0));
  const cap = opts.full ? todo.length : Math.min(todo.length, RUN_FILES);
  const deadline = now + (opts.full ? FULL_MS : RUN_MS);
  for (let i = 0; i < cap && Date.now() < deadline; i += 64) {
    await mapLimit(todo.slice(i, Math.min(i + 64, cap)), CONCURRENCY, async (r) => {
      const abs = containedPath(r.root, r.file);
      const state: FileState = abs ? await inspectFile(abs) : 'unchecked';
      seen.set(r.id, { at: Date.now(), state, mtime: Number(r.mtime ?? 0) });
    });
  }

  const states = new Map<string, FileState>();
  for (const r of rows) {
    const e = seen.get(r.id);
    if (e) states.set(r.id, e.state);
  }
  return { roots, rows, states };
}

export interface BadFile { id: string; seriesId: string; title: string; state: 'missing' | 'empty' | 'broken' }

/**
 * The chapters Fix everything may fetch again: a file in the download folder that is empty, cut short or gone, found by a
 * full look and never in a root the check treats as not mounted.
 */
export async function badChapterFiles(): Promise<BadFile[]> {
  const { roots, rows, states } = await scan({ full: true });
  const skip = goneRoots(rows, states, roots);
  const out: BadFile[] = [];
  for (const r of rows) {
    const st = states.get(r.id);
    if (r.root !== DL_ROOT || skip.has(r.root) || (st !== 'missing' && st !== 'empty' && st !== 'broken')) continue;
    out.push({ id: r.id, seriesId: r.series_id, title: r.title, state: st });
  }
  return out;
}

/**
 * Take the bad files of one series off the disk and mark their chapters 'missing', which is what makes the next sweep fetch
 * them again at the same row (verifyFiles.ts, chapterCleanup.ts heldBooks). Every file is looked at once more first: a
 * chapter that is whole by now stays, and so does one whose folder is not there (a share that went away, not a chapter
 * somebody removed). Download folder only, never the root itself. Returns how many were marked.
 */
export async function dropBadFiles(seriesId: string, bookIds: readonly string[], o: { userId: string | null; runId?: string }): Promise<number> {
  const ids = [...new Set(bookIds)];
  const rows = await q<{ id: string; root: string | null; file: string }>(
    'SELECT id, root, file FROM lib_books WHERE series_id = $1 AND id = ANY($2) AND pruned_at IS NULL', [seriesId, ids]);
  if (!rows.length || !(await allWritable([DL_ROOT])).ok) return 0;
  const root = path.resolve(DL_ROOT);
  const marked: string[] = [];
  let bytes = 0;
  for (const r of rows) {
    if (r.root !== DL_ROOT) continue;
    const abs = containedPath(DL_ROOT, r.file);
    if (!abs || abs === root) continue;
    const state = await inspectFile(abs);
    if (state !== 'missing' && state !== 'empty' && state !== 'broken') continue;
    if (state === 'missing') {
      if (!(await stat(path.dirname(abs)).catch(() => null))) continue;
    } else {
      const st = await stat(abs).catch(() => null);
      try { await rm(abs, { force: true }); } catch { continue; }
      bytes += st?.size ?? 0;
      await rm(`${abs}${REFETCH_BAK}`, { force: true }).catch(() => {});
    }
    marked.push(r.id);
  }
  if (marked.length) {
    await tombstoneBooks(marked, 'missing');
    for (const id of marked) seen.delete(id);
    await logAudit('series.chapters_refetch', { userId: o.userId, detail: { id: seriesId, bookIds: marked, bytes, via: 'autofix', ...(o.runId ? { runId: o.runId } : {}) } });
  }
  return marked.length;
}

export async function chapterFiles(ctx: IgnoreCtx = noIgnores()): Promise<HealthCheck> {
  const base = { id: 'files', title: 'Chapter files' };
  const { roots, rows, states } = await scan({});
  const skip = goneRoots(rows, states, roots);
  const bad = badOf(rows, states, skip);
  const all: Array<HealthItem & { members?: string[] }> = [...bad.entries()]
    .sort((a, b) => b[1].ids.length - a[1].ids.length || a[1].title.localeCompare(b[1].title))
    .map(([seriesId, e]) => ({
      seriesId,
      title: e.title,
      ...detailOf([say('files.detail', e.counts)]),
      key: `series:${seriesId}`,
      members: [...e.ids].sort(),
    }));
  const ignored = applyIgnores('files', all, ctx);
  const findings = all.filter((i) => !i.info);
  const chapters = findings.reduce((n, i) => n + (bad.get(i.seriesId!)?.ids.length ?? 0), 0);
  const anyMissing = findings.some((i) => (bad.get(i.seriesId!)?.counts.missing ?? 0) > 0);
  const looked = rows.filter((r) => seen.has(r.id)).length;
  const { items, hidden } = truncate(all);
  return {
    ...base,
    status: !findings.length ? 'ok' : anyMissing ? 'problem' : 'warn',
    ...summaryOf([
      findings.length
        ? say('files.bad', { n: chapters, m: findings.length })
        : say('files.ok', { looked, total: rows.length }),
      ignoredPart(ignored),
    ]),
    ...noteOf([
      say('files.note', { looked, total: rows.length }),
      skip.size ? say('files.skipped', { roots: [...skip].map((r) => path.resolve(r)) }) : null,
      hiddenPart(hidden),
    ]),
    items,
  };
}
