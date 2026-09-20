// A Komga-compatible API, so Mihon's Komga extension can browse this library and Mihon's Komga TRACKER can
// sync reading progress back to it (issue #51's idea, rebuilt; the PR's code is the spec, not the source).
//
// Two clients, one cookie jar:
//   * the keiyoushi Komga EXTENSION sends `X-API-Key` on every request, or reacts to a 401 with HTTP Basic
//     (upstream keiyoushi Komga.kt L102-120 @9137b65d) -- it holds a credential;
//   * Mihon's Komga TRACKER sends nothing but a `User-Agent` (mihon KomgaApi.kt L27-31 @424bbc53) for
//     `GET /api/v1/series/:id`, `GET`+`PUT /api/v2/series/:id/read-progress/tachiyomi` -- it relies on
//     whatever cookie the extension's traffic left in the shared WebView jar (AndroidCookieJar.kt L12-30).
// So every credentialed request mints/refreshes the UCHIYOMI-SESSION cookie (lib/komgaSession.ts) and the
// credential-less ones are honoured on it. See the hook below for the exact rules.
//
// Everything reads through `owned.*` with the viewer bound by the hook, so soft delete, merge, the library
// grants and the age cap apply by construction; the 18+ surfacing hide follows the token's `show_adult` flag
// (a Komga client has no reveal button, exactly like an OPDS reader). A series or book the viewer may not
// see is a 404, never a 403: a 403 would confirm it exists.
//
// DTO padding (every non-null field the Kotlin clients require) and the progress arithmetic live in
// lib/komgaDto.ts and lib/komgaProgress.ts; this file is the HTTP surface.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { API_TOKEN_PREFIX, resolveApiToken, resolveApiTokenById, type ResolvedToken } from '../lib/auth';
import { SESSION_COOKIE, mintSession, verifySession, shouldRemint } from '../lib/komgaSession';
import { owned, UnsupportedFilter } from '../lib/ownedCatalog';
import { viewCtxFor, seriesVisible, browsable, Params, type ViewCtx } from '../lib/visibility';
import { q, one } from '../lib/db';
import { pushSeriesProgressAsync } from '../lib/trackers';
import { serveLibSeriesThumb, serveLibBookThumb, serveLibBookPage } from './images';
import { springPage, komgaSeries, komgaBook, komgaGhostBook, komgaPage, parseSeriesQuery, parseBooksQuery } from '../lib/komgaDto';
import { readProgressV2, markReadUpTo } from '../lib/komgaProgress';
import { ghostsEnabled, ghostBooksFor, ghostBookById, isGhostId } from '../lib/komgaGhosts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The password half of an HTTP Basic header, or null. The username is ignored, as resolveOpdsBasic does. */
function basicPassword(header: string | undefined): string | null {
  if (!header || !/^basic /i.test(header)) return null;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); } catch { return null; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return pass || null;
}

/** The value of an `Authorization: Bearer` header, or null for any other (or no) Authorization header. */
function bearerValue(header: string | undefined): string | null {
  if (!header || !/^bearer /i.test(header)) return null;
  const raw = header.slice(7).trim();
  return raw || null;
}

/**
 * 401, and only ever 401, for a request that carried nothing usable. The extension's Basic authenticator fires
 * on a 401 alone (OkHttp RetryAndFollowUpInterceptor; a 403 or a redirect never triggers it) and its "log in"
 * check treats any non-2xx on /api/v1/libraries as a failed login, which is what a bad key must look like.
 */
function unauthorized(reply: FastifyReply, message: string) {
  reply.header('WWW-Authenticate', 'Basic realm="Uchiyomi"');
  return reply.code(401).send({ error: 'unauthorized', message });
}

export default async function komgaCompatRoutes(app: FastifyInstance) {
  const vc = (req: FastifyRequest): ViewCtx => (req as any).viewCtx as ViewCtx;
  const uid = (req: FastifyRequest): string => (req as any).user.sub as string;

  /**
   * Failed credentials per client IP, on the budget /auth/login has (10 per 5 minutes; server.ts registers
   * @fastify/rate-limit with `global: false`, so a limiter is opted into here, per plugin). Only a PRESENTED
   * credential that fails to resolve counts: a request with no credential is the extension's normal first
   * request before it answers our 401 with Basic, and a cookie naming a revoked token is a phone that needs a
   * new key, not a guess. Peeked (`increment: false`) before the credential is hashed and looked up, so a
   * client over budget costs no SELECT; counted only after a failure. Good keys never touch the counter, so a
   * phone browsing with a valid key is never throttled by its own traffic, however busy.
   *
   * Nothing here is guessable (256-bit tokens, a keyed-MAC cookie); this bounds the log noise and the SELECT
   * per guess, not the odds. Reintroduce by dropping the peek and the count: "the eleventh bad key from one
   * address in five minutes is a 429" in komgaCompat.int.test.ts sees 401.
   *
   * A test app that mounts this plugin bare (openapiCoverage does, to list routes) gets the plugin registered
   * here, inside this encapsulation; server.ts's root registration is found first and never doubled.
   */
  if (!app.hasDecorator('createRateLimit')) await app.register(rateLimit, { global: false });
  const failedCredentials = app.createRateLimit({ max: 10, timeWindow: '5 minutes' });
  // `isAllowed: true` is the allow-list answer only; a client under the limit comes back `isAllowed: false`
  // with `isExceeded: false`, so the exceeded flag is the one that means anything. Answers the seconds left
  // in the window when over budget (for Retry-After), else 0.
  const overBudget = async (req: FastifyRequest, count: boolean): Promise<number> => {
    const r = await failedCredentials(req, { increment: count });
    return !r.isAllowed && r.isExceeded ? Math.max(1, r.ttlInSeconds) : 0;
  };
  const tooMany = (reply: FastifyReply, retryAfter: number) =>
    reply.code(429).header('Retry-After', String(retryAfter))
      .send({ error: 'too_many_requests', message: 'Too many failed API keys from this address. Try again in a few minutes.' });

  /**
   * Authentication for every route this plugin registers, and nothing else (Fastify encapsulates hooks; the
   * precedent is the OPDS plugin). `onRequest`, not `preHandler`: it runs before the body is parsed, so an
   * unauthenticated PUT is refused before its bytes are read.
   *
   * Credential order -- explicit beats remembered, exactly as Komga re-authenticates on a presented principal:
   *   1. `X-API-Key: uy_…`                       (the extension with an API key, every request)
   *   2. `Authorization: Bearer uy_…`             (the same token the way the rest of /api/* takes it)
   *   3. `Authorization: Basic <anything>:<uy_…>` (the extension without a key, after our 401)
   *   4. the UCHIYOMI-SESSION cookie              (the tracker, which sends no credential at all)
   *
   * ⚠️ ANY Authorization header is a presented credential and is judged: it either resolves or it is a 401.
   * The first cut recognised X-API-Key and Basic only, so `Bearer uy_…` fell through to the cookie and a
   * remembered cookie for ANOTHER token silently answered in its place -- the one gap in "explicit beats
   * remembered", and a Bearer that was an app JWT was refused by luck (no cookie) rather than by rule.
   * Reintroduce by dropping the Bearer branch: "Bearer with an API token is a credential here, and it beats
   * a remembered cookie for another token" in komgaCompat.int.test.ts answers as the cookie's owner.
   *
   * ⚠️ API tokens ONLY. No password path: PR #51 verified argon2 here, which reached an account with the
   * password alone -- no TOTP step, no lockout counter -- and there is no channel for a TOTP code in this
   * protocol, so the honest answer is to refuse. No OPDS tokens either (they carry no scopes) and no app JWT.
   * Reintroduce by resolving the Basic password against users.password_hash: "Basic with the account
   * password is refused even when it is right" in komgaCompat.int.test.ts sees 200.
   *
   * A cookie that does not verify (foreign, tampered, expired, another server's KOMGA-SESSION) is "no cookie"
   * and never a 401 on its own: the phone falls through to its key and gets a fresh one. A cookie that DOES
   * verify but names a token that no longer resolves -- revoked, expired, owner disabled -- is a 401, because
   * the credential it stood for is gone.
   *
   * The cookie is (re)minted only on a credentialed request, only once that request has authenticated, and
   * only when the presented cookie is absent, invalid, for ANOTHER token, or past half its life. "Another
   * token" is the case that matters: the extension's key changed to a different account's token while the jar
   * still held the old user's cookie, and the tracker's credential-less PUT would have written the OLD
   * account's progress. Never on a 401.
   */
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawCookie = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
    const cookie = rawCookie ? verifySession(rawCookie) : null;

    let tok: ResolvedToken | null = null;
    let credentialed = false;
    const key = req.headers['x-api-key'];
    const bearer = bearerValue(req.headers.authorization);
    const basic = basicPassword(req.headers.authorization);
    // The presented secret (X-API-Key wins over the Authorization header, as in Komga) and what to say when
    // it does not resolve; null when the request carries no credential at all.
    let presented: { raw: string; refusal: string } | null = null;
    if (typeof key === 'string' && key.trim()) {
      presented = { raw: key.trim(), refusal: 'The API key is not a valid Uchiyomi API token.' };
    } else if (bearer !== null) {
      presented = { raw: bearer, refusal: 'The bearer token is not a valid Uchiyomi API token. Account sessions are not accepted here.' };
    } else if (basic !== null) {
      presented = { raw: basic, refusal: 'Use an Uchiyomi API token as the password. Account passwords are not accepted here.' };
    } else if (req.headers.authorization) {
      // Some other scheme (Digest, a bare word, an empty Basic): still a credential this request chose to
      // present, so it is judged and refused rather than quietly outranked by a remembered cookie.
      presented = { raw: '', refusal: 'Send an Uchiyomi API token as X-API-Key, as a Bearer token, or as the HTTP Basic password.' };
    }

    if (presented) {
      credentialed = true;
      const wait = await overBudget(req, false);
      if (wait) return tooMany(reply, wait);
      tok = presented.raw.startsWith(API_TOKEN_PREFIX) ? await resolveApiToken(presented.raw) : null;
      if (!tok) {
        const after = await overBudget(req, true);
        if (after) return tooMany(reply, after);
        return unauthorized(reply, presented.refusal);
      }
    } else if (cookie) {
      tok = await resolveApiTokenById(cookie.tokenId);
      if (!tok) return unauthorized(reply, 'This session\'s API token is no longer valid.');
    } else {
      return unauthorized(reply, 'Send an Uchiyomi API token as X-API-Key, as a Bearer token, or as the HTTP Basic password.');
    }

    // The same rule as authenticate(): a read-only token may look but not touch. The only write here is the
    // tracker's PUT, so a token minted without `write` browses and reads fine and cannot sync.
    if (!tok.scopes.includes('write') && !SAFE_METHODS.has(req.method)) {
      return reply.code(403).send({ error: 'forbidden', message: 'This token is read-only.' });
    }

    // Shaped like a verified JWT payload so userIdOf/roleOf work unchanged downstream.
    (req as any).user = { sub: tok.userId, role: tok.role, tokenScopes: tok.scopes };
    // hideAdult is the surfacing filter, decided by the token; the age CAP still applies through visible().
    (req as any).viewCtx = await viewCtxFor(tok.userId, tok.role, { hideAdult: !tok.showAdult });

    if (credentialed) {
      const minted = mintSession(tok.id, tok.expiresAt);
      if (shouldRemint(cookie, tok.id, minted.maxAge)) {
        // secure:'auto' (Secure only over HTTPS): the WebView refuses a Secure cookie set over plain http, and
        // a LAN install is plain http. Path=/ so both /api/v1 and /api/v2 match; no Domain. httpOnly and
        // SameSite=Lax do not restrict OkHttp's jar (it reads with MakeAllInclusive).
        reply.setCookie(SESSION_COOKIE, minted.value, {
          httpOnly: true, secure: 'auto', sameSite: 'lax', path: '/', maxAge: minted.maxAge,
        });
      }
    }
  });

  /**
   * No freshness on JSON. Both clients send `Cache-Control: max-age=600` as a REQUEST directive and Mihon
   * keeps a 5 MiB OkHttp disk cache, so a JSON answer with any freshness at all could be replayed for ten
   * minutes -- including the progress GET right after a PUT. Image bytes keep the image cache's own headers.
   */
  app.addHook('onSend', async (_req, reply, payload) => {
    const ct = String(reply.getHeader('content-type') ?? '');
    if (ct.startsWith('application/json')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const seriesOr404 = async (req: FastifyRequest, reply: FastifyReply, id: string) => {
    try {
      return await owned.series(vc(req), id);
    } catch (e) {
      if ((e as { statusCode?: number })?.statusCode === 404) { reply.code(404).send({ error: 'not_found' }); return null; }
      throw e;
    }
  };

  const listSeries = async (req: FastifyRequest, reply: FastifyReply, forcedSort?: string) => {
    const parsed = parseSeriesQuery(req.query as Record<string, unknown>);
    const sort = forcedSort ?? parsed.sort;
    // The extension never asks for an unpaged series list; a client that does gets the largest page instead
    // of two queries per request.
    const size = parsed.unpaged ? 500 : parsed.size;
    let res;
    try {
      res = await owned.searchSeries(vc(req), { condition: parsed.condition, fullTextSearch: parsed.fullTextSearch }, parsed.page, size, sort);
    } catch (e) {
      // A filter the query cannot express is refused, never silently widened to the whole library.
      if (e instanceof UnsupportedFilter) return reply.code(400).send({ error: 'unsupported_filter', message: `This filter is not supported: ${e.predicate}.` });
      throw e;
    }
    return springPage(res.content.map((s: any) => komgaSeries(s)), res.totalElements, parsed.page, size);
  };

  // ---- libraries ---------------------------------------------------------------------------------------
  // The extension's "log in" check and its Libraries filter. `owned.libraries` already drops what the grants
  // and the cap forbid; the 18+ shelf is additionally kept off the list unless the token asked for it,
  // because the extension shows every library it is told about and has no reveal of its own.
  app.get('/api/v1/libraries', async (req) => {
    const ctx = vc(req);
    const libs = await owned.libraries(ctx);
    return libs
      .filter((l) => !(ctx.hideAdultLibraries && l.adult))
      .map((l) => ({ id: l.id, name: l.name, root: '', unavailable: false }));
  });

  // ---- series ------------------------------------------------------------------------------------------
  app.get('/api/v1/series', (req, reply) => listSeries(req, reply));
  // Komga has no such path; PR #51 exposed it and the extension's Latest tab is `sort=lastModifiedDate,desc`
  // on /series. Kept as an alias for clients that learned it from the PR's docs.
  app.get('/api/v1/series/latest', (req, reply) => listSeries(req, reply, 'lastModifiedDate,desc'));

  // Details, for the extension AND for the tracker's `getTrackSearch` -- which is why the read counts are the
  // real ones: Mihon derives the tracker status from booksCount versus booksRead/UnreadCount.
  app.get('/api/v1/series/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = await seriesOr404(req, reply, id);
    if (!dto) return;
    const prog = await readProgressV2(vc(req), uid(req), id);
    const counts = prog
      ? { read: prog.booksReadCount, unread: prog.booksUnreadCount, inProgress: prog.booksInProgressCount }
      : undefined;
    return komgaSeries(dto, counts);
  });

  // The chapter list. `unpaged=true` answers everything on one page (size = the count, never 0: a follow-only
  // series has zero books and a zero size made totalPages NaN, which the Kotlin client refuses as a Long).
  // `media_status=READY` excludes pruned tombstones: the extension filters nothing client-side, and a tombstone
  // listed as READY is a chapter whose every page 404s the moment it is tapped. Their numbers still count for
  // the progress endpoints, which read all books.
  //
  // Under the ghost opt-in (lib/komgaGhosts) that inverts: the tombstones stay IN, and the chapters the sources
  // listed but this server never fetched join them, both labelled "not downloaded" in the row itself. The
  // trackers are the reason -- Mihon takes the series' chapter total from this list, so a library that prunes
  // what it has read was telling AniList a thousand-chapter manhwa had one chapter.
  app.get('/api/v1/series/:id/books', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await seriesVisible(id, vc(req)))) return reply.code(404).send({ error: 'not_found' });
    const parsed = parseBooksQuery(req.query as Record<string, unknown>);
    const ghosts = await ghostsEnabled();
    // One query for the whole series rather than a count and a page: the READY filter has to run over the
    // rows, and a series holds hundreds of chapters, not millions.
    const all = await owned.seriesBooks(vc(req), id, 0, 100_000, parsed.sort);
    const real = parsed.readyOnly && !ghosts ? all.content.filter((b: any) => !b.pruned) : all.content;
    let rows: unknown[] = real.map((b: any) => komgaBook(b, { absent: ghosts }));
    if (ghosts) {
      // Merged by number into the order seriesBooks already returned, rather than appended: the extension
      // renders the list as given, and a chapter list that runs 1..40 and then jumps back to 3 is unreadable.
      // The sort direction is the one parseBooksQuery resolved, so `desc` stays desc.
      const desc = /desc/i.test(parsed.sort);
      const ghostRows = (await ghostBooksFor(id)).map((g) => komgaGhostBook(g));
      rows = [...rows, ...ghostRows].sort((a: any, b: any) => (desc ? b.number - a.number : a.number - b.number));
    }
    const size = parsed.unpaged ? Math.max(1, rows.length) : parsed.size;
    const page = parsed.unpaged ? 0 : parsed.page;
    const slice = rows.slice(page * size, page * size + size);
    // `unpaged` reaches springPage as the option, never as a size: the size is capped at 500 and a series
    // above it answered `size 500, last false` with every row in content (8 live series are above it).
    return springPage(slice, rows.length, page, size, { unpaged: parsed.unpaged });
  });

  app.get('/api/v1/series/:id/thumbnail', (req, reply) => serveLibSeriesThumb(req, reply, (req.params as { id: string }).id));

  // ---- books -------------------------------------------------------------------------------------------
  // The extension's "Books" search type. This library has no chapter-level search; an empty page is what the
  // client handles gracefully (it reads `content` and `last`), and it is honest.
  app.get('/api/v1/books', async (req) => {
    const parsed = parseBooksQuery(req.query as Record<string, unknown>);
    return springPage([], 0, parsed.page, parsed.size);
  });

  const bookOr404 = async (req: FastifyRequest, reply: FastifyReply, id: string) => {
    try {
      return await owned.book(vc(req), id);
    } catch (e) {
      if ((e as { statusCode?: number })?.statusCode === 404) { reply.code(404).send({ error: 'not_found' }); return null; }
      throw e;
    }
  };

  // ⚠️ Every route that takes a book id has to test for a ghost one FIRST. A ghost id matches no lib_books
  // row, so the ordinary lookup can only 404 it -- which would mean `/pages` saying "no such chapter" for a
  // chapter the list had just handed out. The cheap shape test (isGhostId) gates the settings read, so the
  // ordinary path costs nothing extra.

  app.get('/api/v1/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ghosts = await ghostsEnabled();
    if (isGhostId(id)) {
      const ghost = ghosts ? await ghostBookById(id, vc(req)) : null;
      return ghost ? komgaGhostBook(ghost) : reply.code(404).send({ error: 'not_found' });
    }
    const dto = await bookOr404(req, reply, id);
    return dto ? komgaBook(dto, { absent: ghosts }) : undefined;
  });

  // 1-based page numbers, as Komga's are and as the extension uses them verbatim in the image URL. A pruned
  // chapter answers an empty list: there are no pages behind it, and page_dims is a cache that outlives them.
  //
  // So does a ghost, and for the same reason -- there were never any pages. Mihon shows its own "no pages"
  // error, which is the intended end of tapping one. ⚠️ NOT a placeholder image saying "not downloaded":
  // Mihon marks a chapter read once it is viewed, and that would push the very tracker progress the ghost
  // rows exist to keep honest.
  app.get('/api/v1/books/:id/pages', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (isGhostId(id)) {
      const ghost = (await ghostsEnabled()) ? await ghostBookById(id, vc(req)) : null;
      return ghost ? [] : reply.code(404).send({ error: 'not_found' });
    }
    if (!(await bookOr404(req, reply, id))) return;
    const pages = await owned.bookPages(vc(req), id);
    return pages.map((p, i) => komgaPage(p, i));
  });

  // `?convert=png` is accepted and ignored: the extension appends it for media types it cannot decode, and
  // every page this server holds is jpeg/png/webp/gif/avif, all of which it can.
  app.get('/api/v1/books/:id/pages/:n', (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const pageNo = Number(n);
    if (!Number.isInteger(pageNo) || pageNo < 1) return reply.code(400).send({ error: 'bad_page', message: 'Page numbers start at 1.' });
    // A ghost has no page 1 to serve. 404 rather than a placeholder, for the reason on /pages above.
    if (isGhostId(id)) return reply.code(404).send({ error: 'not_found' });
    return serveLibBookPage(req, reply, id, pageNo, 0);
  });

  // No cover for a chapter with no pages; the extension falls back to the series thumbnail.
  app.get('/api/v1/books/:id/thumbnail', (req, reply) => {
    const { id } = req.params as { id: string };
    if (isGhostId(id)) return reply.code(404).send({ error: 'not_found' });
    return serveLibBookThumb(req, reply, id);
  });

  // ---- referential (the filter sheet) ------------------------------------------------------------------
  // `fetchFilterData` fires libraries, collections, genres, tags, publishers and authors back to back and the
  // whole sheet fails if any one of them does not parse. All through browsable(): a count or a name from a
  // library this viewer cannot open is a disclosure.
  app.get('/api/v1/genres', async (req) => owned.genres(vc(req)));
  app.get('/api/v1/tags', async () => []);
  app.get('/api/v1/publishers', async () => []);
  app.get('/api/v1/authors', async (req) => {
    const p = new Params();
    const rows = await q<{ author: string }>(
      `SELECT DISTINCT COALESCE(o.author, s.author) AS author
         FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
        WHERE ${browsable('s', vc(req), p)} AND btrim(COALESCE(o.author, s.author, '')) <> ''
        ORDER BY author`,
      p.values as any[],
    );
    return rows.map((r) => ({ name: r.author, role: 'writer' }));
  });

  // Collections and read lists answer EMPTY pages. Listing a collection would have to answer `seriesIds`,
  // and a personal collection can name series this credential's cap or grants hide -- an id is a
  // disclosure. The extension only uses these to populate a filter drop-down, and handles an empty one.
  const emptyPage = (req: FastifyRequest) => {
    const parsed = parseBooksQuery(req.query as Record<string, unknown>);
    return springPage([], 0, parsed.unpaged ? 0 : parsed.page, parsed.unpaged ? 1 : parsed.size);
  };
  app.get('/api/v1/collections', async (req) => emptyPage(req));
  app.get('/api/v1/collections/:id/series', async (req) => emptyPage(req));
  app.get('/api/v1/readlists', async (req) => emptyPage(req));
  // Read lists do not exist here, so a read list's progress is not-found in both directions. The tracker only
  // asks for a read list it was bound to, and it cannot bind to one it was never listed.
  app.get('/api/v1/readlists/:id', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.get('/api/v1/readlists/:id/read-progress/tachiyomi', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.put('/api/v1/readlists/:id/read-progress/tachiyomi', async (_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // ---- identity ----------------------------------------------------------------------------------------
  // Komga's UserDto, from the token's owner. `email` is the username: the extension's UI calls that field
  // "the user account email" and other Komga clients show it as the signed-in identity.
  app.get('/api/v2/users/me', async (req) => {
    const ctx = vc(req);
    const u = await one<{ username: string | null; display_name: string; role: string }>(
      'SELECT username, display_name, role FROM users WHERE id = $1', [uid(req)],
    );
    return {
      id: uid(req),
      email: u?.username || u?.display_name || '',
      roles: u?.role === 'admin' ? ['ADMIN', 'USER'] : ['USER'],
      sharedAllLibraries: ctx.libraryIds === null,
      sharedLibrariesIds: ctx.libraryIds ? [...ctx.libraryIds] : [],
      labelsAllow: [],
      labelsExclude: [],
      ageRestriction: ctx.maxAgeRating === null ? null : { age: ctx.maxAgeRating, restriction: 'ALLOW_ONLY' },
    };
  });

  // ---- the tracker -------------------------------------------------------------------------------------
  // What Mihon reads to decide UNREAD / READING / COMPLETED and `last_chapter_read`. Over EVERY book of the
  // series, pruned included: members' history refers to them. Null means the viewer may not see the series.
  app.get('/api/v2/series/:id/read-progress/tachiyomi', async (req, reply) => {
    const { id } = req.params as { id: string };
    const prog = await readProgressV2(vc(req), uid(req), id);
    if (!prog) return reply.code(404).send({ error: 'not_found' });
    return prog;
  });

  /**
   * Mark every chapter up to this number read, as Komga does: forward-only, never un-marks.
   *
   * Mihon PUTs on EVERY bind and refresh, not only after reading (SyncChapterProgressWithTrack.kt L41-46), so
   * this has to be idempotent and cheap: one set-based upsert that skips already-completed rows, and the
   * external trackers (AniList, MAL) are pushed only when something actually changed -- otherwise a library
   * refresh of two hundred bound series was two hundred remote mutations.
   *
   * `<= 0` is a no-op 204. A fresh bind sends 0.0, and in this library number 0 is not rare ("Extra.cbz",
   * "Oneshot.cbz" -- any file without a digit), so honouring it marked prologues read on the first bind.
   * Mihon never legitimately pushes 0 for a chapter it read (TrackChapter.kt skips numbers at or below the
   * last read), so nothing is lost.
   *
   * 404 unless the series is VISIBLE to this viewer -- visible, not browsable: the 18+ hide is a surfacing
   * preference and refusing to record what someone read would be data loss. 403 for a read-only token is the
   * hook's job and has already happened.
   */
  app.put('/api/v2/series/:id/read-progress/tachiyomi', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await seriesVisible(id, vc(req)))) return reply.code(404).send({ error: 'not_found' });
    // `.max(1e9)`: markReadUpTo binds the number as `$3::real`, and a finite double past real's range
    // (1e300) was a Postgres "out of range" DatabaseError -- a 500 and an error-level log line from any write
    // token, for input the schema had accepted. Mihon echoes a Float numberSort as a Double; no chapter number
    // comes near a billion, so the cap refuses nothing real and answers 400 like every other bad body.
    // Reintroduce by dropping `.max(1e9)`: the 1e300 assertion in "the PUT validates its body and treats zero
    // as a no-op" sees 500.
    const b = z.object({ lastBookNumberSortRead: z.number().finite().min(0).max(1e9) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', message: 'lastBookNumberSortRead must be a finite number between 0 and 1000000000.' });
    const n = b.data.lastBookNumberSortRead;
    if (n <= 0) return reply.code(204).send();
    const { changed } = await markReadUpTo(uid(req), id, n);
    if (changed > 0) pushSeriesProgressAsync(uid(req), id);
    return reply.code(204).send();
  });
}
