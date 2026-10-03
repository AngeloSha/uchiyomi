// Which library each series is in when a library's folders change: creating, re-pathing or removing one (v0.55.1, #148).
//
// A scan never moves a series it already knows (lib/library.ts persistScan keeps an existing row in its library, so it
// can never re-mint an id by recomputing), so a library save is where its series move, in the save's own transaction.
// One rule for all three: every series that is not pinned and sits under any folder the library held before the save
// or holds after it goes to the library holding the longest folder its own folder is in, across every library's
// folders -- the rule libraryIdFor applies to a new folder -- or to the default library when none holds it. Removing a
// library also moves what it still holds by hand: nothing may point at a library that is gone.
//
// The preview runs the same statement and stops short of the UPDATE, so the count it promises is what the save does.
import { visibleToAll } from './visibility';
import { diskSpelling } from './libraryAdmin';
import { LIBRARY_ROOT, DL_ROOT } from './library';
import { toStoredRel, trimTrailingSlashes } from './relPath';

type Qq = <R = any>(text: string, params?: any[]) => Promise<R[]>;

/** How many folders one library may hold: a list an admin ticks by hand, kept to a size every save can carry. */
export const LIBRARY_MAX_FOLDERS = 200;

/**
 * The folders a save names, as they are stored, or null when one is not a folder under the root.
 *
 * Each is checked as a library's one folder always was: relative and posix (a `\` typed on Windows is a separator,
 * lib/relPath.ts), no `..`, and on the desktop in the spelling the disk already has (libraryAdmin.ts diskSpelling:
 * NTFS and APFS find `manga/seinen` for `Manga/Seinen`, but series folders are compared as exact strings). The same
 * folder named twice -- or typed in two spellings the disk resolves to one -- is held once, in its first place.
 */
export async function storedFolders(raw: string[]): Promise<string[] | null> {
  const out: string[] = [];
  for (const r of raw) {
    const typed = trimTrailingSlashes(toStoredRel(r).replace(/^\/+/, '')).trim();
    if (!typed || typed.includes('..') || typed.startsWith('/')) return null;
    const path = await diskSpelling([LIBRARY_ROOT, DL_ROOT], typed);
    if (!out.includes(path)) out.push(path);
  }
  return out.length ? out : null;
}

/**
 * The first of `paths`, in the order given, that a library other than `id` already holds, and that library: a folder
 * belongs to one library at most, since two on the same folder have no rule to separate them. Nesting is fine --
 * `Manga/Seinen` inside another library's `Manga` is a folder of its own, and the longest one wins.
 *
 * libraries.path is asked too, though in steady state it is always among library_paths: a first folder a v0.55.0
 * wrote is reconciled only at the next boot, and answering 409 beats the unique index's 500.
 */
export async function heldElsewhere(qq: Qq, id: string, paths: string[]): Promise<{ path: string; id: string; name: string } | null> {
  const [held] = await qq<{ path: string; id: string; name: string }>(
    `SELECT h.path, l.id, l.name
       FROM (SELECT path, library_id FROM library_paths
             UNION SELECT path, id FROM libraries WHERE path <> '') AS h (path, library_id)
       JOIN libraries l ON l.id = h.library_id
      WHERE h.path = ANY($2::text[]) AND h.library_id <> $1
      ORDER BY array_position($2::text[], h.path) LIMIT 1`,
    [id, paths]);
  return held ?? null;
}

/**
 * Library saves, one at a time. A save decides where series go from every OTHER library's folders, so two saves at
 * once could each decide without the other's folders and leave a series in the wrong library after both commit.
 */
const LIBRARY_SAVE_LOCK = 8_263_197;
export const lockLibrarySaves = (qq: Qq) => qq('SELECT pg_advisory_xact_lock($1)', [LIBRARY_SAVE_LOCK]);

/**
 * `folder` is `path` itself or inside it, in SQL. A plain prefix test: the `LIKE path || '/%'` it replaces read a `_` or
 * a `%` in a folder's name as a wildcard, so a library on `Manga_EN` also claimed `MangaXEN/…`.
 */
export const underSql = (folder: string, path: string): string =>
  `(${folder} = ${path} OR starts_with(${folder}, ${path} || '/'))`;

/**
 * The series a save moves, as a `moves` CTE: every series the rule above reaches, with the library it is in (`was`),
 * the one it goes to (`goes`), and whether an admin sees it at all (`shown`: a removed or merged-away series moves
 * too, so putting it back lands it where its folder says, but nobody is promised it).
 *
 * $1 is the library, or '' for one not created yet; $2 the folders it holds after the save, none when $3, it is being
 * removed. Its folders before the save are its library_paths rows, so this runs before they are rewritten.
 */
const MOVES = `
  WITH folders AS (
         SELECT library_id, path FROM library_paths WHERE library_id <> $1
         UNION ALL
         SELECT $1::text, p FROM unnest($2::text[]) AS p
       ),
       touched AS (
         SELECT p FROM unnest($2::text[]) AS p
         UNION
         SELECT path FROM library_paths WHERE library_id = $1
       ),
       moves AS (
         SELECT s.id, s.title, s.library_id AS was, (${visibleToAll('s')}) AS shown,
                COALESCE((SELECT f.library_id FROM folders f WHERE ${underSql('s.folder', 'f.path')}
                           ORDER BY length(f.path) DESC LIMIT 1), 'lib') AS goes
           FROM lib_series s
          WHERE (NOT s.library_pinned AND EXISTS (SELECT 1 FROM touched t WHERE ${underSql('s.folder', 't.p')}))
             OR ($3::boolean AND s.library_id = $1)
       )`;

/** What saving library `id` (null: a new one) with `paths` would move, as the admin sees it: how many, and a few titles. */
export async function previewMoves(qq: Qq, id: string | null, paths: string[]): Promise<{ series: number; sample: string[] }> {
  const args = [id ?? '', paths, false];
  const [n] = await qq<{ n: number }>(`${MOVES} SELECT count(*)::int AS n FROM moves WHERE goes <> was AND shown`, args);
  const sample = await qq<{ title: string }>(
    `${MOVES} SELECT title FROM moves WHERE goes <> was AND shown ORDER BY title LIMIT 20`, args);
  return { series: n?.n ?? 0, sample: sample.map((r) => r.title) };
}

/**
 * Move every series the save reaches, inside the save's transaction and BEFORE its library_paths rows are rewritten
 * (they are what it held before). Answers how many series changed library, removed ones included.
 */
export async function applyMoves(qq: Qq, id: string, paths: string[], removing = false): Promise<number> {
  const moved = await qq(
    `${MOVES} UPDATE lib_series s SET library_id = m.goes FROM moves m WHERE s.id = m.id AND m.goes <> m.was RETURNING s.id`,
    [id, paths, removing]);
  return moved.length;
}

/**
 * Make `paths` the library's folders: its library_paths rows, and libraries.path = the first, which is all a rollback
 * to v0.55.0 reads (and files new folders by).
 */
export async function setFolders(qq: Qq, id: string, paths: string[]): Promise<void> {
  await qq('DELETE FROM library_paths WHERE library_id = $1', [id]);
  await qq('INSERT INTO library_paths (library_id, path) SELECT $1, p FROM unnest($2::text[]) AS p', [id, paths]);
  await qq('UPDATE libraries SET path = $2 WHERE id = $1', [id, paths[0]]);
}
