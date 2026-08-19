// Generic engine for the Manganato/Mangakakalot family of manga sites (same markup engine). No specific site
// is hardcoded — `makeManganato` takes a base URL supplied by the user. Pages are behind Cloudflare → the
// core's FlareSolverr client. Series ids are the manga page URL.
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet } from '../flaresolverr';
import { parseWhen } from '../dates';
import { seriesSlug, isOwnChapterUrl } from '../slug';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();

export function makeManganato(cfg: { id: string; name: string; base: string; order?: number }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  const mangaUrl = (id: string) => (id.startsWith('http') ? id : `${base}/manga/${id}`);

  return {
    id: cfg.id,
    name: cfg.name,
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

    // Browse the site's most recently updated series (Manganato's /genre-all listing, default latest order).
    async latest(page = 1) {
      const p = Math.max(1, page);
      const h = await cfGet(`${base}/genre-all${p > 1 ? `/${p}` : ''}`);
      const covers = new Map<string, string>();
      for (const m of h.matchAll(/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*<img[^>]+src="([^"]+)"/gi)) covers.set(norm(m[1]), norm(m[2]));
      const out: SourceSeries[] = [];
      const seen = new Set<string>();
      for (const m of h.matchAll(/(?:genres-item-name|item-title)[^>]*>\s*<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
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
