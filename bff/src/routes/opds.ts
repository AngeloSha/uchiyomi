// OPDS 1.2 catalog so external comic readers (Panels, Chunky, KOReader, Moon+, …) can browse + download from
// Uchiyomi. Read-only. Auth is HTTP Basic where the password is a per-user OPDS token (issued from the profile);
// the token resolves to a user via opds_tokens. Covers reuse /img/* (its preHandler also accepts this Basic auth).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { q, one } from '../lib/db';
import { resolveOpdsBasic } from '../lib/auth';
import { viewCtxFor, visibleBookFile, Params, visible, browsable, type ViewCtx } from '../lib/visibility';
import { LIBRARY_ROOT } from '../lib/library';
const AdmZip = require('adm-zip');

const IMG = /\.(jpe?g|png|webp|gif|avif)$/i;
const NAV = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const CBZ = 'application/vnd.comicbook+zip';
const PAGE_SIZE = 60;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));

function feed(o: { id: string; title: string; self: string; kind: 'nav' | 'acq'; entries: string[]; up?: string; next?: string }): string {
  const now = new Date().toISOString();
  const links = [
    `<link rel="self" href="${esc(o.self)}" type="${o.kind === 'nav' ? NAV : ACQ}"/>`,
    `<link rel="start" href="/opds" type="${NAV}"/>`,
    `<link rel="search" href="/opds/search?q={searchTerms}" type="${ACQ}" title="Search Uchiyomi"/>`,
    o.up ? `<link rel="up" href="${esc(o.up)}" type="${NAV}"/>` : '',
    o.next ? `<link rel="next" href="${esc(o.next)}" type="${ACQ}"/>` : '',
  ].filter(Boolean).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${esc(o.id)}</id>
  <title>${esc(o.title)}</title>
  <updated>${now}</updated>
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

export default async function opdsRoutes(app: FastifyInstance) {
  /** The viewer bound by the preHandler below. */
  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;

  /**
   * The series source, once. This body was hand-copied into three separate queries here, none of which
   * would have inherited a change made to the real one in ownedCatalog.
   */
  const seriesSrcWith = (gate: typeof visible, ctx: ViewCtx, p: Params) => `(SELECT s.id, COALESCE(o.title, s.title) AS title,
          COALESCE(o.summary, s.summary) AS summary, COALESCE(o.author, s.author) AS author, s.books_count,
          s.latest_mtime, s.created_at
     FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
    WHERE ${gate('s', ctx, p)}) sv`;
  /** The browsing feeds. An OPDS reader has no button to press, so it gets the default: 18+ hidden. */
  const seriesSrc = (ctx: ViewCtx, p: Params) => seriesSrcWith(browsable, ctx, p);
  /** One series the client already navigated to, and the chapter list under it. */
  const seriesSrcById = (ctx: ViewCtx, p: Params) => seriesSrcWith(visible, ctx, p);
  // HTTP Basic auth: password = a per-user OPDS token. Prompts the client when missing/invalid.
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = await resolveOpdsBasic(req.headers.authorization);
    if (!uid) { reply.header('WWW-Authenticate', 'Basic realm="Uchiyomi OPDS"'); return reply.code(401).send('Unauthorized'); }
    (req as { opdsUser?: string }).opdsUser = uid;
    // The uid was resolved here and then never used by any handler, so OPDS served the whole library
    // regardless of who asked. It is a full parallel read path (feed, chapter list, raw CBZ download),
    // so a rule enforced only in the app is not enforced at all.
    // No query parameter to read and no session: an OPDS reader is a client that cannot ask, so it gets the
    // default. Hiding is the right default there -- a feed nobody can filter should not be the way adult
    // titles get onto a device. `/opds/book/:id/file` still works, because downloads go through
    // `visibleBookFile`, which is `visible()` and not `browsable()`.
    (req as any).viewCtx = await viewCtxFor(uid, undefined, { hideAdult: true });
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

  // acquisition feed of series (paginated). Each entry is a navigation link to the series' chapters.
  app.get('/opds/series', async (req, reply) => {
    const { sort, page, q: query } = req.query as { sort?: string; page?: string; q?: string };
    const p = Math.max(0, parseInt(page || '0', 10) || 0);
    const order = sort === 'title' ? 'title ASC' : sort === 'added' ? 'created_at DESC, title ASC' : 'latest_mtime DESC, title ASC';
    const pp = new Params();
    const src = seriesSrc(vc(req), pp);
    let where = 'TRUE';
    if (query?.trim()) where = `title ILIKE ${pp.add(`%${query.trim()}%`)}`;
    const rows = await q<{ id: string; title: string; summary: string | null; author: string | null; books_count: number }>(
        `SELECT id, title, summary, author, books_count FROM ${src}
          WHERE ${where} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${p * PAGE_SIZE}`,
      pp.values as any[],
    );
    const entries = rows.map((s) =>
      `<entry>
    <id>yomi:series:${esc(s.id)}</id>
    <title>${esc(s.title)}</title>
    <updated>${new Date().toISOString()}</updated>
    ${s.author ? `<author><name>${esc(s.author)}</name></author>` : ''}
    <content type="text">${esc((s.summary || '').slice(0, 600))}</content>
    <link rel="http://opds-spec.org/image" href="/img/lib/series/${esc(s.id)}/thumb" type="image/webp"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="/img/lib/series/${esc(s.id)}/thumb" type="image/webp"/>
    <link rel="subsection" href="/opds/series/${esc(s.id)}" type="${ACQ}" title="${esc(s.books_count)} chapters"/>
  </entry>`);
    const self = `/opds/series?sort=${esc(sort || 'updated')}&amp;page=${p}${query ? `&amp;q=${encodeURIComponent(query)}` : ''}`;
    const next = rows.length === PAGE_SIZE ? `/opds/series?sort=${esc(sort || 'updated')}&amp;page=${p + 1}${query ? `&amp;q=${encodeURIComponent(query)}` : ''}` : undefined;
    return sendXml(reply, 'acq', feed({ id: 'yomi:opds:series', title: query ? `Search: ${query}` : 'Series', self, kind: 'acq', up: '/opds', next, entries }));
  });

  app.get('/opds/search', async (req, reply) => {
    const query = ((req.query as { q?: string }).q || '').trim();
    return opdsSeriesSearch(req, reply, query);
  });

  async function opdsSeriesSearch(req: FastifyRequest, reply: FastifyReply, query: string) {
    const pp = new Params();
    const src = seriesSrc(vc(req), pp);
    const rows = await q<{ id: string; title: string; summary: string | null; books_count: number }>(
        `SELECT id, title, summary, books_count FROM ${src}
          WHERE title ILIKE ${pp.add(`%${query}%`)} ORDER BY title ASC LIMIT ${PAGE_SIZE}`,
      pp.values as any[],
    );
    const entries = rows.map((s) =>
      `<entry><id>yomi:series:${esc(s.id)}</id><title>${esc(s.title)}</title><updated>${new Date().toISOString()}</updated>` +
      `<content type="text">${esc((s.summary || '').slice(0, 400))}</content>` +
      `<link rel="http://opds-spec.org/image/thumbnail" href="/img/lib/series/${esc(s.id)}/thumb" type="image/webp"/>` +
      `<link rel="subsection" href="/opds/series/${esc(s.id)}" type="${ACQ}" title="${esc(s.books_count)} chapters"/></entry>`);
    return sendXml(reply, 'acq', feed({ id: 'yomi:opds:search', title: `Search: ${query}`, self: `/opds/search?q=${encodeURIComponent(query)}`, kind: 'acq', up: '/opds', entries }));
  }

  // acquisition feed for one series: each chapter is a downloadable CBZ
  app.get('/opds/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
      const pp = new Params();
      const s = await one<{ title: string }>(
        `SELECT title FROM ${seriesSrcById(vc(req), pp)} WHERE id = ${pp.add(id)}`, pp.values as any[]);
    if (!s) return reply.code(404).send('not found');
    const books = await q<{ id: string; title: string | null; number: number; pages: number }>(
      // This had no visibility predicate whatsoever: the chapter list of a hidden series was served in
      // full. The join is what carries the rule down from the series.
      `SELECT b.id, b.title, b.number, b.pages FROM lib_books b
         JOIN lib_series s ON s.id = b.series_id AND ${visible('s', vc(req), pp)}
        WHERE b.series_id = ${pp.add(id)} ORDER BY b.number ASC, b.file ASC`, pp.values as any[]);
    const entries = books.map((b) => {
      const label = b.title || `Chapter ${b.number}`;
      return `<entry>
    <id>yomi:book:${esc(b.id)}</id>
    <title>${esc(label)}</title>
    <updated>${new Date().toISOString()}</updated>
    <content type="text">${esc(`${label} · ${b.pages} pages`)}</content>
    <link rel="http://opds-spec.org/image/thumbnail" href="/img/lib/books/${esc(b.id)}/thumb" type="image/webp"/>
    <link rel="http://opds-spec.org/acquisition" href="/opds/book/${esc(b.id)}/file" type="${CBZ}"/>
  </entry>`;
    });
    return sendXml(reply, 'acq', feed({ id: `yomi:series:${id}`, title: s.title, self: `/opds/series/${esc(id)}`, kind: 'acq', up: '/opds/series', entries }));
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
