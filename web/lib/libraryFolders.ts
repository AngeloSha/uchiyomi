/**
 * A library's folders (v0.55.1, #148) -- the part of Admin → Content → Library with no React in it, so a test can hold
 * the rules and the words.
 *
 * A library was one folder. @Kedryn: "i want 'Uchiyomi manga' to have all those listed folders BUT '18 porn comics' and
 * 'comix'" -- with one folder per library that meant a library per source folder, or filing series by hand. A library
 * now holds a list of folders: the dialog keeps the list, the folder browser ticks folders in and out of it, and the
 * card says the first and how many more. A series still belongs to the library holding the longest folder its own
 * folder is in, so a folder may sit inside another library's; only the same folder twice is refused.
 */
import { t as tr } from './i18n';
import { clauseSep, joinPart, listSep } from './said';

/** A library as GET /api/admin/libraries lists it, as far as its folders go. */
export interface LibraryFolderRow { id: string; name: string; path: string; paths?: string[] }

/**
 * Every folder a library holds, the first first: the one `path` names, which is all a rollback to v0.55.0 reads. A
 * server older than v0.55.1 sends `path` alone. The default library holds none: it is everything no other one holds.
 */
export const foldersOf = (l: Pick<LibraryFolderRow, 'path' | 'paths'>): string[] => l.paths ?? (l.path ? [l.path] : []);

/** A typed folder as the list holds it: trimmed, with no `/` at either end. The server checks it again on save. */
export function typedFolder(raw: string): string {
  let p = raw.trim();
  let a = 0;
  let b = p.length;
  while (a < b && p[a] === '/') a++;
  while (b > a && p[b - 1] === '/') b--;
  p = p.slice(a, b).trim();
  return p;
}

/** A folder ticked in the browser goes in at the end of the list; ticked again, it comes out. */
export const toggleFolder = (paths: readonly string[], p: string): string[] =>
  paths.includes(p) ? paths.filter((x) => x !== p) : [...paths, p];

/**
 * Add a typed folder, once. It is also what Save does with a folder typed and never added: typing a path and pressing
 * Create is how a library was always made, and a click on Add was never needed for it.
 */
export function addFolder(paths: readonly string[], raw: string): string[] {
  const p = typedFolder(raw);
  return !p || paths.includes(p) ? [...paths] : [...paths, p];
}

/** The same folders in the same order. The order matters: the first is the folder a rollback files by. */
export const sameFolders = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((p, i) => p === b[i]);

/**
 * Every folder another library holds, with that library's name: the browser shows them taken, and Save waits until
 * none is chosen. `self` is the library being edited (null for a new one), whose own folders are its to keep.
 */
export function heldByOthers(libs: readonly LibraryFolderRow[], self: string | null): Map<string, string> {
  const held = new Map<string, string>();
  for (const l of libs) {
    if (l.id === self) continue;
    for (const p of foldersOf(l)) held.set(p, l.name);
  }
  return held;
}

/**
 * The preview's query: the library being edited, so it counts what leaves as well as what comes, and every folder,
 * one `paths` each (a folder's name may hold a comma).
 */
export const previewQuery = (id: string | null, paths: readonly string[]): string =>
  [...(id ? [`id=${encodeURIComponent(id)}`] : []), ...paths.map((p) => `paths=${encodeURIComponent(p)}`)].join('&');

/** After a library's first folder, how many more it holds: "+2 more"; nothing for one folder. */
export function moreFoldersText(paths: readonly string[]): string {
  const n = paths.length - 1;
  if (n < 1) return '';
  return n === 1 ? tr('+1 more') : tr('+{n} more', { n });
}

/** "Held by Picks": a folder another library holds. The name is isolated, so an Arabic line keeps a Latin one whole. */
export const heldByText = (name: string): string => tr('Held by {name}', { name: `⁨${name}⁩` });

/** What the preview promises, said as a pair. */
export const wouldMoveText = (n: number): string =>
  (n === 1 ? tr('1 series would move') : tr('{n} series would move', { n }));

/**
 * The preview's line: what the save would move, up to three of the titles, and that no file is deleted -- punctuated
 * the reader's way (lib/said.ts). The titles are joined with the list's own mark ("A, B" / "A、B" / "A، B"), each
 * isolated (FSI … PDI) so an Arabic line keeps a Latin title whole, after the language's own comma; a list that goes on
 * ends on "…", which ends its sentence too. It read "…, including Tales of Demons and Gods, Martial Peak…. No files are
 * deleted." -- an ellipsis and a full stop, with English commas -- in every language.
 */
export function previewText(n: number, sample: readonly string[]): string {
  const goesOn = sample.length > 3;
  const titles = sample.slice(0, 3).map((s) => `\u2068${s}\u2069`).join(listSep());
  const moved = sample.length ? `${wouldMoveText(n)}${clauseSep()}${tr('including')} ${titles}${goesOn ? '…' : ''}` : wouldMoveText(n);
  return joinPart(moved, tr('No files are deleted.'), goesOn ? 'sentence' : 'period');
}
