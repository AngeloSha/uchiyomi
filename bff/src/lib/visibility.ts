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
import { sep, resolve } from 'path';
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
  return parts.join(' AND ');
}

/**
 * Sees everything. Named so it is obvious in a diff and greppable in review.
 *
 * Legitimate users are background work with no viewer: the scanner, the fingerprint backfill, the hero
 * pre-warmer (whose id list already came from a user-filtered endpoint), and health checks that are
 * reporting on the library as a whole. It must never be reachable from a request handler.
 */
export const SYSTEM_CTX: ViewCtx = { userId: null, libraryIds: null };

/**
 * The predicate for queries that legitimately span every library: the scanner, the updater sweep, health
 * checks, admin reporting. Still respects soft delete and merge, so it is NOT "no filter" -- it is "every
 * library, and nothing that was hidden".
 *
 * Adds no parameters, so converting an existing hand-written copy to this cannot renumber anything.
 */
export const visibleToAll = (alias: string): string => visible(alias, SYSTEM_CTX, new Params());

/**
 * Resolve `rel` under `root` and refuse anything that escapes it.
 *
 * There is no path-containment check anywhere in this codebase today, and sanitize() in the downloader
 * strips path separators but lets `..` through as a whole segment -- sanitize.test.ts records that as an
 * asserted behaviour. Every filesystem write added from here on goes through this.
 *
 * Returns the resolved absolute path, or null if it escapes. Callers treat null as a refusal, never as a
 * reason to fall back to the raw input.
 */
export function containedPath(root: string, rel: string): string | null {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full === base || full.startsWith(base + sep) ? full : null;
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
export async function viewCtxFor(userId: string | null, role?: string): Promise<ViewCtx> {
  // Komga mode has its own libraries and its own restrictions, enforced by Komga. Do not pretend to enforce
  // a model this backend does not have.
  if (process.env.LIBRARY_BACKEND !== 'owned') return { userId, libraryIds: null };
  if (!userId || role === 'admin') return { userId, libraryIds: null };
  const rows = await q<{ library_id: string }>(
    'SELECT library_id FROM user_libraries WHERE user_id = $1', [userId],
  ).catch(() => [] as Array<{ library_id: string }>);
  return { userId, libraryIds: rows.length ? rows.map((r) => r.library_id) : null };
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
