import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { IMG_COOKIE, resolveOpdsBasic } from '../lib/auth';
import { komga, komgaImage } from '../lib/komga';
import { serveImage, getOrFetch } from '../lib/imageCache';
import { dominantHex } from '../lib/color';
import { fetchAniListArt } from '../lib/anilist';
import { linkSeries } from '../lib/trackers';
import { LIBRARY_ROOT, cbzPageAt } from '../lib/library';
import { cfSession } from '../lib/sources/flaresolverr';
import { getSource } from '../lib/sources';
import { suwayomiUrl, suwayomiImageHeaders } from '../lib/sources/suwayomi/client';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { q, one } from '../lib/db';
import { viewCtxFor, visibleBookFile, seriesVisible, SYSTEM_CTX, type ViewCtx } from '../lib/visibility';
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

const CF_IMAGE_TIMEOUT_MS = 5000;

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
    ...(typeof src?.imageHeaders === 'function' ? src.imageHeaders(u) : src?.imageHeaders ?? {}),
  };
  if (src?.requiresCloudflare) {
    // Best-effort: many sources host covers on a separate CDN that ISN'T Cloudflare-protected, where
    // FlareSolverr fails to "solve a challenge". Don't let that abort the cover — the Referer alone is
    // usually enough. Attach cf cookies when we can; otherwise fall through to a plain fetch.
    try {
      // Capped hard. cfSession is built for solving a real challenge on a page load and will sit there for
      // up to 95 seconds; behind an <img> that is a tile that never resolves. The cookies are an optimisation
      // here -- the plain referer-only fetch below usually works -- so waiting more than a moment for them is
      // strictly worse than going without.
      let timer: NodeJS.Timeout | undefined;
      const s = await Promise.race([
        cfSession(u),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('cf timeout')), CF_IMAGE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer)); // or the loser holds the event loop open for 5s
      headers.cookie = s.cookie;
      headers['user-agent'] = s.userAgent;
    } catch {
      /* image host isn't behind Cloudflare, or took too long — proceed with the referer-only headers */
    }
  }
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error('cover'), { statusCode: r.status });
  return Buffer.from(await r.arrayBuffer());
}

// ---- series backdrop recipes (module-level so the pre-warmer can build them without a request) ----
const bookFileAbs = async (id: string, ctx: ViewCtx): Promise<string | null> => {
  const r = await visibleBookFile(id, ctx);
  return r ? join(r.root || LIBRARY_ROOT, r.file) : null;
};
// Bytes of a series' first downloaded page — the universal fallback when a remote cover/backdrop URL can't be
// fetched (hotlink-protected CDN, dead link, timeout, unparsed cover). Guarantees art for any downloaded series.
const firstPageInput = async (id: string, ctx: ViewCtx): Promise<Buffer> => {
  const s = await one<{ cover_book_id: string }>('SELECT cover_book_id FROM lib_series WHERE id = $1', [id]);
  const abs = s?.cover_book_id ? await bookFileAbs(s.cover_book_id, ctx) : null;
  if (!abs) throw Object.assign(new Error('no cover'), { statusCode: 404 });
  const first = await cbzPageAt(abs, 0);
  if (!first) throw Object.assign(new Error('empty'), { statusCode: 404 });
  return first.bytes;
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
async function backdropRecipe(id: string, hero: boolean, ar: HeroAr, ctx: ViewCtx): Promise<{ variant: string; producer: () => Promise<{ buffer: Buffer; contentType: string }> }> {
  // admin override wins (uploaded banner/cover or pasted URL)
  const ovr = await one<{ banner: string | null; v: string }>('SELECT banner, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM series_overrides WHERE series_id = $1', [id]);
  if (ovr?.banner) {
    return {
      variant: `artw7${hero ? `h${ar}` : ''}:${id}:ov:${Math.floor(Number(ovr.v))}`,
      producer: async () => {
        let input: Buffer;
        if (ovr.banner === 'upload') input = await readFile(artFile(id, 'banner'));
        else { try { input = await fetchCoverImage(ovr.banner!); } catch { input = await firstPageInput(id, ctx); } }
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
        input = await firstPageInput(id, ctx);
      }
      const buffer = sharpHero ? await heroSharp(input, ar) : await ambientComposite(input);
      return { buffer, contentType: 'image/webp' };
    },
  };
}

/** Pre-generate both hero frames for a set of series so the carousel never waits on sharp/remote fetches.
 *  Disk-cache aware (getOrFetch): already-warm entries cost one stat() each. Fire-and-forget.
 *
 *  Two things this has to get right. It ran strictly one frame after another, so warming today's seven picks
 *  was fourteen sequential remote fetches and sharp encodes -- long enough that the carousel could easily
 *  reach a frame before the warmer did, which is the case warming exists to prevent. And the `warmed` tag was
 *  only recorded AFTER the work finished, so two callers arriving together both did all of it.
 *
 *  The concurrency cap is deliberately low: this is background work competing with the requests someone is
 *  actually waiting on, and sharp already uses a thread pool per call. */
const warmed = new Set<string>();
const WARM_CONCURRENCY = 3;

export async function warmHeroBackdrops(ids: string[]): Promise<void> {
  const jobs: Array<{ id: string; ar: HeroAr; tag: string }> = [];
  for (const id of ids) {
    for (const ar of ['wide', 'tall'] as const) {
      const tag = `${id}:${ar}`;
      if (warmed.has(tag)) continue;
      warmed.add(tag); // claim it up front so a second caller does not duplicate the work
      jobs.push({ id, ar, tag });
    }
  }
  if (!jobs.length) return;

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const r = await backdropRecipe(job.id, true, job.ar, SYSTEM_CTX);
        await getOrFetch(r.variant, r.producer);
      } catch {
        warmed.delete(job.tag); // best-effort, but let a later pass retry it
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, jobs.length) }, worker));
}

export default async function imageRoutes(app: FastifyInstance) {
  // Browser <img> tags can't set Authorization; authorize via the stateless yomi_img cookie.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // BIND the subject, do not just verify it. This used to call app.jwt.verify(token) and return, so the
    // decoded sub was thrown away and no image handler had any notion of who was asking. That made every
    // series-level rule a no-op on the one route family that serves actual bytes: /img/lib/books/:id/page/:n
    // resolved a file from a book id with no series join, so a hidden series' pages rendered for anyone
    // holding the id.
    const token = req.cookies?.[IMG_COOKIE];
    if (token) {
      try {
        const claims = app.jwt.verify(token) as { sub?: string };
        (req as any).viewCtx = await viewCtxFor(claims.sub ?? null);
        return;
      } catch { /* fall through to OPDS auth */ }
    }
    // OPDS readers load covers/pages with the same HTTP Basic token as the feed
    const uid = await resolveOpdsBasic(req.headers.authorization);
    if (uid) { (req as any).viewCtx = await viewCtxFor(uid); return; }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  /** The viewer bound above. */
  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;

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
    // The series-level art routes read lib_series and series_art by id, so they need the check that
    // bookFileAbs now carries for chapters. Without it a hidden series' cover still renders, which is
    // how a deleted series has always kept its thumbnail.
    if (!(await seriesVisible(id, vc(req)))) return reply.code(404).send({ error: 'not_found' });
    const w = thumbWidth(req);
    const wk = w === 400 ? '' : `:w${w}`; // 400 keeps the legacy cache key so existing entries stay warm
    // admin override wins (uploaded file or pasted URL); variant carries updated_at so edits bust the cache
    const ovr = await one<{ cover: string | null; v: string }>('SELECT cover, EXTRACT(EPOCH FROM updated_at) * 1000 AS v FROM series_overrides WHERE series_id = $1', [id]);
    if (ovr?.cover) {
      return serveImage(req, reply, `lib-sthumb:${id}:ov:${Math.floor(Number(ovr.v))}${wk}`, async () => {
        let input: Buffer;
        if (ovr.cover === 'upload') input = await readFile(artFile(id, 'cover'));
        else { try { input = await fetchCoverImage(ovr.cover!); } catch { input = await firstPageInput(id, vc(req)); } }
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
        catch { input = await firstPageInput(id, vc(req)); }
        storeColor(id, input);
        const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }
    return serveImage(req, reply, `lib-sthumb:${id}:p${wk}`, async () => {
      const input = await firstPageInput(id, vc(req));
      storeColor(id, input);
      const buffer = await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  };
  const serveLibBookThumb = (req: FastifyRequest, reply: FastifyReply, id: string) =>
    serveImage(req, reply, `lib-bthumb:${id}`, async () => {
      const abs = await bookFileAbs(id, vc(req));
      if (!abs) throw Object.assign(new Error('no book'), { statusCode: 404 });
      const first = await cbzPageAt(abs, 0);
      if (!first) throw Object.assign(new Error('empty'), { statusCode: 404 });
      q('UPDATE lib_books SET pages=$1 WHERE id=$2 AND pages<>$1', [first.total, id]).catch(() => {});
      const buffer = await sharp(first.bytes).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  const serveLibBookPage = async (req: FastifyRequest, reply: FastifyReply, id: string, pageNo: number, w: number) => {
    const abs = await bookFileAbs(id, vc(req));
    if (!abs) return reply.code(404).send({ error: 'no_book' });
    if (w && Number.isInteger(w) && w >= 64 && w <= 2000) {
      return serveImage(req, reply, `lib-page:${id}:${pageNo}:w${w}`, async () => {
        const page = await cbzPageAt(abs, pageNo - 1);
        if (!page) throw Object.assign(new Error('no page'), { statusCode: 404 });
        const buffer = await sharp(page.bytes).resize({ width: w, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }
    return serveImage(req, reply, `lib-page:${id}:${pageNo}`, async () => {
      const page = await cbzPageAt(abs, pageNo - 1);
      if (!page) throw Object.assign(new Error('no page'), { statusCode: 404 });
      q('UPDATE lib_books SET pages=$1 WHERE id=$2 AND pages<>$1', [page.total, id]).catch(() => {});
      return { buffer: page.bytes, contentType: libCt(page.name) };
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
    const r = await backdropRecipe(id, hero, ar, vc(req));
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
  // Extension icons live on the extension server, which a browser can't reach (it is on an internal network),
  // so proxy them same-origin. Same lesson as source covers: cross-origin images are unreliable in an
  // installed PWA, same-origin is not.
  app.get('/img/extensions/icon/:pkgName', async (req, reply) => {
    const { pkgName } = req.params as { pkgName: string };
    // the package name lands in a URL path, so allow only what a package name can actually contain
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(pkgName)) return reply.code(400).send({ error: 'bad' });
    return serveImage(req, reply, `swicon:${pkgName}`, async () => {
      const r = await fetch(suwayomiUrl(`/api/v1/extension/icon/${pkgName}`), {
        headers: suwayomiImageHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`extension icon ${r.status}`);
      const buffer = await sharp(Buffer.from(await r.arrayBuffer()))
        .resize({ width: 96, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  });

  app.get('/img/sources/cover', async (req, reply) => {
    const { u, source, w } = req.query as { u?: string; source?: string; w?: string };
    if (!u) return reply.code(400).send({ error: 'bad' });
    // 400px is right for a cover tile and wrong for a wide banner: an AniList key-art strip is ~1900px, and
    // squeezing it to 400 gave the discover hero a 400x84 image stretched across a 1920px box, which reads
    // as no art at all rather than as a low-quality one. Whitelisted rather than free-form so this cannot
    // become a request to render someone's 8000px file.
    const width = w === '1600' ? 1600 : w === '800' ? 800 : 400;
    // The width is part of the cache key, or the first variant fetched would be served for every size.
    return serveImage(req, reply, `srccover:${width}:${u}`, async () => {
      const input = await fetchCoverImage(u, source);
      const buffer = await sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
  });
}
