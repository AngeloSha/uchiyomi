// Pull real per-series art from AniList (free, no key): a wide bannerImage + a high-res cover.
// The manga entry often has no banner while its ANIME adaptation does — pull relations in the same query.
// `id` is the AniList media id — the anchor progress sync writes against, so it is captured here rather
// than re-resolved later by another fuzzy title search.
const QUERY = `query($s:String){Media(search:$s,type:MANGA,sort:SEARCH_MATCH){id title{romaji english}coverImage{extraLarge}bannerImage relations{edges{node{type bannerImage}}}}}`;

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
export async function fetchAniListArt(
  rawTitle: string,
  retry = 0,
): Promise<{ banner: string | null; cover: string | null; mediaId?: number | null; mediaTitle?: string | null }> {
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
  // banner priority: the manga's own, else its anime adaptation's (same request, no extra rate cost)
  const relBanner = (m?.relations?.edges ?? [])
    .map((e: any) => e?.node)
    .find((n: any) => n?.type === 'ANIME' && n.bannerImage)?.bannerImage ?? null;
  return {
    banner: m?.bannerImage ?? relBanner,
    cover: m?.coverImage?.extraLarge ?? null,
    mediaId: m?.id ?? null,
    mediaTitle: m?.title?.english || m?.title?.romaji || null,
  };
}

const ANIME_QUERY = `query($s:String){Media(search:$s,type:ANIME,sort:SEARCH_MATCH){bannerImage}}`;

/** Banner from a direct ANIME search — adapted titles often match the anime by name when the manga entry has no banner. */
export async function fetchAnimeBanner(rawTitle: string, retry = 0): Promise<string | null> {
  const s = clean(rawTitle);
  if (!s) return null;
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: ANIME_QUERY, variables: { s } }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return fetchAnimeBanner(rawTitle, retry + 1);
  }
  if (!r.ok) return null;
  const j: any = await r.json();
  return j?.data?.Media?.bannerImage ?? null;
}

const TRENDING = `query($page:Int){Page(page:$page,perPage:40){media(type:MANGA,countryOfOrigin:"KR",sort:TRENDING_DESC,isAdult:false){title{romaji english}coverImage{extraLarge large}bannerImage description(asHtml:false)genres averageScore chapters status}}}`;

const CANDIDATES = `query($s:String){Page(perPage:5){media(search:$s,type:MANGA,sort:SEARCH_MATCH){title{romaji english}coverImage{extraLarge}bannerImage}}}`;

export interface ArtCandidate { title: string; banner: string | null; cover: string | null }

/** Top AniList matches for a title (art review UI) — several options, not just the best match. */
export async function fetchAniListCandidates(rawTitle: string, retry = 0): Promise<ArtCandidate[]> {
  const s = rawTitle.trim();
  if (!s) return [];
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: CANDIDATES, variables: { s } }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return fetchAniListCandidates(rawTitle, retry + 1);
  }
  if (!r.ok) return [];
  const j: any = await r.json();
  const media: any[] = j?.data?.Page?.media ?? [];
  return media
    .map((m) => ({
      title: m.title?.english || m.title?.romaji || '',
      banner: m.bannerImage ?? null,
      cover: m.coverImage?.extraLarge ?? null,
    }))
    .filter((c) => c.title && (c.banner || c.cover));
}

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
