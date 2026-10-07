// Kitsu (kitsu.io) — free JSON:API, no key. Its manga entries carry a WIDE coverImage that AniList often
// lacks for manhwa/manhua, making it the best second source for hero banner art.
import { namesMatch } from './onlineMatch';

/**
 * Wide cover (banner-shaped) art for a manga title, or null. Searched by `rawTitle`, and taken only from an entry named
 * as the series is (`names`, lib/onlineMatch.ts namesMatch, v0.55.7). Until then any entry whose name merely contained
 * the title, or sat inside it, was taken: the containment a spin-off shares with its parent.
 */
export async function fetchKitsuBanner(rawTitle: string, names: readonly string[]): Promise<string | null> {
  const title = rawTitle.replace(/\([^)]*\)/g, '').trim();
  if (!title) return null;
  try {
    const r = await fetch(`https://kitsu.io/api/edge/manga?filter[text]=${encodeURIComponent(title)}&page[limit]=4`, {
      headers: { accept: 'application/vnd.api+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data: any[] = ((await r.json()) as any)?.data ?? [];
    for (const d of data) {
      const a = d?.attributes;
      const url = a?.coverImage?.original || a?.coverImage?.large;
      if (!url) continue;
      const entryNames = [a?.canonicalTitle, ...(Object.values(a?.titles ?? {}) as string[]), ...((a?.abbreviatedTitles ?? []) as string[])]
        .filter((n): n is string => typeof n === 'string');
      if (namesMatch(names, entryNames)) return url;
    }
    return null;
  } catch {
    return null;
  }
}
