// How many pages a chapter file holds, asked of the file itself.
//
// A module of its own for one reason: to keep the answer coming from `cbzPages` and nothing else.
//
// ⚠️ NEVER adm-zip. The one adm-zip in this codebase is write-only (the note at the top of lib/partial.ts,
// pinned by test/zipExtractionGuard.test.ts): it reads a whole archive into memory and has a directory
// traversal history, and the repair's count step walks tens of thousands of archives in one night --
// exactly the shape that turns "a bit wasteful" into a server that swaps. `cbzPages` streams entry
// headers, and it already knows the four other things a chapter can be: a CBR, a folder, a PDF, an EPUB.
import { cbzPages } from './library';

/**
 * Pages in one chapter file, or 0 when it cannot be read.
 *
 * 0 is a real answer here, not an error: the file may be gone (a database restored without its chapters),
 * truncated by a download nobody finished, or an archive of nothing but a ComicInfo. The caller stamps
 * `lib_books.pages_checked_at` either way, which is what stops those files being re-opened every night
 * forever -- see the column note in lib/migrate.ts. Nothing is reported to the source health ledger from
 * here: a file on our own disk says nothing about the site it came from.
 */
export async function countPages(abs: string): Promise<number> {
  return (await cbzPages(abs).catch(() => [])).length;
}
