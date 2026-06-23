// Generic engine for the "MangaThemesia" (a.k.a. WP-Mangastream / Themesia) WordPress theme — the second
// biggest manga-site family after Madara. No specific site is hardcoded — `makeMangaThemesia` takes a base URL
// supplied by the user. Most are behind Cloudflare → the core's FlareSolverr client. Series ids are the full
// series page URL (search returns them), so /series, /manga or /komik path prefixes all work.
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet } from '../flaresolverr';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();
const numOf = (s: string) => { const m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN; };

export function makeMangaThemesia(cfg: { id: string; name: string; base: string; order?: number }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');

  return {
    id: cfg.id,
    name: cfg.name,
    imageReferer: `${base}/`, // covers/images often live on a separate hotlink-protected CDN that wants the SITE origin as Referer
    requiresCloudflare: true,
    preferredOrder: cfg.order,

    async search(query) {
      const h = await cfGet(`${base}/?s=${encodeURIComponent(query)}`);
      const out: SourceSeries[] = [];
      const seen = new Set<string>();
      // result cards: <div class="bsx"><a href="<series>" title="<title>"> … <img data-src/src="<cover>">
      for (const m of h.matchAll(/<div class="bsx">\s*<a[^>]+href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = norm(m[1]);
        if (seen.has(url)) continue;
        seen.add(url);
        const cover = (m[3].match(/<img[^>]+(?:data-src|src)="([^"]+)"/i) || [])[1];
        out.push({ sourceId: url, source: cfg.id, title: strip(m[2]), url, coverUrl: cover ? norm(cover) : undefined });
      }
      return out;
    },

    async getSeries(id) {
      const url = id.startsWith('http') ? id : `${base}/manga/${id}/`;
      const h = await cfGet(url);
      const title = strip((h.match(/class="entry-title"[^>]*>([\s\S]*?)<\/h1>/i) || h.match(/property="og:title" content="([^"]+)"/i) || [])[1] || '');
      let summary = strip((h.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/i) || h.match(/property="og:description" content="([^"]+)"/i) || [])[1] || '');
      if (/<\/?(?:style|script)\b/i.test(summary)) summary = '';
      const cover = (h.match(/class="thumb"[\s\S]{0,160}?<img[^>]+(?:data-src|src)="([^"]+)"/i) || h.match(/property="og:image" content="([^"]+)"/i) || [])[1];
      const gblock = (h.match(/class="mgen"[^>]*>([\s\S]*?)<\/div>/i) || h.match(/class="seriestugenre"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
      const genres = [...gblock.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((x) => x[1].trim());
      const status = strip((h.match(/class="imptdt"[^>]*>\s*Status\s*<i>([\s\S]*?)<\/i>/i) || [])[1] || '');
      return { sourceId: url, source: cfg.id, title, summary, genres, status: status || undefined, coverUrl: cover ? norm(cover) : undefined, url };
    },

    async listChapters(seriesId) {
      const url = seriesId.startsWith('http') ? seriesId : `${base}/manga/${seriesId}/`;
      const h = await cfGet(url);
      const out: SourceChapter[] = [];
      const seen = new Set<string>();
      // #chapterlist <li data-num> … <a href="<chapter>"> … <span class="chapternum">Chapter N</span>
      for (const m of h.matchAll(/<li[^>]*data-num=[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<span class="chapternum">([\s\S]*?)<\/span>/gi)) {
        const cu = norm(m[1]);
        const num = numOf(strip(m[2]));
        if (!seen.has(cu) && !Number.isNaN(num)) { seen.add(cu); out.push({ sourceId: cu, number: num, title: strip(m[2]) }); }
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
      for (const mm of area.matchAll(/<img[^>]+(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"?]*)/gi)) urls.push(norm(mm[1]));
      return urls.filter((u) => /^https?:/.test(u));
    },
  };
}
