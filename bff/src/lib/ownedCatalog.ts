// Owned catalog backend: a drop-in for the `komga` client, returning Komga-shaped series/book DTOs from
// the lib_* tables. enrichSeries/booksForUser in catalog.ts then add per-user state exactly as before.
import { q, one } from './db';
import { cbzPageDims, LIBRARY_ROOT, persistScan } from './library';

interface Page<T> { content: T[]; totalElements: number; totalPages: number; number: number; size: number; first: boolean; last: boolean }
function page<T>(content: T[], total: number, p: number, size: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(total / size));
  return { content, totalElements: total, totalPages, number: p, size, first: p <= 0, last: p >= totalPages - 1 };
}

const SERIES_COLS = 'id, title, summary, status, genres, author, books_count, cover_book_id, web, created_at, latest_mtime, auto_update';

/**
 * The one place a series is read from.
 *
 * Two things have to be true of every series query and were previously true of almost none of them:
 *   1. the admin's title/summary override wins, so a renamed series is findable by its new name, sorts under
 *      it, and carries it into the reader, OPDS and offline manifests -- not just its own detail page;
 *   2. a deleted or merged-away series is invisible.
 *
 * Doing it in a subquery rather than at each call site means `title ILIKE`, `ORDER BY title` and every rail
 * agree by construction. `GET /api/series/:id` still reads series_overrides directly afterwards, because it
 * additionally returns `overrides` and `artVersion` for the edit modal and thumbnail cache-busting.
 */
const SERIES_SRC = `(
  SELECT s.id, COALESCE(o.title, s.title) AS title, COALESCE(o.summary, s.summary) AS summary,
         COALESCE(o.status, s.status) AS status, COALESCE(o.genres, s.genres) AS genres,
         COALESCE(o.author, s.author) AS author,
         s.books_count, s.cover_book_id, s.web, s.created_at, s.latest_mtime,
         s.auto_update
    FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
   WHERE s.deleted_at IS NULL AND s.merged_into IS NULL
) sv`;

/**
 * The one place a chapter is read from, so an override applies everywhere at once: the chapter list, reading
 * order, next/previous, the OPDS feed and what the tracker is told. Mirrors SERIES_SRC.
 */
const BOOKS_SRC = `(
  SELECT b.id, b.series_id, b.source, b.file, b.root, b.pages, b.mtime, b.published_at, b.page_dims,
         b.updated_at, b.fingerprint,
         COALESCE(ov.number, b.number) AS number,
         COALESCE(ov.title,  b.title)  AS title
    FROM lib_books b LEFT JOIN book_overrides ov ON ov.book_id = b.id
) bv`;

/** The overridden title for one series, for the book DTOs that carry seriesTitle. */
const SERIES_TITLE_SQL = 'COALESCE(o.title, s.title)';
const SERIES_TITLE_JOIN = 'JOIN lib_series s ON s.id = %col% LEFT JOIN series_overrides o ON o.series_id = s.id';

function seriesDto(r: any) {
  const genres: string[] = r.genres ?? [];
  const summary: string = r.summary ?? '';
  const count: number = r.books_count ?? 0;
  return {
    id: r.id,
    libraryId: 'lib',
    name: r.title,
    created: r.created_at ? new Date(r.created_at).toISOString() : null, // when the series entered the library
    booksCount: count,
    booksReadCount: 0,
    booksUnreadCount: count,
    booksInProgressCount: 0,
    metadata: {
      title: r.title,
      status: r.status ? String(r.status).toUpperCase() : '',
      summary,
      readingDirection: 'WEBTOON',
      author: r.author ?? '',
      publisher: r.author ?? '',
      genres,
      tags: [],
      ageRating: null,
      language: 'en',
    },
    booksMetadata: { summary, genres, tags: [] },
    // whether the scheduled updater pulls new chapters for this series; settable from the series page
    autoUpdate: r.auto_update !== false,
  };
}

function bookDto(r: any) {
  const num: number = r.number ?? 0;
  // release date: the source's chapter date when stamped, else when the file landed in the library
  const released = r.published_at
    ? new Date(r.published_at).toISOString()
    : r.mtime && Number(r.mtime) > 0
      ? new Date(Number(r.mtime)).toISOString()
      : null;
  return {
    id: r.id,
    seriesId: r.series_id,
    seriesTitle: r.series_title ?? '',
    name: r.title,
    number: num,
    media: { pagesCount: r.pages ?? 0, mediaType: 'application/vnd.comicbook+zip', status: 'READY' },
    metadata: { title: r.title, number: String(num), numberSort: num, summary: '', releaseDate: released },
  };
}

function mediaType(name: string): string {
  const e = name.toLowerCase().split('.').pop();
  return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : e === 'avif' ? 'image/avif' : 'image/jpeg';
}

// Translate the subset of Komga's condition tree the app actually builds into a SQL predicate.
function condSql(cond: any, params: any[]): string {
  if (!cond || typeof cond !== 'object') return 'TRUE';
  if (Array.isArray(cond.allOf)) return cond.allOf.length ? '(' + cond.allOf.map((c: any) => condSql(c, params)).join(' AND ') + ')' : 'TRUE';
  if (Array.isArray(cond.anyOf)) return cond.anyOf.length ? '(' + cond.anyOf.map((c: any) => condSql(c, params)).join(' OR ') + ')' : 'TRUE';
  if (cond.genre && cond.genre.value != null) {
    params.push(String(cond.genre.value));
    const ex = `EXISTS (SELECT 1 FROM unnest(genres) AS g WHERE lower(g) = lower($${params.length}))`;
    return cond.genre.operator === 'isNot' ? `NOT ${ex}` : ex;
  }
  // readStatus / releaseDate / library / other per-user or unsupported predicates: match all
  return 'TRUE';
}

function sortSql(sort?: string): string {
  if (!sort) return 'title ASC';
  const [field, dir0] = String(sort).split(',');
  const dir = (dir0 || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  if (/random/i.test(field)) return 'random()';
  if (/title|name/i.test(field)) return `title ${dir}`;
  if (/created|added/i.test(field)) return `created_at ${dir}`;
  if (/updated|date|modified/i.test(field)) return `latest_mtime ${dir}`;
  return `title ${dir}`;
}

const total = async (where = 'TRUE', params: any[] = []) =>
  (await one<{ c: number }>(`SELECT count(*)::int AS c FROM ${SERIES_SRC} WHERE ${where}`, params))?.c ?? 0;

export const owned = {
  libraries: async () => [{ id: 'lib', name: 'Library' }],

  genres: async () => (await q<{ g: string }>(`SELECT DISTINCT g FROM ${SERIES_SRC}, unnest(genres) AS g ORDER BY g`)).map((r) => r.g),

  series: async (id: string) => {
    const r = await one(`SELECT ${SERIES_COLS} FROM ${SERIES_SRC} WHERE id = $1`, [id]);
    if (!r) throw Object.assign(new Error('series not found'), { statusCode: 404 });
    return seriesDto(r);
  },

  seriesNew: async (p = 0, size = 20) => {
    const rows = await q(`SELECT ${SERIES_COLS} FROM ${SERIES_SRC} ORDER BY created_at DESC, title ASC LIMIT $1 OFFSET $2`, [size, p * size]);
    return page(rows.map(seriesDto), await total(), p, size);
  },

  seriesUpdated: async (p = 0, size = 20) => {
    const rows = await q(`SELECT ${SERIES_COLS} FROM ${SERIES_SRC} ORDER BY latest_mtime DESC, title ASC LIMIT $1 OFFSET $2`, [size, p * size]);
    return page(rows.map(seriesDto), await total(), p, size);
  },

  booksOnDeck: async (_p = 0, size = 20) => page([] as any[], 0, 0, size), // owned: continue-reading is served from read_progress in catalog

  searchSeries: async (body: any, p = 0, size = 40, sort?: string) => {
    const params: any[] = [];
    let where = body?.condition ? condSql(body.condition, params) : 'TRUE';
    if (body?.fullTextSearch) {
      params.push(`%${body.fullTextSearch}%`);
      where = `(${where}) AND title ILIKE $${params.length}`;
    }
    const t = await total(where, params);
    const rows = await q(
      `SELECT ${SERIES_COLS} FROM ${SERIES_SRC} WHERE ${where} ORDER BY ${sortSql(sort)} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, p * size],
    );
    return page(rows.map(seriesDto), t, p, size);
  },

  seriesBooks: async (id: string, p = 0, size = 100, sort = 'metadata.numberSort,asc') => {
    const dir = /desc/i.test(sort) ? 'DESC' : 'ASC';
    const st = (await one<{ title: string }>(`SELECT title FROM ${SERIES_SRC} WHERE id = $1`, [id]))?.title ?? '';
    const t = (await one<{ c: number }>('SELECT count(*)::int AS c FROM lib_books WHERE series_id = $1', [id]))?.c ?? 0;
    const rows = await q(`SELECT * FROM ${BOOKS_SRC} WHERE series_id = $1 ORDER BY number ${dir}, file ${dir} LIMIT $2 OFFSET $3`, [id, size, p * size]);
    return page(rows.map((r) => bookDto({ ...r, series_title: st })), t, p, size);
  },

  book: async (id: string) => {
    const r = await one(`SELECT b.*, ${SERIES_TITLE_SQL} AS series_title FROM ${BOOKS_SRC.replace('bv', 'b')} ${SERIES_TITLE_JOIN.replace('%col%', 'b.series_id')} WHERE b.id = $1`, [id]);
    if (!r) throw Object.assign(new Error('book not found'), { statusCode: 404 });
    return bookDto(r);
  },

  bookPages: async (id: string) => {
    const r = await one<{ file: string; root: string; page_dims: Array<{ name: string; width: number | null; height: number | null }> | null }>(
      'SELECT file, root, page_dims FROM lib_books WHERE id = $1',
      [id],
    );
    if (!r) return [];
    if (Array.isArray(r.page_dims) && r.page_dims.length) {
      return r.page_dims.map((p, i) => ({ number: i + 1, fileName: p.name, mediaType: mediaType(p.name), width: p.width ?? null, height: p.height ?? null, sizeBytes: null }));
    }
    const dims = await cbzPageDims(`${r.root || LIBRARY_ROOT}/${r.file}`).catch(() => [] as Array<{ name: string; width: number | null; height: number | null }>);
    if (dims.length) q('UPDATE lib_books SET pages = $1, page_dims = $2 WHERE id = $3', [dims.length, JSON.stringify(dims), id]).catch(() => {});
    return dims.map((p, i) => ({ number: i + 1, fileName: p.name, mediaType: mediaType(p.name), width: p.width, height: p.height, sizeBytes: null }));
  },

  // Next/previous compare (number, file) rather than number alone. Two chapters legitimately share a
  // number -- a duplicate that merge deliberately keeps, or a manual renumber -- and comparing the number
  // by itself then makes "next" arbitrary, and can hand back the chapter you are already reading.
  // The tuple matches the ORDER BY number, file used everywhere else, so the reader walks one order.
  bookNext: async (id: string) => {
    const b = await one<{ series_id: string; number: number; file: string }>(
      `SELECT series_id, number, file FROM ${BOOKS_SRC} WHERE id = $1`, [id]);
    if (!b) throw Object.assign(new Error('not found'), { statusCode: 404 });
    const n = await one(`SELECT bk.*, ${SERIES_TITLE_SQL} AS series_title FROM ${BOOKS_SRC.replace('bv', 'bk')} ${SERIES_TITLE_JOIN.replace('%col%', 'bk.series_id')} WHERE bk.series_id = $1 AND (bk.number, bk.file) > ($2, $3) ORDER BY bk.number ASC, bk.file ASC LIMIT 1`, [b.series_id, b.number, b.file]);
    if (!n) throw Object.assign(new Error('no next'), { statusCode: 404 });
    return bookDto(n);
  },

  bookPrevious: async (id: string) => {
    const b = await one<{ series_id: string; number: number; file: string }>(
      `SELECT series_id, number, file FROM ${BOOKS_SRC} WHERE id = $1`, [id]);
    if (!b) throw Object.assign(new Error('not found'), { statusCode: 404 });
    const n = await one(`SELECT bk.*, ${SERIES_TITLE_SQL} AS series_title FROM ${BOOKS_SRC.replace('bv', 'bk')} ${SERIES_TITLE_JOIN.replace('%col%', 'bk.series_id')} WHERE bk.series_id = $1 AND (bk.number, bk.file) < ($2, $3) ORDER BY bk.number DESC, bk.file DESC LIMIT 1`, [b.series_id, b.number, b.file]);
    if (!n) throw Object.assign(new Error('no previous'), { statusCode: 404 });
    return bookDto(n);
  },

  setReadProgress: async () => {}, // owned: read_progress is the source of truth (no native store to mirror to)

  scanLibrary: async () => { await persistScan(); },

  seriesThumbPath: (id: string) => `/img/lib/series/${encodeURIComponent(id)}/thumb`,
  bookThumbPath: (id: string) => `/img/lib/books/${encodeURIComponent(id)}/thumb`,
  bookPagePath: (id: string, n: number) => `/img/lib/books/${encodeURIComponent(id)}/page/${n}`,
};
