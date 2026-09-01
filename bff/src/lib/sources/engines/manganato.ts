// Generic engine for the Manganato/Mangakakalot family of manga sites (same markup engine). No specific site
// is hardcoded — `makeManganato` takes a base URL supplied by the user. Pages are behind Cloudflare → the
// core's FlareSolverr client. Series ids are the manga page URL.
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet } from '../flaresolverr';
import { parseWhen } from '../dates';
import { seriesSlug, isOwnChapterUrl, rebase } from '../slug';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();
/** The solver returns JSON inside an HTML <pre>, so the payload arrives entity-escaped. */
const unescapeHtml = (s: string) => s
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Series cards from a Manganato-family listing page, whichever markup it happens to be serving.
 *
 * Patterns are tried in order and the first that yields anything wins. The `title`-attribute form is the
 * most precise on current markup; the two below it are older layouts. Note the alt-text fallback already
 * handled the rebranded pages on its own -- these are belt and braces for a template pointed at whatever
 * Manganato-family site an operator names, not a fix for a specific site.
 */
/**
 * Is this a link to a SERIES, or to a chapter of one?
 *
 * Both live under `/manga/`: a series is `/manga/some-slug`, a chapter is `/manga/some-slug/chapter-12`.
 * Matching on `/manga/` alone therefore harvests every chapter link on the page as if it were a series, and
 * a listing page is full of them -- it shows the latest chapters beside each title. On natomanga that turned
 * twenty-four results into twelve real series and twelve entries called "Chapter 2", "Chapter 156", each
 * with no cover, because a chapter page has no cover to find.
 *
 * So: exactly one path segment after `/manga/`, and nothing that looks like a chapter.
 */
const isSeriesUrl = (u: string): boolean => /\/manga\/[^/?#]+\/?(?:[?#]|$)/.test(u) && !/\/chapter/i.test(u);

export function parseListing(h: string, sourceId: string): SourceSeries[] {
  if (!h) return [];
  const covers = new Map<string, string>();
  for (const m of h.matchAll(/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi)) {
    if (isSeriesUrl(m[1])) covers.set(norm(m[1]), norm(m[2]));
  }

  const patterns: Array<[RegExp, 1 | 2]> = [
    // current: <a href=".../manga/slug" title="Name"><img ...>, inside .list-comic-item-wrap
    [/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*\stitle="([^"]+)"/gi, 2],
    // older Manganato: the name is the anchor's text under .genres-item-name / .item-title
    [/(?:genres-item-name|item-title)[^>]*>\s*<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, 2],
    // last resort: take it off the thumbnail's alt text
    [/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+alt="([^"]*?)"/gi, 2],
  ];

  // Parse the CARDS, not the page. A listing also carries sidebar and "popular" widgets whose links have a
  // `title` attribute but no thumbnail beside them, and they sit early in the document -- so they crowded
  // out real results and arrived without covers. On natomanga that was thirteen of twenty-four entries with
  // no artwork. Splitting on the card wrapper first keeps the budget for actual listing entries; when a
  // theme has no such wrapper, the whole document is used exactly as before.
  const cards = h.split(/(?=class="[^"]*list-comic-item-wrap[^"]*")/i);
  const scope = cards.length > 1 ? cards.slice(1) : [h];

  for (const [re] of patterns) {
    const out: SourceSeries[] = [];
    const seen = new Set<string>();
    for (const m of scope.join('').matchAll(re)) {
      const url = norm(m[1]);
      const title = strip(m[2]).replace(/\s+class=.*$/i, '');
      // A listing page also links series from its sidebar and its "hot" carousel. Those are real series, so
      // they cannot be filtered by shape -- but they are few, and de-duplicating by url keeps them from
      // appearing twice. Order still follows the document, which is the listing itself.
      if (!title || seen.has(url) || !isSeriesUrl(url)) continue;
      seen.add(url);
      out.push({ sourceId: url, source: sourceId, title, url, coverUrl: covers.get(url) });
    }
    if (out.length) return out;
  }
  return [];
}

export function makeManganato(cfg: { id: string; name: string; base: string; order?: number }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  const mangaUrl = (id: string) => (id.startsWith('http') ? rebase(id, base) : `${base}/manga/${id}`);

  /**
   * The chapter list as JSON, paged.
   *
   * `/api/manga/<slug>/chapters` answers `{data:{chapters:[…],pagination:{total,limit,offset,has_more}}}`.
   * It caps at fifty per call whatever you ask for by default, so this walks `offset` until the server says
   * there is no more, rather than trusting one large `limit` that a future cap could quietly shrink.
   *
   * Returns [] rather than throwing when the site is not one of the ones that serves this, so the caller
   * falls back to scraping the page. Older Manganato-family sites do not have it.
   */
  const CHAPTER_PAGE = 200;   // asked for; the server may return fewer, which `has_more` then tells us
  const MAX_PAGES = 40;       // 8,000 chapters, far past the longest thing anyone reads. A stop, not a limit.

  async function apiChapters(seriesUrl: string): Promise<SourceChapter[]> {
    const slug = seriesSlug(seriesUrl);
    if (!slug) return [];
    const out: SourceChapter[] = [];
    const seen = new Set<number>();
    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      const raw = await cfGet(`${base}/api/manga/${slug}/chapters?limit=${CHAPTER_PAGE}&offset=${offset}`);
      // The solver hands back a browser's rendering of the JSON, so the body arrives inside <pre>.
      const body = (raw.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || [, raw])[1] || '';
      const data = JSON.parse(unescapeHtml(body).trim())?.data;
      const rows: any[] = data?.chapters || [];
      if (!rows.length) break;
      for (const r of rows) {
        const number = typeof r.chapter_num === 'number' ? r.chapter_num : parseFloat(r.chapter_num);
        if (!Number.isFinite(number) || seen.has(number)) continue;
        seen.add(number);
        const cslug = String(r.chapter_slug || '').replace(/^\/+/, '');
        if (!cslug) continue;
        out.push({
          sourceId: `${base}/manga/${slug}/${cslug}`,
          number,
          title: strip(String(r.chapter_name || `Chapter ${number}`)),
          publishedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
        });
      }
      const pg = data?.pagination;
      if (!pg?.has_more) break;
      offset += rows.length;
    }
    return out.sort((a, b) => a.number - b.number);
  }

  return {
    id: cfg.id,
    name: cfg.name,
    base,
    imageReferer: `${base}/`, // covers/images often live on a separate hotlink-protected CDN that wants the SITE origin as Referer
    requiresCloudflare: true, // Manganato-engine sites sit behind Cloudflare
    preferredOrder: cfg.order,

    async search(query) {
      const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const h = await cfGet(`${base}/search/story/${slug}`);
      // map each manga url → its thumbnail (the source's img alt is malformed, so titles come from story_name)
      const covers = new Map<string, string>();
      for (const m of h.matchAll(/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi)) covers.set(norm(m[1]), norm(m[2]));
      const out: SourceSeries[] = [];
      const seen = new Set<string>();
      for (const m of h.matchAll(/(?:story_name|item-title)[^>]*>\s*<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = norm(m[1]);
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ sourceId: url, source: cfg.id, title: strip(m[2]), url, coverUrl: covers.get(url) });
      }
      if (!out.length) {
        for (const m of h.matchAll(/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+alt="([^"]*?)"/gi)) {
          const url = norm(m[1]);
          if (seen.has(url)) continue;
          seen.add(url);
          out.push({ sourceId: url, source: cfg.id, title: strip(m[2]).replace(/\s+class=.*$/i, ''), url, coverUrl: covers.get(url) });
        }
      }
      return out;
    },

    /**
     * Browse the site's most recently updated series.
     *
     * Two listing layouts and two URL shapes, tried in order, because this engine template is pointed at
     * whatever Manganato-family site the operator names and they do not all move at once.
     *
     * THE PATH is what broke, not the parsing. `/genre-all` was the only path here, and both sites on this
     * install stopped serving it: it now answers 200 with a 20 KB stub carrying no series links at all.
     * Because an empty parse throws nothing, the sources reported no error and simply went quiet -- the
     * silent failure `reportLatest` exists to make visible. Mangakakalot and Natomanga had been returning
     * nothing for weeks and months respectively while still reporting healthy.
     *
     * Worth stating plainly, because it was mis-diagnosed once already: the current markup parses fine
     * under the pre-existing fallback. Nothing had to change about reading the page, only about which page
     * is asked for.
     */
    async latest(page = 1) {
      const p = Math.max(1, page);
      const paths = [
        `/manga-list/latest-manga${p > 1 ? `?page=${p}` : ''}`,
        `/genre-all${p > 1 ? `/${p}` : ''}`,
      ];
      for (const path of paths) {
        const h = await cfGet(`${base}${path}`).catch(() => '');
        const out = parseListing(h, cfg.id);
        if (out.length) return out;
      }
      return [];
    },

    /**
     * The site's own popularity listing.
     *
     * This family is the awkward one: the sort is a PATH SEGMENT, not a query parameter, so there is no
     * single URL that works everywhere and a wrong guess is indistinguishable from an empty page. Hence the
     * same candidate list `latest` uses -- try each, take the first that parses, give up quietly. Giving up
     * quietly is the right failure here: the source simply drops out of Popular rather than throwing, and a
     * listing that returns nothing is now recorded rather than silent.
     */
    async popular(page = 1) {
      const p = Math.max(1, page);
      const paths = [
        `/manga-list/hot-manga${p > 1 ? `?page=${p}` : ''}`,
        `/genre-all${p > 1 ? `/${p}` : ''}?type=topview`,
      ];
      for (const path of paths) {
        const h = await cfGet(`${base}${path}`).catch(() => '');
        const out = parseListing(h, cfg.id);
        if (out.length) return out;
      }
      return [];
    },

    async getSeries(id) {
      const url = mangaUrl(id);
      const h = await cfGet(url);
      const title = strip((h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || h.match(/property="og:title" content="([^"]+)"/i) || [])[1] || '');
      const summary = strip(
        (h.match(/(?:id|class)="[^"]*(?:panel-story-info-description|story-info-description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
          h.match(/property="og:description" content="([^"]+)"/i) ||
          h.match(/<meta name="description" content="([^"]+)"/i) ||
          [])[1] || '',
      ).replace(/^Description\s*:?\s*/i, '');
      const cover = (h.match(/class="[^"]*info-image[^"]*"[\s\S]{0,120}?<img[^>]+src="([^"]+)"/i) || h.match(/property="og:image" content="([^"]+)"/i) || [])[1];
      const genres = [...h.matchAll(/href="[^"]*\/genre[^"\/]*\/[^"]*"[^>]*>([^<]+)<\/a>/gi)].map((x) => strip(x[1])).filter(Boolean);
      return { sourceId: url, source: cfg.id, title, summary, genres, coverUrl: cover ? norm(cover) : undefined, url };
    },

    async listChapters(seriesId) {
      const url = mangaUrl(seriesId);
      // The JSON list first. The HTML below only ever carried the newest FIFTY chapters, and nothing on the
      // page said so: no pagination control, no "load more", just a list that stopped. Every series added
      // from a site on this engine therefore arrived truncated, silently, and the updater could not repair it
      // because it only ever asked the same page. On this install that was 7 of the 10 series from the two
      // manganato-family sources, about 528 chapters, and it took a reader hitting "chapter 93 is the first
      // one" to notice.
      //
      // The page itself names the endpoint that has the rest, in `data-api-url` on #chapter-list-container.
      // It also answers with a real `chapter_num` and a real `updated_at`, so this path is more accurate than
      // the scrape as well as more complete: no number parsed out of a URL, and a release date we otherwise
      // do not get from these sites at all.
      const viaApi = await apiChapters(url).catch(() => null);
      if (viaApi && viaApi.length) return viaApi;
      // Only accept chapters under THIS manga's slug — sidebar widgets link to other titles' chapters and would
      // otherwise be scraped as phantom chapters (e.g. a stray "2021"). See lib/sources/slug.ts.
      const slug = seriesSlug(url);
      const mine = (u: string) => isOwnChapterUrl(u, slug);
      const h = await cfGet(url);
      const out: SourceChapter[] = [];
      const seen = new Set<string>();
      // chapter rows carry a release date in the sibling <span class="chapter-time" title="Jul 01,2026 12:00">
      const dates = new Map<string, string>();
      for (const li of h.matchAll(/<li[^>]*class="[^"]*a-h[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
        const href = (li[1].match(/href="([^"]+\/chapter[^"]*)"/i) || [])[1];
        const when = parseWhen((li[1].match(/chapter-time[^>]*title="([^"]+)"/i) || li[1].match(/class="[^"]*chapter-time[^"]*"[^>]*>([^<]+)/i) || [])[1]);
        if (href && when) dates.set(norm(href), when);
      }
      for (const m of h.matchAll(/href="([^"]+\/manga\/[^"]+\/chapter[^"]*)"/gi)) {
        const cu = norm(m[1]);
        if (seen.has(cu) || !mine(cu)) continue;
        seen.add(cu);
        const num = parseFloat(((cu.match(/chapter[-_]([0-9]+(?:[.-][0-9]+)?)/i) || [])[1] || '').replace('-', '.'));
        if (!Number.isNaN(num)) out.push({ sourceId: cu, number: num, title: `Chapter ${num}`, publishedAt: dates.get(cu) });
      }
      return out.sort((a, b) => a.number - b.number);
    },

    async getPageUrls(chapterId) {
      const h = await cfGet(chapterId);
      const block = (h.match(/class="[^"]*container-chapter-reader[^"]*"[^>]*>([\s\S]*?)(?:<div class="container|<\/body)/i) || [])[1] || h;
      const urls: string[] = [];
      for (const m of block.matchAll(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"?]*)/gi)) urls.push(norm(m[1]));
      return urls.filter((u) => /^https?:/.test(u));
    },
  };
}
