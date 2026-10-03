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

type Qq = <R = any>(text: string, params?: any[]) => Promise<R[]>;

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
