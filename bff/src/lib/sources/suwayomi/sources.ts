// Turn each Suwayomi source (i.e. each installed Mihon/Tachiyomi extension's source) into an Uchiyomi
// SourceAdapter. Operation names and argument shapes below were taken from live introspection of
// Suwayomi-Server v2.2.2100, not from documentation -- the docs are wrong about the endpoint path already.
//
// Suwayomi's model is STATEFUL, which shapes the id mapping: fetchSourceManga returns manga rows carrying
// Suwayomi's own integer ids, and fetchChapters/fetchChapterPages take those integer ids rather than any
// source-native identifier. So a series' sourceId here is Suwayomi's manga id. That is stable for as long as
// Suwayomi's database lives; wiping it orphans the routing, same as uninstalling an extension would.
import type { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { gql as defaultGql, suwayomiUrl, suwayomiImageHeaders, type Gql } from './client';

export const SW_PREFIX = 'sw:';

/** Adapter id for a Suwayomi source. Namespaced so it can never collide with a built-in, pack or custom site. */
export const swAdapterId = (remoteId: string): string => SW_PREFIX + remoteId;
export const isSwAdapterId = (id: string): boolean => id.startsWith(SW_PREFIX);

export interface RemoteSource {
  id: string; // LongString
  name: string;
  displayName?: string | null;
  lang?: string | null;
  iconUrl?: string | null;
  isNsfw?: boolean | null;
  supportsLatest?: boolean | null;
  baseUrl?: string | null;
}

const SOURCES_Q = `{ sources { totalCount nodes { id name displayName lang iconUrl isNsfw supportsLatest baseUrl } } }`;

/** Every source Suwayomi currently exposes (one per source in each installed extension). */
export async function listRemoteSources(run: Gql = defaultGql): Promise<RemoteSource[]> {
  const d = await run<{ sources: { nodes: RemoteSource[] } }>(SOURCES_Q, {}, 20000);
  const nodes = d?.sources?.nodes;
  return Array.isArray(nodes) ? nodes.filter((s) => s && s.id != null) : [];
}

// ---- GraphQL operations used by the adapter --------------------------------

const MANGA_FIELDS = `id title thumbnailUrl realUrl url description author artist genre status`;

const FETCH_SOURCE_MANGA = `mutation($source:LongString!,$type:FetchSourceMangaType!,$query:String,$page:Int!){
  fetchSourceManga(input:{source:$source,type:$type,query:$query,page:$page}){ mangas { ${MANGA_FIELDS} } }
}`;

const FETCH_MANGA = `mutation($id:Int!){ fetchManga(input:{id:$id}){ manga { ${MANGA_FIELDS} } } }`;

const FETCH_CHAPTERS = `mutation($mangaId:Int!){
  fetchChapters(input:{mangaId:$mangaId}){ chapters { id chapterNumber name scanlator uploadDate pageCount } }
}`;

const FETCH_PAGES = `mutation($chapterId:Int!){ fetchChapterPages(input:{chapterId:$chapterId}){ pages } }`;

interface RemoteManga {
  id: number;
  title?: string | null;
  thumbnailUrl?: string | null;
  realUrl?: string | null;
  url?: string | null;
  description?: string | null;
  author?: string | null;
  artist?: string | null;
  genre?: string[] | null;
  status?: string | null;
}

interface RemoteChapter {
  id: number;
  chapterNumber?: number | null;
  name?: string | null;
  scanlator?: string | null;
  uploadDate?: string | null; // epoch millis as a string (Suwayomi's LongString)
  pageCount?: number | null;
}

/** Suwayomi's MangaStatus enum is SCREAMING_CASE; the rest of the app shows this verbatim. */
function prettyStatus(s?: string | null): string | undefined {
  if (!s || s === 'UNKNOWN') return undefined;
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

function toSeries(m: RemoteManga, adapterId: string): SourceSeries | null {
  // A row without an id can't be routed back to Suwayomi, and one without a title is not a real result.
  if (m?.id == null || !m.title?.trim()) return null;
  return {
    sourceId: String(m.id),
    source: adapterId,
    title: m.title.trim(),
    summary: m.description?.trim() || undefined,
    author: m.author?.trim() || m.artist?.trim() || undefined,
    genres: Array.isArray(m.genre) ? m.genre.filter((g) => typeof g === 'string' && g.trim()) : undefined,
    status: prettyStatus(m.status),
    // Suwayomi proxies covers through itself, so make the path absolute against its origin.
    coverUrl: m.thumbnailUrl ? suwayomiUrl(m.thumbnailUrl) : undefined,
    url: m.realUrl || undefined,
  };
}

function toChapter(c: RemoteChapter): SourceChapter | null {
  if (c?.id == null) return null;
  const num = typeof c.chapterNumber === 'number' ? c.chapterNumber : NaN;
  // A chapter with no usable number can't be ordered, named or diffed against the library — drop it rather
  // than inventing 0, which would collide with a real chapter 0.
  if (!Number.isFinite(num) || num < 0) return null;
  const when = Number(c.uploadDate);
  return {
    sourceId: String(c.id),
    number: num,
    title: c.name?.trim() || `Chapter ${num}`,
    pages: typeof c.pageCount === 'number' && c.pageCount > 0 ? c.pageCount : undefined,
    publishedAt: Number.isFinite(when) && when > 0 ? new Date(when).toISOString() : undefined,
  };
}

/**
 * Build the Uchiyomi adapter for one Suwayomi source.
 *
 * `requiresCloudflare` is deliberately false: Suwayomi solves Cloudflare itself with an embedded browser, so
 * these sources skip our FlareSolverr entirely. Images do need Suwayomi's auth header, which is declared via
 * `imageHeaders` rather than special-cased on the id, so the core keeps consulting capabilities not names.
 */
export function makeSuwayomiAdapter(remote: RemoteSource, run: Gql = defaultGql): SourceAdapter {
  const adapterId = swAdapterId(remote.id);

  const fetchList = async (type: 'SEARCH' | 'LATEST' | 'POPULAR', query: string | null, page: number): Promise<SourceSeries[]> => {
    const d = await run<{ fetchSourceManga: { mangas: RemoteManga[] } }>(FETCH_SOURCE_MANGA, {
      source: remote.id,
      type,
      query,
      page: Math.max(1, page),
    });
    const list = d?.fetchSourceManga?.mangas;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list
      .map((m) => toSeries(m, adapterId))
      .filter((s): s is SourceSeries => !!s && (seen.has(s.sourceId) ? false : (seen.add(s.sourceId), true)));
  };

  const adapter: SourceAdapter = {
    id: adapterId,
    name: remote.displayName?.trim() || remote.name,
    lang: remote.lang?.trim() || undefined,
    // Declared by the extension author and the only adult signal any source gives us. Carried onto the
    // adapter so the routes can decide with the object they already hold, without a per-request DB read.
    isNsfw: !!remote.isNsfw,
    requiresCloudflare: false,
    imageHeaders: suwayomiImageHeaders,
    // After the built-ins but ahead of user-added engine sites: an extension is usually a better-maintained
    // parser than a generic engine pointed at the same site.
    preferredOrder: 30,

    async search(query) {
      return fetchList('SEARCH', query, 1);
    },

    async getSeries(id) {
      const d = await run<{ fetchManga: { manga: RemoteManga | null } }>(FETCH_MANGA, { id: Number(id) });
      const m = d?.fetchManga?.manga;
      return m ? toSeries(m, adapterId) : null;
    },

    async listChapters(seriesId) {
      const d = await run<{ fetchChapters: { chapters: RemoteChapter[] } }>(FETCH_CHAPTERS, { mangaId: Number(seriesId) });
      const list = d?.fetchChapters?.chapters;
      if (!Array.isArray(list)) return [];
      const seen = new Set<number>();
      return list
        .map(toChapter)
        .filter((c): c is SourceChapter => !!c && (seen.has(c.number) ? false : (seen.add(c.number), true)))
        .sort((a, b) => a.number - b.number);
    },

    async getPageUrls(chapterId) {
      const d = await run<{ fetchChapterPages: { pages: string[] } }>(FETCH_PAGES, { chapterId: Number(chapterId) });
      const pages = d?.fetchChapterPages?.pages;
      if (!Array.isArray(pages)) return [];
      // Suwayomi hands back its own proxy paths; the downloader fetches them straight from Suwayomi.
      return pages.filter((p) => typeof p === 'string' && p.trim()).map((p) => suwayomiUrl(p));
    },
  };

  // Only claim `latest` when the extension actually implements it — the loader duck-types this, and
  // GET /api/sources reports the capability straight from the method's presence.
  if (remote.supportsLatest) {
    adapter.latest = (page = 1) => fetchList('LATEST', null, page);
  }
  return adapter;
}
