// "Download as a zip": a job that packs a series (or a selection of its chapters) into one archive on the server,
// reports its progress, and then hands the finished file to the browser. Kept in memory with the file in the temp
// directory: a restart forgets the jobs and sweeps the files, which is right for something that exists only to be
// downloaded once.
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { q } from './db';
import { containedPath } from './fsGuard';

export type ExportStatus = 'queued' | 'zipping' | 'ready' | 'failed' | 'cancelled';
interface Entry { abs: string; name: string; size: number; dir?: boolean }
export interface ExportJob {
  id: string; userId: string; token: string; seriesId: string;
  name: string; status: ExportStatus; chapters: number;
  totalBytes: number; doneBytes: number; fileBytes: number;
  error?: string; createdAt: number; finishedAt?: number;
  file: string; entries: Entry[]; cancel?: () => void;
  /** `file` is a library chapter served as it is: never deleted with the job. */
  direct?: boolean;
}

const DIR = join(process.env.EXPORT_DIR || tmpdir(), 'uchiyomi-exports');
const KEEP_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = 2;
const jobs = new Map<string, ExportJob>();
let running = 0;
const waiting: ExportJob[] = [];

export const viewOf = (j: ExportJob) => ({
  id: j.id, seriesId: j.seriesId, name: j.name, status: j.status, chapters: j.chapters,
  totalBytes: j.totalBytes, doneBytes: j.doneBytes, fileBytes: j.fileBytes, error: j.error ?? null,
  createdAt: j.createdAt, finishedAt: j.finishedAt ?? null,
});

export const jobsOf = (userId: string) => [...jobs.values()].filter((j) => j.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
export const jobById = (id: string) => jobs.get(id);

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/[^\P{C}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'series';

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export interface Target { seriesId: string; title: string; bookIds: string[] }

/** One chapter file, as it will sit in the zip: a .cbz named after the chapter. A chapter kept as a folder is packed into a .cbz first. */
async function entriesFor(t: Target, used: Set<string>): Promise<{ entries: Entry[]; chapters: number }> {
  const folder = safe(t.title);
  const rows = await q<{ root: string; file: string }>(
    `SELECT root, file FROM lib_books WHERE series_id = $1 AND pruned_at IS NULL ${t.bookIds.length ? 'AND id = ANY($2::text[])' : ''} ORDER BY number, file`,
    t.bookIds.length ? [t.seriesId, t.bookIds] : [t.seriesId]);
  const entries: Entry[] = [];
  for (const r of rows) {
    const abs = containedPath(r.root, r.file);
    if (!abs) continue;
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    const dir = st.isDirectory();
    const leaf = basename(abs);
    let name = `${folder}/${dir ? `${leaf}.cbz` : leaf}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${folder}/${dir ? `${leaf} (${n}).cbz` : `${leaf.replace(/(\.[^.]*)?$/, ` (${n})$1`)}`}`;
    used.add(name.toLowerCase());
    entries.push({ abs, name, size: dir ? await dirBytes(abs) : st.size, dir });
  }
  return { entries, chapters: entries.length };
}

function packFolder(dir: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    const zip = archiver('zip', { store: true });
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);
    zip.directory(dir, false);
    void zip.finalize();
  });
}

async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  for (const f of await filesUnder(dir)) n += (await stat(f).catch(() => null))?.size ?? 0;
  return n;
}

/** `label` names a multi-series zip (a list, a selection); one series is named after itself. */
export async function startExport(userId: string, targets: Target[], label: string): Promise<ExportJob | null> {
  const used = new Set<string>();
  const entries: Entry[] = [];
  for (const t of targets) entries.push(...(await entriesFor(t, used)).entries);
  if (!entries.length) return null;
  const id = randomUUID();
  const single = entries.length === 1;
  const only = single ? entries[0] : null;
  const multi = targets.length > 1;
  const name = only && !only.dir
    ? `${safe(targets[0].title)} - ${basename(only.abs)}`
    : only ? `${safe(targets[0].title)} - ${basename(only.abs)}.cbz`
    : `${safe(multi ? label : targets[0].title)}${!multi && targets[0].bookIds.length ? ` (${entries.length} chapters)` : ''}.zip`;
  const job: ExportJob = {
    id, userId, token: randomBytes(24).toString('base64url'), seriesId: targets[0].seriesId,
    name, status: 'queued', chapters: entries.length, totalBytes: entries.reduce((n, e) => n + e.size, 0), doneBytes: 0, fileBytes: 0,
    createdAt: Date.now(), file: join(DIR, `${id}.zip`), entries,
  };
  if (only && !only.dir) {
    // One chapter is delivered as the chapter file itself -- no wrapper to open.
    job.file = only.abs; job.direct = true; job.status = 'ready'; job.doneBytes = job.totalBytes;
    job.fileBytes = only.size; job.finishedAt = Date.now(); job.entries = [];
    jobs.set(id, job);
    return job;
  }
  jobs.set(id, job);
  waiting.push(job);
  pump();
  return job;
}

function pump(): void {
  while (running < MAX_CONCURRENT && waiting.length) {
    const job = waiting.shift()!;
    if (job.status !== 'queued') continue;
    running++;
    void run(job).finally(() => { running--; job.entries = []; pump(); });
  }
}

async function run(job: ExportJob): Promise<void> {
  job.status = 'zipping';
  await mkdir(DIR, { recursive: true });
  const temps: string[] = [];
  try {
    // A chapter kept as a folder of images is packed into a .cbz first, so the zip holds only .cbz files.
    for (const [i, e] of job.entries.entries()) {
      if (!e.dir) continue;
      const cbz = join(DIR, `${job.id}-${i}.cbz`);
      temps.push(cbz);
      await packFolder(e.abs, cbz);
      e.abs = cbz; e.dir = false;
      job.doneBytes = Math.min(job.totalBytes, job.doneBytes + e.size);
    }
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(job.file);
      // Chapters are already compressed images, so storing them is as small and far faster.
      const zip = archiver('zip', { store: true });
      job.cancel = () => { zip.abort(); out.destroy(); reject(new Error('cancelled')); };
      out.on('close', resolve);
      out.on('error', reject);
      zip.on('error', reject);
      const base = job.doneBytes;
      zip.on('progress', (p) => { job.doneBytes = Math.min(job.totalBytes, base + p.fs.processedBytes); });
      zip.pipe(out);
      for (const e of job.entries) zip.file(e.abs, { name: e.name });
      void zip.finalize();
    });
    job.doneBytes = job.totalBytes;
    job.fileBytes = (await stat(job.file)).size;
    job.status = 'ready';
  } catch (e) {
    await rm(job.file, { force: true });
    if ((job.status as ExportStatus) !== 'cancelled') { job.status = 'failed'; job.error = (e as Error).message; }
  }
  await Promise.all(temps.map((t) => rm(t, { force: true })));
  job.cancel = undefined;
  job.finishedAt = Date.now();
}

export async function dropExport(job: ExportJob): Promise<void> {
  if (job.status === 'queued' || job.status === 'zipping') { job.status = 'cancelled'; job.cancel?.(); }
  jobs.delete(job.id);
  if (!job.direct) await rm(job.file, { force: true });
}

/** A finished file is kept for an hour, so a download started late still works but the disk does not fill up. */
async function sweepExports(): Promise<void> {
  for (const j of [...jobs.values()]) {
    if (j.finishedAt && Date.now() - j.finishedAt > KEEP_MS) await dropExport(j);
  }
}

export async function initExports(): Promise<void> {
  await rm(DIR, { recursive: true, force: true });
  setInterval(() => void sweepExports(), 10 * 60 * 1000).unref();
}
