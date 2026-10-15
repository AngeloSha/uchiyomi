import type { FastifyInstance } from 'fastify';
import { junkPagesFor } from '../lib/junkPages';
import { z } from 'zod';
import { one, q } from '../lib/db';
import { content } from '../lib/backend';
import { viewCtxFor, type ViewCtx, hideAdult } from '../lib/visibility';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { createReadStream } from 'node:fs';
import { dropExport, jobById, jobsOf, startExport, viewOf, type Target } from '../lib/zipExport';
import { timingSafeEqual } from 'node:crypto';

/** Admin → Settings → Download as zip (server_settings.zip_exports). Off by default; a column the schema does not have yet reads as off. */
const zipExportsOn = async (): Promise<boolean> =>
  !!(await one<{ on: boolean | null }>('SELECT zip_exports AS "on" FROM server_settings WHERE id = 1').catch(() => null))?.on;

/** The finished zip is fetched by a plain browser navigation, which cannot send a Bearer header: its job token authorises it instead. */
const EXPORT_FILE = '/api/exports/:id/file';

export default async function downloadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.routeOptions?.url === EXPORT_FILE) return;
    return authenticate(req, reply);
  });
  // Same shape as catalog.ts: resolve the viewer once, and let the handlers read it. Without this the
  // manifest reached the raw Komga client, which is not the backend anyone runs -- see below.
  app.addHook('preHandler', async (req) => {
    if (req.routeOptions?.url === EXPORT_FILE) return;
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req), { hideAdult: hideAdult(req) });
  });

  const vc = (req: any): ViewCtx => req.viewCtx as ViewCtx;

  // Everything the service worker needs to fetch + store a chapter for offline reading.
  //
  // This called the raw Komga HTTP client (`lib/komga`) rather than the configured backend, and had done
  // since the first commit. In owned mode -- the default, and what every self-hosted install runs -- there
  // is no Komga to call, so every request threw, hit the catch, and returned 404. Offline downloads have
  // been unavailable for the entire life of the project; `web/lib/downloads.ts` asks for this manifest
  // first and gives up when it 404s.
  //
  // Going through `content` also means the manifest is subject to the same visibility rule as everything
  // else, which the old call had no notion of: it resolved a book id with no viewer at all.
  app.get('/api/books/:id/download-manifest', async (req, reply) => {
    const { id } = req.params as { id: string };
    let book: any;
    try {
      book = await content.book(vc(req), id);
    } catch {
      book = null;
    }
    if (!book) return reply.code(404).send({ error: 'not_found' });
    // Gone, not missing: the row is a tombstone (lib/chapterCleanup.ts) and there are no pages to fetch.
    // 410 rather than an empty manifest, so the client can say why instead of saving a zero-page chapter.
    if (book.pruned) return reply.code(410).send({ error: 'pruned', message: 'This chapter\'s file was deleted from the server; there are no pages to download.' });
    const [pages, series] = await Promise.all([
      content.bookPages(vc(req), id),
      book.seriesId ? content.series(vc(req), book.seriesId).catch(() => null) : Promise.resolve(null),
    ]);
    const readingDirection = series?.metadata?.readingDirection ?? 'WEBTOON';

    // ⚠️ The junk flags ride along with the download. Without this a downloaded chapter reads differently
    // from the same chapter online -- the reader consults its offline copy BEFORE any server call, so the
    // flag simply would not be there. That is exactly how this was found: the browser suite downloads
    // chapters early on, and every later reader check was quietly taking the offline path.
    const junk = await junkPagesFor(id).catch(() => new Set<number>());

    let totalBytes = 0;
    const mapped = (pages ?? []).map((p: any) => {
      totalBytes += p.sizeBytes ?? 0;
      return {
        number: p.number,
        url: `/img/books/${encodeURIComponent(id)}/page/${p.number}`,
        width: p.width ?? null,
        height: p.height ?? null,
        bytes: p.sizeBytes ?? null,
        mediaType: p.mediaType ?? null,
        junk: junk.has(p.number) || undefined,
        // A placeholder page of a partial chapter (lib/partial.ts), marked by bookPages. Copied for the same
        // reason as `junk`: the offline reader never asks the server, so the caption has to travel with the
        // download. The placeholder's bytes download like any page.
        missing: p.missing || undefined,
      };
    });

    return {
      bookId: id,
      seriesId: book.seriesId,
      seriesTitle: book.seriesTitle ?? series?.metadata?.title ?? '',
      title: book.metadata?.title ?? book.name,
      number: book.metadata?.number ?? book.number,
      pageCount: mapped.length,
      readingDirection,
      mediaType: book.media?.mediaType ?? null,
      coverUrl: `/img/books/${encodeURIComponent(id)}/thumb`,
      totalBytes,
      pages: mapped,
    };
  });

  app.get('/api/downloads', async (req) => {
    const uid = userIdOf(req);
    const deviceId = (req.query as Record<string, string>).deviceId;
    const rows = deviceId
      ? await q('SELECT book_id, series_id, device_id, status, page_count, bytes, created_at, completed_at FROM offline_downloads WHERE user_id = $1 AND device_id = $2 ORDER BY created_at DESC', [uid, deviceId])
      : await q('SELECT book_id, series_id, device_id, status, page_count, bytes, created_at, completed_at FROM offline_downloads WHERE user_id = $1 ORDER BY created_at DESC', [uid]);
    return { content: rows };
  });

  app.post('/api/downloads', async (req) => {
    const uid = userIdOf(req);
    const b = z
      .object({
        bookId: z.string().min(1),
        seriesId: z.string().min(1),
        deviceId: z.string().min(1).max(128),
        status: z.enum(['pending', 'downloading', 'complete', 'error']).default('pending'),
        pageCount: z.number().int().optional(),
        bytes: z.number().int().optional(),
      })
      .parse(req.body);
    await q(
      `INSERT INTO offline_downloads (user_id, book_id, series_id, device_id, status, page_count, bytes, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $5 = 'complete' THEN now() ELSE NULL END)
       ON CONFLICT (user_id, book_id, device_id)
       DO UPDATE SET status = EXCLUDED.status,
                     page_count = COALESCE(EXCLUDED.page_count, offline_downloads.page_count),
                     bytes = COALESCE(EXCLUDED.bytes, offline_downloads.bytes),
                     completed_at = CASE WHEN EXCLUDED.status = 'complete' THEN now() ELSE offline_downloads.completed_at END`,
      [uid, b.bookId, b.seriesId, b.deviceId, b.status, b.pageCount ?? null, b.bytes ?? null],
    );
    return { ok: true };
  });

  app.delete('/api/downloads/:bookId', async (req) => {
    const uid = userIdOf(req);
    const { bookId } = req.params as { bookId: string };
    const deviceId = (req.query as Record<string, string>).deviceId;
    if (deviceId) {
      await q('DELETE FROM offline_downloads WHERE user_id = $1 AND book_id = $2 AND device_id = $3', [uid, bookId, deviceId]);
    } else {
      await q('DELETE FROM offline_downloads WHERE user_id = $1 AND book_id = $2', [uid, bookId]);
    }
    return { ok: true };
  });

  // Download a series, or chosen chapters of it, as one zip: a job the client watches (like Google Drive's "Preparing
  // your download"), then a file the browser fetches. Jobs are the caller's own; nobody else sees or fetches them.
  // `enabled` is how the web app knows whether to offer Download as zip at all.
  app.get('/api/exports', async (req) => ({ content: jobsOf(userIdOf(req)).map(viewOf), enabled: await zipExportsOn() }));

  app.post('/api/exports', async (req, reply) => {
    if (!(await zipExportsOn())) return reply.code(403).send({ error: 'exports_off', message: 'Downloading as a zip is turned off on this server.' });
    const b = z.object({
      seriesId: z.string().min(1).max(200).optional(),
      seriesIds: z.array(z.string().min(1).max(200)).max(500).optional(),
      bookIds: z.array(z.string().min(1).max(200)).max(5000).optional(),
      collectionId: z.string().min(1).max(100).optional(),
    }).safeParse(req.body ?? {});
    if (!b.success || (!b.data.seriesId && !b.data.seriesIds?.length && !b.data.collectionId)) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    let ids = [...(b.data.seriesIds ?? []), ...(b.data.seriesId ? [b.data.seriesId] : [])];
    let label = 'Uchiyomi export';
    if (b.data.collectionId === 'favorites') {
      label = 'Favorites';
      ids = (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1 ORDER BY created_at', [uid])).map((r) => r.series_id);
    } else if (b.data.collectionId) {
      const c = await q<{ name: string }>('SELECT name FROM collections WHERE id::text = $1 AND user_id = $2', [b.data.collectionId, uid]);
      if (!c.length) return reply.code(404).send({ error: 'not_found' });
      label = c[0].name;
      ids = (await q<{ series_id: string }>('SELECT series_id FROM collection_items WHERE collection_id::text = $1 ORDER BY position', [b.data.collectionId])).map((r) => r.series_id);
    }
    const targets: Target[] = [];
    for (const id of [...new Set(ids)]) {
      const series = await content.series(vc(req), id).catch(() => null);
      if (series) targets.push({ seriesId: id, title: series.metadata?.title ?? series.name ?? 'series', bookIds: ids.length === 1 ? b.data.bookIds ?? [] : [] });
    }
    if (!targets.length) return reply.code(404).send({ error: 'not_found' });
    const job = await startExport(uid, targets, label);
    if (!job) return reply.code(404).send({ error: 'nothing_to_export', message: 'None of those chapters have files on the server.' });
    return { ...viewOf(job), token: job.token };
  });

  app.delete('/api/exports/:id', async (req, reply) => {
    const job = jobById((req.params as { id: string }).id);
    if (!job || job.userId !== userIdOf(req)) return reply.code(404).send({ error: 'not_found' });
    await dropExport(job);
    return { ok: true };
  });

  app.get(EXPORT_FILE, async (req, reply) => {
    const job = jobById((req.params as { id: string }).id);
    const t = Buffer.from(String((req.query as { t?: string }).t ?? ''));
    const want = Buffer.from(job?.token ?? '');
    if (!job || t.length !== want.length || !timingSafeEqual(t, want)) return reply.code(404).send({ error: 'not_found' });
    if (job.status !== 'ready') return reply.code(409).send({ error: 'not_ready' });
    return reply
      .header('Content-Type', /\.cbz$/i.test(job.name) ? 'application/vnd.comicbook+zip' : /\.zip$/i.test(job.name) ? 'application/zip' : 'application/octet-stream')
      .header('Content-Length', job.fileBytes)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(job.name)}`)
      .header('Cache-Control', 'private, no-store')
      .send(createReadStream(job.file));
  });
}
