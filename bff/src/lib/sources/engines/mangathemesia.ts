// Generic engine for the "MangaThemesia" (a.k.a. WP-Mangastream / Themesia) WordPress theme — the second
// biggest manga-site family after Madara. No specific site is hardcoded — `makeMangaThemesia` takes a base URL
// supplied by the user. Most are behind Cloudflare → the core's FlareSolverr client. Series ids are the full
// series page URL (search returns them), so /series, /manga or /komik path prefixes all work.
import { rebase } from '../slug';
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet } from '../flaresolverr';
import { parseWhen } from '../dates';
import { plainText } from '../../htmlText';
import { pickImgUrlIn, pickAllImgUrls, dropRepeatedCovers } from '../imgAttr';

const strip = plainText;
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();
const numOf = (s: string) => { const m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN; };

export function makeMangaThemesia(cfg: { id: string; name: string; base: string; order?: number; lang?: string }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  // Search results and the /manga/?order=update listing share the same `.bsx` cards, so parse both here.
  const parseBsx = (h: string): SourceSeries[] => {
    const out: SourceSeries[] = [];
    const seen = new Set<string>();
    for (const m of h.matchAll(/<div class="bsx">\s*<a[^>]+href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = norm(m[1]);
      if (seen.has(url)) continue;
      seen.add(url);
      const cover = pickImgUrlIn(m[3]);
      out.push({ sourceId: url, source: cfg.id, title: strip(m[2]), url, coverUrl: cover ? norm(cover) : undefined });
    }
    // See madara's parseResults and imgAttr: a cover on three or more cards is a placeholder, not art.
    return dropRepeatedCovers(out);
  };

  return {
    id: cfg.id,
    name: cfg.name,
    // The site's own language (v0.62.0, customSites.ts Site.lang); absent, the unstated one.
    ...(cfg.lang ? { lang: cfg.lang } : {}),
    base,
    imageReferer: `${base}/`, // covers/images often live on a separate hotlink-protected CDN that wants the SITE origin as Referer
    requiresCloudflare: true,
    preferredOrder: cfg.order,

    async search(query) {
      return parseBsx(await cfGet(`${base}/?s=${encodeURIComponent(query)}`));
    },

    // Browse the site's most recently updated series (MangaThemesia's /manga/?order=update listing).
    async latest(page = 1) {
      const p = Math.max(1, page);
      const path = p > 1 ? `/manga/?page=${p}&order=update` : `/manga/?order=update`;
      return parseBsx(await cfGet(`${base}${path}`));
    },

    // The same listing endpoint; `order` is just the sort key. The theme's own popularity ranking, and
    // `parseBsx` is shared with search and latest already, so nothing new is parsed.
    async popular(page = 1) {
      const p = Math.max(1, page);
      const path = p > 1 ? `/manga/?page=${p}&order=popular` : `/manga/?order=popular`;
      return parseBsx(await cfGet(`${base}${path}`));
    },

    async getSeries(id) {
      const url = id.startsWith('http') ? rebase(id, base) : `${base}/manga/${id}/`;
      const h = await cfGet(url);
      const title = strip((h.match(/class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i) || h.match(/property="og:title" content="([^"]+)"/i) || [])[1] || '');
      let summary = strip((h.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/i) || h.match(/property="og:description" content="([^"]+)"/i) || [])[1] || '');
      if (/<\/?(?:style|script)\b/i.test(summary)) summary = '';
      const cover = pickImgUrlIn(h, /class="thumb"/i) || (h.match(/property="og:image" content="([^"]+)"/i) || [])[1];
      const gblock = (h.match(/class="mgen"[^>]*>([\s\S]*?)<\/div>/i) || h.match(/class="seriestugenre"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
      const genres = [...gblock.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((x) => x[1].trim());
      const status = strip((h.match(/class="imptdt"[^>]*>\s*Status\s*<i>([\s\S]*?)<\/i>/i) || [])[1] || '');
      return { sourceId: url, source: cfg.id, title, summary, genres, status: status || undefined, coverUrl: cover ? norm(cover) : undefined, url };
    },

    async listChapters(seriesId) {
      const url = seriesId.startsWith('http') ? rebase(seriesId, base) : `${base}/manga/${seriesId}/`;
      const h = await cfGet(url);
      const out: SourceChapter[] = [];
      const seen = new Set<string>();
      // #chapterlist <li data-num> … <a href="<chapter>"> … <span class="chapternum">Chapter N</span> <span class="chapterdate">DATE</span>
      for (const m of h.matchAll(/<li[^>]*data-num=[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<span class="chapternum">([\s\S]*?)<\/span>(?:\s*<span class="chapterdate">([\s\S]*?)<\/span>)?/gi)) {
        const cu = norm(m[1]);
        const num = numOf(strip(m[2]));
        if (!seen.has(cu) && !Number.isNaN(num)) { seen.add(cu); out.push({ sourceId: cu, number: num, title: strip(m[2]), publishedAt: parseWhen(m[3]) }); }
      }
      // fallback: any anchor directly wrapping a chapternum span
      if (!out.length) {
        for (const m of h.matchAll(/<a[^>]+href="([^"]+)"[^>]*>\s*<span class="chapternum">([\s\S]*?)<\/span>/gi)) {
          const cu = norm(m[1]);
          const num = numOf(strip(m[2]));
          if (!seen.has(cu) && !Number.isNaN(num)) { seen.add(cu); out.push({ sourceId: cu, number: num, title: strip(m[2]) }); }
        }
      }
      return out.sort((a, b) => a.number - b.number);
    },

    async getPageUrls(chapterId) {
      const h = await cfGet(chapterId);
      // pages live in a ts_reader.run({ sources:[{ images:[...] }] }) script blob
      const m = h.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
      if (m) {
        try {
          const j = JSON.parse(m[1]);
          const imgs: string[] = (j.sources && j.sources[0] && j.sources[0].images) || [];
          if (imgs.length) return imgs.map(norm).filter((u) => /^https?:/.test(u));
        } catch { /* fall through */ }
      }
      const area = (h.match(/id="readerarea"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) || [])[1] || h;
      const urls: string[] = [];
      for (const u of pickAllImgUrls(area)) {
        if (/\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(u)) urls.push(norm(u));
      }
      return urls.filter((u) => /^https?:/.test(u));
    },
  };
}
