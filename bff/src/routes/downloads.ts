import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../lib/db';
import { komga } from '../lib/komga';
import { authenticate, userIdOf } from '../lib/auth';

export default async function downloadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Everything the service worker needs to fetch + store a chapter for offline reading.
  app.get('/api/books/:id/download-manifest', async (req, reply) => {
    const { id } = req.params as { id: string };
    let book: any;
    try {
      book = await komga.book(id);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const [pages, series] = await Promise.all([
      komga.bookPages(id),
      komga.series(book.seriesId).catch(() => null),
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
