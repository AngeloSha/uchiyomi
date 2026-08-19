import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { IMG_COOKIE, resolveOpdsBasic } from '../lib/auth';
import { komga, komgaImage } from '../lib/komga';
import { serveImage, getOrFetch } from '../lib/imageCache';
import { dominantHex } from '../lib/color';
import { fetchAniListArt } from '../lib/anilist';
import { linkSeries } from '../lib/trackers';
import { LIBRARY_ROOT, cbzPages, cbzEntry } from '../lib/library';
import { cfSession } from '../lib/sources/flaresolverr';
import { getSource } from '../lib/sources';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { q, one } from '../lib/db';
import { artFile } from '../lib/seriesArt';
import { HERO_FRAMES, heroFit, type HeroAr } from '../lib/heroFrame';

async function fetchUpstream(path: string): Promise<Buffer> {
  const res = await komgaImage(path);
  if (res.statusCode >= 400) {
    const t = await res.body.text();
    throw Object.assign(new Error(`upstream ${res.statusCode}`), { statusCode: res.statusCode, body: t });
  }
  return Buffer.from(await res.body.arrayBuffer());
}

async function fetchUpstreamWithType(path: string): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await komgaImage(path);
  if (res.statusCode >= 400) {
    const t = await res.body.text();
    throw Object.assign(new Error(`upstream ${res.statusCode}`), { statusCode: res.statusCode, body: t });
  }
  return {
    buffer: Buffer.from(await res.body.arrayBuffer()),
    contentType: (res.headers['content-type'] as string) || 'image/jpeg',
  };
}

/** Fetch a remote cover image as raw bytes. Sends browser-ish headers (AniList/MangaDex CDNs reject bare
 *  requests) and, for Cloudflare-protected source hosts (Aqua/ManhuaPlus), attaches FlareSolverr cookies. */
async function fetchCoverImage(u: string, source?: string): Promise<Buffer> {
  const src = source ? getSource(source) : null;
  const staticReferer = typeof src?.imageReferer === 'string' ? src.imageReferer : undefined;
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site',
    referer: staticReferer ?? `${new URL(u).origin}/`,
  };
  if (src?.requiresCloudflare) {
    // Best-effort: many sources host covers on a separate CDN that ISN'T Cloudflare-protected, where
    // FlareSolverr fails to "solve a challenge". Don't let that abort the cover — the Referer alone is
    // usually enough. Attach cf cookies when we can; otherwise fall through to a plain fetch.
    try {
      const s = await cfSession(u);
      headers.cookie = s.cookie;
      headers['user-agent'] = s.userAgent;
    } catch {
      /* image host isn't behind Cloudflare — proceed with the referer-only headers */
    }
  }
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error('cover'), { statusCode: r.status });
  return Buffer.from(await r.arrayBuffer());
}

// ---- series backdrop recipes (module-level so the pre-warmer can build them without a request) ----
const bookFileAbs = async (id: string): Promise<string | null> => {
  const r = await one<{ file: string; root: string }>('SELECT file, root FROM lib_books WHERE id = $1', [id]);
  return r ? join(r.root || LIBRARY_ROOT, r.file) : null;
};
// Bytes of a series' first downloaded page — the universal fallback when a remote cover/backdrop URL can't be
// fetched (hotlink-protected CDN, dead link, timeout, unparsed cover). Guarantees art for any downloaded series.
const firstPageInput = async (id: string): Promise<Buffer> => {
  const s = await one<{ cover_book_id: string }>('SELECT cover_book_id FROM lib_series WHERE id = $1', [id]);
  const abs = s?.cover_book_id ? await bookFileAbs(s.cover_book_id) : null;
  if (!abs) throw Object.assign(new Error('no cover'), { statusCode: 404 });
  const pages = await cbzPages(abs);
  if (!pages[0]) throw Object.assign(new Error('empty'), { statusCode: 404 });
  return cbzEntry(abs, pages[0]);
};

// Hero frames match the two client viewports (lg desktop strip / phone portrait) so the browser barely crops.
const ambientComposite = (input: Buffer) =>
  sharp(input).resize(1600, 1024, { fit: 'cover' }).blur(22).modulate({ brightness: 0.82, saturation: 1.18 }).webp({ quality: 80 }).toBuffer();
const heroSharp = async (input: Buffer, ar: HeroAr) => {
  const f = HERO_FRAMES[ar];
  const meta = await sharp(input).metadata();
  if (heroFit(meta.width ?? 0, meta.height ?? 0, ar) === 'crop') {
    // shapes are close — a mild saliency crop fills the frame without wrecking the art
    return sharp(input).resize(f.w, f.h, { fit: 'cover', position: 'attention' }).modulate({ brightness: 0.95 }).webp({ quality: 82 }).toBuffer();
  }
  // shapes differ a lot — sharp art shown whole over a blurred self-fill (no crop, no zoom)
  const fg = await sharp(input).resize(f.w, f.h, { fit: 'inside' }).toBuffer();
  return sharp(input)
    .resize(f.w, f.h, { fit: 'cover' })
    .blur(28)
    .modulate({ brightness: 0.62, saturation: 1.15 })
    .composite([{ input: fg, gravity: 'centre' }])
    .webp({ quality: 82 })
    .toBuffer();
};

/** Resolve a backdrop's cache variant + producer for (series, style, frame) — shared by the route and warmer. */
async function backdropRecipe(id: string, hero: boolean, ar: HeroAr): Promise<{ variant: string; producer: () => Promise<{ buffer: Buffer; contentType: string }> }> {
  // admin override wins (uploaded banner/cover or pasted URL)
  const ovr = await one<{ banner: string | null; v: string }>('SELECT banner, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM series_overrides WHERE series_id = $1', [id]);
  if (ovr?.banner) {
    return {
      variant: `artw7${hero ? `h${ar}` : ''}:${id}:ov:${Math.floor(Number(ovr.v))}`,
      producer: async () => {
        let input: Buffer;
        if (ovr.banner === 'upload') input = await readFile(artFile(id, 'banner'));
        else { try { input = await fetchCoverImage(ovr.banner!); } catch { input = await firstPageInput(id); } }
        const buffer = hero ? await heroSharp(input, ar) : await ambientComposite(input);
        return { buffer, contentType: 'image/webp' };
      },
    };
  }
  let art = await one<{ banner: string | null; cover: string | null }>('SELECT banner, cover FROM series_art WHERE series_id = $1', [id]);
  if (!art) {
    try {
      let title = '';
      try {
        const lib = await one<{ title: string }>('SELECT title FROM lib_series WHERE id = $1', [id]);
        if (lib?.title) title = lib.title;
        else { const s = await komga.series(id); title = s?.metadata?.title || s?.name || ''; }
      } catch {}
      const fetched = title ? await fetchAniListArt(title) : { banner: null, cover: null };
      await q(
        `INSERT INTO series_art (series_id, banner, cover) VALUES ($1, $2, $3)
         ON CONFLICT (series_id) DO UPDATE SET banner = EXCLUDED.banner, cover = EXCLUDED.cover, fetched_at = now()`,
        [id, fetched.banner, fetched.cover],
      );
      // the same match also anchors tracker sync — record it while we have it
      if (fetched.mediaId) await linkSeries(id, fetched.mediaId, fetched.mediaTitle ?? null);
      art = fetched;
    } catch {
      art = { banner: null, cover: null }; // transient AniList error: don't cache; fall back this view
    }
  }
  const url = art.banner || art.cover;
  const sharpHero = hero && !!url; // banner OR cover: show the real art sharp; only the no-art first-page fallback stays ambient
  const variant = url ? `artw${sharpHero ? `7h${ar}` : '6'}:${id}:${art.banner ? 'b' : 'c'}` : `artw6:${id}:p`;
  const srcRow = await one<{ source_id: string | null }>('SELECT source_id FROM lib_series WHERE id = $1', [id]);
  return {
    variant,
    producer: async () => {
      // remote art (AniList banner / source cover) first; fall back to the first downloaded page so the hero is never empty
      let input: Buffer;
      try {
        if (!url) throw new Error('no remote art');
        input = await fetchCoverImage(url, srcRow?.source_id || undefined);
      } catch {
        input = await firstPageInput(id);
      }
      const buffer = sharpHero ? await heroSharp(input, ar) : await ambientComposite(input);
      return { buffer, contentType: 'image/webp' };
    },
  };
}

/** Pre-generate both hero frames for a set of series so the carousel never waits on sharp/remote fetches.
 *  Disk-cache aware (getOrFetch): already-warm entries cost one stat() each. Fire-and-forget. */
const warmed = new Set<string>();
export async function warmHeroBackdrops(ids: string[]): Promise<void> {
  for (const id of ids) {
    for (const ar of ['wide', 'tall'] as const) {
      const tag = `${id}:${ar}`;
      if (warmed.has(tag)) continue;
      try {
        const r = await backdropRecipe(id, true, ar);
        await getOrFetch(r.variant, r.producer);
        warmed.add(tag);
      } catch { /* warming is best-effort */ }
    }
  }
}

export default async function imageRoutes(app: FastifyInstance) {
  // Browser <img> tags can't set Authorization; authorize via the stateless yomi_img cookie.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[IMG_COOKIE];
    if (token) { try { app.jwt.verify(token); return; } catch { /* fall through to OPDS auth */ } }
    // OPDS readers load covers/pages with the same HTTP Basic token as the feed
    if (await resolveOpdsBasic(req.headers.authorization)) return;
    return reply.code(401).send({ error: 'unauthorized' });
  });

  // ---- owned library image helpers: serve thumbnails + pages straight from the CBZ files ----
  const libCt = (name: string): string => {
    const e = name.toLowerCase().split('.').pop() || '';
    return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : e === 'avif' ? 'image/avif' : 'image/jpeg';
  };
  const storeColor = (id: string, input: Buffer) =>
    dominantHex(input)
      .then((hex) => q(`INSERT INTO series_colors (series_id, color) VALUES ($1,$2)
        ON CONFLICT (series_id) DO UPDATE SET color=EXCLUDED.color, updated_at=now()`, [id, hex]))
      .catch(() => {});
  // Hi-res poster variants: covers default to 400px (cards), the detail poster + hero request 800/1600.
  // Only whitelisted widths are honored so the cache can't be spammed with arbitrary sizes.
  const thumbWidth = (req: FastifyRequest): number => {
    const w = Number((req.query as any)?.w);
    return w === 800 || w === 1600 ? w : 400;
  };
  // Series cover: prefer the real cover art (AniList, cached in series_art.cover); fall back to the first
  // page of chapter 1. Distinct cache variants so it upgrades to the real cover once one is known.
  const serveLibSeriesThumb = async (req: FastifyRequest, reply: FastifyReply, id: string) => {
    const w = thumbWidth(req);
    const wk = w === 400 ? '' : `:w${w}`; // 400 keeps the legacy cache key so existing entries stay warm
    // admin override wins (uploaded file or pasted URL); variant carries updated_at so edits bust the cache
    const ovr = await one<{ cover: string | null; v: string }>('SELECT cover, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM series_overrides WHERE series_id = $1', [id]);
    if (ovr?.cover) {
      return serveImage(req, reply, `lib-sthumb:${id}:ov:${Math.floor(Number(ovr.v))}${wk}`, async () => {
        let input: Buffer;
        if (ovr.cover === 'upload') input = await readFile(artFile(id, 'cover'));
        else { try { input = await fetchCoverImage(ovr.cover!); } catch { input = await firstPageInput(id); } }
        storeColor(id, input);
        const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }
    const art = await one<{ cover: string | null; source_id: string | null }>(
      'SELECT a.cover, s.source_id FROM series_art a LEFT JOIN lib_series s ON s.id = a.series_id WHERE a.series_id = $1', [id]);
    if (art?.cover) {
      return serveImage(req, reply, `lib-sthumb:${id}:c${wk}`, async () => {
        // remote cover first; on ANY failure (hotlink CDN, dead link, timeout) fall back to the first page
        let input: Buffer;
        try { input = await fetchCoverImage(art.cover!, art.source_id || undefined); }
        catch { input = await firstPageInput(id); }
        storeColor(id, input);
        const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }
    return serveImage(req, reply, `lib-sthumb:${id}:p${wk}`, async () => {
      const input = await firstPageInput(id);
      storeColor(id, input);
      const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  };
  const serveLibBookThumb = (req: FastifyRequest, reply: FastifyReply, id: string) =>
    serveImage(req, reply, `lib-bthumb:${id}`, async () => {
      const abs = await bookFileAbs(id);
      if (!abs) throw Object.assign(new Error('no book'), { statusCode: 404 });
      const pages = await cbzPages(abs);
      if (!pages[0]) throw Object.assign(new Error('empty'), { statusCode: 404 });
      q('UPDATE lib_books SET pages=$1 WHERE id=$2 AND pages<>$1', [pages.length, id]).catch(() => {});
      const input = await cbzEntry(abs, pages[0]);
      const buffer = await sharp(input).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  const serveLibBookPage = async (req: FastifyRequest, reply: FastifyReply, id: string, pageNo: number, w: number) => {
    const abs = await bookFileAbs(id);
    if (!abs) return reply.code(404).send({ error: 'no_book' });
    if (w && Number.isInteger(w) && w >= 64 && w <= 2000) {
      return serveImage(req, reply, `lib-page:${id}:${pageNo}:w${w}`, async () => {
        const name = (await cbzPages(abs))[pageNo - 1];
        if (!name) throw Object.assign(new Error('no page'), { statusCode: 404 });
        const buffer = await sharp(await cbzEntry(abs, name)).resize({ width: w, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }
    return serveImage(req, reply, `lib-page:${id}:${pageNo}`, async () => {
      const pages = await cbzPages(abs);
      q('UPDATE lib_books SET pages=$1 WHERE id=$2 AND pages<>$1', [pages.length, id]).catch(() => {});
      const name = pages[pageNo - 1];
      if (!name) throw Object.assign(new Error('no page'), { statusCode: 404 });
      return { buffer: await cbzEntry(abs, name), contentType: libCt(name) };
    });
  };

  // Series cover thumbnail -> webp (400px default; ?w=800|1600 for the detail poster / hero).
  app.get('/img/series/:id/thumb', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.startsWith('s_')) return serveLibSeriesThumb(req, reply, id);
    const w = thumbWidth(req);
    return serveImage(req, reply, `series-thumb:${id}:webp:${w}`, async () => {
      const input = await fetchUpstream(komga.seriesThumbPath(id));
      // ambient theming: store the cover's dominant color (fire-and-forget, once per cover)
      dominantHex(input)
        .then((hex) =>
          q(
            `INSERT INTO series_colors (series_id, color) VALUES ($1, $2)
             ON CONFLICT (series_id) DO UPDATE SET color = EXCLUDED.color, updated_at = now()`,
            [id, hex],
          ),
        )
        .catch(() => {});
      const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  });

  // Book/chapter cover thumbnail.
  app.get('/img/books/:id/thumb', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.startsWith('b_')) return serveLibBookThumb(req, reply, id);
    return serveImage(req, reply, `book-thumb:${id}:webp:400`, async () => {
      const input = await fetchUpstream(komga.bookThumbPath(id));
      const buffer = await sharp(input).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  });

  // Full page image. Default: pass-through original bytes (already-optimized JPEGs).
  // Optional ?w=<px> downscales to webp for lightweight previews.
  app.get('/img/books/:id/page/:n', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const pageNo = Number(n);
    if (!Number.isInteger(pageNo) || pageNo < 1) return reply.code(400).send({ error: 'bad_page' });
    const w = Number((req.query as Record<string, string>).w);
    if (id.startsWith('b_')) return serveLibBookPage(req, reply, id, pageNo, w);

    if (w && Number.isInteger(w) && w >= 64 && w <= 2000) {
      return serveImage(req, reply, `page:${id}:${pageNo}:w${w}`, async () => {
        const input = await fetchUpstream(komga.bookPagePath(id, pageNo));
        const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }

    return serveImage(req, reply, `page:${id}:${pageNo}`, () =>
      fetchUpstreamWithType(komga.bookPagePath(id, pageNo)),
    );
  });

  // Real per-series art pulled from the internet (AniList): wide banner, else high-res cover.
  // Looked up lazily on first view and cached in series_art, so newly-added series get art automatically.
  // ?style=hero → the REAL art sharp, frame-aware (?ar=wide|tall). Recipe + warmer live at module level.
  app.get('/img/series/:id/backdrop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const hero = (req.query as Record<string, string>)?.style === 'hero';
    const ar: HeroAr = (req.query as Record<string, string>)?.ar === 'tall' ? 'tall' : 'wide';
    const r = await backdropRecipe(id, hero, ar);
    return serveImage(req, reply, r.variant, r.producer);
  });

  // direct owned-library image routes (the /img/series & /img/books routes above also reach these by id prefix)
  app.get('/img/lib/series/:id/thumb', (req, reply) => serveLibSeriesThumb(req, reply, (req.params as { id: string }).id));
  app.get('/img/lib/books/:id/thumb', (req, reply) => serveLibBookThumb(req, reply, (req.params as { id: string }).id));
  app.get('/img/lib/books/:id/page/:n', (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const pageNo = Number(n);
    if (!Number.isInteger(pageNo) || pageNo < 1) return reply.code(400).send({ error: 'bad_page' });
    return serveLibBookPage(req, reply, id, pageNo, Number((req.query as Record<string, string>).w));
  });

  // Proxy a remote source cover (for search results); handles Cloudflare sites via FlareSolverr cookies.
  app.get('/img/sources/cover', async (req, reply) => {
    const { u, source } = req.query as { u?: string; source?: string };
    if (!u) return reply.code(400).send({ error: 'bad' });
    return serveImage(req, reply, `srccover:${u}`, async () => {
      const input = await fetchCoverImage(u, source);
      const buffer = await sharp(input).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  });
}
