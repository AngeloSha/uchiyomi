// Chapter-ownership check shared by the Madara and Manganato engines.
//
// Manga sites embed "hot/popular chapters" widgets that link to OTHER titles. Without this scope those get
// scraped as chapters of whatever page we're on, producing phantom entries (the notorious "Chapter 3862" on a
// 200-chapter series). We compare the manga slug inside each chapter URL to the series' own slug.
//
// Extracted from the engines so it can be unit-tested: this guard silently corrupting a library is exactly
// the failure mode that went unnoticed for weeks.

/** The trailing path segment of a series URL, lowercased — e.g. ".../manga/solo-leveling/" -> "solo-leveling". */
export function seriesSlug(url: string): string {
  return url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? '';
}

/**
 * Does `chapterUrl` belong to the series identified by `slug`?
 * Lenient by design: when the chapter URL carries no identifiable manga slug we keep it, because dropping a
 * real chapter is worse than admitting an occasional stray. Aliases are allowed via prefix matching (sites
 * append suffixes like "-vol2" or truncate), but unrelated titles are rejected.
 */
export function isOwnChapterUrl(chapterUrl: string, slug: string): boolean {
  const m = chapterUrl.toLowerCase().match(/\/([^/]+)\/chapter[-_/]/);
  if (!slug || !m) return true;
  const cs = m[1];
  return cs === slug || cs.startsWith(slug) || slug.startsWith(cs);
}
