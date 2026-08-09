// Kitsu (kitsu.io) — free JSON:API, no key. Its manga entries carry a WIDE coverImage that AniList often
// lacks for manhwa/manhua, making it the best second source for hero banner art.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Wide cover (banner-shaped) art for a manga title, or null. Loose title check guards against bad matches. */
export async function fetchKitsuBanner(rawTitle: string): Promise<string | null> {
  const title = rawTitle.replace(/\([^)]*\)/g, '').trim();
  if (!title) return null;
  try {
    const r = await fetch(`https://kitsu.io/api/edge/manga?filter[text]=${encodeURIComponent(title)}&page[limit]=4`, {
      headers: { accept: 'application/vnd.api+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data: any[] = ((await r.json()) as any)?.data ?? [];
    const want = norm(title);
    for (const d of data) {
      const a = d?.attributes;
      const url = a?.coverImage?.original || a?.coverImage?.large;
      if (!url) continue;
      // accept when any of the entry's titles loosely matches the query (equality or containment)
      const names = [a?.canonicalTitle, ...(Object.values(a?.titles ?? {}) as string[]), ...((a?.abbreviatedTitles ?? []) as string[])]
        .filter(Boolean)
        .map((n) => norm(String(n)));
      if (names.some((n) => n === want || n.includes(want) || want.includes(n))) return url;
    }
    return null;
  } catch {
    return null;
  }
}
