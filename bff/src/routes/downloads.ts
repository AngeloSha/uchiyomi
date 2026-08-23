import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/db';
import { content } from '../lib/backend';
import { viewCtxFor, type ViewCtx } from '../lib/visibility';
import { authenticate, userIdOf, roleOf } from '../lib/auth';

export default async function downloadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  // Same shape as catalog.ts: resolve the viewer once, and let the handlers read it. Without this the
  // manifest reached the raw Komga client, which is not the backend anyone runs -- see below.
  app.addHook('preHandler', async (req) => {
    (req as any).viewCtx = await viewCtxFor(userIdOf(req), roleOf(req));
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
    const [pages, series] = await Promise.all([
      content.bookPages(vc(req), id),
      book.seriesId ? content.series(vc(req), book.seriesId).catch(() => null) : Promise.resolve(null),
    ]);
    const readingDirection = series?.metadata?.readingDirection ?? 'WEBTOON';

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
}
