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

/**
 * Point a stored series URL at wherever the site lives NOW.
 *
 * A series id is an absolute URL captured when the series was added, and sites move. Aqua Manga went from
 * `aquareader.net` to `aquareader.org`, the operator updated the site's `base` accordingly, and nothing
 * changed: every engine resolves a stored id with `id.startsWith('http') ? id : base + path`, so the 176
 * series added before the move kept asking the dead host.
 *
 * What made that invisible rather than loud is the shape of the failure. The old host answers a 404 *page*,
 * not an HTTP error, so `cfGet` succeeds, the chapter parser finds nothing in it, and zero chapters is
 * indistinguishable from a series with nothing new. 79% of a library went stale while every surface, including
 * the health checks, reported it healthy.
 *
 * Editing `base` is the operator saying "it moved". Honouring that for ids already stored makes a domain move
 * one config edit instead of a database migration, and keeps working the next time it happens.
 */
export function rebase(id: string, base: string): string {
  if (!id || !base || !id.startsWith('http')) return id;
  try {
    const u = new URL(id);
    const b = new URL(base);
    if (u.host === b.host && u.protocol === b.protocol) return id;
    u.protocol = b.protocol;
    u.host = b.host;
    return u.toString();
  } catch {
    return id; // an id we cannot parse is one we must not rewrite
  }
}
