// Language editions of one work (v0.52.0, #72): Blue Lock in English and Blue Lock in Spanish as two series, each
// with its own folder, sources, chapters and reading progress, linked by lib_series.work_id so the Library shows
// one card for both, the series page and the reader switch between them, and a Komga or OPDS client can tell them
// apart. Every row in a work states its language (lib_series.lang), and a work holds one row per language: the
// partial unique index on (work_id, lang) in migrate.ts, which a removed edition keeps its slot in, so Put back
// can never collide.
//
// Grouping lives at the edges and only there: the add path links an edition here, the Library collapses a work to
// one card (ownedCatalog.ts searchSeries), the series page and the reader read editionInfo, Komga and OPDS suffix
// titles with editionLabels, and merge, forget and unlink dissolve a work left with a single edition. Everything
// else -- the listing, numbering, follows, the sweep, Health's per-series checks -- is per series, as it always was.
//
// ⚠️ A work of one is harmless and v0.51.0 can leave one behind (it never clears work_id on a merge or forget):
// every reader here treats "no live sibling" as standalone.
import { randomUUID } from 'node:crypto';
import { q, tx } from './db';
import { sanitize } from './downloader';
import { canonLang, langLabel } from './lang';
import { effectiveLang, followGuard } from './seriesLang';
import { Params, visible, type ViewCtx } from './visibility';

/** The module's q, or a transaction's own (db.ts tx). */
type Qq = <R = any>(text: string, params?: any[]) => Promise<R[]>;

/**
 * An edition's folder: `MangaDex (ES-419)/Blue Lock (ES-419)`. The code after the title, so it never collides with
 * the original's folder -- not even when one multi-language source serves both -- and it is deterministic, so adding
 * the same edition again finds its own folder and answers "already in library". Komga or Kavita reading the same disk
 * see two series they can tell apart. Appended AFTER sanitize, whose 150-character cut would otherwise be free to
 * take the suffix off a long title; 135 leaves the code its room. The original edition's folder is never renamed.
 */
export function editionFolder(srcDir: string, title: string, lang: string): string {
  return `${srcDir}/${sanitize(title).slice(0, 135).trimEnd()} (${langLabel(lang)})`;
}

export interface Linked { workId: string; lang: string }

/**
 * Make `seriesId` the `lang` edition of `of`'s work, starting the work when `of` has none. One transaction with `of`
 * locked, so two editions added at once cannot both start a work. `of` states its language on the way in -- every
 * row in a work does: its own when stated, else `ofLang` (the add dialog's "The copy you have is in"), else what it
 * is inferred to be. The work's tracker links are copied to the new edition (both are the same AniList or MyAnimeList
 * entry, so progress syncs from whichever is read; lib/trackers.ts pushOne keeps one entry from going backwards), and
 * so is the 18+ rating an admin set, or a capped account could reach the Spanish copy of an 18+ work.
 *
 * 'taken' when the language already has its edition in the work -- the unique index, which is how a race between two
 * adds of one language ends: the second series stays a series of its own, and its job card says so. 'gone' when `of`
 * was merged away or removed meanwhile. A series moved here from another work leaves that one dissolved if it was the
 * other's last companion.
 */
export async function linkEdition(seriesId: string, opts: { of: string; lang: string; ofLang?: string | null }): Promise<Linked | 'taken' | 'gone'> {
  const lang = canonLang(opts.lang);
  if (!lang || seriesId === opts.of) return 'gone';
  try {
    return await tx(async (qq) => {
      const [o] = await qq<{ lang: string | null; work_id: string | null; source_id: string | null; deleted_at: string | null; merged_into: string | null }>(
        'SELECT lang, work_id, source_id, deleted_at, merged_into FROM lib_series WHERE id = $1 FOR UPDATE', [opts.of]);
      const [s] = await qq<{ work_id: string | null }>('SELECT work_id FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
      if (!o || !s || o.merged_into || o.deleted_at) return 'gone' as const;
      const workId = o.work_id ?? randomUUID();
      const ofLang = canonLang(o.lang) ?? canonLang(opts.ofLang) ?? effectiveLang(null, o.source_id);
      await qq('UPDATE lib_series SET work_id = $2, lang = $3 WHERE id = $1', [opts.of, workId, ofLang]);
      await qq('UPDATE lib_series SET work_id = $2, lang = $3 WHERE id = $1', [seriesId, workId, lang]);
      if (s.work_id && s.work_id !== workId) await dissolveLoneWork(qq, s.work_id);
      await qq(
        `INSERT INTO series_trackers (series_id, provider, external_id, title, linked_by)
         SELECT $2, provider, external_id, title, linked_by FROM series_trackers WHERE series_id = $1
         ON CONFLICT (series_id, provider) DO NOTHING`,
        [opts.of, seriesId],
      );
      await copyRating(qq, opts.of, [seriesId]);
      return { workId, lang };
    });
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') return 'taken';
    throw e;
  }
}

/**
 * The 18+ rating an admin set on `from` (series_overrides.age_rating and adult_exempt), onto `to`. Only what was set:
 * a sibling's own override for a field `from` leaves blank stays. The meta PUT writes the same thing over the whole
 * work (routes/admin.ts), so the rating can never differ between two editions of one work.
 */
export async function copyRating(qq: Qq, from: string, to: string[]): Promise<void> {
  if (!to.length) return;
  await qq(
    `INSERT INTO series_overrides (series_id, age_rating, adult_exempt)
     SELECT t, o.age_rating, o.adult_exempt FROM series_overrides o, unnest($2::text[]) AS t
      WHERE o.series_id = $1 AND (o.age_rating IS NOT NULL OR o.adult_exempt IS NOT NULL)
     ON CONFLICT (series_id) DO UPDATE SET
       age_rating = COALESCE(EXCLUDED.age_rating, series_overrides.age_rating),
       adult_exempt = COALESCE(EXCLUDED.adult_exempt, series_overrides.adult_exempt),
       updated_at = now()`,
    [from, to],
  );
}

/** Take a series out of its work: it stays in the library on its own, chapters, sources and progress kept. */
export async function unlinkEdition(seriesId: string): Promise<{ workId: string } | null> {
  return tx(async (qq) => {
    const [s] = await qq<{ work_id: string | null }>('SELECT work_id FROM lib_series WHERE id = $1 FOR UPDATE', [seriesId]);
    if (!s?.work_id) return null;
    await qq('UPDATE lib_series SET work_id = NULL WHERE id = $1', [seriesId]);
    await dissolveLoneWork(qq, s.work_id);
    return { workId: s.work_id };
  });
}

/**
 * A work left with one edition is no work: its last row goes back to standing alone, so nothing labels it "(EN)"
 * beside a sibling that is not there. A removed edition still counts -- it holds its slot until it is forgotten --
 * and a row merged into another never does. Run by unlink, merge and forget in their own transactions.
 */
export async function dissolveLoneWork(qq: Qq, workId: string | null | undefined): Promise<void> {
  if (!workId) return;
  await qq(
    `UPDATE lib_series SET work_id = NULL
      WHERE work_id = $1 AND (SELECT count(*) FROM lib_series w WHERE w.work_id = $1 AND w.merged_into IS NULL) <= 1`,
    [workId],
  );
}

export interface EditionRow {
  seriesId: string;
  lang: string;
  title: string;
  booksCount: number;
  /** The edition the request is about. */
  current: boolean;
  /** The viewer's highest finished chapter in this edition, or null: the switcher's "Español · ch. 12". */
  lastRead: number | null;
}

/**
 * The editions of `id`'s work this viewer may open (visible(): a removed edition, one in a library they were not
 * granted and one above their age cap are left out), oldest first. Null for a series on its own -- and for one whose
 * every sibling is out of the viewer's sight: a viewer who can open one edition sees a plain series.
 */
export async function editionInfo(id: string, ctx: ViewCtx, userId: string | null): Promise<{ workId: string; editions: EditionRow[] } | null> {
  const p = new Params();
  const me = p.add(id);
  const uid = p.add(userId);
  const rows = await q<{ id: string; work_id: string; lang: string | null; source_id: string | null; title: string; books_count: number | null; last_read: number | null }>(
    `SELECT s.id, s.work_id, s.lang, s.source_id, COALESCE(o.title, s.title) AS title, s.books_count,
            (SELECT max(COALESCE(ov.number, b.number)) FROM read_progress rp
               JOIN lib_books b ON b.id = rp.book_id LEFT JOIN book_overrides ov ON ov.book_id = b.id
              WHERE rp.user_id = ${uid} AND rp.series_id = s.id AND rp.completed) AS last_read
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.work_id = (SELECT w.work_id FROM lib_series w WHERE w.id = ${me}) AND ${visible('s', ctx, p)}
      ORDER BY s.created_at, s.id`,
    p.values as any[],
  );
  if (rows.length < 2 || !rows.some((r) => r.id === id)) return null;
  return {
    workId: rows[0].work_id,
    editions: rows.map((r) => ({
      seriesId: r.id, lang: effectiveLang(r.lang, r.source_id), title: r.title, booksCount: r.books_count ?? 0,
      current: r.id === id, lastRead: r.last_read == null ? null : Number(r.last_read),
    })),
  };
}

/**
 * The edition of `id`'s work that may follow `sourceId` (v0.52.0, where #123's guard meets #72's editions): a follow
 * refused for its language points there when the work holds that language already -- "Add it as an edition" would
 * only end on "already in your library". The oldest edition this viewer may open (visible()) whose own guard passes
 * the source; null when there is none, and the refusal offers the edition to add instead.
 */
export async function editionFollowing(id: string, sourceId: string, ctx: ViewCtx): Promise<{ id: string; lang: string } | null> {
  const p = new Params();
  const me = p.add(id);
  const rows = await q<{ id: string; lang: string | null; source_id: string | null }>(
    `SELECT s.id, s.lang, s.source_id FROM lib_series s
      WHERE s.work_id = (SELECT w.work_id FROM lib_series w WHERE w.id = ${me}) AND s.id <> ${me} AND ${visible('s', ctx, p)}
      ORDER BY s.created_at, s.id`,
    p.values as any[],
  );
  for (const r of rows) {
    if ((await followGuard(r.id))(sourceId)) return { id: r.id, lang: effectiveLang(r.lang, r.source_id) };
  }
  return null;
}

/**
 * " (ES-419)" for each of these series that has a sibling edition this viewer may open, for the titles a Komga or
 * OPDS client shows: two series named "Blue Lock" in Mihon are one too many to tell apart. Nothing for a series on
 * its own, or whose sibling the viewer cannot see. One query for a page of series.
 */
export async function editionLabels(ids: readonly string[], ctx: ViewCtx): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const p = new Params();
  const arr = p.add(list);
  const rows = await q<{ id: string; lang: string | null; source_id: string | null }>(
    `SELECT s.id, s.lang, s.source_id FROM lib_series s
      WHERE s.id = ANY(${arr}) AND s.work_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM lib_series o WHERE o.work_id = s.work_id AND o.id <> s.id AND ${visible('o', ctx, p)})`,
    p.values as any[],
  ).catch(() => [] as Array<{ id: string; lang: string | null; source_id: string | null }>);
  const out = new Map<string, string>();
  for (const r of rows) {
    const label = langLabel(effectiveLang(r.lang, r.source_id));
    if (label) out.set(r.id, ` (${label})`);
  }
  return out;
}

/** A series and the other rows of its work, as the add path and the admin link route weigh a new edition against them. */
export interface WorkRow { id: string; title: string; lang: string; stated: boolean; hidden: boolean }

/**
 * `id` and every other row of its work that is not merged away, removed ones included (they keep their slot), each
 * with its language: stated, else inferred. Visible to all, not to a viewer: whether a language is taken is a fact
 * about the library, as the add path's duplicate check is.
 */
export async function workRows(id: string, qq: Qq = q): Promise<WorkRow[]> {
  const rows = await qq<{ id: string; title: string; lang: string | null; source_id: string | null; hidden: boolean }>(
    `SELECT s.id, COALESCE(o.title, s.title) AS title, s.lang, s.source_id, (s.deleted_at IS NOT NULL) AS hidden
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.merged_into IS NULL
        AND (s.id = $1 OR (s.work_id IS NOT NULL AND s.work_id = (SELECT w.work_id FROM lib_series w WHERE w.id = $1)))
      ORDER BY s.created_at, s.id`,
    [id],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, lang: effectiveLang(r.lang, r.source_id), stated: canonLang(r.lang) !== null, hidden: r.hidden }));
}

/** Why two series could not be linked as editions (linkPair). The admin route answers each with its own status. */
export type LinkPairRefusal = 'not_found' | 'deleted' | 'same_series' | 'same_work' | 'other_work' | 'same_lang' | 'edition_exists';

/**
 * Link two series already in the library as language editions of one work: POST /api/admin/series/:id/editions and, since
 * v0.55.0, Fix everything's duplicates phase (lib/autofix.ts) on a duplicate pair in two languages. `lang` states `id`'s
 * language and `withLang` `withId`'s, each where the series does not state one (otherwise what it is inferred to be). A
 * series already in a work brings the work: the other joins it. Refused when both are in one language (merge them
 * instead), when the language is taken in the work, and when each is already in a different work. `joiner` and `of` say
 * which joined which, for the audit line.
 */
export async function linkPair(
  id: string, withId: string, o: { lang?: string; withLang?: string } = {},
): Promise<{ ok: true; workId: string; lang: string; joiner: WorkRow; of: WorkRow } | { refused: LinkPairRefusal }> {
  if (withId === id) return { refused: 'same_series' };
  const [mine, theirs] = await Promise.all([workRows(id), workRows(withId)]);
  const a = mine.find((r) => r.id === id);
  const w = theirs.find((r) => r.id === withId);
  if (!a || !w) return { refused: 'not_found' };
  if (a.hidden || w.hidden) return { refused: 'deleted' };
  if (mine.length > 1 && theirs.length > 1) return { refused: mine.some((r) => r.id === w.id) ? 'same_work' : 'other_work' };
  // What each will state: the language asked for where the series states none, else its own.
  const langA = a.stated ? a.lang : canonLang(o.lang) ?? a.lang;
  const langW = w.stated ? w.lang : canonLang(o.withLang) ?? w.lang;
  if (langA === langW) return { refused: 'same_lang' };
  // The one in a work stays where it is and the other joins it.
  const [joiner, of, joinerLang, ofLang] = mine.length > 1 ? [w, a, langW, langA] : [a, w, langA, langW];
  const taken = (mine.length > 1 ? mine : theirs).find((r) => r.id !== of.id && r.lang === joinerLang);
  if (taken) return { refused: 'edition_exists' };
  const r = await linkEdition(joiner.id, { of: of.id, lang: joinerLang, ofLang });
  if (r === 'taken') return { refused: 'edition_exists' };
  if (r === 'gone') return { refused: 'not_found' };
  return { ok: true, workId: r.workId, lang: r.lang, joiner, of };
}
