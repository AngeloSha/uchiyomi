// Komga-compatible REST API so the Mihon Komga extension can point directly at Uchiyomi.
//
// The extension is configured with:
//   Address : https://your-uchiyomi-install.example.com
//   API key : a personal API token from Profile → Account → Tokens (uy_...)
//
// Once configured, the extension behaves exactly as it does against a real Komga server:
// it can browse the library, open chapters, read pages, and — through Mihon's built-in Komga
// tracker — sync reading progress in both directions.
//
// Endpoints:
//   GET  /api/v1/libraries                              library list (credentials check)
//   GET  /api/v1/series                                 series listing, search, filter, sort, page
//   GET  /api/v1/series/:id                             series detail
//   GET  /api/v1/series/:id/books                       chapters for a series
//   GET  /api/v1/series/:id/thumbnail                   cover image
//   GET  /api/v1/books/:id                              book/chapter detail
//   GET  /api/v1/books/:id/pages                        page list (page count + file names)
//   GET  /api/v1/books/:id/pages/:page                  raw page image (1-based page number)
//   GET  /api/v1/books/:id/thumbnail                    chapter thumbnail
//   GET  /api/v1/genres                                 genre list (for filter screen)
//   GET  /api/v1/tags                                   tag list (same as genres for now)
//   GET  /api/v1/publishers                             publisher list (author names)
//   GET  /api/v1/authors                                author list
//   GET  /api/v1/collections                            Uchiyomi collection list
//   GET  /api/v1/collections/:id/series                 series in one collection
//   GET  /api/v1/readlists                              read lists (empty — Uchiyomi has none)
//   GET  /api/v2/series/:id/read-progress/tachiyomi     progress overview for Mihon tracker
//   PUT  /api/v2/series/:id/read-progress/tachiyomi     mark chapters read (Mihon tracker write)
//
// Only registered when LIBRARY_BACKEND=owned (the default). In the legacy komga-backend mode
// Komga IS the library, and exposing a second Komga-shaped layer over it would just be confusing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { join } from 'path';
import sharp from 'sharp';
import { q, one } from '../lib/db';
import { resolveKomgaUser } from '../lib/komgaCompatAuth';
import { visible, browsable, Params, type ViewCtx } from '../lib/visibility';
import { cbzPageAt, cbzPageDims, LIBRARY_ROOT } from '../lib/library';
import { visibleBookFile } from '../lib/visibility';
import { writeProgress } from '../lib/progress';
import { pushSeriesProgressAsync } from '../lib/trackers';

// ---- helpers ---------------------------------------------------------------

function mime(fileName: string): string {
  const ext = (fileName.toLowerCase().split('.').pop() ?? '');
  return ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : ext === 'avif' ? 'image/avif'
    : 'image/jpeg';
}

function komgaStatus(s: string | null | undefined): string {
  if (!s) return 'UNKNOWN';
  const u = s.toUpperCase();
  // Komga's vocabulary (ONGOING/ENDED/ABANDONED/HIATUS) is a superset of Uchiyomi's display names,
  // which follow Mihon's own labels. Map the common synonyms.
  if (u === 'COMPLETED' || u === 'PUBLISHING FINISHED') return 'ENDED';
  if (u === 'CANCELLED') return 'ABANDONED';
  if (u === 'ON HIATUS') return 'HIATUS';
  if (['ONGOING', 'ENDED', 'ABANDONED', 'HIATUS', 'UNKNOWN'].includes(u)) return u;
  return 'UNKNOWN';
}

/** Spring-style page envelope that Komga returns for every list. */
function springPage<T>(content: T[], total: number, pageNum: number, size: number) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  return { content, totalElements: total, totalPages, number: pageNum, size, first: pageNum === 0, last: pageNum >= totalPages - 1 };
}

function toSeriesDto(r: any) {
  const mtime = Number(r.latest_mtime);
  const mtimeIso = mtime > 0 ? new Date(mtime).toISOString() : (r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString());
  return {
    id: r.id,
    libraryId: r.library_id ?? 'lib',
    name: r.title,
    url: r.id,           // Komga compat: not a real URL, Mihon doesn't use this field
    created:      r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString(),
    lastModified: mtimeIso,
    fileLastModified: mtimeIso,
    booksCount: r.books_count ?? 0,
    metadata: {
      status: komgaStatus(r.status),
      title: r.title,
      titleSort: r.title,
      summary: r.summary ?? '',
      readingDirection: 'VERTICAL',
      publisher: '',
      ageRating: r.age_rating ?? null,
      language: 'en',
      genres: r.genres ?? [],
      tags: [],
      totalBookCount: null,
    },
    booksMetadata: {
      authors: r.author ? [{ name: r.author, role: 'writer' }] : [],
      tags: [],
      releaseDate: null,
      summary: r.summary ?? '',
      summaryNumber: '',
      created: r.created_at ? new Date(r.created_at).toISOString() : new Date(0).toISOString(),
      lastModified: mtimeIso,
    },
    deleted: false,
  };
}

function toBookDto(r: any, readProgress?: { page: number | null; completed: boolean; updated_at: string | null } | null) {
  const num = Number(r.number ?? 0);
  const mtime = Number(r.mtime ?? 0);
  const created  = r.published_at ? new Date(r.published_at).toISOString() : (mtime > 0 ? new Date(mtime).toISOString() : new Date(0).toISOString());
  const modified = r.updated_at   ? new Date(r.updated_at).toISOString()   : created;
  return {
    id: r.id,
    seriesId: r.series_id,
    seriesTitle: r.series_title ?? '',
    libraryId: r.library_id ?? 'lib',
    name: r.title ?? `Chapter ${num}`,
    number: Math.round(num),
    url: r.file ?? '',
    created,
    lastModified: modified,
    fileLastModified: mtime > 0 ? new Date(mtime).toISOString() : new Date(0).toISOString(),
    sizeBytes: r.size ?? 0,
    size: r.size ? `${(Number(r.size) / 1048576).toFixed(1)} MB` : '0 B',
    media: {
      status: r.pruned_at ? 'ERROR' : 'READY',
      mediaType: 'application/vnd.comicbook+zip',
      pagesCount: r.pages ?? 0,
      comment: '',
      epubDivinaCompatible: false,
      epubIsKepub: false,
    },
    metadata: {
      title: r.title ?? '',
      summary: '',
      number: String(num),
      numberSort: num,
      releaseDate: r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : null,
      authors: [],
      tags: [],
    },
    readProgress: readProgress != null ? {
      page: Math.max(1, (readProgress.page ?? 0) + 1),  // 0-based → 1-based
      completed: !!readProgress.completed,
      readDate:     readProgress.updated_at ? new Date(readProgress.updated_at).toISOString() : new Date(0).toISOString(),
      created:      readProgress.updated_at ? new Date(readProgress.updated_at).toISOString() : new Date(0).toISOString(),
      lastModified: readProgress.updated_at ? new Date(readProgress.updated_at).toISOString() : new Date(0).toISOString(),
      deviceId:   'uchiyomi',
      deviceName: 'Uchiyomi',
    } : null,
    deleted:  !!r.pruned_at,
    fileHash: '',
    oneshot:  false,
  };
}

// ---- series WHERE clause builder ------------------------------------------
//
// Called TWICE per listing request (once for COUNT, once for data) with a fresh Params each time, so
// the two queries are fully independent and expectedParams() validates each one independently.

interface SeriesFilter {
  search?: string | null;
  genre?: string | null;
  status?: string | null;
  libraryId?: string | null;
}

function seriesWhere(ctx: ViewCtx, f: SeriesFilter): { sql: string; values: unknown[] } {
  const p = new Params();
  const parts: string[] = [browsable('s', ctx, p)];
  if (f.search) {
    const term = `%${f.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    parts.push(`COALESCE(o.title, s.title) ILIKE ${p.add(term)} ESCAPE '\\'`);
  }
  if (f.genre)     parts.push(`${p.add(f.genre)} = ANY(COALESCE(o.genres, s.genres))`);
  if (f.status)    parts.push(`upper(COALESCE(o.status, s.status)) = ${p.add(komgaStatus(f.status))}`);
  if (f.libraryId) parts.push(`s.library_id = ${p.add(f.libraryId)}`);
  return { sql: parts.join(' AND '), values: p.values };
}

const SERIES_SELECT = `
  s.id, COALESCE(o.title, s.title) AS title, COALESCE(o.summary, s.summary) AS summary,
  COALESCE(o.status, s.status) AS status, COALESCE(o.genres, s.genres) AS genres,
  COALESCE(o.author, s.author) AS author, s.age_rating, s.books_count,
  s.cover_book_id, s.library_id, s.created_at, s.latest_mtime`;

const SERIES_FROM = `lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id`;

function parseSort(raw?: string | null): string {
  const [col, dir] = (raw ?? '').toLowerCase().split(',');
  const d = (dir?.trim() === 'desc') ? 'DESC' : 'ASC';
  const c = (col ?? '').trim();
  if (c.includes('title')    ) return `lower(COALESCE(o.title, s.title)) ${d}, s.id ${d}`;
  if (c === 'createddate'    ) return `s.created_at ${d}, s.id ${d}`;
  if (c.includes('modified') ) return `s.latest_mtime ${d}, s.id ${d}`;
  if (c === 'random'         ) return 'RANDOM()';
  return `lower(COALESCE(o.title, s.title)) ASC, s.id ASC`;
}

// ---- thumbnail serving -------------------------------------------------------

async function serveThumbnail(reply: FastifyReply, abs: string): Promise<void> {
  const first = await cbzPageAt(abs, 0);
  if (!first) return reply.code(404).send();
  try {
    const thumb = await sharp(first.bytes)
      .resize({ width: 300, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    reply.header('content-type', 'image/jpeg');
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(thumb);
  } catch {
    reply.header('content-type', mime(first.name));
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(first.bytes);
  }
}

async function bookAbs(bookId: string, ctx: ViewCtx): Promise<string | null> {
  const r = await visibleBookFile(bookId, ctx);
  if (!r) return null;
  return join(r.root || LIBRARY_ROOT, r.file);
}

// ---- route auth wrapper -----------------------------------------------------

function withAuth(fn: (req: FastifyRequest, reply: FastifyReply, user: import('../lib/komgaCompatAuth').KomgaCompatUser) => Promise<unknown>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await resolveKomgaUser(req).catch(() => null);
    if (!user) return reply.code(401).send({ error: 'unauthorized', message: 'Paste an Uchiyomi API token into the API key field.' });
    return fn(req, reply, user);
  };
}

// ============================================================================

export default async function komgaCompatRoutes(app: FastifyInstance) {

  // ---- /api/v1/libraries ----------------------------------------------------
  // The extension calls this first to verify credentials. Returns libraries the caller can see.
  app.get('/api/v1/libraries', withAuth(async (_req, _reply, user) => {
    const rows = await q<{ id: string; name: string }>(
      'SELECT id, name FROM libraries ORDER BY sort_order, name',
    );
    // Apply the user's library restriction (no SYSTEM_CTX here: we want their personal view)
    const visible = !user.ctx.libraryIds
      ? rows
      : rows.filter((r) => (user.ctx.libraryIds as string[]).includes(r.id));
    return visible.map((r) => ({ id: r.id, name: r.name, root: null }));
  }));

  // ---- /api/v1/series -------------------------------------------------------
  // Handles Popular, Latest and Search in the extension (all go to this endpoint with different sorts).
  app.get('/api/v1/series', withAuth(async (req, reply, user) => {
    const qs = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(0, Number(qs.page) || 0);
    const size    = Math.max(1, Math.min(500, Number(qs.size) || 20));
    const filter: SeriesFilter = {
      search:    qs.search    || null,
      genre:     qs.genre     || null,
      status:    qs.status    || null,
      libraryId: qs.library_id || null,
    };
    const orderBy = parseSort(qs.sort);

    const cw = seriesWhere(user.ctx, filter);
    const totalRow = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${SERIES_FROM} WHERE ${cw.sql}`, cw.values as any[],
    );

    const dw = seriesWhere(user.ctx, filter);
    const n = dw.values.length;
    const rows = await q<any>(
      `SELECT ${SERIES_SELECT} FROM ${SERIES_FROM} WHERE ${dw.sql} ORDER BY ${orderBy} LIMIT $${n+1} OFFSET $${n+2}`,
      [...dw.values, size, pageNum * size] as any[],
    );

    return springPage(rows.map(toSeriesDto), totalRow?.n ?? 0, pageNum, size);
  }));

  // ---- /api/v1/series/:id ---------------------------------------------------
  app.get('/api/v1/series/:id', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const p = new Params();
    const row = await one<any>(
      `SELECT ${SERIES_SELECT} FROM ${SERIES_FROM}
        WHERE s.id = ${p.add(id)} AND ${browsable('s', user.ctx, p)}`,
      p.values as any[],
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return toSeriesDto(row);
  }));

  // ---- /api/v1/series/:id/books ---------------------------------------------
  // Always returns books sorted by number ascending (Mihon reverses for display).
  app.get('/api/v1/series/:id/books', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const unpaged  = qs.unpaged === 'true';
    const onlyReady = qs.media_status === 'READY';
    const pageNum  = Math.max(0, Number(qs.page) || 0);
    const size     = unpaged ? 10_000 : Math.max(1, Math.min(500, Number(qs.size) || 20));

    // First confirm the series is visible to this user.
    const p0 = new Params();
    const seriesRow = await one<{ title: string; library_id: string | null }>(
      `SELECT COALESCE(o.title, s.title) AS title, s.library_id
         FROM ${SERIES_FROM}
        WHERE s.id = ${p0.add(id)} AND ${browsable('s', user.ctx, p0)}`,
      p0.values as any[],
    );
    if (!seriesRow) return reply.code(404).send({ error: 'not_found' });

    const p = new Params();
    const readyClause = onlyReady ? 'AND b.pruned_at IS NULL' : '';
    const rows = await q<any>(`
      SELECT b.id, b.series_id, b.file, b.root, b.pages, b.mtime, b.published_at,
             b.updated_at, b.pruned_at, b.size,
             COALESCE(ov.number, b.number) AS number,
             COALESCE(ov.title, b.title) AS title,
             rp.page AS rp_page, rp.completed AS rp_completed, rp.updated_at AS rp_updated_at
        FROM lib_books b
        JOIN lib_series s ON s.id = b.series_id AND ${visible('s', user.ctx, p)}
        LEFT JOIN book_overrides ov ON ov.book_id = b.id
        LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = ${p.add(user.userId)}
       WHERE b.series_id = ${p.add(id)} ${readyClause}
       ORDER BY COALESCE(ov.number, b.number) ASC, b.file ASC
       ${unpaged ? '' : `LIMIT $${p.values.length + 1} OFFSET $${p.values.length + 2}`}
    `, unpaged ? p.values as any[] : [...p.values, size, pageNum * size] as any[]);

    const books = rows.map((r: any) => toBookDto(
      { ...r, series_title: seriesRow.title, library_id: seriesRow.library_id },
      r.rp_page !== null || r.rp_completed != null
        ? { page: r.rp_page, completed: !!r.rp_completed, updated_at: r.rp_updated_at }
        : null,
    ));

    if (unpaged) return { content: books, totalElements: books.length, totalPages: 1, number: 0, size: books.length, first: true, last: true };
    return springPage(books, books.length, pageNum, size);
  }));

  // ---- /api/v1/series/:id/thumbnail -----------------------------------------
  app.get('/api/v1/series/:id/thumbnail', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const p = new Params();
    const row = await one<{ cover_book_id: string | null }>(
      `SELECT s.cover_book_id FROM ${SERIES_FROM} WHERE s.id = ${p.add(id)} AND ${browsable('s', user.ctx, p)}`,
      p.values as any[],
    );
    if (!row) return reply.code(404).send();
    const bookId = row.cover_book_id;
    if (!bookId) return reply.code(404).send();
    const abs = await bookAbs(bookId, user.ctx);
    if (!abs) return reply.code(404).send();
    return serveThumbnail(reply, abs);
  }));

  // ---- /api/v1/books/:id ----------------------------------------------------
  app.get('/api/v1/books/:id', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const p = new Params();
    const r = await one<any>(`
      SELECT b.id, b.series_id, b.file, b.root, b.pages, b.mtime, b.published_at,
             b.updated_at, b.pruned_at, b.size,
             COALESCE(ov.number, b.number) AS number,
             COALESCE(ov.title, b.title) AS title,
             COALESCE(so.title, s.title) AS series_title, s.library_id,
             rp.page AS rp_page, rp.completed AS rp_completed, rp.updated_at AS rp_updated_at
        FROM lib_books b
        JOIN lib_series s ON s.id = b.series_id AND ${visible('s', user.ctx, p)}
        LEFT JOIN series_overrides so ON so.series_id = s.id
        LEFT JOIN book_overrides ov ON ov.book_id = b.id
        LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = ${p.add(user.userId)}
       WHERE b.id = ${p.add(id)}
    `, p.values as any[]);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return toBookDto(r, r.rp_page !== null || r.rp_completed != null
      ? { page: r.rp_page, completed: !!r.rp_completed, updated_at: r.rp_updated_at }
      : null);
  }));

  // ---- /api/v1/books/:id/pages ----------------------------------------------
  // Returns the full page listing so Mihon knows how many pages a chapter has and their types.
  app.get('/api/v1/books/:id/pages', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const p = new Params();
    const r = await one<{ pages: number | null; page_dims: any[] | null; pruned_at: string | null; file: string; root: string }>(
      `SELECT b.pages, b.page_dims, b.pruned_at, b.file, b.root
         FROM lib_books b JOIN lib_series s ON s.id = b.series_id AND ${visible('s', user.ctx, p)}
        WHERE b.id = ${p.add(id)}`,
      p.values as any[],
    );
    if (!r) return reply.code(404).send({ error: 'not_found' });
    if (r.pruned_at) return reply.code(404).send({ error: 'deleted' });

    // page_dims is a JSON array of {name, width, height} cached after the first read.
    if (r.page_dims && Array.isArray(r.page_dims) && r.page_dims.length > 0) {
      return r.page_dims.map((d: any, i: number) => ({
        number: i + 1,
        fileName: d.name ?? `page${i + 1}.jpg`,
        mediaType: mime(d.name ?? ''),
      }));
    }
    // Cache miss: open the archive now. cbzPageDims is the slow path and also saves to page_dims
    // via the background job, so the NEXT call uses the fast path above.
    const abs = join(r.root || LIBRARY_ROOT, r.file);
    const dims = await cbzPageDims(abs).catch(() => [] as { name: string; width: number | null; height: number | null }[]);
    if (dims.length) {
      return dims.map((d, i) => ({ number: i + 1, fileName: d.name, mediaType: mime(d.name) }));
    }
    // Last resort: fake names from the count (only happens when the file can't be read).
    return Array.from({ length: r.pages ?? 0 }, (_, i) => ({
      number: i + 1,
      fileName: `page${i + 1}.jpg`,
      mediaType: 'image/jpeg',
    }));
  }));

  // ---- /api/v1/books/:id/pages/:page ----------------------------------------
  // Serves the raw image. `page` is 1-based (Komga convention) → cbzPageAt takes 0-based.
  app.get('/api/v1/books/:id/pages/:page', withAuth(async (req, reply, user) => {
    const { id, page: pageStr } = req.params as { id: string; page: string };
    const pageNo = Number(pageStr);
    if (!Number.isInteger(pageNo) || pageNo < 1) return reply.code(400).send({ error: 'bad_page' });
    const abs = await bookAbs(id, user.ctx);
    if (!abs) return reply.code(404).send({ error: 'not_found' });
    // Optionally convert to png (some platforms struggle with a rare media type)
    const convert = (req.query as Record<string, string | undefined>).convert;
    const raw = await cbzPageAt(abs, pageNo - 1); // convert to 0-based
    if (!raw) return reply.code(404).send({ error: 'no_page' });
    if (convert === 'png') {
      try {
        const buf = await sharp(raw.bytes).png().toBuffer();
        reply.header('content-type', 'image/png');
        reply.header('cache-control', 'private, max-age=86400');
        return reply.send(buf);
      } catch {
        // Fall through to raw
      }
    }
    reply.header('content-type', mime(raw.name));
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(raw.bytes);
  }));

  // ---- /api/v1/books/:id/thumbnail ------------------------------------------
  app.get('/api/v1/books/:id/thumbnail', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const abs = await bookAbs(id, user.ctx);
    if (!abs) return reply.code(404).send();
    return serveThumbnail(reply, abs);
  }));

  // ---- /api/v1/genres -------------------------------------------------------
  // Feeds the filter screen. Returns every distinct genre across the visible library.
  app.get('/api/v1/genres', withAuth(async (_req, _reply, user) => {
    const p = new Params();
    const rows = await q<{ g: string }>(
      `SELECT DISTINCT unnest(COALESCE(o.genres, s.genres)) AS g
         FROM ${SERIES_FROM}
        WHERE ${browsable('s', user.ctx, p)}
        ORDER BY g`,
      p.values as any[],
    );
    return rows.map((r) => r.g);
  }));

  // ---- /api/v1/tags ---------------------------------------------------------
  // Komga has separate genres and tags; Uchiyomi uses only genres. Return genres as tags too so the
  // filter screen has something to offer in both boxes without extra DB columns.
  app.get('/api/v1/tags', withAuth(async (_req, _reply, user) => {
    const p = new Params();
    const rows = await q<{ g: string }>(
      `SELECT DISTINCT unnest(COALESCE(o.genres, s.genres)) AS g
         FROM ${SERIES_FROM}
        WHERE ${browsable('s', user.ctx, p)}
        ORDER BY g`,
      p.values as any[],
    );
    return rows.map((r) => r.g);
  }));

  // ---- /api/v1/publishers ---------------------------------------------------
  // Uchiyomi stores a single author string, not separate publishers. Return empty; the filter
  // screen shows an empty list rather than failing.
  app.get('/api/v1/publishers', withAuth(async () => []));

  // ---- /api/v1/authors ------------------------------------------------------
  // Komga expects [{name, role}]. Uchiyomi stores a free-text author field; emit each distinct
  // value as a single "writer" entry.
  app.get('/api/v1/authors', withAuth(async (_req, _reply, user) => {
    const p = new Params();
    const rows = await q<{ author: string }>(
      `SELECT DISTINCT COALESCE(o.author, s.author) AS author
         FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
        WHERE ${browsable('s', user.ctx, p)} AND COALESCE(o.author, s.author) IS NOT NULL
        ORDER BY author`,
      p.values as any[],
    );
    return rows.map((r) => ({ name: r.author, role: 'writer' }));
  }));

  // ---- /api/v1/collections --------------------------------------------------
  // Returns this user's personal Uchiyomi collections. Used only to populate the "Collection" filter
  // drop-down; the extension only reads `id` and `name`, so the heavy series-list fields can be empty.
  app.get('/api/v1/collections', withAuth(async (_req, _reply, user) => {
    const rows = await q<{ id: string; name: string; created_at: string }>(
      'SELECT id, name, created_at FROM collections WHERE user_id = $1 ORDER BY name',
      [user.userId],
    );
    const result = rows.map((r) => ({
      id: r.id,
      name: r.name,
      ordered: true,
      seriesIds: [],
      createdDate:      new Date(r.created_at).toISOString(),
      lastModifiedDate: new Date(r.created_at).toISOString(),
      filtered: false,
    }));
    return springPage(result, result.length, 0, result.length || 1);
  }));

  // ---- /api/v1/collections/:id/series ---------------------------------------
  app.get('/api/v1/collections/:id/series', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const owns = await one(
      'SELECT id FROM collections WHERE id = $1 AND user_id = $2',
      [id, user.userId],
    );
    if (!owns) return reply.code(404).send({ error: 'not_found' });

    const qs = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(0, Number(qs.page) || 0);
    const size    = Math.max(1, Math.min(500, Number(qs.size) || 20));

    const p = new Params();
    const rows = await q<any>(`
      SELECT ${SERIES_SELECT}
        FROM collection_items ci
        JOIN ${SERIES_FROM} ON s.id = ci.series_id
       WHERE ci.collection_id = ${p.add(id)} AND ${browsable('s', user.ctx, p)}
       ORDER BY ci.position ASC, lower(COALESCE(o.title, s.title)) ASC
       LIMIT $${p.values.length + 1} OFFSET $${p.values.length + 2}
    `, [...p.values, size, pageNum * size] as any[]);

    const pCount = new Params();
    const total = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM collection_items ci JOIN ${SERIES_FROM} ON s.id = ci.series_id
        WHERE ci.collection_id = ${pCount.add(id)} AND ${browsable('s', user.ctx, pCount)}`,
      pCount.values as any[],
    );

    return springPage(rows.map(toSeriesDto), total?.n ?? 0, pageNum, size);
  }));

  // ---- /api/v1/readlists ----------------------------------------------------
  // Uchiyomi has no read-list concept. Return an empty page so the extension does not crash when
  // the user picks "Read lists" in the type filter.
  app.get('/api/v1/readlists', withAuth(async (_req, _reply, _user) => springPage([], 0, 0, 20)));

  // ---- /api/v2/series/:id/read-progress/tachiyomi ---------------------------
  // GET: Mihon's tracker reads the current progress overview.
  app.get('/api/v2/series/:id/read-progress/tachiyomi', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    // Confirm the series is visible to this user
    const p0 = new Params();
    const exists = await one(
      `SELECT s.id FROM ${SERIES_FROM} WHERE s.id = ${p0.add(id)} AND ${visible('s', user.ctx, p0)}`,
      p0.values as any[],
    );
    if (!exists) return reply.code(404).send({ error: 'not_found' });

    const stats = await one<{
      books_count: number;
      books_read: number;
      books_in_progress: number;
      max_number: number | null;
    }>(
      `SELECT count(*)::int                                               AS books_count,
              count(*) FILTER (WHERE rp.completed = true)::int           AS books_read,
              count(*) FILTER (WHERE rp.book_id IS NOT NULL
                                 AND rp.completed = false)::int          AS books_in_progress,
              MAX(COALESCE(ov.number, b.number))                         AS max_number
         FROM lib_books b
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
         LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $1
        WHERE b.series_id = $2`,
      [user.userId, id],
    );

    const booksCount      = stats?.books_count ?? 0;
    const booksReadCount  = stats?.books_read  ?? 0;
    const booksInProgress = stats?.books_in_progress ?? 0;
    const booksUnread     = booksCount - booksReadCount - booksInProgress;
    const maxNumberSort   = Number(stats?.max_number ?? 0);
    // Highest chapter N where every chapter 1..N is completed — the value Mihon uses as "last read".
    const books2 = await q<{ number: number; completed: boolean }>(
      `SELECT COALESCE(ov.number, b.number) AS number, (rp.completed = true) AS completed
         FROM lib_books b
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
         LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $1
        WHERE b.series_id = $2 ORDER BY 1 ASC`,
      [user.userId, id],
    );
    let lastContinuous = 0;
    for (const b2 of books2) { if (!b2.completed) break; lastContinuous = Number(b2.number); }

    return {
      booksCount,
      booksReadCount,
      booksUnreadCount: Math.max(0, booksUnread),
      booksInProgressCount: booksInProgress,
      lastReadContinuousNumberSort: lastContinuous,
      maxNumberSort,
    };
  }));

  // ---- /api/v2/series/:id/read-progress/tachiyomi ---------------------------
  // PUT: Mihon's tracker writes progress — "mark everything up to this chapter number as read".
  app.put('/api/v2/series/:id/read-progress/tachiyomi', withAuth(async (req, reply, user) => {
    const { id } = req.params as { id: string };
    const body = req.body as { lastBookNumberSortRead?: number } | null;
    const upTo = Number(body?.lastBookNumberSortRead ?? 0);
    if (!Number.isFinite(upTo) || upTo < 0) return reply.code(400).send({ error: 'bad_request' });

    // Confirm visibility first so we don't mark read on a series the user cannot see.
    const p0 = new Params();
    const exists = await one(
      `SELECT s.id FROM ${SERIES_FROM} WHERE s.id = ${p0.add(id)} AND ${visible('s', user.ctx, p0)}`,
      p0.values as any[],
    );
    if (!exists) return reply.code(404).send({ error: 'not_found' });

    // Fetch the matching books so we can call writeProgress (which fires the reading event and tracker hooks).
    const books = await q<{ id: string; pages: number; number: number }>(
      `SELECT b.id, b.pages, COALESCE(ov.number, b.number) AS number
         FROM lib_books b
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id = $1 AND COALESCE(ov.number, b.number) <= $2`,
      [id, upTo],
    );

    // Bulk upsert read_progress for speed, then fire the tracker push once per series.
    // Deliberately silent (no reading_events) – this is Mihon syncing to Uchiyomi, not
    // native reading in Uchiyomi, so it should not show up in streaks or Wrapped.
    for (const b of books) {
      await writeProgress({
        userId:   user.userId,
        bookId:   b.id,
        seriesId: id,
        page:     Math.max(0, (b.pages ?? 1) - 1),
        completed: true,
        // silent: no reading_events — this write is Mihon syncing progress, not native reading in Uchiyomi,
        // so it must not inflate streaks, the leaderboard, or Wrapped. AniList etc. DO still get the push
        // (pushSeriesProgressAsync fires from writeProgress) which is correct: you read a chapter.
        silent:   true,
      });
    }
    // After the bulk write, trigger external tracker push (e.g. AniList) for this series.
    if (books.length) pushSeriesProgressAsync(user.userId, id);

    return reply.code(204).send();
  }));
}
