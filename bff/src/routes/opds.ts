// OPDS 1.2 catalog so external comic readers (Panels, Chunky, KOReader, Moon+, …) can browse + download from
// Uchiyomi. Read-only. Auth is HTTP Basic where the password is a per-user OPDS token (issued from the profile);
// the token resolves to a user via opds_tokens. Covers reuse /img/* (its preHandler also accepts this Basic auth).
//
// Beyond the 1.2 baseline this speaks two things a reader can use or ignore:
//   * OPDS-PSE 1.1 page streaming (Panels, Chunky, KOReader): a chapter can be read page by page over HTTP
//     instead of downloaded whole. A reader that does not know the `rel` keeps downloading the CBZ.
//   * Facets (OPDS 1.2 §7): sort, library, genre and status as links the reader renders as filters.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { q, one } from '../lib/db';
import { resolveOpdsBasic } from '../lib/auth';
import { viewCtxFor, visibleBookFile, Params, visible, browsable, type ViewCtx } from '../lib/visibility';
import { LIBRARY_ROOT, cbzPageAt } from '../lib/library';
import { serveImage } from '../lib/imageCache';
const AdmZip = require('adm-zip');

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;
const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const CBZ = 'application/vnd.comicbook+zip';
const PSE_NS = 'http://vaemendis.net/opds-pse/ns';
const PSE_REL = 'http://vaemendis.net/opds-pse/stream';
const FACET_REL = 'http://opds-spec.org/facet';
const PAGE_SIZE = 60;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));

const iso = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString() : null);
/** The newest of several timestamps, for a feed's own `<updated>`. */
const newest = (ds: Array<string | null>): string => {
  let best = 0;
  for (const d of ds) { const t = d ? new Date(d).getTime() : 0; if (t > best) best = t; }
  return best ? new Date(best).toISOString() : new Date().toISOString();
};

function feed(o: {
  id: string; title: string; self: string; kind: 'nav' | 'acq'; entries: string[];
  up?: string; next?: string; updated?: string; extra?: string[];
}): string {
  const links = [
    `<link rel="self" href="${esc(o.self)}" type="${o.kind === 'nav' ? NAV : ACQ}"/>`,
    `<link rel="start" href="/opds" type="${NAV}"/>`,
    `<link rel="search" href="/opds/search?q={searchTerms}" type="${ACQ}" title="Search Uchiyomi"/>`,
    o.up ? `<link rel="up" href="${esc(o.up)}" type="${NAV}"/>` : '',
    o.next ? `<link rel="next" href="${esc(o.next)}" type="${ACQ}"/>` : '',
    ...(o.extra ?? []),
  ].filter(Boolean).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:pse="${PSE_NS}">
  <id>${esc(o.id)}</id>
  <title>${esc(o.title)}</title>
  <updated>${o.updated ?? new Date().toISOString()}</updated>
  <author><name>Uchiyomi</name></author>
  ${links}
  ${o.entries.join('\n  ')}
</feed>`;
}

const navEntry = (title: string, href: string, summary = '') =>
  `<entry><id>${esc(href)}</id><title>${esc(title)}</title><updated>${new Date().toISOString()}</updated>` +
  `${summary ? `<content type="text">${esc(summary)}</content>` : ''}` +
  `<link rel="subsection" href="${esc(href)}" type="${NAV}"/></entry>`;

const sendXml = (reply: FastifyReply, kind: 'nav' | 'acq', xml: string) =>
  reply.header('Content-Type', `${kind === 'nav' ? NAV : ACQ};charset=utf-8`).send(xml);

/** The page's own content type, by its name inside the archive. */
const pageCt = (name: string): string => {
  const e = name.toLowerCase().split('.').pop() || '';
  return e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : e === 'gif' ? 'image/gif' : e === 'avif' ? 'image/avif' : 'image/jpeg';
};

/** The browsing parameters a series feed understands, and the query string that reproduces them. */
interface Browse { sort: string; q: string; library: string; genre: string; status: string }
const SORTS: Array<[string, string]> = [['updated', 'Recently updated'], ['title', 'Title A–Z'], ['added', 'Recently added']];

function browseOf(query: Record<string, string | undefined>): Browse {
  const sort = ['updated', 'title', 'added'].includes(query.sort || '') ? (query.sort as string) : 'updated';
  return {
    sort, q: (query.q || '').trim(), library: (query.library || '').trim(),
    genre: (query.genre || '').trim(), status: (query.status || '').trim(),
  };
}
/** A RAW query string ('&'-joined); `esc()` happens exactly once, where the link is emitted. Building it
 *  pre-escaped and then escaping again produced `&amp;amp;` in every `next` link, which a reader decodes to
 *  `&amp;page=1` -- a query key named `amp;page` -- so paging past sixty silently restarted at page one.
 *  Every active filter is carried, so a facet link or a `next` link never drops the others already applied. */
function qs(b: Browse, page: number, over: Partial<Browse> = {}): string {
  const v = { ...b, ...over };
  const parts = [`sort=${encodeURIComponent(v.sort)}`];
  if (v.q) parts.push(`q=${encodeURIComponent(v.q)}`);
  if (v.library) parts.push(`library=${encodeURIComponent(v.library)}`);
  if (v.genre) parts.push(`genre=${encodeURIComponent(v.genre)}`);
  if (v.status) parts.push(`status=${encodeURIComponent(v.status)}`);
  if (page > 0) parts.push(`page=${page}`);
  return parts.join('&');
}
const facetLink = (href: string, title: string, group: string, active: boolean, count: number) =>
  `<link rel="${FACET_REL}" href="${esc(href)}" title="${esc(title)}" opds:facetGroup="${esc(group)}"` +
  `${active ? ' opds:activeFacet="true"' : ''} thresholdCount="${count}"/>`;

export default async function opdsRoutes(app: FastifyInstance) {
  /** The viewer bound by the preHandler below. */
  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;
  const uidOf = (req: FastifyRequest): string => (req as any).opdsUser as string;

  /**
   * The series source, once. This body was hand-copied into three separate queries here, none of which
   * would have inherited a change made to the real one in ownedCatalog.
   */
  const seriesSrcWith = (gate: typeof visible, ctx: ViewCtx, p: Params) => `(SELECT s.id, COALESCE(o.title, s.title) AS title,
          COALESCE(o.summary, s.summary) AS summary, COALESCE(o.author, s.author) AS author, s.books_count,
          COALESCE(o.genres, s.genres) AS genres, COALESCE(o.status, s.status) AS status, s.library_id,
          s.latest_mtime, s.created_at
     FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
    WHERE ${gate('s', ctx, p)}) sv`;
  /** The browsing feeds: 18+ hidden unless this reader's token says otherwise (see the preHandler). */
  const seriesSrc = (ctx: ViewCtx, p: Params) => seriesSrcWith(browsable, ctx, p);
  /** One series the client already navigated to, and the chapter list under it. */
  const seriesSrcById = (ctx: ViewCtx, p: Params) => seriesSrcWith(visible, ctx, p);

  // HTTP Basic auth: password = a per-user OPDS token. Prompts the client when missing/invalid.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const who = await resolveOpdsBasic(req.headers.authorization);
    if (!who) { reply.header('WWW-Authenticate', 'Basic realm="Uchiyomi OPDS"'); return reply.code(401).send('Unauthorized'); }
    (req as { opdsUser?: string }).opdsUser = who.userId;
    // The uid was resolved here and then never used by any handler, so OPDS served the whole library
    // regardless of who asked. It is a full parallel read path (feed, chapter list, raw CBZ download),
    // so a rule enforced only in the app is not enforced at all.
    //
    // 18+ libraries: hidden unless the token itself says otherwise. An OPDS reader has no button to press
    // and no query parameter it knows about, so the preference lives on the credential (Profile → External
    // readers) rather than being inferred from anything the request carries. Hidden is the right default:
    // a feed nobody can filter should not be the way adult titles get onto a device. `/opds/book/:id/file`
    // and page streaming still work either way, because by-id resolution goes through `visibleBookFile`,
    // which is `visible()` and not `browsable()`. The age CAP is a permission and is not affected by this.
    (req as any).viewCtx = await viewCtxFor(who.userId, undefined, { hideAdult: !who.showAdult });
  });

  // root navigation feed
  app.get('/opds', async (_req, reply) =>
    sendXml(reply, 'nav', feed({
      id: 'yomi:opds:root', title: 'Uchiyomi', self: '/opds', kind: 'nav',
      entries: [
        navEntry('Recently updated', '/opds/series?sort=updated', 'Series with the newest chapters'),
        navEntry('All series (A–Z)', '/opds/series?sort=title', 'Your whole library'),
        navEntry('Recently added', '/opds/series?sort=added', 'Newest series first'),
      ],
    })));

  app.get('/opds/opensearch.xml', async (_req, reply) =>
    reply.header('Content-Type', 'application/opensearchdescription+xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Uchiyomi</ShortName>
  <Description>Search the Uchiyomi library</Description>
  <Url type="${ACQ}" template="/opds/search?q={searchTerms}"/>
</OpenSearchDescription>`));

  /**
   * The facet links for a series feed: every value the viewer could filter by, with how many of THEIR
   * series it would leave. Counted over the same gated source as the listing, so a genre that exists only
   * in a library this viewer cannot open never appears -- a count is a disclosure. Genres are grouped
   * case-insensitively for the same reason the browse page groups them: "Slice of life" and "Slice of Life"
   * are one filter in `?genre=`, so they must be one facet.
   */
  async function facetsFor(ctx: ViewCtx, b: Browse, path: string): Promise<string[]> {
    const p = new Params();
    const src = seriesSrc(ctx, p);
    const [libs, genres, statuses] = await Promise.all([
      q<{ id: string; name: string; n: number }>(
        `SELECT l.id, l.name, count(*)::int AS n FROM ${src} JOIN libraries l ON l.id = sv.library_id
          GROUP BY l.id, l.name, l.sort_order ORDER BY l.sort_order, l.name`, p.values as any[]),
      q<{ key: string; label: string; n: number }>(
        `SELECT key, mode() WITHIN GROUP (ORDER BY label) AS label, count(DISTINCT id)::int AS n
           FROM (SELECT sv.id, lower(btrim(g)) AS key, btrim(g) AS label FROM ${src}, unnest(sv.genres) AS g WHERE btrim(g) <> '') t
          GROUP BY key ORDER BY count(DISTINCT id) DESC, key ASC LIMIT 40`, p.values as any[]),
      q<{ key: string; label: string; n: number }>(
        `SELECT lower(status) AS key, mode() WITHIN GROUP (ORDER BY status) AS label, count(*)::int AS n
           FROM ${src} WHERE status IS NOT NULL AND status <> '' GROUP BY lower(status) ORDER BY count(*) DESC`, p.values as any[]),
    ]);
    const out: string[] = [];
    for (const [key, title] of SORTS) out.push(facetLink(`${path}?${qs(b, 0, { sort: key })}`, title, 'Sort', b.sort === key, 0));
    // A single library is not a choice; only offer the group when there is one to make.
    if (libs.length > 1) for (const l of libs) {
      const on = b.library === l.id;
      out.push(facetLink(`${path}?${qs(b, 0, { library: on ? '' : l.id })}`, l.name, 'Library', on, l.n));
    }
    for (const g of genres) {
      const on = b.genre.toLowerCase() === g.key;
      out.push(facetLink(`${path}?${qs(b, 0, { genre: on ? '' : g.label })}`, g.label, 'Genre', on, g.n));
    }
    if (statuses.length > 1) for (const s of statuses) {
      const on = b.status.toLowerCase() === s.key;
      out.push(facetLink(`${path}?${qs(b, 0, { status: on ? '' : s.label })}`, s.label, 'Status', on, s.n));
    }
    return out;
  }

  /** The series listing behind both `/opds/series` and `/opds/search`: paginated, filterable, faceted. */
  async function seriesFeed(req: FastifyRequest, reply: FastifyReply, path: string, id: string) {
    const query = req.query as Record<string, string | undefined>;
    const b = browseOf(query);
    const page = Math.max(0, parseInt(query.page || '0', 10) || 0);
    const order = b.sort === 'title' ? 'title ASC' : b.sort === 'added' ? 'created_at DESC, title ASC' : 'latest_mtime DESC, title ASC';
    const pp = new Params();
    const src = seriesSrc(vc(req), pp);
    const where: string[] = ['TRUE'];
    if (b.q) where.push(`title ILIKE ${pp.add(`%${b.q}%`)}`);
    if (b.library) where.push(`library_id = ${pp.add(b.library)}`);
    // The same shape the app's own genre filter uses (ownedCatalog condSql), so a facet and a search agree.
    if (b.genre) where.push(`EXISTS (SELECT 1 FROM unnest(genres) AS g WHERE lower(btrim(g)) = lower(${pp.add(b.genre)}))`);
    if (b.status) where.push(`lower(status) = lower(${pp.add(b.status)})`);
    const rows = await q<{ id: string; title: string; summary: string | null; author: string | null; books_count: number; latest_mtime: number | null; created_at: string }>(
        `SELECT id, title, summary, author, books_count, latest_mtime, created_at FROM ${src}
          WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
      pp.values as any[],
    );
    // `latest_mtime` is the newest chapter file's mtime in epoch ms; a series with no chapters yet falls back
    // to when it was added. This used to be "now" on every entry, which defeats a reader's own change
    // detection: every series looked freshly changed on every fetch.
    const stamp = (r: { latest_mtime: number | null; created_at: string }) =>
      r.latest_mtime && Number(r.latest_mtime) > 0 ? new Date(Number(r.latest_mtime)).toISOString() : iso(r.created_at)!;
    const entries = rows.map((s) =>
      `<entry>
    <id>yomi:series:${esc(s.id)}</id>
    <title>${esc(s.title)}</title>
    <updated>${stamp(s)}</updated>
    ${s.author ? `<author><name>${esc(s.author)}</name></author>` : ''}
    <content type="text">${esc((s.summary || '').slice(0, 600))}</content>
    <link rel="http://opds-spec.org/image" href="/img/lib/series/${esc(s.id)}/thumb" type="image/webp"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="/img/lib/series/${esc(s.id)}/thumb" type="image/webp"/>
    <link rel="subsection" href="/opds/series/${esc(s.id)}" type="${ACQ}" title="${esc(s.books_count)} chapters"/>
  </entry>`);
    const self = `${path}?${qs(b, page)}`;
    const next = rows.length === PAGE_SIZE ? `${path}?${qs(b, page + 1)}` : undefined;
    const title = b.q ? `Search: ${b.q}` : b.genre ? `Genre: ${b.genre}` : b.status ? `Status: ${b.status}` : 'Series';
    const extra = await facetsFor(vc(req), b, path);
    return sendXml(reply, 'acq', feed({
      id, title, self, kind: 'acq', up: '/opds', next, entries, extra,
      updated: newest(rows.map(stamp)),
    }));
  }

  // acquisition feed of series (paginated). Each entry is a navigation link to the series' chapters.
  app.get('/opds/series', (req, reply) => seriesFeed(req, reply, '/opds/series', 'yomi:opds:series'));
  // The OpenSearch target. Same feed, same facets, same paging: a search that could not be narrowed or
  // paged past its first sixty hits was the old behaviour, and it was a different code path.
  app.get('/opds/search', (req, reply) => seriesFeed(req, reply, '/opds/search', 'yomi:opds:search'));

  // acquisition feed for one series: each chapter is a downloadable CBZ, and streamable page by page
  app.get('/opds/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const pp = new Params();
    const s = await one<{ title: string }>(
      `SELECT title FROM ${seriesSrcById(vc(req), pp)} WHERE id = ${pp.add(id)}`, pp.values as any[]);
    if (!s) return reply.code(404).send('not found');
    // A FRESH Params. The series lookup above bound the id as $1; reusing its list here would send that $1
    // along unreferenced, and Postgres refuses a statement with a parameter it cannot type -- "could not
    // determine data type of parameter $1" -- so the whole chapter list answered 500.
    const bp = new Params();
    const uid = bp.add(uidOf(req));
    const books = await q<{ id: string; title: string | null; number: number; pages: number; updated_at: string; root: string | null; file: string; last_page: number | null; last_at: string | null }>(
      // This had no visibility predicate whatsoever: the chapter list of a hidden series was served in
      // full. The join is what carries the rule down from the series. The progress join is per reader, so
      // `pse:lastRead` is where THIS person stopped, not where anyone did.
      `SELECT b.id, b.title, b.number, b.pages, b.updated_at, b.root, b.file, rp.page AS last_page, rp.updated_at AS last_at
         FROM lib_books b
         JOIN lib_series s ON s.id = b.series_id AND ${visible('s', vc(req), bp)}
         LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = ${uid}
        WHERE b.series_id = ${bp.add(id)} ORDER BY b.number ASC, b.file ASC`, bp.values as any[]);
    // A page count of 0 means "never counted", not "no pages". The scanner counts most archives, but a
    // streaming link with count 0 is a link a reader cannot use, so the unknowns get counted here, once,
    // and written back the way the image server does it.
    await Promise.all(books.filter((b) => !(b.pages > 0)).map(async (b) => {
      const first = await cbzPageAt(join(b.root || LIBRARY_ROOT, b.file), 0).catch(() => null);
      if (!first) return;
      b.pages = first.total;
      q('UPDATE lib_books SET pages=$1 WHERE id=$2 AND pages<>$1', [first.total, b.id]).catch(() => {});
    }));
    const entries = books.map((b) => {
      const label = b.title || `Chapter ${b.number}`;
      // `{pageNumber}` and `{maxWidth}` are literal templates the reader fills in (OPDS-PSE 1.1), and the
      // page number is ZERO-based per that spec -- the same base as read_progress.page, so lastRead is
      // passed through untouched. `esc()` leaves braces alone on purpose.
      const stream = b.pages > 0
        ? `<link rel="${PSE_REL}" type="image/jpeg" href="/opds/book/${esc(b.id)}/page/{pageNumber}?maxWidth={maxWidth}" pse:count="${b.pages}"` +
          (b.last_page != null ? ` pse:lastRead="${b.last_page}" pse:lastReadDate="${iso(b.last_at)}"` : '') + '/>'
        : '';
      return `<entry>
    <id>yomi:book:${esc(b.id)}</id>
    <title>${esc(label)}</title>
    <updated>${iso(b.updated_at)}</updated>
    <content type="text">${esc(`${label} · ${b.pages} pages`)}</content>
    <link rel="http://opds-spec.org/image/thumbnail" href="/img/lib/books/${esc(b.id)}/thumb" type="image/webp"/>
    <link rel="http://opds-spec.org/acquisition" href="/opds/book/${esc(b.id)}/file" type="${CBZ}"/>
    ${stream}
  </entry>`;
    });
    return sendXml(reply, 'acq', feed({
      id: `yomi:series:${id}`, title: s.title, self: `/opds/series/${esc(id)}`, kind: 'acq', up: '/opds/series', entries,
      updated: newest(books.map((b) => iso(b.updated_at))),
    }));
  });

  // One page of a chapter, for OPDS-PSE readers. ZERO-based, unlike /img/lib/books/:id/page/:n, because the
  // PSE template is; that route stays 1-based and untouched. Without `maxWidth` this serves the original
  // bytes under the SAME cache key the web reader uses, so the two never fetch or store a page twice; with
  // it, a distinct key and a JPEG, because a resized variant must not be mistaken for the original and a
  // reader asking for a width is not necessarily one that decodes webp.
  app.get('/opds/book/:id/page/:n', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const pageNo = Number(n);
    if (!Number.isInteger(pageNo) || pageNo < 0) return reply.code(400).send('bad page');
    const row = await visibleBookFile(id, vc(req));
    if (!row) return reply.code(404).send('not found');
    const abs = join(row.root || LIBRARY_ROOT, row.file);
    const w = Number((req.query as Record<string, string>).maxWidth);
    if (w && Number.isInteger(w) && w >= 64 && w <= 2000) {
      return serveImage(req, reply, `pse-page:${id}:${pageNo + 1}:w${w}`, async () => {
        const page = await cbzPageAt(abs, pageNo);
        if (!page) throw Object.assign(new Error('no page'), { statusCode: 404 });
        const buffer = await sharp(page.bytes).resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        return { buffer, contentType: 'image/jpeg' };
      });
    }
    return serveImage(req, reply, `lib-page:${id}:${pageNo + 1}`, async () => {
      const page = await cbzPageAt(abs, pageNo);
      if (!page) throw Object.assign(new Error('no page'), { statusCode: 404 });
      q('UPDATE lib_books SET pages=$1 WHERE id=$2 AND pages<>$1', [page.total, id]).catch(() => {});
      return { buffer: page.bytes, contentType: pageCt(page.name) };
    });
  });

  // download one chapter as a CBZ (streams the file; zips a loose-image folder on the fly)
  app.get('/opds/book/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Streams raw bytes off disk, so it is the same hole the image server had: resolve through the
    // shared checker rather than a bare id lookup.
    const row = await visibleBookFile(id, vc(req));
    if (!row) return reply.code(404).send('not found');
    const abs = join(row.root || LIBRARY_ROOT, row.file);
    const st = await stat(abs).catch(() => null);
    if (!st) return reply.code(404).send('not found');
    const base = (row.file.split('/').pop() || 'chapter').replace(/\.(cbr|zip|rar)$/i, '.cbz');
    reply.header('Content-Type', CBZ);
    if (st.isDirectory()) {
      const zip = new AdmZip();
      for (const name of (await readdir(abs)).filter((n) => IMG.test(n)).sort()) zip.addLocalFile(join(abs, name));
      reply.header('Content-Disposition', `attachment; filename="${esc(base)}.cbz"`);
      return reply.send(zip.toBuffer());
    }
    reply.header('Content-Disposition', `attachment; filename="${esc(base)}"`);
    return reply.send(createReadStream(abs));
  });
}
