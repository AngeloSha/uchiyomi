// Generic engine for WordPress "Madara"-themed manga sites. No specific site is hardcoded — `makeMadara`
// takes a base URL (supplied by the user via Admin → Providers → Add a site) and parses that site's markup.
// Cloudflare-protected sites work via the core's FlareSolverr client. Series ids are the manga page URL.
import { SourceAdapter, SourceSeries, SourceChapter } from '../types';
import { cfGet, cfPost } from '../flaresolverr';
import { parseWhen } from '../dates';
import { plainText } from '../../htmlText';
import { seriesSlug, isOwnChapterUrl, rebase } from '../slug';
import { pickImgUrl, pickImgUrlIn, pickAllImgUrls, dropRepeatedCovers } from '../imgAttr';
import { throwIfOffline } from '../offline';

/**
 * Anything of the theme's own (v0.49.1, lib/sources/offline.ts): result cards, a series page's parts, a chapter
 * list, a reader. A page carrying any of it is the site working, however little it parsed to; only a small page
 * with none of it whose title says the site is offline is the site saying so.
 */
export const MADARA_MARKUP = /post-title|wp-manga|manga-item|page-item-detail|c-tabs-item|tab-thumb|item-thumb|summary_content|summary__content|reading-content|\/manga\//i;

const strip = plainText;
const norm = (u: string) => u.replace(/^\/\//, 'https://').replace(/&amp;/g, '&').trim();

/**
 * The key a series' url is matched on WITHIN one parse. Not the url itself -- the url is the identity that
 * gets stored, and it is emitted untouched.
 *
 * ⚠️ THE PASSES BELOW READ THE SAME HREF OUT OF DIFFERENT MARKUP, AND THEY DO NOT AGREE ON THE TRAILING
 * SLASH. The thumbnail-fallback pattern ends `[^"/?#]+)\/?"` -- the `/?` sits OUTSIDE the capture -- so it
 * yields `/manga/blue-lock` where the heading pass yields `/manga/blue-lock/`. On a site that writes the
 * slash, `seen` therefore never matched, every series was emitted a SECOND time titled from its `<img alt>`,
 * and that copy carried no cover because the cover map was keyed the other way. Measured on a live
 * MangaRead listing: twelve series parsed as twenty-four, half of them blank -- and since `latestPage`
 * dedupes by sourceId and then takes 24, half the source's Discover feed was a copy of the other half.
 *
 * It hid because every fixture in madaraListing.test.ts writes urls WITHOUT the slash. The one shape that
 * breaks is the one shape the tests never used.
 *
 * Reintroduce by keying `covers` and `seen` on `norm(...)` directly: a slash-terminated listing doubles, and
 * the mirror case -- thumbnail href bare, heading href slashed -- loses every cover instead.
 */
const key = (u: string) => norm(u).replace(/\/+$/, '');

// Madara search-result and latest-listing pages share the same result-card markup, so parse both here.
export function parseResults(h: string, sourceId: string): SourceSeries[] {
  const covers = new Map<string, string>();
  // The rule lives in ../imgAttr now, because this engine was not the only place that needed it and the
  // other places all got it wrong. See that file for why the attribute cannot be chosen inside the regex.
  const pickSrc = pickImgUrl;

  // `tab-thumb` is stock Madara; `item-thumb`/`item-thumbnail` is what several themes ship instead, and
  // matching only the first meant those sites returned every title with no cover at all -- a wall of blank
  // cards. ManhuaPlus was one: fifteen results, fifteen thumbnails in the html, none of them found.
  for (const m of h.matchAll(/class="[^"]*(?:tab-thumb|item-thumb)[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>\s*(<img[^>]+>)/gi)) {
    const u = pickSrc(m[2]);
    if (u) covers.set(key(m[1]), norm(u));
  }
  // Some themes hang the thumbnail off the anchor with no wrapper class at all. Only consulted for urls the
  // pass above did not already resolve, so a real thumbnail always wins over a guess.
  for (const m of h.matchAll(/<a[^>]+href="([^"]+\/manga\/[^"]+)"[^>]*>\s*(<img[^>]+>)/gi)) {
    const k = key(m[1]);
    const u = pickSrc(m[2]);
    if (u && !covers.has(k)) covers.set(k, norm(u));
  }
  const out: SourceSeries[] = [];
  const seen = new Set<string>();
  // match `post-title` as a class token in any tag (div/h3/…) with extra classes — sites tweak this markup
  for (const m of h.matchAll(/class="[^"]*\bpost-title\b[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = norm(m[1]);
    const k = key(url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ sourceId: url, source: sourceId, title: strip(m[2]), url, coverUrl: covers.get(k) });
  }

  // A second way in, for themes whose cards carry a thumbnail but no `post-title` heading the pass above can
  // read. The name then comes from the img `alt`, which these themes do fill in. Anything already found
  // keeps the title the site put in its heading, so this only ever adds.
  //
  // Bounded to the CARD thumbnail wrappers rather than to every /manga/ link on the page. Unbounded it also
  // harvested the sidebar and "popular" widgets: sixty-three entries where the listing holds six, so the
  // wall would fill with perennially-popular titles instead of what is actually new.
  //
  // (Note for anyone counting: a listing showing fifteen cards for six series is normal and correct. The
  // same series appears once per recent chapter, and de-duplicating by url is the right answer.)
  for (const m of h.matchAll(/class="[^"]*(?:tab-thumb|item-thumb)[^"]*"[^>]*>\s*<a[^>]+href="([^"]+\/manga\/[^"/?#]+)\/?"[^>]*>\s*(<img[^>]+>)/gi)) {
    const url = norm(m[1]);
    const k = key(url);
    if (seen.has(k)) continue;
    const alt = (m[2].match(/\salt="([^"]+)"/i) || [])[1];
    if (!alt) continue;
    seen.add(k);
    out.push({ sourceId: url, source: sourceId, title: strip(alt), url, coverUrl: covers.get(k) });
  }
  // ⚠️ A cover shared by three or more of these is not a cover. Dropping it is the repair: showing one
  // picture on twenty cards is a confident lie, and nothing lets the real fallbacks take over. See imgAttr.
  return dropRepeatedCovers(out);
}

export function makeMadara(cfg: { id: string; name: string; base: string; order?: number }): SourceAdapter {
  const base = cfg.base.replace(/\/$/, '');
  const mangaUrl = (id: string) => (id.startsWith('http') ? rebase(id, base) : `${base}/manga/${id}/`);
  // Parsing lives at module scope so it can be tested against real markup; see madaraListing.test.ts.
  // A listing that parsed to nothing is either an empty answer or the site's offline notice (lib/sources/offline.ts):
  // the second throws, so nothing downstream mistakes a site that is down for one with nothing on it.
  const listing = (h: string): SourceSeries[] => {
    const out = parseResults(h, cfg.id);
    if (!out.length) throwIfOffline(h, MADARA_MARKUP);
    return out;
  };

  return {
    id: cfg.id,
    name: cfg.name,
    base,
    imageReferer: `${base}/`, // covers/images often live on a separate hotlink-protected CDN that wants the SITE origin as Referer
    // Madara sites serve pages + images from behind Cloudflare. Also read by the diagnosis layer: it is
    // what tells it that a 403 from a bare, solver-less probe is the challenge page, not a block.
    requiresCloudflare: true,
    preferredOrder: cfg.order,

    async search(query) {
      return listing(await cfGet(`${base}/?s=${encodeURIComponent(query)}&post_type=wp-manga`));
    },

    // Browse the site's most recently updated series (Madara's `m_orderby=latest` listing).
    async latest(page = 1) {
      const p = Math.max(1, page);
      const path = p > 1 ? `/page/${p}/?s=&post_type=wp-manga&m_orderby=latest` : `/?s=&post_type=wp-manga&m_orderby=latest`;
      return listing(await cfGet(`${base}${path}`));
    },

    // Identical query with a different sort key. Madara's listing takes `m_orderby=views` for the site's own
    // all-time popularity, and serves the same result cards, so `parseResults` -- already shared between
    // search and latest by design -- reads it unchanged.
    async popular(page = 1) {
      const p = Math.max(1, page);
      const path = p > 1 ? `/page/${p}/?s=&post_type=wp-manga&m_orderby=views` : `/?s=&post_type=wp-manga&m_orderby=views`;
      return listing(await cfGet(`${base}${path}`));
    },

    async getSeries(id) {
      const url = mangaUrl(id);
      const h = await cfGet(url);
      // Before anything is read off it: an offline notice's own <h1> would otherwise become the series' title.
      throwIfOffline(h, MADARA_MARKUP);
      const title = strip(
        (h.match(/<div class="post-title">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i) || h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '',
      );
      let summary = strip((h.match(/class="(?:summary__content|description-summary|manga-summary)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
      // guard: if the capture swept up an inline <style>/<script> block, it's not a real description
      if (summary.length > 2500 || /<\/?(?:style|script)\b|\.[a-z][\w-]*\s*[{,]|@import|gtag\(|wp-manga|woocommerce|settings-page|datalayer|sourceurl/i.test(summary)) summary = '';
      const genreBlock = (h.match(/class="genres-content"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
      const genres = [...genreBlock.matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((x) => x[1].trim());
      // ⚠️ This line is why some MangaRead covers were the site's `Read.gif` placeholder: the old form put
      // the alternation inside the regex, so attribute ORDER picked the winner, not us.
      const cover = pickImgUrlIn(h, /class="summary_image"/i);
      let status = strip((h.match(/Status[\s\S]*?summary-content[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
      // a real status is a short word ("Ongoing"/"Completed") — anything long/CSS-ish is a mis-capture.
      if (status.length > 40 || /[{}]|@import|settings-page|woocommerce/i.test(status)) status = '';
      return { sourceId: url, source: cfg.id, title, summary, genres, status: status || undefined, coverUrl: cover ? norm(cover) : undefined, url };
    },

    async listChapters(seriesId) {
      const url = mangaUrl(seriesId);
      // Only accept chapters that belong to THIS manga — sites embed "popular/hot chapters" widgets linking to
      // other titles, which would otherwise be scraped as phantom chapters. See lib/sources/slug.ts.
      const slug = seriesSlug(url);
      const mine = (u: string) => isOwnChapterUrl(u, slug);
      const parse = (h: string): SourceChapter[] => {
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
      };
      // Prefer Madara's ajax chapter partial, but some sites (e.g. ManhuaPlus) now return a bogus full page there
      // whose only chapter links are cross-title widgets — after slug-scoping that parses to nothing for THIS series.
      // When the ajax path yields no chapters, fall back to the main manga page, which carries the real chapter list.
      let out: SourceChapter[] = [];
      try { out = parse(await cfPost(`${url.replace(/\/$/, '')}/ajax/chapters/`, '')); } catch {}
      if (!out.length) {
        const h = await cfGet(url);
        out = parse(h);
        if (!out.length) throwIfOffline(h, MADARA_MARKUP);
      }
      return out;
    },

    async getPageUrls(chapterId) {
      const h = await cfGet(chapterId);
      const urls: string[] = [];
      // Pages, not covers -- and the LAZY form here failed on the opposite attribute order to the cover
      // above, so a lazy-loading theme served placeholder PAGES. Nobody had noticed.
      for (const m of h.matchAll(/<img\b[^>]*class="[^"]*wp-manga-chapter-img[^"]*"[^>]*>/gi)) {
        const u = pickImgUrl(m[0]);
        if (u) urls.push(norm(u));
      }
      if (!urls.length)
        for (const u of pickAllImgUrls(h)) {
          if (/\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(u)) urls.push(norm(u));
        }
      const pages = urls.filter((u) => /^https?:/.test(u));
      if (!pages.length) throwIfOffline(h, MADARA_MARKUP);
      return pages;
    },
  };
}
