/**
 * Manual chapter uploads, authorized for admins or explicitly enabled members.
 * New series: title + fresh=1; subsequent/missing chapters: explicit visible seriesId.
 * Files stay under DL_ROOT, are streamed to an ignored temporary filename, checked for
 * a bounded readable archive and first image, then atomically linked without replacement.
 * Writer claims serialize changes to the same series; at most two uploads run together.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createWriteStream, promises as fs } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { dirname, posix } from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import { one } from '../lib/db';
import { newSeriesId } from '../lib/ids';
import { visible, Params, viewCtxFor } from '../lib/visibility';
import { actsAsAdmin, authenticate, userIdOf, roleOf } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { DL_ROOT, persistScan, cbzPages, cbzEntry, libraryRows, libraryIdFor } from '../lib/library';
import sharp from 'sharp';
import { MIN_FREE_GB, freeBytes, sanitize } from '../lib/downloader';
import { realContainedPath } from '../lib/fsGuard';
import { claimWriterFolders } from '../lib/bulkNewest';
import { folderBusy } from '../lib/numbering';
import { runsInside } from '../lib/updater';
import { scheduleHealthSummaryRefresh } from '../lib/healthSummary';
import multipart from '@fastify/multipart';
import { writeImageChapter, ImageChapterError } from '../lib/imageChapter';
import { resolveAddScope, scopeForSeries, scopeSql, ContentScopeError, defaultPrivateFor, folderForScope } from '../lib/contentScope';

/** The largest file an upload takes, in MB (UPLOAD_MAX_MB). A whole volume as one CBZ fits well inside the default. */
const configuredMax = Number(process.env.UPLOAD_MAX_MB);
export const UPLOAD_MAX_BYTES = (Number.isFinite(configuredMax) && configuredMax > 0 ? Math.min(configuredMax, 16384) : 2048) * 1024 * 1024;
// These readers load a whole file; do not let a multi-gigabyte upload exhaust the application.
const EAGER_READER_CAP = 128 * 1024 * 1024;

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
    if (!KINDS[ext].some((m) => bytesRead >= m.length && head.subarray(0, m.length).equals(m))) return false;
    if (/^(zip|cbz|epub)$/.test(ext)) {
      // Bound the ZIP index before node-stream-zip allocates/parses its central directory.
      const { size } = await fh.stat();
      const tail = Buffer.alloc(Math.min(size, 65557));
      await fh.read(tail, 0, tail.length, size - tail.length);
      const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (at < 0 || at + 22 > tail.length || at + 22 + tail.readUInt16LE(at + 20) !== tail.length) return false;
      if (tail.readUInt16LE(at + 4) || tail.readUInt16LE(at + 6)) return false;
      const entries = tail.readUInt16LE(at + 10), directoryBytes = tail.readUInt32LE(at + 12);
      const offset = tail.readUInt32LE(at + 16);
      if (!entries || entries > 50000 || directoryBytes > 32 * 1024 * 1024 || offset + directoryBytes > size - tail.length + at) return false;
    }
    return true;
  } finally { await fh.close(); }
}

type Refusal = { code: number; error: string; message: string; page?: string };
const refuse = (reply: FastifyReply, r: Refusal) => reply.code(r.code).send({ error: r.error, message: r.message, ...(r.page ? {page:r.page} : {}) });

/** Stream the request body to <DL_ROOT>/<folder>/<name>; a refusal, or the stored path relative to DL_ROOT. */
async function receive(req: FastifyRequest, folder: string, name: string, images = false): Promise<Refusal | { rel: string; bytes: number }> {
  const declared = Number(req.headers['content-length']);
  const limit = /^(pdf|rar|cbr)$/.test(extOf(name)) ? Math.min(UPLOAD_MAX_BYTES, EAGER_READER_CAP) : UPLOAD_MAX_BYTES;
  if (declared > limit) return { code: 413, error: 'too_large', message: `Files up to ${Math.round(limit / 2 ** 20)} MB can be uploaded.` };
  await fs.mkdir(DL_ROOT, { recursive: true });
  if (MIN_FREE_GB > 0) {
    const free = await freeBytes();
    if (free !== null && free - (declared || 1024 * 1024) < MIN_FREE_GB * 2 ** 30) {
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
  let sinceSpaceCheck = 1024 * 1024;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length; sinceSpaceCheck += chunk.length;
      if (bytes > limit) { done(Object.assign(new Error('too_large'), { tooLarge: true })); return; }
      // Real bytes, including chunked uploads; backpressure waits for the disk-floor check.
      if (MIN_FREE_GB > 0 && sinceSpaceCheck >= 1024 * 1024) {
        sinceSpaceCheck = 0;
        freeBytes().then((free) => {
          if (free === null || free < MIN_FREE_GB * 2 ** 30 + 1024 * 1024) {
            done(Object.assign(new Error('disk_full'), { diskFull: true }));
          } else done(null, chunk);
        }, done);
      } else done(null, chunk);
    },
  });
  try {
    if (images) bytes = await writeImageChapter(req, tmp, limit, async () => {
      if (MIN_FREE_GB <= 0) return;
      const free = await freeBytes();
      if (free === null || free < MIN_FREE_GB * 2 ** 30 + 1024 * 1024) throw Object.assign(new Error('disk_full'), { diskFull: true });
    });
    else await pipeline(req.body as Readable, cap, createWriteStream(tmp, { flags: 'wx' }));
    if (!bytes) throw Object.assign(new Error('empty'), { empty: true });
    if (!(await looksLike(tmp, extOf(name)))) throw Object.assign(new Error('bad_file'), { badFile: true });
    const pages = await cbzPages(tmp, name).catch(() => []);
    if (!pages.length || pages.length > 50000) throw Object.assign(new Error('bad_file'), { badFile: true });
    try {
      const page = await cbzEntry(tmp, pages[0], name);
      await sharp(page, { limitInputPixels: 64 * 1024 * 1024 }).resize({ width: 1, height: 1, fit: 'inside' }).toBuffer();
    } catch { throw Object.assign(new Error('bad_file'), { badFile: true }); }
    if (await realContainedPath(DL_ROOT, rel) !== abs) throw Object.assign(new Error('bad_file'), { badFile: true });
    // link is atomic and fails with EEXIST. A stat followed by rename can overwrite another writer on POSIX.
    try { await fs.link(tmp, abs); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error('exists'), { exists: true });
      throw error;
    }
    await fs.unlink(tmp).catch(() => {});
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e instanceof ImageChapterError) return { code: e.statusCode, error: e.code, message: e.page ? `Could not read image: ${e.page}` : e.code, ...(e.page ? {page:e.page} : {}) };
    const x = e as { tooLarge?: boolean; empty?: boolean; badFile?: boolean; exists?: boolean; diskFull?: boolean };
    if ((e as NodeJS.ErrnoException).code === 'ENOSPC' || (e as NodeJS.ErrnoException).code === 'EDQUOT') x.diskFull = true;
    if (x.tooLarge) return { code: 413, error: 'too_large', message: `Files up to ${Math.round(limit / 2 ** 20)} MB can be uploaded.` };
    if (x.diskFull) return { code: 507, error: 'disk_full', message: 'The download folder is out of space.' };
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

/** Whether the account may start a series from its own files: an admin, or a member with `canUploadManually` (opt-in). */
async function mayUpload(req: FastifyRequest): Promise<boolean> {
  if (actsAsAdmin(req)) return true;
  const me = await one<{ perms: { canUploadManually?: boolean } | null }>('SELECT perms FROM users WHERE id = $1', [userIdOf(req)]);
  return me?.perms?.canUploadManually === true;
}

export async function uploadSeriesRoutes(app: FastifyInstance) {
  await app.register(multipart);
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req, reply) => {
    if (!(await mayUpload(req))) return reply.code(403).send({ error: 'forbidden', message: 'Uploading needs an admin to allow it.' });
  });
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  let active = 0;
  app.post('/api/library/upload', async (req, reply) => {
    const images = (req.query as { images?: string }).images === '1';
    if (images ? !req.isMultipart() : (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream'
      || (!images && typeof (req.body as Readable | undefined)?.pipe !== 'function')) {
      return reply.code(415).send({ error: 'unsupported_media_type', message: 'Send the file as application/octet-stream.' });
    }
    const p = z.object({ title: z.string().trim().min(1).max(300).optional(), name: NAME,
      fresh: z.literal('1').optional(), seriesId: z.string().min(1).max(200).optional(), images: z.literal('1').optional(),
      visibility: z.enum(['shared', 'private']).optional(), libraryId: z.string().min(1).max(100).optional(),
      adult: z.literal('1').optional() }).strict().safeParse(req.query);
    if (!p.success || !(p.data.seriesId ? !p.data.title && !p.data.fresh : p.data.title && p.data.fresh)) {
      return reply.code(400).send({ error: 'bad_request', message: 'Choose a new title or an existing series.' });
    }
    const name = uploadName(p.data.name);
    if (!name) return refuse(reply, { code: 400, error: 'bad_type', message: 'Upload a .cbz, .cbr, .zip, .rar, .pdf or .epub file.' });
    if (images && extOf(name) !== 'cbz') return reply.code(400).send({ error: 'bad_type' });
    if (active >= 2) return reply.code(429).send({ error: 'busy', message: 'Two uploads are already running. Try again when one finishes.' });
    const ctx = await viewCtxFor(userIdOf(req), roleOf(req));
    const params = new Params(); const shown = visible('s', ctx, params);
    const idParam = p.data.seriesId ? params.add(p.data.seriesId) : null;
    const known = idParam ? await one<{ id: string; folder: string }>(
      `SELECT s.id, s.folder FROM lib_series s WHERE s.id = ${idParam} AND ${shown}`, params.values as any[]) : null;
    if (p.data.seriesId && !known) return reply.code(404).send({ error: 'not_found' });
    const originalFolder = posix.join(UPLOAD_FOLDER, sanitize(p.data.title ?? ''));
    let scope;
    try {
      const privateTarget = p.data.visibility === 'private' || (p.data.visibility === undefined && await defaultPrivateFor(userIdOf(req)));
      scope = known ? await scopeForSeries(ctx, known.id, { write: true }) : await resolveAddScope(ctx, {
        visibility: p.data.visibility,
        libraryId: p.data.libraryId ?? (privateTarget ? undefined : libraryIdFor(originalFolder, await libraryRows())),
      }, 'upload');
    } catch (error) {
      if (error instanceof ContentScopeError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    if (!scope) return reply.code(404).send({ error: 'not_found' });
    let folder = known?.folder ?? await folderForScope(scope, originalFolder);
    if (!known) {
      const collision = new Params(), destination = collision.add(folder);
      if (await one(`SELECT 1 FROM lib_series s WHERE s.folder=${destination} AND NOT (${scopeSql('s',scope,collision)}) LIMIT 1`,collision.values)) {
        // Publishing a private copy may retain its physical folder. Its next private copy needs its OWN folder.
        // Public owner/library identifiers form a stable folder namespace, never a password or credential.
        const folderNamespace = scope.visibility === 'private' ? `private:${scope.ownerUserId}` : `shared:${scope.libraryId}`;
        folder += ` [${createHash('sha256').update(folderNamespace).digest('hex').slice(0,10)}]`;
        const again = new Params(), retry = again.add(folder);
        if (await one(`SELECT 1 FROM lib_series s WHERE s.folder=${retry} AND NOT (${scopeSql('s',scope,again)}) LIMIT 1`,again.values)) return reply.code(409).send({error:'privacy_destination_conflict'});
      }
    }
    // A new upload must land in a library this account can access. Existing series use the same viewer gate above.
    if (!known) {
      const libraryId = scope.libraryId;
      if (scope.visibility === 'shared' && ctx.libraryIds && !ctx.libraryIds.includes(libraryId)) return reply.code(403).send({ error: 'forbidden' });
      const lib = await one<{ age_rating: number | null }>('SELECT age_rating FROM libraries WHERE id = $1', [libraryId]);
      if (ctx.maxAgeRating !== null && lib?.age_rating != null && lib.age_rating > ctx.maxAgeRating) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const unique = new Params();
      const folderParam = unique.add(folder), titleParam = unique.add(p.data.title);
      if (await one(`SELECT 1 FROM lib_series s WHERE (${scopeSql('s', scope, unique)}) AND (folder = ${folderParam} OR lower(title) = lower(${titleParam})) LIMIT 1`, unique.values as any[])) {
        return refuse(reply, { code: 409, error: 'taken', message: 'A series by that title is already here. Pick another title.' });
      }
    }
    // All awaited authorization reads are over: reserve the global slot and folder in one synchronous turn.
    if (active >= 2) return reply.code(429).send({ error: 'busy', message: 'Two uploads are already running. Try again when one finishes.' });
    const claim = claimWriterFolders([folder], folderBusy, () => !!known && runsInside(known.id) > 0);
    if (!claim) return reply.code(409).send({ error: 'busy', message: 'Another task is changing this series.' });
    active++;
    let reserved: string | null = null;
    let reservedSeries: string | null = null;
    let stored = false;
    const discardUnpublished = async () => {
      if (reservedSeries && !stored) {
        await one(`DELETE FROM lib_series s WHERE id=$1 AND books_count=0
          AND NOT EXISTS(SELECT 1 FROM lib_books b WHERE b.series_id=s.id) RETURNING id`, [reservedSeries])
          .catch(error => req.log.warn({ err: error }, 'Failed upload reservation cleanup is pending.'));
        reservedSeries = null;
      }
      if (reserved && !stored) await fs.rmdir(reserved).catch(() => {});
    };
    try {
      if (!known) {
        await fs.mkdir(DL_ROOT, { recursive: true });
        const path = await realContainedPath(DL_ROOT, folder);
        if (!path) return reply.code(400).send({ error: 'bad_path' });
        await fs.mkdir(dirname(path), { recursive: true });
        if (await realContainedPath(DL_ROOT, folder) !== path) return reply.code(400).send({ error: 'bad_path' });
        try { await fs.mkdir(path); reserved = path; }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') return reply.code(409).send({ error: 'taken' });
          throw e;
        }
      }
      if (!known) {
        // Reserve the authenticated destination before the archive is published. A library's path mapping
        // may be absent or change while a large request streams; the scanner must keep this chosen scope.
        const pinned = libraryIdFor(folder, await libraryRows()) !== scope.libraryId;
        const allocated = await one<{ id: string }>(`INSERT INTO lib_series
          (id, source, title, folder, books_count, library_id, owner_user_id, is_private, library_pinned)
          VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8) RETURNING id`,
        [newSeriesId(), UPLOAD_FOLDER, p.data.title, folder, scope.libraryId, scope.ownerUserId, scope.visibility === 'private', pinned]);
        reservedSeries = allocated!.id;
      }
      const r = await receive(req, folder, name, images);
      if ('error' in r) { await discardUnpublished(); return refuse(reply, r); }
      stored = true;
      let scanFailed = false;
      await persistScan().catch((e) => { scanFailed = true; req.log.warn({ err: e }, 'Uploaded file was stored; indexing is pending.'); });
      scheduleHealthSummaryRefresh();
      const book = await bookAt(r.rel);
      await logAudit('series.upload', { userId: userIdOf(req), detail: { id: book?.series_id ?? null, file: r.rel, bytes: r.bytes, created: !known }, req });
      // A stored file is never reported as an indexed chapter if its scan failed.
      if (!book || scanFailed) reply.code(202);
      return { ok: true, indexed: !!book && !scanFailed, file: r.rel, seriesId: book?.series_id ?? known?.id ?? reservedSeries ?? null,
        bookId: book?.id ?? null, number: book?.number ?? null };
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC' || (error as NodeJS.ErrnoException).code === 'EDQUOT') { await discardUnpublished(); return reply.code(507).send({error:'disk_full'}); }
      throw error;
    } finally {
      await discardUnpublished();
      active--; claim.release();
    }
  });
}
