// Generic engine for the Manganato/Mangakakalot family of manga sites (same markup engine). No specific site
// is hardcoded — `makeManganato` takes a base URL supplied by the user. Pages are behind Cloudflare → the
// core's FlareSolverr client. Series ids are the manga page URL.
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet } from '../flaresolverr';
import { parseWhen } from '../dates';
import { seriesSlug, isOwnChapterUrl } from '../slug';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();

/**
 * Series cards from a Manganato-family listing page, whichever markup it happens to be serving.
 *
 * Patterns are tried in order and the first that yields anything wins. The `title`-attribute form is the
 * most precise on current markup; the two below it are older layouts. Note the alt-text fallback already
 * handled the rebranded pages on its own -- these are belt and braces for a template pointed at whatever
 * Manganato-family site an operator names, not a fix for a specific site.
 */
export function parseListing(h: string, sourceId: string): SourceSeries[] {
  if (!h) return [];
  const covers = new Map<string, string>();
  for (const m of h.matchAll(/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi)) covers.set(norm(m[1]), norm(m[2]));

  const patterns: Array<[RegExp, 1 | 2]> = [
    // current: <a href=".../manga/slug" title="Name"><img ...>, inside .list-comic-item-wrap
    [/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*\stitle="([^"]+)"/gi, 2],
    // older Manganato: the name is the anchor's text under .genres-item-name / .item-title
    [/(?:genres-item-name|item-title)[^>]*>\s*<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, 2],
    // last resort: take it off the thumbnail's alt text
    [/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+alt="([^"]*?)"/gi, 2],
  ];

  for (const [re] of patterns) {
    const out: SourceSeries[] = [];
    const seen = new Set<string>();
    for (const m of h.matchAll(re)) {
      const url = norm(m[1]);
      const title = strip(m[2]).replace(/\s+class=.*$/i, '');
      // A listing page also links series from its sidebar and its "hot" carousel. Those are real series, so
      // they cannot be filtered by shape -- but they are few, and de-duplicating by url keeps them from
      // appearing twice. Order still follows the document, which is the listing itself.
      if (!title || seen.has(url)) continue;
      seen.add(url);
      out.push({ sourceId: url, source: sourceId, title, url, coverUrl: covers.get(url) });
    }
    if (out.length) return out;
  }
  return [];
}

export function makeManganato(cfg: { id: string; name: string; base: string; order?: number }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  const mangaUrl = (id: string) => (id.startsWith('http') ? id : `${base}/manga/${id}`);

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
