// Generic engine for WordPress "Madara"-themed manga sites. No specific site is hardcoded — `makeMadara`
// takes a base URL (supplied by the user via Admin → Providers → Add a site) and parses that site's markup.
// Cloudflare-protected sites work via the core's FlareSolverr client. Series ids are the manga page URL.
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet, cfPost } from '../flaresolverr';
import { parseWhen } from '../dates';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();

export function makeMadara(cfg: { id: string; name: string; base: string; order?: number }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  const mangaUrl = (id: string) => (id.startsWith('http') ? id : `${base}/manga/${id}/`);
  // Madara search-result and latest-listing pages share the same result-card markup, so parse both here.
  const parseResults = (h: string): SourceSeries[] => {
    const covers = new Map<string, string>();
    for (const m of h.matchAll(/class="[^"]*tab-thumb[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>\s*<img[^>]+(?:data-src|src)="([^"]+)"/gi)) {
      covers.set(norm(m[1]), norm(m[2]));
    }
    const out: SourceSeries[] = [];
    const seen = new Set<string>();
    // match `post-title` as a class token in any tag (div/h3/…) with extra classes — sites tweak this markup
    for (const m of h.matchAll(/class="[^"]*\bpost-title\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = norm(m[1]);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ sourceId: url, source: cfg.id, title: strip(m[2]), url, coverUrl: covers.get(url) });
    }
    return out;
  };

  return {
    id: cfg.id,
    name: cfg.name,
    imageReferer: `${base}/`, // covers/images often live on a separate hotlink-protected CDN that wants the SITE origin as Referer
    requiresCloudflare: true, // Madara sites serve pages + images from behind Cloudflare
    preferredOrder: cfg.order,

    async search(query) {
      return parseResults(await cfGet(`${base}/?s=${encodeURIComponent(query)}&post_type=wp-manga`));
    },

    // Browse the site's most recently updated series (Madara's `m_orderby=latest` listing).
    async latest(page = 1) {
      const p = Math.max(1, page);
      const path = p > 1 ? `/page/${p}/?s=&post_type=wp-manga&m_orderby=latest` : `/?s=&post_type=wp-manga&m_orderby=latest`;
      return parseResults(await cfGet(`${base}${path}`));
    },

    async getSeries(id) {
      const url = mangaUrl(id);
      const h = await cfGet(url);
      const title = strip(
        (h.match(/<div class="post-title">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i) || h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '',
      );
      let summary = strip((h.match(/class="(?:summary__content|description-summary|manga-summary)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
      // guard: if the capture swept up an inline <style>/<script> block, it's not a real description
      if (summary.length > 2500 || /<\/?(?:style|script)\b|\.[a-z][\w-]*\s*[{,]|@import|gtag\(|wp-manga|woocommerce|settings-page|datalayer|sourceurl/i.test(summary)) summary = '';
      const genreBlock = (h.match(/class="genres-content"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
      const genres = [...genreBlock.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((x) => x[1].trim());
      const cover = (h.match(/class="summary_image"[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"/i) || [])[1];
      let status = strip((h.match(/Status[\s\S]*?summary-content[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
      // a real status is a short word ("Ongoing"/"Completed") — anything long/CSS-ish is a mis-capture.
      if (status.length > 40 || /[{}]|@import|settings-page|woocommerce/i.test(status)) status = '';
      return { sourceId: url, source: cfg.id, title, summary, genres, status: status || undefined, coverUrl: cover ? norm(cover) : undefined, url };
    },

    async listChapters(seriesId) {
      const url = mangaUrl(seriesId);
      // Only accept chapters that belong to THIS manga. Sites embed "popular/hot chapters" widgets linking to
      // OTHER titles; without this scope those get scraped as phantom chapters (e.g. Martial Peak ch. 3862 on a
      // Necromancer page). We compare the manga-slug in each chapter url to the series slug.
      const slug = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()!.toLowerCase();
      const mine = (u: string) => {
        const m = u.toLowerCase().match(/\/([^/]+)\/chapter[-_/]/);
        if (!slug || !m) return true;                       // can't identify the chapter's manga → keep (lenient)
        const cs = m[1];
        return cs === slug || cs.startsWith(slug) || slug.startsWith(cs); // same title (allow slug aliases), reject others
      };
      let h = '';
      try { h = await cfPost(`${url.replace(/\/$/, '')}/ajax/chapters/`, ''); } catch {}
      if (!/chapter/i.test(h)) h = await cfGet(url);
      const out: SourceChapter[] = [];
      // standard Madara: <li class="wp-manga-chapter"><a href="...">Chapter N</a> … <span class="chapter-release-date">…</span></li>
      for (const li of h.matchAll(/<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
        const m = li[1].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!m || !mine(norm(m[1]))) continue;
        const label = strip(m[2]);
        const num = parseFloat((label.match(/(\d+(?:\.\d+)?)/) || [])[1]);
        if (Number.isNaN(num)) continue;
        const when = parseWhen((li[1].match(/chapter-release-date[^>]*>([\s\S]*?)<\/(?:span|div)>/i) || [])[1]);
        out.push({ sourceId: norm(m[1]), number: num, title: label, publishedAt: when });
      }
      // Madara variants: plain links like /manga/<slug>/chapter-N
      if (!out.length) {
        const seenU = new Set<string>();
        for (const m of h.matchAll(/href="([^"]*\/chapter[-/][0-9][^"]*)"/gi)) {
          const cu = norm(m[1]);
          if (seenU.has(cu) || !mine(cu)) continue;
          seenU.add(cu);
          const num = parseFloat(((cu.match(/chapter[-/]([0-9]+(?:[.-][0-9]+)?)/i) || [])[1] || '').replace('-', '.'));
          if (!Number.isNaN(num)) out.push({ sourceId: cu, number: num, title: `Chapter ${num}` });
        }
      }
      const seen = new Set<number>();
      return out.filter((c) => (seen.has(c.number) ? false : (seen.add(c.number), true))).sort((a, b) => a.number - b.number);
    },

    async getPageUrls(chapterId) {
      const h = await cfGet(chapterId);
      const urls: string[] = [];
      for (const m of h.matchAll(/class="[^"]*wp-manga-chapter-img[^"]*"[^>]*?(?:data-src|src)="([^"]+)"/gi)) urls.push(norm(m[1]));
      if (!urls.length)
        for (const m of h.matchAll(/<img[^>]+(?:data-src|src)="([^"]+\.(?:jpg|jpeg|png|webp)[^"?]*)[^"]*"/gi)) urls.push(norm(m[1]));
      return urls.filter((u) => /^https?:/.test(u));
    },
  };
}
