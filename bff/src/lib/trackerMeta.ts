// Metadata from trackers other than AniList: Kitsu and MangaUpdates (both free, keyless JSON). Each entry is taken only
// when it is named as the series is (lib/onlineMatch.ts namesMatch), like every online match.
import { namesMatch } from './onlineMatch';

export interface TrackerMeta {
  source: 'kitsu' | 'mangaupdates';
  cover: string | null;
  banner: string | null;
  summary: string | null;
  genres: string[];
}

const clean = (t: string) => t.replace(/\([^)]*\)/g, '').trim();
/**
 * A description from a service as plain text. Tags are removed until none is left (one pass can leave a tag behind when one was nested
 * inside another), then any angle bracket that remains, so no markup can survive.
 */
export function strip(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  let t = s, prev: string;
  do { prev = t; t = t.replace(/<[^<>]*>/g, ''); } while (t !== prev);
  return t.replace(/[<>]/g, '').replace(/\s+\n/g, '\n').trim() || null;
}

async function kitsu(title: string, names: readonly string[]): Promise<TrackerMeta | null> {
  const r = await fetch(`https://kitsu.io/api/edge/manga?filter[text]=${encodeURIComponent(title)}&page[limit]=4&include=categories`, {
    headers: { accept: 'application/vnd.api+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return null;
  const body: any = await r.json();
  const cats = new Map<string, string>((body?.included ?? []).filter((i: any) => i?.type === 'categories').map((i: any) => [i.id, i.attributes?.title]));
  for (const d of body?.data ?? []) {
    const a = d?.attributes;
    const entryNames = [a?.canonicalTitle, ...(Object.values(a?.titles ?? {}) as string[]), ...((a?.abbreviatedTitles ?? []) as string[])]
      .filter((n): n is string => typeof n === 'string');
    if (!namesMatch(names, entryNames)) continue;
    const genres = ((d?.relationships?.categories?.data ?? []) as any[]).map((c) => cats.get(c.id)).filter((g): g is string => !!g);
    return {
      source: 'kitsu',
      cover: a?.posterImage?.large || a?.posterImage?.original || null,
      banner: a?.coverImage?.original || a?.coverImage?.large || null,
      summary: strip(a?.synopsis),
      genres,
    };
  }
  return null;
}

async function mangaUpdates(title: string, names: readonly string[]): Promise<TrackerMeta | null> {
  const r = await fetch('https://api.mangaupdates.com/v1/series/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ search: title, perpage: 4 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return null;
  const hits: any[] = ((await r.json()) as any)?.results ?? [];
  for (const h of hits) {
    const rec = h?.record;
    if (!rec || !namesMatch(names, [rec.title])) continue;
    // The search record has no alternative titles, so a match is by the primary title alone: stricter, never looser.
    return {
      source: 'mangaupdates',
      cover: rec.image?.url?.original || null,
      banner: null,
      summary: strip(rec.description),
      genres: ((rec.genres ?? []) as any[]).map((g) => g?.genre).filter((g): g is string => typeof g === 'string'),
    };
  }
  return null;
}

/** What the first tracker that knows this series says about it, or null. Never throws. */
export async function fetchTrackerMeta(rawTitle: string, names: readonly string[]): Promise<TrackerMeta | null> {
  const title = clean(rawTitle);
  if (!title) return null;
  for (const f of [kitsu, mangaUpdates]) {
    try {
      const m = await f(title, names);
      if (m && (m.cover || m.banner || m.summary || m.genres.length)) return m;
    } catch { /* a tracker that is down is a miss */ }
  }
  return null;
}
