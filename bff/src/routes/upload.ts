/**
 * Manual uploads: a chapter or volume file an admin already has, put into the library by hand -- for a series no source
 * carries (or one that is gone), where nothing could ever download it.
 *
 *   POST /api/admin/series/:id/upload?name=<file name>       into that series' folder
 *   POST /api/admin/library/upload?title=<series>&name=<file> into a new series' folder (Uploads/<title>)
 *
 * The body is the file itself (application/octet-stream), streamed to disk: a volume is hundreds of megabytes, and the
 * base64-in-JSON the art upload uses would hold all of it, and a third more, in memory. The parser that hands the
 * stream over is registered here, inside this plugin, so no other route takes a raw body.
 *
 * ⚠️ EVERY FILE LANDS UNDER DL_ROOT, never LIBRARY_ROOT. The download folder is the one Uchiyomi owns and may write to
 *   (README: "what it downloads goes to its own folder"); a library folder is the admin's, and may be read-only. The
 *   scanner keys a series on its folder relative to the root (lib/library.ts persistScan), so a file written to
 *   <DL_ROOT>/<folder> joins the series whose chapters sit in <LIBRARY_ROOT>/<folder> all the same.
 *
 * ⚠️ NOTHING IS OVERWRITTEN. A name already in the folder is refused (`exists`): a chapter on disk may be the only copy.
 *
 * The file is written beside its final name under the half-write suffix (lib/fsAtomic.ts TMP_RE, which the startup
 * sweep reaps and the scanner never reads as a chapter), checked to be the archive its extension says, then renamed into
 * place, and a scan indexes it. The chapter's number is read from its file name, as for every file the scan meets.
 *
 * Registered from inside routes/admin.ts, after its `authenticate` + `requireAdmin` hooks, so every route here is
 * admin-only structurally.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createWriteStream, promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, posix } from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import { one } from '../lib/db';
import { userIdOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { DL_ROOT, persistScan } from '../lib/library';
import { MIN_FREE_GB, freeBytes, sanitize } from '../lib/downloader';
import { realContainedPath } from '../lib/fsGuard';
import { renameRetry } from '../lib/fsAtomic';
import { renumberRunning } from '../lib/numbering';
import { scheduleHealthSummaryRefresh } from '../lib/healthSummary';

/** The largest file an upload takes, in MB (UPLOAD_MAX_MB). A whole volume as one CBZ fits well inside the default. */
export const UPLOAD_MAX_BYTES = (Number(process.env.UPLOAD_MAX_MB) || 2048) * 1024 * 1024;

/** The parent folder of every series an upload starts, under DL_ROOT, as a download's folder is `<source>/<title>`. */
export const UPLOAD_FOLDER = 'Uploads';

/** What the scanner reads as a chapter (lib/naming.ts ARCHIVE_EXT), and the first bytes each kind of file starts with. */
const KINDS: Record<string, Buffer[]> = {
  cbz: [Buffer.from('PK\x03\x04', 'latin1')],
  zip: [Buffer.from('PK\x03\x04', 'latin1')],
  epub: [Buffer.from('PK\x03\x04', 'latin1')],
  cbr: [Buffer.from('Rar!\x1a\x07', 'latin1')],
  rar: [Buffer.from('Rar!\x1a\x07', 'latin1')],
  pdf: [Buffer.from('%PDF-', 'latin1')],
};

const extOf = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();

/** The file's name as it will be stored, or null for one the scanner would never read as a chapter. */
export function uploadName(raw: string): string | null {
  const name = sanitize(raw);
  return KINDS[extOf(name)] ? name : null;
}

/** Whether the file starts the way its extension says it does: a page renamed .cbz is refused, not indexed as a chapter. */
async function looksLike(abs: string, ext: string): Promise<boolean> {
  const fh = await fs.open(abs, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await fh.read(head, 0, 8, 0);
    return KINDS[ext].some((m) => bytesRead >= m.length && head.subarray(0, m.length).equals(m));
  } finally { await fh.close(); }
}

type Refusal = { code: number; error: string; message: string };
const refuse = (reply: FastifyReply, r: Refusal) => reply.code(r.code).send({ error: r.error, message: r.message });

/** Stream the request body to <DL_ROOT>/<folder>/<name>; a refusal, or the stored path relative to DL_ROOT. */
async function receive(req: FastifyRequest, folder: string, name: string): Promise<Refusal | { rel: string; bytes: number }> {
  const declared = Number(req.headers['content-length']);
  if (declared > UPLOAD_MAX_BYTES) return { code: 413, error: 'too_large', message: `Files up to ${Math.round(UPLOAD_MAX_BYTES / 2 ** 20)} MB can be uploaded.` };
  if (MIN_FREE_GB > 0) {
    const free = await freeBytes();
    if (free !== null && free - (declared || 0) < MIN_FREE_GB * 2 ** 30) {
      return { code: 507, error: 'disk_full', message: `The download folder is at its ${MIN_FREE_GB} GiB free-space floor.` };
    }
  }
  const rel = posix.join(folder, name);
  await fs.mkdir(DL_ROOT, { recursive: true });
  const abs = await realContainedPath(DL_ROOT, rel);
  if (!abs) return { code: 400, error: 'bad_path', message: 'That name cannot be stored.' };
  if (await fs.stat(abs).then(() => true, () => false)) return { code: 409, error: 'exists', message: 'A file with that name is already in this series.' };
  await fs.mkdir(dirname(abs), { recursive: true });
  // Asked again once the folder exists: mkdir followed whatever was on the way there.
  if (await realContainedPath(DL_ROOT, rel) !== abs) return { code: 400, error: 'bad_path', message: 'That name cannot be stored.' };

  const tmp = `${abs}.tmp.${randomBytes(6).toString('hex')}`;
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > UPLOAD_MAX_BYTES ? Object.assign(new Error('too_large'), { tooLarge: true }) : null, chunk);
    },
  });
  try {
    await pipeline(req.body as Readable, cap, createWriteStream(tmp, { flags: 'wx' }));
    if (!bytes) throw Object.assign(new Error('empty'), { empty: true });
    if (!(await looksLike(tmp, extOf(name)))) throw Object.assign(new Error('bad_file'), { badFile: true });
    if (await fs.stat(abs).then(() => true, () => false)) throw Object.assign(new Error('exists'), { exists: true });
    await renameRetry(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    const x = e as { tooLarge?: boolean; empty?: boolean; badFile?: boolean; exists?: boolean };
    if (x.tooLarge) return { code: 413, error: 'too_large', message: `Files up to ${Math.round(UPLOAD_MAX_BYTES / 2 ** 20)} MB can be uploaded.` };
    if (x.empty) return { code: 400, error: 'empty', message: 'That file is empty.' };
    if (x.badFile) return { code: 400, error: 'bad_file', message: `That file is not a .${extOf(name)} file.` };
    if (x.exists) return { code: 409, error: 'exists', message: 'A file with that name is already in this series.' };
    throw e;
  }
  return { rel, bytes };
}

/** The chapter the scan made of the file, for the answer. */
const bookAt = (rel: string) =>
  one<{ id: string; series_id: string; number: number }>(`SELECT id, series_id, number FROM lib_books WHERE root = $1 AND file = $2`, [DL_ROOT, rel]);

const NAME = z.string().min(1).max(255);

export default async function uploadRoutes(app: FastifyInstance) {
  // The body is handed to the route as the request stream, unread: receive() streams it to disk under its own cap.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.post('/api/admin/series/:id/upload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = z.object({ name: NAME }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const name = uploadName(p.data.name);
    if (!name) return refuse(reply, { code: 400, error: 'bad_type', message: 'Upload a .cbz, .cbr, .zip, .rar, .pdf or .epub file.' });
    const s = await one<{ id: string; folder: string; deleted_at: string | null; merged_into: string | null }>(
      'SELECT id, folder, deleted_at, merged_into FROM lib_series WHERE id = $1', [id]);
    if (!s || s.deleted_at) return reply.code(404).send({ error: 'not_found' });
    if (s.merged_into) return refuse(reply, { code: 409, error: 'merged', message: 'This series was merged into another; upload there.' });
    // A renumber renames the folder's files under a journal (lib/numbering.ts): a file arriving mid-way is not in it.
    if (renumberRunning(s.id)) return refuse(reply, { code: 409, error: 'renumber_pending', message: 'This series is being renumbered. Try again in a moment.' });

    const r = await receive(req, s.folder, name);
    if ('error' in r) return refuse(reply, r);
    await persistScan().catch((e) => req.log.warn(`[upload] ${s.folder}: the scan after the upload threw: ${(e as Error)?.message || e}`));
    scheduleHealthSummaryRefresh();
    const book = await bookAt(r.rel);
    await logAudit('series.upload', { userId: userIdOf(req), detail: { id: s.id, file: r.rel, bytes: r.bytes }, req });
    return { ok: true, file: r.rel, bookId: book?.id ?? null, number: book?.number ?? null };
  });

  app.post('/api/admin/library/upload', async (req, reply) => {
    const p = z.object({ title: z.string().trim().min(1).max(300), name: NAME }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const name = uploadName(p.data.name);
    if (!name) return refuse(reply, { code: 400, error: 'bad_type', message: 'Upload a .cbz, .cbr, .zip, .rar, .pdf or .epub file.' });
    const folder = posix.join(UPLOAD_FOLDER, sanitize(p.data.title));
    // A folder an earlier upload started is the same series again, unless it was deleted: the scan never revives
    // a deleted series (lib/library.ts), so a file put there would never be seen.
    const known = await one<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM lib_series WHERE folder = $1 ORDER BY (deleted_at IS NOT NULL) LIMIT 1', [folder]);
    if (known?.deleted_at) return refuse(reply, { code: 409, error: 'deleted', message: 'A series of that name was deleted. Restore it, or pick another title.' });

    const r = await receive(req, folder, name);
    if ('error' in r) return refuse(reply, r);
    await persistScan().catch((e) => req.log.warn(`[upload] ${folder}: the scan after the upload threw: ${(e as Error)?.message || e}`));
    scheduleHealthSummaryRefresh();
    const book = await bookAt(r.rel);
    await logAudit('series.upload', { userId: userIdOf(req), detail: { id: book?.series_id ?? null, file: r.rel, bytes: r.bytes, created: !known }, req });
    return { ok: true, file: r.rel, seriesId: book?.series_id ?? null, bookId: book?.id ?? null, number: book?.number ?? null };
  });
}
