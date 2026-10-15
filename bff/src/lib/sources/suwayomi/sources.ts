// Turn each Suwayomi source (i.e. each installed Mihon/Tachiyomi extension's source) into an Uchiyomi
// SourceAdapter. The documents are in operations.ts, validated against the schema of every supported engine; the
// docs are wrong about the endpoint path already, so nothing here was taken from them.
//
// Suwayomi's model is STATEFUL, which shapes the id mapping: fetchSourceManga returns manga rows carrying
// Suwayomi's own integer ids, and fetchMangaAndChapters/fetchChapterPages take those integer ids rather than any
// source-native identifier. So a series' sourceId here is Suwayomi's manga id. That is stable for as long as
// Suwayomi's database lives; wiping it orphans the routing, same as uninstalling an extension would.
import { UNNUMBERED, type SourceAdapter, type SourceSeries, type SourceChapter } from '../types';
import { gql as defaultGql, suwayomiUrl, suwayomiImageHeaders, onEngineOrigin, type Gql } from './client';
import { OPS } from './operations';
import { env } from '../../../env';

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
  /** Adult or not, read from `contentWarning` by listRemoteSources (adultOf): the one flag the rest of the app reads. */
  isNsfw?: boolean | null;
  /** The engine's own word: SAFE, MIXED or NSFW. */
  contentWarning?: string | null;
  supportsLatest?: boolean | null;
  /**
   * The installed extension (APK) this source came out of. One package can expose many sources -- 3Hentai
   * is one extension and twenty-nine language variants -- and `pkgName` is the only thing they share that
   * is not a guess: the display names differ by their ` (XX)` suffix and nothing else, which is exactly the
   * kind of string comparison that breaks on the first extension with a bracket in its name. Optional and
   * nullable on our side because the value comes from a server we do not control: a node that answers
   * without it must register as a source with an unknown extension, never fail the whole list.
   */
  extension?: { pkgName?: string | null; name?: string | null } | null;
}

/**
 * Adult, from the engine's `contentWarning` (SAFE, MIXED, NSFW), which replaced the deprecated `isNsfw`. The engine's
 * own rule is isNsfw = contentWarning >= MIXED, so only SAFE is safe -- and a legacy store's 18+ extension is MIXED
 * (measured). ⚠️ Fails CLOSED: a missing or unknown value is adult. A capped account loses a source it could have read
 * until the engine says SAFE, which is the right way round; the other way, a value this Uchiyomi does not know yet
 * would open an 18+ source to a child's account. Reintroduce `=== 'NSFW'`: "a MIXED source is adult" in
 * suwayomiAdapter.test.ts reads it as safe.
 */
export const adultOf = (contentWarning: unknown): boolean => contentWarning !== 'SAFE';

/** Every source Suwayomi currently exposes (one per source in each installed extension). */
export async function listRemoteSources(run: Gql = defaultGql): Promise<RemoteSource[]> {
  const d = await run<{ sources: { nodes: RemoteSource[] } }>(OPS.sources.doc, {}, 20000);
  const nodes = d?.sources?.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((s) => s && s.id != null).map((s) => ({ ...s, isNsfw: adultOf(s.contentWarning) }))
    : [];
}

// ---- the adapter --------------------------------------------------------------------------------------------------
//
// ⚠️ No fallback query for an older engine any more. Until the engine upgrade, listChapters retried an engine that
// refused `sourceOrder url` with the v0.48 query (FETCH_CHAPTERS_V048, remembered per transport in
// legacyChapterEngines, recognised by refusedChapterFields). Those engines predate v2.3.2243, the oldest one every
// document here is validated against (enginePin.ts OLDEST_ENGINE), and an engine that old lacks
// fetchMangaAndChapters too: a fallback would only have hidden it. Such an engine is now refused openly
// (client.ts EngineRefusedError) and Health says to update it.

interface RemoteManga {
  id: number;
  /** The extension source the manga belongs to (a LongString, so a string). */
  sourceId?: string | number | null;
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
  uploadDate?: string | null; // epoch millis as a string (Suwayomi's LongString); seconds on v2.3.2243 sometimes (uploadedAt)
  pageCount?: number | null;
  sourceOrder?: number | null;
  url?: string | null;
}

/** 2000-01-01: no chapter an extension lists was posted before it, and anything earlier is a misread number. */
const EARLIEST_UPLOAD_MS = Date.UTC(2000, 0, 1);

/**
 * A chapter's upload date as an ISO string, or undefined when the engine's number is not a date.
 *
 * ⚠️ Seconds or milliseconds. v2.3.2243 gives a NEW chapter the extension listed without a date the current time in
 * epoch SECONDS (Chapter.updateChapterListDatabase, `Instant.now().epochSecond`; measured on a throwaway engine:
 * "1791984615" beside a dated chapter's "1704067200000"). Read as milliseconds that is 1970-01-21, which the release
 * radar, a group's posting history, the Komga API's releaseDate and the catalogue then showed. v2.4 stamps
 * milliseconds. A value under 1e11 is seconds -- in milliseconds it would be before March 1973 -- and anything before
 * 2000 is no date at all. migrate.ts `suwayomi-chapter-dates-in-seconds` repairs what the bug already stored.
 * Reintroduce by dropping the `* 1000`: "a date in seconds is read as one" in suwayomiAdapter.test.ts finds no date
 * where there is one (and without the 2000 floor too, 1970-01-21 again).
 */
export function uploadedAt(raw: unknown): string | undefined {
  let ms = typeof raw === 'string' && raw.trim() ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms < 1e11) ms *= 1000;
  if (ms < EARLIEST_UPLOAD_MS) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
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
    // The extension-relative url (what a Mihon backup stores for this manga), kept apart from the web
    // link above: the import review proves "same entry as the backup" by comparing this, and `realUrl`
    // is absolute and site-shaped, so the two never compare equal.
    path: m.url || undefined,
  };
}

/** `position` is the row's 1-based place in the engine's answer: the order when the row carries none. */
function toChapter(c: RemoteChapter, position: number): SourceChapter | null {
  if (c?.id == null) return null;
  const num = typeof c.chapterNumber === 'number' ? c.chapterNumber : NaN;
  // A chapter with no usable number can't be ordered, named or diffed against the library — drop it rather
  // than inventing 0, which would collide with a real chapter 0.
  if (!Number.isFinite(num) || num < 0) return null;
  const out: SourceChapter = {
    sourceId: String(c.id),
    // The extension's number, raw, even when many posts share it (#116): what to do about that is decided per
    // series in the listing layer (lib/postingOrder.ts), which can see the series and this adapter cannot.
    number: num,
    title: c.name?.trim() || `Chapter ${num}`,
    pages: typeof c.pageCount === 'number' && c.pageCount > 0 ? c.pageCount : undefined,
    publishedAt: uploadedAt(c.uploadDate),
    // Mihon's free-text scanlator column, verbatim. Blank means the extension does not know, and the
    // chooser treats an absent group differently from an empty-named one, so it must not become ''.
    scanlator: c.scanlator?.trim() || undefined,
    order: typeof c.sourceOrder === 'number' && Number.isFinite(c.sourceOrder) && c.sourceOrder > 0 ? c.sourceOrder : position,
  };
  const url = typeof c.url === 'string' ? c.url.trim() : '';
  if (url) out.url = url;
  return out;
}

/**
 * Build the Uchiyomi adapter for one Suwayomi source.
 *
 * `requiresCloudflare` is deliberately false: the engine talks to the site, this server never does, so
 * routing these sources through our FlareSolverr would solve a challenge for a request we do not make.
 * ⚠️ That does NOT mean the engine solves Cloudflare on its own. Suwayomi-Server is a headless JVM with no
 * browser; its CloudflareInterceptor hands challenged requests to a FlareSolverr of ITS OWN, and that
 * integration is OFF by default -- every challenged request then throws `Cloudflare bypass currently
 * disabled` (issue #54). The compose files point the bundled engine at the bundled solver with
 * FLARESOLVERR_ENABLED / FLARESOLVERR_URL; an external engine needs the same two settings. Images do need
 * Suwayomi's auth header, which is declared via
 * `imageHeaders` rather than special-cased on the id, so the core keeps consulting capabilities not names.
 * The same goes for pacing: `pageConcurrency` and `pageGapMs` say that page URLs here are the engine's own
 * proxy paths, rate-limited by the engine towards the site, so the downloader may overlap them instead of
 * applying the one-at-a-time quarter-second gap that scraped sites need. The downloader never asks whether
 * an id starts with `sw:`; it reads these two fields.
 */
export function makeSuwayomiAdapter(remote: RemoteSource, run: Gql = defaultGql): SourceAdapter {
  const adapterId = swAdapterId(remote.id);

  const fetchList = async (type: 'SEARCH' | 'LATEST' | 'POPULAR', query: string | null, page: number): Promise<SourceSeries[]> => {
    const d = await run<{ fetchSourceManga: { mangas: RemoteManga[] } }>(OPS.fetchSourceManga.doc, {
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

  /** Whether a manga the engine answered with is this source's own. Absent means the engine did not say (a test fake). */
  const ownManga = (sourceId: string | number | null | undefined): boolean => sourceId == null || String(sourceId) === String(remote.id);

  const adapter: SourceAdapter = {
    id: adapterId,
    name: remote.displayName?.trim() || remote.name,
    lang: remote.lang?.trim() || undefined,
    // Declared by the extension author and the only adult signal any source gives us. Carried onto the
    // adapter so the routes can decide with the object they already hold, without a per-request DB read.
    isNsfw: !!remote.isNsfw,
    // The extension ships its own logo and the sources query has always selected it; it was simply dropped here.
    // Served to browsers through /img/sources/icon/:id, never linked directly: the extension server is not
    // reachable from a browser.
    iconUrl: remote.iconUrl?.trim() || undefined,
    requiresCloudflare: false,
    // The engine's login, for the engine's own URLs only. Declared as a function of the URL because every caller passes
    // the URL it is about to fetch, and some of those URLs are not the engine's: the cover proxy's `?u=` is the
    // caller's, so this used to hand the engine's Basic credentials to any host a member named. Reintroduce by
    // returning suwayomiImageHeaders() for every URL: outboundGuard.test.ts sees the login offered to another host.
    imageHeaders: (url: string) => (onEngineOrigin(url) ? suwayomiImageHeaders() : {}),
    // Pages are fetched from the engine, not the site, so they may overlap and need no gap of their own;
    // see the doc comment above and SUWAYOMI_PAGE_CONCURRENCY in env.ts.
    pageConcurrency: env.SUWAYOMI_PAGE_CONCURRENCY,
    pageGapMs: 0,
    // Every extension's pages are on the engine: its address says nothing about which site's limit a page counts
    // against, so it never joins two extensions under one rate key (lib/pace.ts notePageHosts).
    pagesProxied: true,
    // After the built-ins but ahead of user-added engine sites: an extension is usually a better-maintained
    // parser than a generic engine pointed at the same site.
    preferredOrder: 30,

    async search(query) {
      return fetchList('SEARCH', query, 1);
    },

    async getSeries(id) {
      const d = await run<{ fetchMangaAndChapters: { manga: RemoteManga | null } }>(OPS.fetchManga.doc, { id: Number(id) });
      const m = d?.fetchMangaAndChapters?.manga;
      // The engine's manga ids are global, across every extension: an id from ANOTHER source resolved here, under this
      // source's name -- and the age cap and the source switches are judged on the name (sourceAllowedFor), so an
      // adult extension's manga opened through a safe one. Reintroduce by dropping the check: "a manga of another
      // source is not this source's" in suwayomiAdapter.test.ts resolves it.
      if (!m || !ownManga(m.sourceId)) return null;
      return toSeries(m, adapterId);
    },

    async listChapters(seriesId) {
      const d = await run<{ fetchMangaAndChapters: { manga?: { sourceId?: string | number | null } | null; chapters: RemoteChapter[] } }>(OPS.fetchChapters.doc, { id: Number(seriesId) });
      if (!ownManga(d?.fetchMangaAndChapters?.manga?.sourceId)) return []; // another source's manga, as getSeries above
      const list = d?.fetchMangaAndChapters?.chapters;
      if (!Array.isArray(list)) return [];
      // Every copy of a number is reported, not just the first the engine listed. The choice between
      // groups belongs to lib/releases.ts, which knows the series' preference; this adapter's job is to
      // say who released what. Sorting stays: callers diff the list in order. The position is taken BEFORE
      // the sort and before junk rows are dropped: the engine answers in sourceOrder, so a row's place in
      // its answer is its posting order when the row does not say.
      const out = list
        .map((c, i) => toChapter(c, i + 1))
        .filter((c): c is SourceChapter => !!c)
        .sort((a, b) => a.number - b.number);
      // How many rows toChapter dropped for having no usable number (#115): on the FINAL array, after the sort,
      // so the smoke test can tell "no numbers" from "no chapters". Non-enumerable (types.ts UNNUMBERED).
      const dropped = list.filter((c) => c?.id != null).length - out.length;
      if (dropped > 0) Object.defineProperty(out, UNNUMBERED, { value: dropped });
      return out;
    },

    async getPageUrls(chapterId) {
      const d = await run<{ fetchChapterPages: { pages: string[] } }>(OPS.fetchChapterPages.doc, { chapterId: Number(chapterId) });
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

  // Popular is NOT gated, and the asymmetry with `latest` above is deliberate rather than an oversight.
  // In the Mihon source model a catalogue must implement popular -- it is the abstract method every
  // extension fills in -- while latest is the optional extra, which is exactly why `supportsLatest` exists
  // as a field and `supportsPopular` does not. So every enabled extension can answer this, and there is no
  // capability to probe. `fetchList` has accepted 'POPULAR' in its signature since it was written; this is
  // the first caller.
  adapter.popular = (page = 1) => fetchList('POPULAR', null, page);

  return adapter;
}
