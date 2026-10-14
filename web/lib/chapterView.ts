// The chapter list's layout on a computer (#214, klave7): the rows side by side in columns -- the default, as the series
// page has drawn them since v0.49 -- or one list the page's width, so a long chapter title is read whole. In three
// columns at 1366 px a title had about 90 px beside its date and two keys, and "Ch. 81 · The Return" read "Ch. …".
//
// Per DEVICE, in localStorage, like the Library's layout (lib/libraryLayout.ts) and the compact chapter list
// (lib/compactChapters.ts), which it combines with: a phone's list is one column at any setting. Read after mount --
// the static export renders without storage -- and storage that throws reads as the default.
export const CHAPTER_VIEWS = ['columns', 'list'] as const;
export type ChapterView = (typeof CHAPTER_VIEWS)[number];
const KEY = 'uchiyomi.chapterView';

/** This device's chapter layout. Columns unless it chose List; junk and storage that throws read as Columns. */
export function chapterViewOn(): ChapterView {
  try { return localStorage.getItem(KEY) === 'list' ? 'list' : 'columns'; } catch { return 'columns'; }
}
/** Remember `v` on this device. Columns is the default, so it is stored as nothing at all. */
export function setChapterView(v: ChapterView): void {
  try { if (v === 'list') localStorage.setItem(KEY, 'list'); else localStorage.removeItem(KEY); } catch { /* a private window */ }
}
/** The rows' container: columns from lg up, each at least 250 px, or one list. A phone stacks them either way. */
export function chapterRowsClass(v: ChapterView): string {
  return v === 'list' ? '' : 'lg:grid lg:gap-x-8 lg:[grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]';
}
