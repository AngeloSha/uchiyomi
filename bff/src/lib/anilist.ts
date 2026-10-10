// Pull real per-series art from AniList (free, no key): a wide bannerImage + a high-res cover.
// The manga entry often has no banner while its ANIME adaptation does — pull relations in the same query.
// `id` is the AniList media id — the anchor progress sync writes against, so it is captured here rather
// than re-resolved later by another fuzzy title search.
import { plainText } from './htmlText';
import { namesMatch } from './onlineMatch';

/**
 * Where AniList is: ANILIST_API_URL, the test knob the tracker calls already read (lib/trackerProviders.ts), moves these
 * title and id lookups too (v0.55.7) -- the browser walk points it at a fake AniList (web/test/e2e/fakeAniList.mjs), so
 * no walk asks the real one. Read once at module load; unset, it is AniList's own endpoint (docs/CONFIGURATION.md).
 * Reintroduce the hard-coded address: "every AniList lookup goes where ANILIST_API_URL says" in anilistUrl.test.ts.
 */
const ANILIST = (process.env.ANILIST_API_URL || 'https://graphql.anilist.co').replace(/\/+$/, '');

// `countryOfOrigin` rides along for the series' reading direction (lib/readingDirection.ts), with every title
// the entry goes by so the direction is taken only from an entry that is visibly the series searched for
// (directionFromAniListMatch): the same match, the same request, no extra rate cost.
const QUERY = `query($s:String){Media(search:$s,type:MANGA,sort:SEARCH_MATCH){id title{romaji english native}synonyms countryOfOrigin coverImage{extraLarge}bannerImage relations{edges{node{type bannerImage}}}}}`;

/** Every name an entry goes by: its three titles and its synonyms. */
function titlesOf(m: any): string[] {
  return [m?.title?.romaji, m?.title?.english, m?.title?.native, ...(Array.isArray(m?.synonyms) ? m.synonyms : [])]
    .filter((t): t is string => typeof t === 'string' && !!t.trim());
}

function clean(t: string): string {
  return t
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\([^)]*\)/g, '') // drop "(Remake)", "(EN)" etc.
    .replace(/\s*[-–—:]\s*(season|part|vol\.?|book)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What the art lookup found: the entry's art, id and names, or nulls for a miss. */
export interface AniListArt {
  banner: string | null;
  cover: string | null;
  mediaId?: number | null;
  mediaTitle?: string | null;
  country?: string | null;
  titles?: string[];
  /** The entry the search answered with when none of its names is the series' (v0.55.7): stored as a miss. */
  refused?: { id: number | null; title: string | null };
}

/**
 * Returns { banner, cover } from AniList for a manga title, searched by `rawTitle` and kept only when the entry is the
 * series: one of its names is one of `names`, the names the series goes by here (lib/onlineMatch.ts namesMatch).
 * Throws on transient network/5xx errors (so the caller doesn't cache a miss); returns nulls on a genuine "no match",
 * and on an answer that is another work -- `refused` says which -- so the caller stores that as a miss as well and
 * does not ask again on every view (v0.55.7, #168: a comic with no online source took a manga's cover and banner, and
 * the manga's AniList link). Reintroduce by returning the entry unchecked: "another work's answer is a miss" in
 * onlineMatch.int.test.ts stores the manga's cover.
 */
export async function fetchAniListArt(rawTitle: string, names: readonly string[], retry = 0): Promise<AniListArt> {
  const s = clean(rawTitle);
  if (!s) return { banner: null, cover: null };
  const r = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { s } }),
    signal: AbortSignal.timeout(10000),
  });
  // AniList rate-limits (~30/min); wait out Retry-After and retry so we don't lose the match.
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return fetchAniListArt(rawTitle, names, retry + 1);
  }
  if (r.status === 404) return { banner: null, cover: null }; // no match -> cache the miss
  if (!r.ok) throw new Error(`anilist ${r.status}`); // transient -> don't cache
  const j: any = await r.json();
  const m = j?.data?.Media;
  if (m && !namesMatch(names, titlesOf(m))) {
    return { banner: null, cover: null, refused: { id: Number.isInteger(m.id) ? m.id : null, title: m.title?.english || m.title?.romaji || null } };
  }
  // banner priority: the manga's own, else its anime adaptation's (same request, no extra rate cost)
  const relBanner = (m?.relations?.edges ?? [])
    .map((e: any) => e?.node)
    .find((n: any) => n?.type === 'ANIME' && n.bannerImage)?.bannerImage ?? null;
  return {
    banner: m?.bannerImage ?? relBanner,
    cover: m?.coverImage?.extraLarge ?? null,
    mediaId: m?.id ?? null,
    mediaTitle: m?.title?.english || m?.title?.romaji || null,
    country: typeof m?.countryOfOrigin === 'string' ? m.countryOfOrigin : null,
    titles: titlesOf(m),
  };
}

const COUNTRIES = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:MANGA){id countryOfOrigin title{romaji english native}synonyms}}}`;

/**
 * `countryOfOrigin` and every title for many linked entries at once (series_trackers' AniList ids), fifty per
 * request, for the repair's reading-direction backfill (lib/readingDirection.ts detectDirections). Public data:
 * no token. Paced like the art jobs between pages, and a 429 is waited out as fetchAniListArt waits it out;
 * anything else throws, so the caller stops asking for the night instead of recording nothing as an answer.
 */
export async function fetchAniListCountries(ids: number[]): Promise<Map<number, { country: string; titles: string[] }>> {
  const out = new Map<number, { country: string; titles: string[] }>();
  await mediaById(COUNTRIES, ids, (m) => {
    if (Number.isInteger(m?.id) && typeof m?.countryOfOrigin === 'string') out.set(m.id, { country: m.countryOfOrigin, titles: titlesOf(m) });
  });
  return out;
}

const SCORES = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:MANGA){id averageScore meanScore popularity}}}`;

/** An entry's outside rating (v0.58.0, lib/anilistScores.ts): its score out of 100 and how many people list it. */
export interface AniListScore { score: number | null; popularity: number | null }

/**
 * The score and popularity of many linked entries at once (series_trackers' AniList ids), fifty per request: what the
 * Library's Most popular / Top rated sorts and Home's Most popular rail read. `score` is AniList's weighted average,
 * else its plain mean (an entry with few ratings has only that), out of 100; `popularity` how many AniList users have
 * the entry in a list. An id AniList does not answer is absent from the map. Public data: no token. Paced and
 * 429-handled by mediaById; anything else throws.
 */
export async function fetchAniListScores(ids: number[]): Promise<Map<number, AniListScore>> {
  const out = new Map<number, AniListScore>();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  await mediaById(SCORES, ids, (m) => {
    if (Number.isInteger(m?.id)) out.set(m.id, { score: num(m.averageScore) ?? num(m.meanScore), popularity: num(m.popularity) });
  });
  return out;
}

/**
 * One `query($ids)` over many entries, fifty ids per request, `each` called with every media AniList answers. Paced
 * like the art jobs between pages; a 429 is waited out as fetchAniListArt waits it out, anything else throws.
 */
async function mediaById(query: string, ids: number[], each: (m: any) => void): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    if (i) await new Promise((res) => setTimeout(res, 2200)); // stay under AniList's ~30 req/min
    const chunk = ids.slice(i, i + 50);
    let j: any = null;
    for (let retry = 0; ; retry++) {
      const r = await fetch(ANILIST, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables: { ids: chunk } }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 429 && retry < 2) {
        const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
        await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`anilist ${r.status}`);
      j = await r.json();
      break;
    }
    for (const m of j?.data?.Page?.media ?? []) each(m);
  }
}

/** What AniList calls an entry, and which entries it is related to: what a stored match is held to again. */
export interface AniListEntry {
  id: number;
  type: 'MANGA' | 'ANIME';
  titles: string[];
  /** The related entries (an anime's source manga, a manga's adaptations): id and type. */
  related: Array<{ id: number; type: 'MANGA' | 'ANIME' }>;
}

const ENTRIES = `query($ids:[Int]){Page(perPage:50){media(id_in:$ids){id type title{romaji english native}synonyms relations{edges{node{id type}}}}}}`;

/**
 * Every name of many entries at once, manga or anime, with what each is related to (v0.55.7): the recheck of the
 * matches stored by title before the title check existed (lib/matchCheck.ts). By id, so nothing is searched and the
 * answer is the entry itself. An id AniList does not answer for is simply absent; a failure throws, so the recheck
 * stops for now and records no verdict. Public data: no token.
 */
export async function fetchAniListEntries(ids: number[]): Promise<Map<number, AniListEntry>> {
  const out = new Map<number, AniListEntry>();
  const typeOf = (t: unknown): 'MANGA' | 'ANIME' | null => (t === 'MANGA' || t === 'ANIME' ? t : null);
  await mediaById(ENTRIES, [...new Set(ids)], (m) => {
    const type = typeOf(m?.type);
    if (!Number.isInteger(m?.id) || !type) return;
    const related = ((m?.relations?.edges ?? []) as any[]).flatMap((e) => {
      const t = typeOf(e?.node?.type);
      return Number.isInteger(e?.node?.id) && t ? [{ id: e.node.id as number, type: t }] : [];
    });
    out.set(m.id, { id: m.id, type, titles: titlesOf(m), related });
  });
  return out;
}

const ANIME_QUERY = `query($s:String){Media(search:$s,type:ANIME,sort:SEARCH_MATCH){title{romaji english native}synonyms bannerImage}}`;

/**
 * Banner from a direct ANIME search — adapted titles often match the anime by name when the manga entry has no banner.
 * Only from an anime named as the series is (`names`, lib/onlineMatch.ts namesMatch, v0.55.7): the search answers with
 * its best guess whatever it was asked.
 */
export async function fetchAnimeBanner(rawTitle: string, names: readonly string[], retry = 0): Promise<string | null> {
  const s = clean(rawTitle);
  if (!s) return null;
  const r = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: ANIME_QUERY, variables: { s } }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return fetchAnimeBanner(rawTitle, names, retry + 1);
  }
  if (!r.ok) return null;
  const j: any = await r.json();
  const m = j?.data?.Media;
  return m && namesMatch(names, titlesOf(m)) ? (m.bannerImage ?? null) : null;
}

const TRENDING = `query($page:Int){Page(page:$page,perPage:40){media(type:MANGA,countryOfOrigin:"KR",sort:TRENDING_DESC,isAdult:false){id title{romaji english}coverImage{extraLarge large}bannerImage description(asHtml:false)genres averageScore chapters status}}}`;

const CANDIDATES = `query($s:String){Page(perPage:5){media(search:$s,type:MANGA,sort:SEARCH_MATCH){title{romaji english}coverImage{extraLarge}bannerImage}}}`;

export interface ArtCandidate { title: string; banner: string | null; cover: string | null }

/** Top AniList matches for a title (art review UI) — several options, not just the best match. */
export async function fetchAniListCandidates(rawTitle: string, retry = 0): Promise<ArtCandidate[]> {
  const s = rawTitle.trim();
  if (!s) return [];
  const r = await fetch(ANILIST, {
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

const WORKS = `query($s:String){Page(perPage:5){media(search:$s,type:MANGA,format_not_in:[NOVEL],sort:SEARCH_MATCH){id title{romaji english native}synonyms}}}`;

/** An AniList entry as Discover's identity lookup needs it (lib/discoverIdentity.ts): its id and every name it goes by. */
export interface AniListWork { id: number; titles: string[] }

/**
 * The entries a name may be, by AniList's own search: up to five, each with its titles and synonyms, for the caller to
 * keep only one that IS the name (namesMatch). Empty for no answer. Throws on a transient failure -- a network error, a
 * 5xx, a 429 still answered after two waits -- so the caller asks again later rather than storing a miss.
 */
export async function searchAniListWorks(rawTitle: string, retry = 0): Promise<AniListWork[]> {
  const s = clean(rawTitle);
  if (!s) return [];
  const r = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: WORKS, variables: { s } }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 429 && retry < 2) {
    const wait = Math.min(6, Number(r.headers.get('retry-after')) || 4);
    await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000));
    return searchAniListWorks(rawTitle, retry + 1);
  }
  if (r.status === 404) return [];
  if (!r.ok) throw Object.assign(new Error(`anilist ${r.status}`), { status: r.status });
  const j: any = await r.json();
  const media: any[] = j?.data?.Page?.media ?? [];
  return media.filter((m) => typeof m?.id === 'number').map((m) => ({ id: m.id as number, titles: titlesOf(m) }));
}

export interface TrendingItem {
  /** The AniList entry (v0.56.0): Discover hides a trending title the library holds by its AniList link as well as its name. */
  id: number | null;
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
  const r = await fetch(ANILIST, {
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
      id: typeof m.id === 'number' ? m.id : null,
      title: m.title?.english || m.title?.romaji || '',
      // `large` (~230px) is plenty for the rail cards and lighter than extraLarge; loaded direct from AniList's CDN.
      cover: m.coverImage?.large || m.coverImage?.extraLarge || null,
      banner: m.bannerImage ?? null,
      description: plainText(String(m.description || '').replace(/<br\s*\/?>/gi, ' ')),
      genres: Array.isArray(m.genres) ? m.genres : [],
      score: typeof m.averageScore === 'number' ? m.averageScore : null,
      chapters: typeof m.chapters === 'number' ? m.chapters : null,
      status: m.status ?? null,
    }))
    .filter((x) => x.title && x.cover);
}
