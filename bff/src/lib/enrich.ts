// Per-user state laid over a series DTO: favourite, rating, unread, what is new since you last looked, and
// the cover's dominant colour.
//
// This lived inside routes/catalog.ts, which meant the two rails served from routes/personal.ts -- your
// favourites and the contents of a collection -- returned raw DTOs with none of it. They had no `yomi` block
// and no `color`, so a favourite could not show a rating, could not show what was new, and could not be
// tinted. Nothing announced that; the fields were simply absent and every consumer read undefined.
//
// It also fixes a DTO that was lying. `seriesDto` in lib/ownedCatalog.ts has no user context, so it hardcodes
// booksReadCount 0 / booksUnreadCount = the total / booksInProgressCount 0. Every cover badge in the app reads
// booksUnreadCount, so every badge showed the chapter COUNT rather than how many were unread -- a number that
// never changed no matter how much you read. Those three fields are Komga-shaped and published in
// openapi.yaml, so the fix belongs here, in the one place that knows who is asking, rather than in each of
// the three components that render them.
import type { FastifyRequest } from 'fastify';
import { q } from './db';
import { NATIVE_PROGRESS } from './backend';
import { roleOf, userIdOf } from './auth';
import { autoHeroFor } from './autoHero';
import { effectiveLang } from './seriesLang';
import { browsable, Params, type ViewCtx } from './visibility';
import { noticeBook, noticeHidden, noticesActive } from './noticeChapters';

export async function seriesColors(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await q<{ series_id: string; color: string }>(
    'SELECT series_id, color FROM series_colors WHERE series_id = ANY($1)',
    [ids],
  );
  return new Map(rows.map((r) => [r.series_id, r.color]));
}

/**
 * The chapter count "new since you last looked" is kept in (series_seen.seen_books_count): every chapter row,
 * lib_series.books_count, the notice chapters an admin hides included (lib/noticeChapters.ts) -- where `booksCount`
 * leaves those out. booksCount moves when a switch flips or a notice's pages get counted, and nobody read anything
 * new: kept in it, a hide switched on swallowed the next real chapters of every favourite (the seen count stood
 * above the count left), and one switched off announced every old notice as new. The same as booksCount while
 * nothing hides, so nothing is asked then. Either way the count is what each series' row says when there is none.
 * Reintroduce by keeping booksCount: "Updates count real chapters across a switch" in noticeSurfaces.int.test.ts
 * finds the favourite gone from Updates after a new chapter.
 */
export async function seenCounts(list: Array<{ id: string; booksCount?: number }>): Promise<Map<string, number>> {
  const out = new Map(list.map((s) => [s.id, s.booksCount ?? 0]));
  if (!noticesActive() || !list.length) return out;
  const rows = await q<{ id: string; n: number }>('SELECT id, books_count AS n FROM lib_series WHERE id = ANY($1)', [list.map((s) => s.id)]);
  for (const r of rows) out.set(r.id, Number(r.n));
  return out;
}

/**
 * How many chapters came since this reader last looked, for each series they have looked at (`seen`, from
 * seriesSeen): the rows above the count they saw, `counts` (seenCounts). While nothing hides, simply the difference,
 * as it always was. Otherwise the newest that many rows by number, less every hidden notice among them -- so a
 * notice that arrived uncounted and turned out to be two pages stops being new, and an old notice a switch shows
 * again never was.
 */
export async function newSinceSeen(seen: Map<string, number>, counts: Map<string, number>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const due: Array<[string, number]> = [];
  for (const [id, was] of seen) {
    const now = counts.get(id);
    if (now === undefined) continue;
    const fresh = Math.max(0, now - was);
    out.set(id, fresh);
    if (fresh > 0) due.push([id, fresh]);
  }
  if (!noticesActive() || !due.length) return out;
  const rows = await q<{ id: string; n: number }>(
    `SELECT k.id, count(*) FILTER (WHERE NOT t.hidden)::int AS n
       FROM unnest($1::text[], $2::int[]) AS k(id, fresh)
       CROSS JOIN LATERAL (
         SELECT ${noticeHidden('s', 'b', 'COALESCE(ov.number, b.number)')} AS hidden
           FROM lib_books b JOIN lib_series s ON s.id = b.series_id LEFT JOIN book_overrides ov ON ov.book_id = b.id
          WHERE b.series_id = k.id
          ORDER BY COALESCE(ov.number, b.number) DESC, b.file DESC
          LIMIT k.fresh
       ) t
      GROUP BY k.id`,
    [due.map(([id]) => id), due.map(([, n]) => n)],
  ).catch(() => null);
  for (const r of rows ?? []) out.set(r.id, Number(r.n));
  return out;
}

export async function seriesSeen(userId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await q<{ series_id: string; seen_books_count: number }>(
    'SELECT series_id, seen_books_count FROM series_seen WHERE user_id = $1 AND series_id = ANY($2)',
    [userId, ids],
  );
  return new Map(rows.map((r) => [r.series_id, r.seen_books_count]));
}

/**
 * How many chapters of each series this user has finished, and how many they are part-way through.
 *
 * One grouped query rather than two: `read_progress` holds a row per opened chapter with a `completed` flag,
 * so both numbers come from the same scan.
 */
async function seriesProgress(userId: string, seriesIds: string[]): Promise<Map<string, { done: number; started: number }>> {
  if (!seriesIds.length) return new Map();
  const rows = await q<{ series_id: string; done: number; started: number }>(
    `SELECT series_id,
            count(*) FILTER (WHERE completed)::int      AS done,
            count(*) FILTER (WHERE NOT completed)::int  AS started
       FROM read_progress
      WHERE user_id = $1 AND series_id = ANY($2)
        -- A hidden notice chapter (lib/noticeChapters.ts) is out of the total these are laid against, so out of
        -- these too, or one read notice would cover for an unread chapter.
        AND NOT ${noticeBook('read_progress.book_id')}
      GROUP BY series_id`,
    [userId, seriesIds],
  );
  return new Map(rows.map((r) => [r.series_id, { done: r.done, started: r.started }]));
}

/**
 * The languages of each listed work this viewer may browse (v0.52.0, #72): the Library card's `EN · ES-419`
 * caption. One query for every row that is an edition, through browsable() with the request's viewer -- a sibling
 * in a library they were not granted, above their age cap or tidied away by the 18+ switch is not named, and a work
 * of which they may browse one edition reads as a plain series (no entry). Oldest edition first, as the series page
 * lists them. Nothing without a viewer: the caption is per person.
 */
async function editionLangs(list: any[], ctx: ViewCtx | undefined): Promise<Map<string, string[]>> {
  const works = [...new Set(list.map((s) => s.workId).filter((w): w is string => typeof w === 'string' && !!w))];
  if (!works.length || !ctx) return new Map();
  const p = new Params();
  const arr = p.add(works);
  const rows = await q<{ work_id: string; lang: string | null; source_id: string | null }>(
    `SELECT s.work_id, s.lang, s.source_id FROM lib_series s
      WHERE s.work_id = ANY(${arr}::uuid[]) AND ${browsable('s', ctx, p)} ORDER BY s.created_at, s.id`,
    p.values as any[],
  ).catch(() => [] as Array<{ work_id: string; lang: string | null; source_id: string | null }>);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const langs = out.get(r.work_id) ?? [];
    const lang = effectiveLang(r.lang, r.source_id);
    if (!langs.includes(lang)) langs.push(lang);
    out.set(r.work_id, langs);
  }
  return out;
}

export async function enrichSeries(req: FastifyRequest, list: any[]): Promise<any[]> {
  if (!list?.length) return list ?? [];
  const userId = userIdOf(req);
  // Only a Komga backend reports real per-user counts of its own; in owned mode NATIVE_PROGRESS is false, so
  // admins take the computed path like everyone else.
  const admin = NATIVE_PROGRESS && roleOf(req) === 'admin';
  const favs = new Set(
    (await q<{ series_id: string }>('SELECT series_id FROM favorites WHERE user_id = $1', [userId])).map((r) => r.series_id),
  );
  const ratings = new Map(
    (await q<{ series_id: string; stars: number }>('SELECT series_id, stars FROM ratings WHERE user_id = $1', [userId])).map(
      (r) => [r.series_id, r.stars],
    ),
  );
  const progress = admin ? null : await seriesProgress(userId, list.map((s) => s.id));
  const colors = await seriesColors(list.map((s) => s.id));
  const seen = await seriesSeen(userId, list.map((s) => s.id));
  const fresh = await newSinceSeen(seen, await seenCounts(list));
  const heroes = await autoHeroFor(list.map((s) => s.id));
  const editions = await editionLangs(list, (req as any).viewCtx as ViewCtx | undefined);
  return list.map((s) => {
    const p = progress?.get(s.id);
    const total = s.booksCount ?? 0;
    const done = p?.done ?? 0;
    const unread = admin ? (s.booksUnreadCount ?? 0) : Math.max(0, total - done);
    return {
      ...s,
      // The three Komga-shaped counts, corrected. seriesDto cannot fill these in -- it has no user -- so it
      // ships placeholders, and every one of them was wrong for every reader.
      ...(admin ? {} : { booksReadCount: done, booksUnreadCount: unread, booksInProgressCount: p?.started ?? 0 }),
      color: colors.get(s.id) ?? null,
      // v0.51.0: the banner made from its own pages (lib/autoHero.ts), for a series with no banner of its own; null
      // when it has one or may not have one. The web shows /img/series/:id/hero?v=<seed> in its hero.
      autoHero: heroes.get(s.id) ?? null,
      // v0.52.0: the languages of this work the viewer may browse, when that is more than this one series.
      edition: (editions.get(s.workId)?.length ?? 0) > 1 ? { langs: editions.get(s.workId)! } : null,
      yomi: {
        favorite: favs.has(s.id),
        rating: ratings.get(s.id) ?? null,
        // Kept alongside booksUnreadCount even though they now agree: it is a shipped field, and removing it
        // would break any client reading it for nothing.
        unread,
        newCount: fresh.get(s.id) ?? 0,
      },
    };
  });
}
