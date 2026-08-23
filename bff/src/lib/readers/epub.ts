// EPUB chapters, for the image kind.
//
// An EPUB is a zip, so it needs no new archive reader -- only a different answer to "which entries are the
// pages, and in what order". A CBZ has no order but the filenames, whereas an EPUB states its order in the
// spine, and manga bought from a store (BookWalker and friends ship fixed-layout EPUB) relies on it: the
// image files inside are routinely named by an internal id that natural-sorts wrong.
//
// TEXT EPUBs ARE NOT CHAPTERS, and that falls out rather than being enforced. A reflowable novel has no
// images in its spine, so it yields no pages, so listChapters does not count it. The README's "skips EPUB on
// purpose" was really "skips ebooks", and this keeps that true for the right reason: there is nothing for a
// manga reader to show, not a blanket refusal to open the file.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const StreamZip = require('node-stream-zip');

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;

/** Resolve `href` relative to the directory holding `base`, and normalise away any ./ and ../ */
function resolveHref(base: string, href: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  const parts = (dir ? dir + '/' : '') + decodeURIComponent(href.split('#')[0]);
  const out: string[] = [];
  for (const seg of parts.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? m[1] : null;
};

/**
 * The pages of an image EPUB, in spine order.
 *
 * Deliberately regex-driven rather than pulling in an XML parser: the OPF shapes that matter here are flat
 * and machine-written, and a malformed one must degrade to the fallback rather than throw. Returns [] for a
 * text EPUB, which is what makes it not a chapter.
 */
export async function epubPages(path: string): Promise<string[]> {
  const zip = new StreamZip.async({ file: path });
  try {
    const entries = await zip.entries();
    const has = (n: string) => Object.prototype.hasOwnProperty.call(entries, n) && !entries[n].isDirectory;
    const allImages = () =>
      Object.keys(entries).filter((n) => !entries[n].isDirectory && IMG.test(n)).sort();

    // container.xml names the OPF; without it there is no stated order to honour.
    let opfPath: string | null = null;
    if (has('META-INF/container.xml')) {
      const c = (await zip.entryData('META-INF/container.xml')).toString('utf8');
      const m = /<rootfile\b[^>]*>/i.exec(c);
      if (m) opfPath = attr(m[0], 'full-path');
    }
    if (!opfPath || !has(opfPath)) return allImages();

    const opf = (await zip.entryData(opfPath)).toString('utf8');

    // manifest: id -> { href, type }
    const manifest = new Map<string, { href: string; type: string }>();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = attr(m[0], 'id');
      const href = attr(m[0], 'href');
      if (id && href) manifest.set(id, { href, type: (attr(m[0], 'media-type') || '').toLowerCase() });
    }

    const pages: string[] = [];
    const seen = new Set<string>();
    const push = (p: string) => { if (p && has(p) && !seen.has(p)) { seen.add(p); pages.push(p); } };

    for (const ref of opf.matchAll(/<itemref\b[^>]*>/gi)) {
      const item = manifest.get(attr(ref[0], 'idref') || '');
      if (!item) continue;
      const target = resolveHref(opfPath, item.href);

      // A spine entry that IS an image (rare, but valid and used by some converters).
      if (item.type.startsWith('image/') || IMG.test(target)) { push(target); continue; }

      // The usual shape: a one-page XHTML wrapper around a single <img> or SVG <image>.
      if (!has(target)) continue;
      const html = (await zip.entryData(target)).toString('utf8');
      for (const tag of html.matchAll(/<(?:img|image)\b[^>]*>/gi)) {
        const src = attr(tag[0], 'src') || attr(tag[0], 'xlink:href') || attr(tag[0], 'href');
        if (src) push(resolveHref(target, src));
      }
    }

    // A spine that produced nothing is either a text ebook or a shape we did not understand. Fall back to
    // every image only when the spine yielded none at all, so a partially-understood spine is never mixed
    // with a guess.
    return pages.length ? pages : allImages();
  } catch {
    return [];
  } finally {
    await zip.close().catch(() => {});
  }
}

/** Whether this EPUB has anything a manga reader can show. */
export async function epubIsImageBased(path: string): Promise<boolean> {
  return (await epubPages(path)).length > 0;
}
