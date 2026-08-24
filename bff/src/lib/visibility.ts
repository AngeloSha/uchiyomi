// What a given viewer is allowed to see, in one place.
//
// The two invariants every series read has to satisfy -- not deleted, not merged away -- were hand-copied
// into 23 query strings across 10 files, and STILL never reached the route that serves actual bytes:
// GET /img/lib/books/:id/page/:n resolved a file path from a book id with no series join at all, so a
// hidden series' pages have always been readable by anyone holding the id. BOOKS_SRC likewise contained
// zero references to lib_series, so a book id bypassed every series-level rule and next/previous then
// walked the whole thing.
//
// That duplication is the measure of the risk. Per-library access does not get to become a 24th copy: it is
// one more clause on `visible()`, and every caller inherits it because they all go through here.
import { q, one } from './db';

export interface ViewCtx {
  /** null only for background work that legitimately sees everything: the scanner, the hero pre-warmer. */
  readonly userId: string | null;
  /**
   * null means every library. A list means exactly these.
   *
   * An empty list is a real (if unusual) admin choice meaning "nothing", so it must never be produced by a
   * `|| []` fallback -- that would turn a lookup failure into a silent lockout instead of an error.
   */
  readonly libraryIds: readonly string[] | null;
  /**
   * The highest age rating this viewer may see, or null for no cap.
   *
   * null means unrestricted, exactly as `libraryIds: null` means every library, so the two restrictions read
   * the same way and an account with neither set behaves as it always did.
   */
  readonly maxAgeRating: number | null;
  /**
   * Keep libraries rated 18+ off browsing surfaces for this request.
   *
   * A SURFACING filter, not a permission -- `maxAgeRating` is the permission and is unaffected. It answers
   * "do not put this on my home screen unasked", so it is applied by `browsable()` to things that LIST
   * series and never by `visible()`, which also gates page bytes, chapter navigation, the offline manifest
   * and reading-progress writes. Hiding those would lose data rather than tidy a screen.
   *
   * `false` emits no clause at all, which matters twice over: it is what `SYSTEM_CTX` uses, and it is what
   * an older ViewCtx literal degrades to, so nothing silently starts filtering.
   */
  readonly hideAdultLibraries: boolean;
}

/**
 * Positional parameters that no call site ever has to count.
 *
 * condSql() already pushes its own params as it walks a condition tree, so once visibility pushes too, a
 * hand-written `$1` is a silently-wrong-row bug rather than a syntax error. Handing out the placeholder at
 * push time makes that impossible.
 */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** The predicate. `alias` is the lib_series alias in the query being built. */
export function visible(alias: string, ctx: ViewCtx, p: Params): string {
  const parts = [`${alias}.deleted_at IS NULL`, `${alias}.merged_into IS NULL`];
  if (ctx.libraryIds) parts.push(`${alias}.library_id = ANY(${p.add([...ctx.libraryIds])})`);
  if (ctx.maxAgeRating !== null) {
    // The admin's override wins over what the scan read, like every other piece of series metadata. This is
    // a correlated subquery rather than a join because `visible()` is applied wherever `lib_series` appears
    // -- including booksSrc, which joins it with no access to series_overrides. Only a capped account pays
    // for it, and an unrestricted one adds no clause at all.
    // Series override beats what the scan read, which beats the library's own rating. That last step is
    // what makes ratings usable: marking one library 18+ covers everything in it, and a single title inside
    // it can still be let through by rating it lower.
    const eff = `COALESCE(
      (SELECT o2.age_rating FROM series_overrides o2 WHERE o2.series_id = ${alias}.id),
      ${alias}.age_rating,
      (SELECT l2.age_rating FROM libraries l2 WHERE l2.id = ${alias}.library_id))`;
    // Unrated stays visible on purpose. Treating NULL as adults-only would empty most libraries the first
    // time anyone set a cap, and a parent would reasonably read that as the app being broken.
    parts.push(`(${eff} IS NULL OR ${eff} <= ${p.add(ctx.maxAgeRating)})`);
  }
  return parts.join(' AND ');
}

/**
 * Sees everything. Named so it is obvious in a diff and greppable in review.
 *
 * Legitimate users are background work with no viewer: the scanner, the fingerprint backfill, the hero
 * pre-warmer (whose id list already came from a user-filtered endpoint), and health checks that are
 * reporting on the library as a whole. It must never be reachable from a request handler.
 */
/**
 * The grant row that means "no libraries at all".
 *
 * `user_libraries` having no rows means EVERY library. That is deliberate and load-bearing on upgrade -- it
 * is why nobody was locked out when per-library access shipped -- but it left "nothing" with no
 * representation, and every path that could remove a member's last grant therefore handed them the whole
 * collection instead: unticking their last library, revoking them from it in the library's own Access
 * dialog, or just deleting that library. Three different ways to widen access, all silent.
 *
 * No library can have this id (they are `lib` or `lib_<hex>`), so `library_id = ANY(...)` matches nothing
 * while the row count stays non-zero. That is exactly "restricted, to nothing", said in the existing shape.
 */
export const NO_LIBRARIES = '';

export const SYSTEM_CTX: ViewCtx = {
  userId: null, libraryIds: null, maxAgeRating: null,
  // Background work and admin reporting count what is there, not what someone wants on screen.
  hideAdultLibraries: false,
};

/**
 * The predicate for anything that LISTS series: `visible()`, plus the 18+ hide.
 *
 * Deliberately separate from `visible()` rather than folded into it. `visible()` is also the gate on page
 * bytes, the chapter list, next/previous, the offline download manifest, OPDS file downloads and the
 * progress write path -- and none of those can see a browser session. The service worker flushes reading
 * progress with the app closed; an `<img>` cannot carry the signal; an OPDS reader has no button to press.
 * Hiding a series from a home rail is tidying. Refusing to record that someone read it is data loss.
 *
 * So: listings call this, by-id resolvers call `visible()`, and the split is the whole design.
 */
export function browsable(alias: string, ctx: ViewCtx, p: Params): string {
  const base = visible(alias, ctx, p);
  if (!ctx.hideAdultLibraries) return base;
  // NO p.add() here, on purpose. `visibleToAll()` throws its Params away (see below) and 25 call sites
  // interpolate the result into queries whose parameter arrays are hand-written, so a bound parameter would
  // emit a `$N` nothing ever binds -- and `q()` would either throw or, worse, collide with the caller's own
  // $1. ADULT_RATING is a code constant, never user input, so interpolating it is safe.
  return `${base} AND NOT EXISTS (
    SELECT 1 FROM libraries l_ad WHERE l_ad.id = ${alias}.library_id AND l_ad.age_rating >= ${ADULT_RATING})`;
}

/**
 * Does this request want 18+ libraries kept off its listings?
 *
 * Carried as a query parameter rather than a header or a cookie, for one concrete reason: the service
 * worker caches `/api/` responses with `networkFirst`, and the Cache API keys by URL with NO `Vary`. A
 * header would leave a revealed `/api/home` stored under the same URL as an unrevealed one and replayed to
 * it the first time the network hiccups. A different URL is a different cache entry, for free.
 *
 * Absent means hidden. That is the default for anything that cannot ask -- an OPDS reader, a bare curl --
 * and it is the right default: a client that does not know about the filter should not defeat it.
 */
export const hideAdult = (req: { query?: unknown }): boolean =>
  (req.query as { adult?: string } | undefined)?.adult !== '1';

/**
 * Which of these series ids may be listed to this viewer.
 *
 * Several rails do not build one query over `lib_series` -- they collect ids from somewhere else (reading
 * history, favourites, a collection, AniList) and then resolve each one. Those cannot inherit `browsable()`,
 * and resolving-then-filtering is also why some rails silently came back short: the LIMIT ran before the
 * filter did. One round trip, applied to the id list BEFORE the limit.
 */
export async function browsableIds(ids: readonly string[], ctx: ViewCtx): Promise<Set<string>> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  const p = new Params();
  const arr = p.add(list);
  const rows = await q<{ id: string }>(
    `SELECT s.id FROM lib_series s WHERE s.id = ANY(${arr}) AND ${browsable('s', ctx, p)}`,
    p.values as any[],
  ).catch(() => [] as Array<{ id: string }>);
  return new Set(rows.map((r) => r.id));
}

/**
 * The predicate for queries that legitimately span every library: the scanner, the updater sweep, health
 * checks, admin reporting. Still respects soft delete and merge, so it is NOT "no filter" -- it is "every
 * library, and nothing that was hidden".
 *
 * Adds no parameters, so converting an existing hand-written copy to this cannot renumber anything.
 */
export const visibleToAll = (alias: string): string => visible(alias, SYSTEM_CTX, new Params());


/**
 * The age at which adult content stops being withheld, and the top of the rating scale the admin UI offers
 * (`z.number().int().min(0).max(18)` in three places in admin.ts).
 */
export const ADULT_RATING = 18;

/**
 * May this viewer reach this source at all?
 *
 * `visible()` answers the same question for a series already in the library, using a rating on the row. A
 * source has no rows yet -- the whole point of Discover is that nothing has been added -- so the only signal
 * is the adult flag its extension declares, and the only sane reading of it is all-or-nothing: an adult
 * source's newest page is twenty-four adult covers.
 *
 * Structurally typed rather than taking a `SourceAdapter` so the visibility module keeps depending on
 * nothing, exactly as `visible()` does.
 *
 * Undefined `isNsfw` means allowed, matching `visible()`'s rule about unrated content: only Suwayomi tells
 * us anything, and treating every built-in and custom site as adult would empty Discover for a capped
 * account rather than filter it.
 */
export function sourceAllowedFor(src: { isNsfw?: boolean } | null | undefined, maxAgeRating: number | null): boolean {
  if (!src?.isNsfw) return true;
  return maxAgeRating === null || maxAgeRating >= ADULT_RATING;
}

/**
 * The viewer for one request.
 *
 * Called once per handler. Everything downstream -- every SQL source, the image server, OPDS -- inherits
 * whatever this returns, which is the point: there is one decision, in one place, rather than a predicate
 * each route has to remember.
 *
 * Admins are unrestricted, always, and any grant rows for an admin are ignored. Otherwise the same class of
 * bug as "the last admin disables themselves" reappears here, with a worse recovery story.
 *
 * No grant rows means every library, NOT none. Seeding a row per user per library on migration has a worse
 * failure mode: a seed that half-runs locks people out of everything, whereas this one's failure mode is
 * "sees exactly what they saw yesterday". It is also why the empty list must never come from a `|| []`.
 */
export async function viewCtxFor(
  userId: string | null,
  role?: string,
  /**
   * Per-request browsing options. `hideAdult` is the 18+ surfacing filter and is deliberately OUTSIDE the
   * admin short-circuit below: an admin is exempt from the age CAP because that is a permission, but they
   * asked for a tidy home screen like everyone else.
   */
  opts?: { hideAdult?: boolean },
): Promise<ViewCtx> {
  const hideAdultLibraries = !!opts?.hideAdult;
  // Komga mode has its own libraries and its own restrictions, enforced by Komga. Do not pretend to enforce
  // a model this backend does not have.
  if (process.env.LIBRARY_BACKEND !== 'owned') return { userId, libraryIds: null, maxAgeRating: null, hideAdultLibraries: false };
  if (!userId || role === 'admin') return { userId, libraryIds: null, maxAgeRating: null, hideAdultLibraries };
  const [rows, cap] = await Promise.all([
    q<{ library_id: string }>('SELECT library_id FROM user_libraries WHERE user_id = $1', [userId])
      .catch(() => [] as Array<{ library_id: string }>),
    one<{ max_age_rating: number | null }>('SELECT max_age_rating FROM users WHERE id = $1', [userId])
      .catch(() => null),
  ]);
  return {
    userId,
    libraryIds: rows.length ? rows.map((r) => r.library_id) : null,
    maxAgeRating: cap?.max_age_rating ?? null,
    hideAdultLibraries,
  };
}

/**
 * The absolute path of a chapter file, but only if this viewer may see its series.
 *
 * The image server's helper was `SELECT file, root FROM lib_books WHERE id = $1` with no series join and no
 * visibility check at all, so a book id alone yielded raw page bytes -- including for a series that had been
 * deleted. OPDS's file download had the same shape. One resolver now guards both.
 *
 * Returns null when the book does not exist OR the viewer may not see it. The caller must not distinguish
 * the two: "no such chapter" and "not yours" should look identical from outside.
 */
export async function visibleBookFile(bookId: string, ctx: ViewCtx): Promise<{ file: string; root: string } | null> {
  const p = new Params();
  const id = p.add(bookId);
  return (await one<{ file: string; root: string }>(
    `SELECT b.file, b.root FROM lib_books b
       JOIN lib_series s ON s.id = b.series_id
      WHERE b.id = ${id} AND ${visible('s', ctx, p)}`,
    p.values as any[],
  )) ?? null;
}

/** The same question for a series id: may this viewer see it at all? */
export async function seriesVisible(seriesId: string, ctx: ViewCtx): Promise<boolean> {
  const p = new Params();
  const id = p.add(seriesId);
  const r = await one<{ id: string }>(
    `SELECT s.id FROM lib_series s WHERE s.id = ${id} AND ${visible('s', ctx, p)}`,
    p.values as any[],
  );
  return !!r;
}
