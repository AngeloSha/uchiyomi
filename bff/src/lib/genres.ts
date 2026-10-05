// A series' genres as its own: what a site's page or a chapter file says, without a site's whole genre menu (v0.55.5).
//
// Natomanga's series pages carry the site's genre menu at their foot -- "All, Completed, Ongoing, Action, Adaptation,
// Adult, Adventure, ..." -- and the Manganato engine read every genre link on the page until v0.55.5. Twelve series on
// the install this was written against held all 69 genres, Adult, Hentai and Smut among them, and their chapter files
// say so too (ComicInfo <Genre>, which a scan reads back). A menu is told apart by how it starts: the three status
// filters every listing menu leads with, side by side. No series is "All", "Completed" and "Ongoing" at once.

/** The run a site's genre menu starts with, folded. */
const MENU_RUN = ['all', 'completed', 'ongoing'];

/**
 * `genres` without a site menu's run and everything after it, trimmed, and each genre once (the first spelling kept,
 * compared case-blind: the page lists a series' genres twice, its info panel and the box beside it). Anything not a
 * non-empty string is dropped. A list with no menu comes back as it was, less repeats.
 */
export function cleanGenres(genres: readonly unknown[] | null | undefined): string[] {
  const list = (Array.isArray(genres) ? genres : []).filter((g): g is string => typeof g === 'string').map((g) => g.trim()).filter(Boolean);
  const folded = list.map((g) => g.toLowerCase());
  const at = folded.findIndex((_, i) => MENU_RUN.every((m, k) => folded[i + k] === m));
  const seen = new Set<string>();
  return (at >= 0 ? list.slice(0, at) : list).filter((g) => {
    const k = g.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
