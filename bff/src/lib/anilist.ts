// Pull real per-series art from AniList (free, no key): a wide bannerImage + a high-res cover.
const QUERY = `query($s:String){Media(search:$s,type:MANGA,sort:SEARCH_MATCH){title{romaji english}coverImage{extraLarge}bannerImage}}`;

function clean(t: string): string {
  return t
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\([^)]*\)/g, '') // drop "(Remake)", "(EN)" etc.
    .replace(/\s*[-–—:]\s*(season|part|vol\.?|book)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns { banner, cover } from AniList for a manga title.
 * Throws on transient network/5xx errors (so the caller doesn't cache a miss);
 * returns nulls on a genuine "no match".
 */
export async function fetchAniListArt(rawTitle: string, retry = 0): Promise<{ banner: string | null; cover: string | null }> {
  const s = clean(rawTitle);
  if (!s) return { banner: null, cover: null };
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { s } }),
    signal: AbortSignal.timeout(10000),
  });
  // AniList rate-limits (~30/min); wait out Retry-After and retry so we don't lose the match.
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return fetchAniListArt(rawTitle, retry + 1);
  }
  if (r.status === 404) return { banner: null, cover: null }; // no match -> cache the miss
  if (!r.ok) throw new Error(`anilist ${r.status}`); // transient -> don't cache
  const j: any = await r.json();
  const m = j?.data?.Media;
  return { banner: m?.bannerImage ?? null, cover: m?.coverImage?.extraLarge ?? null };
}

const TRENDING = `query($page:Int){Page(page:$page,perPage:40){media(type:MANGA,countryOfOrigin:"KR",sort:TRENDING_DESC,isAdult:false){title{romaji english}coverImage{extraLarge large}bannerImage description(asHtml:false)genres averageScore chapters status}}}`;

export interface TrendingItem {
  title: string;
  cover: string | null;
  banner: string | null;
  description: string;
  genres: string[];
  score: number | null;
  chapters: number | null;
  status: string | null;
}

/** Globally trending manhwa (Korean-origin manga) from AniList — for the Discover "Trending" rail. */
export async function fetchTrendingManhwa(page = 1, retry = 0): Promise<TrendingItem[]> {
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: TRENDING, variables: { page } }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return fetchTrendingManhwa(page, retry + 1);
  }
  if (!r.ok) throw new Error(`anilist ${r.status}`);
  const j: any = await r.json();
  const media: any[] = j?.data?.Page?.media ?? [];
  return media
    .map((m) => ({
      title: m.title?.english || m.title?.romaji || '',
      // `large` (~230px) is plenty for the rail cards and lighter than extraLarge; loaded direct from AniList's CDN.
      cover: m.coverImage?.large || m.coverImage?.extraLarge || null,
      banner: m.bannerImage ?? null,
      description: String(m.description || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      genres: Array.isArray(m.genres) ? m.genres : [],
      score: typeof m.averageScore === 'number' ? m.averageScore : null,
      chapters: typeof m.chapters === 'number' ? m.chapters : null,
      status: m.status ?? null,
    }))
    .filter((x) => x.title && x.cover);
}
