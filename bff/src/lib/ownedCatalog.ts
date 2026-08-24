// Owned catalog backend: a drop-in for the `komga` client, returning Komga-shaped series/book DTOs from
// the lib_* tables. enrichSeries/booksForUser in catalog.ts then add per-user state exactly as before.
import { q, one } from './db';
import { cbzPageDims, LIBRARY_ROOT, persistScan } from './library';
import { ViewCtx, Params, visible } from './visibility';

interface Page<T> { content: T[]; totalElements: number; totalPages: number; number: number; size: number; first: boolean; last: boolean }
function page<T>(content: T[], total: number, p: number, size: number): Page<T> {
  const totalPages = Math.max(1, Math.ceil(total / size));
  return { content, totalElements: total, totalPages, number: p, size, first: p <= 0, last: p >= totalPages - 1 };
}

const SERIES_COLS = 'id, title, summary, status, genres, author, age_rating, books_count, cover_book_id, web, created_at, latest_mtime, auto_update, library_id, library_pinned';

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
const seriesSrc = (ctx: ViewCtx, p: Params, alias = 'sv') => `(
  SELECT s.id, COALESCE(o.title, s.title) AS title, COALESCE(o.summary, s.summary) AS summary,
         COALESCE(o.status, s.status) AS status, COALESCE(o.genres, s.genres) AS genres,
         COALESCE(o.author, s.author) AS author,
         COALESCE(o.age_rating, s.age_rating) AS age_rating,
         s.books_count, s.cover_book_id, s.web, s.created_at, s.latest_mtime,
         s.auto_update, s.library_id, s.library_pinned
    FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
   WHERE ${visible('s', ctx, p)}
) ${alias}`;

/**
 * The one place a chapter is read from, so an override applies everywhere at once: the chapter list, reading
 * order, next/previous, the OPDS feed and what the tracker is told. Mirrors SERIES_SRC.
 */
const booksSrc = (ctx: ViewCtx, p: Params, alias = 'bv') => `(
  SELECT b.id, b.series_id, b.source, b.file, b.root, b.pages, b.mtime, b.published_at, b.page_dims,
         b.updated_at, b.fingerprint,
         COALESCE(ov.number, b.number) AS number,
         COALESCE(ov.title,  b.title)  AS title
    FROM lib_books b
    -- The join that was missing. This carried zero references to lib_series, so a book id alone opened a
    -- chapter of a hidden series and next/previous then walked the whole thing. Every series-level rule --
    -- soft delete, merge, and now library access -- reaches chapters only through here.
    JOIN lib_series s ON s.id = b.series_id AND ${visible('s', ctx, p)}
    LEFT JOIN book_overrides ov ON ov.book_id = b.id
) ${alias}`;

/** The overridden title for one series, for the book DTOs that carry seriesTitle. */
const SERIES_TITLE_SQL = 'COALESCE(o.title, s.title)';
const SERIES_TITLE_JOIN = 'JOIN lib_series s ON s.id = %col% LEFT JOIN series_overrides o ON o.series_id = s.id';

function seriesDto(r: any) {
  const genres: string[] = r.genres ?? [];
  const summary: string = r.summary ?? '';
  const count: number = r.books_count ?? 0;
  return {
    id: r.id,
    libraryId: r.library_id ?? 'lib',
    // Whether an admin filed this series into that library by hand. Shown so the edit modal can say
    // "automatic" honestly rather than implying every placement was a decision someone made.
    libraryPinned: r.library_pinned === true,
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
      ageRating: r.age_rating ?? null,
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
/** A filter the query cannot express. Surfaced as a 400 rather than silently widened. */
export class UnsupportedFilter extends Error {
  constructor(public predicate: string) {
    super(`unsupported filter: ${predicate}`);
  }
}

/**
 * Translate a condition tree into SQL.
 *
 * Unknown predicates THROW rather than returning TRUE. Returning TRUE is what this did for everything except
 * genre, which meant "show me only what I have not read" silently returned the entire library: no error, no
 * empty result, nothing to debug against. A filter that appears to work and does nothing is worse than one
 * that refuses.
 *
 * `hasUser` gates the per-user predicates. They read a `mine` CTE that is only joined in when the caller
 * said who is asking.
 */
function condSql(cond: any, params: any[], hasUser = false): string {
  if (!cond || typeof cond !== 'object') return 'TRUE';
  if (Array.isArray(cond.allOf)) return cond.allOf.length ? '(' + cond.allOf.map((c: any) => condSql(c, params, hasUser)).join(' AND ') + ')' : 'TRUE';
  if (Array.isArray(cond.anyOf)) return cond.anyOf.length ? '(' + cond.anyOf.map((c: any) => condSql(c, params, hasUser)).join(' OR ') + ')' : 'TRUE';

  if (cond.genre && cond.genre.value != null) {
    params.push(String(cond.genre.value));
    const ex = `EXISTS (SELECT 1 FROM unnest(genres) AS g WHERE lower(g) = lower($${params.length}))`;
    return cond.genre.operator === 'isNot' ? `NOT ${ex}` : ex;
  }

  // Which library. `visible()` has already narrowed the source to what this viewer may open, so naming a
  // library they cannot see returns nothing rather than an error that would confirm it exists.
  if (cond.libraryId && cond.libraryId.value != null) {
    params.push(String(cond.libraryId.value));
    const ex = `library_id = $${params.length}`;
    return cond.libraryId.operator === 'isNot' ? `NOT (${ex})` : `(${ex})`;
  }

  if (cond.status && cond.status.value != null) {
    params.push(String(cond.status.value));
    const ex = `lower(status) = lower($${params.length})`;
    return cond.status.operator === 'isNot' ? `NOT (${ex})` : `(${ex})`;
  }

  // A single free-text column that often holds several names, so contains rather than equals.
  if (cond.author && cond.author.value != null) {
    params.push(`%${String(cond.author.value)}%`);
    const ex = `author ILIKE $${params.length}`;
    return cond.author.operator === 'isNot' ? `NOT (${ex})` : `(${ex})`;
  }

  if (cond.readStatus && cond.readStatus.value != null) {
    if (!hasUser) throw new UnsupportedFilter('readStatus (no user context)');
    const done = 'COALESCE(m.done, 0)';
    const started = 'COALESCE(m.started, 0)';
    const v = String(cond.readStatus.value).toUpperCase();
    const sql =
      v === 'UNREAD' ? `${done} = 0 AND ${started} = 0`
      : v === 'IN_PROGRESS' ? `(${started} > 0 OR (${done} > 0 AND ${done} < books_count))`
      : v === 'READ' ? `books_count > 0 AND ${done} >= books_count`
      : null;
    if (!sql) throw new UnsupportedFilter(`readStatus:${v}`);
    return cond.readStatus.operator === 'isNot' ? `NOT (${sql})` : `(${sql})`;
  }

  throw new UnsupportedFilter(Object.keys(cond).filter((k) => k !== 'operator')[0] || 'unknown');
}

function sortSql(sort?: string): string {
  if (!sort) return 'title ASC';
  const [field, dir0] = String(sort).split(',');
  const dir = (dir0 || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  if (/random/i.test(field)) return 'random()';
  if (/title|name/i.test(field)) return `title ${dir}`;
  if (/created|added/i.test(field)) return `created_at ${dir}`;
  if (/updated|date|modified/i.test(field)) return `latest_mtime ${dir}`;
  if (/author/i.test(field)) return `author ${dir} NULLS LAST`;
  // real unread count, which needs the `mine` CTE; the library page used to sort by total chapters and
  // label it "Most chapters" because this was not expressible
  if (/unread/i.test(field)) return `(books_count - COALESCE(m.done, 0)) ${dir}`;
  return `title ${dir}`;
}

/**
 * Per-user reading state, rolled up once.
 *
 * One indexed pass over read_progress for this user (idx_rp_series is (user_id, series_id)), joined once,
 * rather than a correlated count re-run for every predicate on every candidate series. Only emitted when a
 * per-user filter or sort is actually asked for, so the ordinary "everything, A to Z" query is unchanged.
 *
 * userId is always $1 when present, because condSql pushes its own parameters as it walks the tree.
 */
const MINE_CTE = `WITH mine AS (
  SELECT series_id,
         count(*) FILTER (WHERE completed)::int     AS done,
         count(*) FILTER (WHERE NOT completed)::int AS started
    FROM read_progress WHERE user_id = $1 GROUP BY series_id
)`;

/**
 * The chapter before or after this one, within the same series.
 *
 * Both directions were byte-identical apart from two comparison operators, and both had to be kept in step
 * with the (number, file) tuple ordering, so they share one body.
 */
async function adjacentBook(ctx: ViewCtx, id: string, dir: 'next' | 'prev') {
  const pb = new Params();
  const bsrc0 = booksSrc(ctx, pb);
  const b = await one<{ series_id: string; number: number; file: string }>(
    `SELECT series_id, number, file FROM ${bsrc0} WHERE id = ${pb.add(id)}`,
    pb.values as any[],
  );
  if (!b) throw Object.assign(new Error('not found'), { statusCode: 404 });

  const cmp = dir === 'next' ? '>' : '<';
  const order = dir === 'next' ? 'ASC' : 'DESC';
  const p = new Params();
  const bsrc = booksSrc(ctx, p, 'bk');
  const n = await one(
    `SELECT bk.*, ${SERIES_TITLE_SQL} AS series_title FROM ${bsrc} ${SERIES_TITLE_JOIN.replace('%col%', 'bk.series_id')}
      WHERE bk.series_id = ${p.add(b.series_id)} AND (bk.number, bk.file) ${cmp} (${p.add(b.number)}, ${p.add(b.file)})
      ORDER BY bk.number ${order}, bk.file ${order} LIMIT 1`,
    p.values as any[],
  );
  if (!n) throw Object.assign(new Error(dir === 'next' ? 'no next' : 'no previous'), { statusCode: 404 });
  return bookDto(n);
}

/** A copy, so a count query and its page query can each own their parameter list without re-pushing. */
const clone = (p: Params): Params => {
  const c = new Params();
  for (const v of p.values) c.add(v);
  return c;
};

const total = async (ctx: ViewCtx, where = 'TRUE', p = new Params(), cte = '', from?: string) =>
  (await one<{ c: number }>(
    `${cte} SELECT count(*)::int AS c FROM ${from ?? seriesSrc(ctx, p)} WHERE ${where}`,
    p.values as any[],
  ))?.c ?? 0;

export const owned = {
  libraries: async (ctx: ViewCtx) => {
    const rows = await q<{ id: string; name: string }>(
      'SELECT id, name FROM libraries ORDER BY sort_order, name',
    );
    // A restricted viewer is told about the libraries they hold, not all of them: the list itself would
    // otherwise leak the existence and names of everything they cannot open.
    return ctx.libraryIds ? rows.filter((r) => ctx.libraryIds!.includes(r.id)) : rows;
  },

  /**
   * Every genre with how much of THIS viewer's library sits in it, plus the covers to build a tile from.
   *
   * The browse page had genre NAMES and nothing else, so it painted them with six stock images shared
   * between forty genre names: on the real library the same night-market photo appears under Comedy,
   * Cooking, Historical, Music, School Life, Slice of Life and Sports, and fifty-six genres including the
   * second-largest one get no image at all and render as a near-black rectangle. Covers from the viewer's
   * own library cannot repeat like that and cannot be wrong, because they ARE the thing behind the label.
   *
   * Everything comes from seriesSrc, so the override-aware genre list, the soft-delete rule, per-library
   * access and the age cap all apply by construction: a viewer restricted to one library sees counts for
   * that library alone, and a genre that exists only in what they cannot open does not appear at all. A
   * count is a disclosure -- "Horror (12)" says twelve horror series exist somewhere -- so this mattering
   * is the reason it is not a separate query.
   *
   * GROUPED CASE-INSENSITIVELY, because `condSql` already filters genres with `lower(g) = lower($n)`.
   * "Slice of life" and "Slice of Life" are one filter, so they must be one tile, or the tile promises a
   * number the grid behind it does not deliver. For the same reason the count is over distinct series
   * rather than over rows: a series carrying both spellings would otherwise be counted twice.
   */
  genreOverview: async (ctx: ViewCtx, covers = 4) => {
    const p = new Params();
    const src = seriesSrc(ctx, p);
    // Bounded here rather than interpolated blindly: it reaches SQL as an identifier position in the slice.
    const n = Math.max(1, Math.min(12, Math.trunc(covers) || 4));
    return q<{ key: string; label: string; series: number; covers: string[] }>(
      `WITH tagged AS (
         SELECT sv.id, sv.title, sv.books_count, sv.latest_mtime, sv.created_at,
                lower(btrim(g)) AS key, btrim(g) AS label
           FROM ${src}, unnest(sv.genres) AS g
          WHERE btrim(g) <> ''
       ),
       one_per_series AS (
         SELECT DISTINCT ON (key, id) key, id, label, title, books_count, latest_mtime, created_at
           FROM tagged ORDER BY key, id, label
       ),
       ranked AS (
         -- Biggest and most recently touched first, so a mosaic shows what is alive in a genre rather
         -- than whatever happens to sort first alphabetically.
         SELECT o.*, row_number() OVER (
                  PARTITION BY key
                  ORDER BY books_count DESC, latest_mtime DESC NULLS LAST, created_at DESC NULLS LAST, title ASC
                ) AS rn
           FROM one_per_series o
       )
       SELECT key,
              -- The spelling the library actually uses most, so the tile is labelled the way its series are.
              mode() WITHIN GROUP (ORDER BY label) AS label,
              count(*)::int AS series,
              coalesce(array_agg(id ORDER BY rn) FILTER (WHERE rn <= ${n}), '{}') AS covers
         FROM ranked
        GROUP BY key
        ORDER BY count(*) DESC, key ASC`,
      p.values as any[],
    );
  },

  genres: async (ctx: ViewCtx) => {
    const p = new Params();
    const src = seriesSrc(ctx, p);
    return (await q<{ g: string }>(`SELECT DISTINCT g FROM ${src}, unnest(genres) AS g ORDER BY g`, p.values as any[]))
      .map((r) => r.g);
  },

  series: async (ctx: ViewCtx, id: string) => {
    const p = new Params();
    const src = seriesSrc(ctx, p);
    const r = await one(`SELECT ${SERIES_COLS} FROM ${src} WHERE id = ${p.add(id)}`, p.values as any[]);
    if (!r) throw Object.assign(new Error('series not found'), { statusCode: 404 });
    return seriesDto(r);
  },

  seriesNew: async (ctx: ViewCtx, pg = 0, size = 20) => {
    const p = new Params();
    const src = seriesSrc(ctx, p);
    const rows = await q(
      `SELECT ${SERIES_COLS} FROM ${src} ORDER BY created_at DESC, title ASC LIMIT ${p.add(size)} OFFSET ${p.add(pg * size)}`,
      p.values as any[],
    );
    return page(rows.map(seriesDto), await total(ctx), pg, size);
  },

  seriesUpdated: async (ctx: ViewCtx, pg = 0, size = 20) => {
    const p = new Params();
    const src = seriesSrc(ctx, p);
    const rows = await q(
      `SELECT ${SERIES_COLS} FROM ${src} ORDER BY latest_mtime DESC, title ASC LIMIT ${p.add(size)} OFFSET ${p.add(pg * size)}`,
      p.values as any[],
    );
    return page(rows.map(seriesDto), await total(ctx), pg, size);
  },

  booksOnDeck: async (_ctx: ViewCtx, _p = 0, size = 20) => page([] as any[], 0, 0, size), // owned: continue-reading is served from read_progress in catalog

  /**
   * Per-user filters and sorts are answered in SQL rather than by filtering the page afterwards:
   * enrichSeries runs after LIMIT/OFFSET, so post-filtering would return short pages, a totalElements that
   * disagrees with them, and an infinite scroll that stops early.
   *
   * MINE_CTE needs the user id as $1, so it is pushed before anything else and the visibility predicate
   * follows. Nothing here counts placeholders by hand.
   */
  searchSeries: async (ctx: ViewCtx, body: any, pg = 0, size = 40, sort?: string) => {
    const wantsUser = !!ctx.userId && (JSON.stringify(body?.condition ?? {}).includes('readStatus') || /unread/i.test(sort || ''));
    const p = new Params();
    const cte = wantsUser ? MINE_CTE : '';
    if (wantsUser) p.add(ctx.userId); // MINE_CTE reads $1
    const src = seriesSrc(ctx, p);
    const from = wantsUser ? `${src} LEFT JOIN mine m ON m.series_id = sv.id` : src;

    let where = body?.condition ? condSql(body.condition, p.values as any[], wantsUser) : 'TRUE';
    if (body?.fullTextSearch) {
      where = `(${where}) AND title ILIKE ${p.add(`%${body.fullTextSearch}%`)}`;
    }
    const t = await total(ctx, where, clone(p), cte, from);
    const rows = await q(
      `${cte} SELECT ${SERIES_COLS} FROM ${from} WHERE ${where} ORDER BY ${sortSql(sort)} LIMIT ${p.add(size)} OFFSET ${p.add(pg * size)}`,
      p.values as any[],
    );
    return page(rows.map(seriesDto), t, pg, size);
  },

  seriesBooks: async (ctx: ViewCtx, id: string, pg = 0, size = 100, sort = 'metadata.numberSort,asc') => {
    const dir = /desc/i.test(sort) ? 'DESC' : 'ASC';
    const ps = new Params();
    const ssrc = seriesSrc(ctx, ps);
    const st = (await one<{ title: string }>(`SELECT title FROM ${ssrc} WHERE id = ${ps.add(id)}`, ps.values as any[]))?.title ?? '';

    const pc = new Params();
    const bsrcCount = booksSrc(ctx, pc);
    const t = (await one<{ c: number }>(
      `SELECT count(*)::int AS c FROM ${bsrcCount} WHERE series_id = ${pc.add(id)}`, pc.values as any[],
    ))?.c ?? 0;

    const p = new Params();
    const bsrc = booksSrc(ctx, p);
    const rows = await q(
      `SELECT * FROM ${bsrc} WHERE series_id = ${p.add(id)} ORDER BY number ${dir}, file ${dir} LIMIT ${p.add(size)} OFFSET ${p.add(pg * size)}`,
      p.values as any[],
    );
    return page(rows.map((r) => bookDto({ ...r, series_title: st })), t, pg, size);
  },

  book: async (ctx: ViewCtx, id: string) => {
    const p = new Params();
    const bsrc = booksSrc(ctx, p, 'b');
    const r = await one(
      `SELECT b.*, ${SERIES_TITLE_SQL} AS series_title FROM ${bsrc} ${SERIES_TITLE_JOIN.replace('%col%', 'b.series_id')} WHERE b.id = ${p.add(id)}`,
      p.values as any[],
    );
    if (!r) throw Object.assign(new Error('book not found'), { statusCode: 404 });
    return bookDto(r);
  },

  bookPages: async (ctx: ViewCtx, id: string) => {
    // Goes through booksSrc so page dimensions cannot enumerate a chapter of a hidden series.
    const p = new Params();
    const bsrc = booksSrc(ctx, p);
    const r = await one<{ file: string; root: string; page_dims: Array<{ name: string; width: number | null; height: number | null }> | null }>(
      `SELECT file, root, page_dims FROM ${bsrc} WHERE id = ${p.add(id)}`,
      p.values as any[],
    );
    if (!r) return [];
    if (Array.isArray(r.page_dims) && r.page_dims.length) {
      return r.page_dims.map((pd, i) => ({ number: i + 1, fileName: pd.name, mediaType: mediaType(pd.name), width: pd.width ?? null, height: pd.height ?? null, sizeBytes: null }));
    }
    const dims = await cbzPageDims(`${r.root || LIBRARY_ROOT}/${r.file}`).catch(() => [] as Array<{ name: string; width: number | null; height: number | null }>);
    if (dims.length) q('UPDATE lib_books SET pages = $1, page_dims = $2 WHERE id = $3', [dims.length, JSON.stringify(dims), id]).catch(() => {});
    return dims.map((pd, i) => ({ number: i + 1, fileName: pd.name, mediaType: mediaType(pd.name), width: pd.width, height: pd.height, sizeBytes: null }));
  },

  // Next/previous compare (number, file) rather than number alone. Two chapters legitimately share a
  // number -- a duplicate that merge deliberately keeps, or a manual renumber -- and comparing the number
  // by itself then makes "next" arbitrary, and can hand back the chapter you are already reading.
  // The tuple matches the ORDER BY number, file used everywhere else, so the reader walks one order.
  bookNext: async (ctx: ViewCtx, id: string) => adjacentBook(ctx, id, 'next'),
  bookPrevious: async (ctx: ViewCtx, id: string) => adjacentBook(ctx, id, 'prev'),

  setReadProgress: async () => {}, // owned: read_progress is the source of truth (no native store to mirror to)

  scanLibrary: async () => { await persistScan(); },

  seriesThumbPath: (id: string) => `/img/lib/series/${encodeURIComponent(id)}/thumb`,
  bookThumbPath: (id: string) => `/img/lib/books/${encodeURIComponent(id)}/thumb`,
  bookPagePath: (id: string, n: number) => `/img/lib/books/${encodeURIComponent(id)}/page/${n}`,
};
