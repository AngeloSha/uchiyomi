import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { IMG_COOKIE } from '../lib/auth';
import { komga, komgaImage } from '../lib/komga';
import { serveImage } from '../lib/imageCache';
import { dominantHex } from '../lib/color';
import { fetchAniListArt } from '../lib/anilist';
import { LIBRARY_ROOT, cbzPages, cbzEntry } from '../lib/library';
import { cfSession } from '../lib/sources/flaresolverr';
import { getSource } from '../lib/sources';
import { join } from 'path';
import { q, one } from '../lib/db';

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
    const s = await cfSession(u);
    headers.cookie = s.cookie;
    headers['user-agent'] = s.userAgent;
  }
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error('cover'), { statusCode: r.status });
  return Buffer.from(await r.arrayBuffer());
}

export default async function imageRoutes(app: FastifyInstance) {
  // Browser <img> tags can't set Authorization; authorize via the stateless yomi_img cookie.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[IMG_COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    try {
      app.jwt.verify(token);
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // ---- owned library image helpers: serve thumbnails + pages straight from the CBZ files ----
  const libCt = (name: string): string => {
    const e = name.toLowerCase().split('.').pop() || '';
    return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : e === 'avif' ? 'image/avif' : 'image/jpeg';
  };
  const bookFileAbs = async (id: string): Promise<string | null> => {
    const r = await one<{ file: string; root: string }>('SELECT file, root FROM lib_books WHERE id = $1', [id]);
    return r ? join(r.root || LIBRARY_ROOT, r.file) : null;
  };
  const storeColor = (id: string, input: Buffer) =>
    dominantHex(input)
      .then((hex) => q(`INSERT INTO series_colors (series_id, color) VALUES ($1,$2)
        ON CONFLICT (series_id) DO UPDATE SET color=EXCLUDED.color, updated_at=now()`, [id, hex]))
      .catch(() => {});

  // Series cover: prefer the real cover art (AniList, cached in series_art.cover); fall back to the first
  // page of chapter 1. Distinct cache variants so it upgrades to the real cover once one is known.
  const serveLibSeriesThumb = async (req: FastifyRequest, reply: FastifyReply, id: string) => {
    const art = await one<{ cover: string | null }>('SELECT cover FROM series_art WHERE series_id = $1', [id]);
    if (art?.cover) {
      return serveImage(req, reply, `lib-sthumb:${id}:c`, async () => {
        const input = await fetchCoverImage(art.cover!); // CF-aware: handles AniList CDN and Aqua's Cloudflare host
        storeColor(id, input);
        const buffer = await sharp(input).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        return { buffer, contentType: 'image/webp' };
      });
    }
    return serveImage(req, reply, `lib-sthumb:${id}:p`, async () => {
      const s = await one<{ cover_book_id: string }>('SELECT cover_book_id FROM lib_series WHERE id = $1', [id]);
      const abs = s?.cover_book_id ? await bookFileAbs(s.cover_book_id) : null;
      if (!abs) throw Object.assign(new Error('no cover'), { statusCode: 404 });
      const pages = await cbzPages(abs);
      if (!pages[0]) throw Object.assign(new Error('empty'), { statusCode: 404 });
      const input = await cbzEntry(abs, pages[0]);
      storeColor(id, input);
      const buffer = await sharp(input).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
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

  // Series cover thumbnail -> webp ~400px (fast encode, universal support, tiny).
  app.get('/img/series/:id/thumb', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.startsWith('s_')) return serveLibSeriesThumb(req, reply, id);
    return serveImage(req, reply, `series-thumb:${id}:webp:400`, async () => {
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
      const buffer = await sharp(input).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
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
  app.get('/img/series/:id/backdrop', async (req, reply) => {
    const { id } = req.params as { id: string };
    let art = await one<{ banner: string | null; cover: string | null }>(
      'SELECT banner, cover FROM series_art WHERE series_id = $1',
      [id],
    );
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
        art = fetched;
      } catch {
        art = { banner: null, cover: null }; // transient AniList error: don't cache; fall back this view
      }
    }
    const url = art.banner || art.cover;
    if (!url) return reply.code(404).send({ error: 'no_art' });
    // artw4 = a wide, full-bleed, blurred + darkened ambient backdrop composited from whatever art we have
    // (banner or portrait cover). A short-wide banner can't fill a near-square mobile hero sharply, so we
    // treat all art the same → consistent, always full-bleed (no empty bars, no floating poster), crop hidden.
    const variant = `artw5:${id}:${art.banner ? 'b' : 'c'}`;
    return serveImage(req, reply, variant, async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw Object.assign(new Error(`art ${r.status}`), { statusCode: r.status });
      const input = Buffer.from(await r.arrayBuffer());
      const buffer = await sharp(input)
        .resize(1280, 820, { fit: 'cover' })
        .blur(22)
        .modulate({ brightness: 0.82, saturation: 1.18 })
        .webp({ quality: 80 })
        .toBuffer();
      return { buffer, contentType: 'image/webp' };
    });
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
