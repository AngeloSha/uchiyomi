// The Komga-compatible API (routes/komgaCompat.ts): who gets in, what the cookie does, and what a client sees.
//
// Driven over HTTP against the real plugin with real CBZ files on disk, because the two things that matter
// here are not "does the helper work" but (1) "did adding a cookie session weaken any existing credential"
// -- the session value must open nothing but these routes, and revoking or disabling must end it -- and
// (2) "does a viewer's cap or grant still apply on every route, including the byte routes", which only a
// request through the hook can show. Mihon's tracker sends NO credential at all (KomgaApi.kt L27-31), so the
// cookie-only GET/PUT cases below are the whole point of the feature.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Static, like the other zod-shaped tests: a dynamic import of zod is a different module instance than the
// routes' own, and `instanceof ZodError` then fails in the error handler. See uchiyomi-zod-instanceof-trap.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
const TMP = DSN ? mkdtempSync(join(tmpdir(), 'uchiyomi-kc-')) : '';
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(TMP, 'cache'); // serveImage writes here; never the live cache
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const LIB = 'lib_kc_a', ADULT_LIB = 'lib_kc_x';
const S_MAIN = 's_kc_main', S_HIDDEN = 's_kc_hidden', S_ADULT = 's_kc_adult', S_EMPTY = 's_kc_empty', S_RATED = 's_kc_rated';
const B1 = 'b_kc_1', B2 = 'b_kc_2', B3 = 'b_kc_3', BX = 'b_kc_x1', BR = 'b_kc_r1';
const READER = 'kc-reader', CAPPED = 'kc-capped', OTHER = 'kc-other', DISABLED = 'kc-disabled';
const PASSWORD = 'correct horse battery staple';
const COOKIE = 'UCHIYOMI-SESSION';
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const key = (t: string) => ({ 'x-api-key': t });

/** The UCHIYOMI-SESSION Set-Cookie header of a response, split into value and attributes, or null. */
function sessionCookie(r: { headers: Record<string, unknown> }): { value: string; attrs: string } | null {
  const raw = r.headers['set-cookie'];
  const list = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []) as string[];
  const hit = list.find((c) => c.startsWith(`${COOKIE}=`));
  if (!hit) return null;
  const [pair, ...rest] = hit.split(';');
  return { value: pair.slice(COOKIE.length + 1), attrs: rest.join(';') };
}

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const session = await import('../src/lib/komgaSession');
  const { hash } = await import('@node-rs/argon2');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  const komgaCompat = (await import('../src/routes/komgaCompat')).default;
  const imageRoutes = (await import('../src/routes/images')).default;
  const authRoutes = (await import('../src/routes/auth')).default;
  const sharp = (await import('sharp')).default;
  const AdmZip = require('adm-zip');

  await migrate();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[READER, CAPPED, OTHER, DISABLED]]);
  await q(`DELETE FROM lib_series WHERE id LIKE 's_kc_%'`);
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [[LIB, ADULT_LIB]]);

  // Two real pages, distinguishable by size, so page 1 and page 2 are checkable as bytes.
  const page = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#446622' } }).png().toBuffer();
  const [p0, p1] = await Promise.all([page(600, 900), page(500, 800)]);
  mkdirSync(join(TMP, 'lib'), { recursive: true });
  const cbz = (name: string) => { const z = new AdmZip(); z.addFile('001.png', p0); z.addFile('002.png', p1); writeFileSync(join(TMP, 'lib', name), z.toBuffer()); return name; };

  const pw = await hash(PASSWORD);
  const users = await q<{ id: string; username: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, max_age_rating, disabled)
     VALUES ($1,$1,$5,'user','password',NULL,false), ($2,$2,'x','user','password',16,false),
            ($3,$3,'x','user','password',NULL,false), ($4,$4,'x','user','password',NULL,true)
     RETURNING id, username`, [READER, CAPPED, OTHER, DISABLED, pw]);
  const idOf = (u: string) => users.find((x) => x.username === u)!.id;
  const reader = idOf(READER), capped = idOf(CAPPED), other = idOf(OTHER), disabled = idOf(DISABLED);

  await q(`INSERT INTO libraries (id, name, path, sort_order, age_rating) VALUES ($1,'Shelf','/kc/shelf',0,NULL), ($2,'Grown-ups','/kc/grown',1,18)`, [LIB, ADULT_LIB]);
  const series = async (id: string, title: string, lib: string, count: number, rating: number | null = null) =>
    q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, genres, status, author, latest_mtime, created_at, age_rating)
       VALUES ($1,'T!kc',$2,$3,$4,$5,'{Action}','ongoing','Someone',$6,'2026-01-02T03:04:05Z',$7)`,
      [id, title, `T!kc/${id}`, count, lib, Date.parse('2026-03-04T05:06:07Z'), rating]);
  await series(S_MAIN, 'Kc Main Title', LIB, 3);
  await series(S_HIDDEN, 'Kc Hidden Title', LIB, 1);
  await series(S_ADULT, 'Kc Grown Title', ADULT_LIB, 1);
  await series(S_EMPTY, 'Kc Follow Only', LIB, 0); // a follow-only add: a series with no books at all
  await series(S_RATED, 'Kc Rated Title', LIB, 1, 18); // an 18-rated title on the ordinary shelf
  await q(`UPDATE lib_series SET deleted_at = now() WHERE id = $1`, [S_HIDDEN]);

  const book = (id: string, sid: string, file: string, n: number) =>
    q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, updated_at)
       VALUES ($1,$2,'T!kc',$3,$4,$5,2,$6,'2026-01-02T03:04:05Z')`, [id, sid, file, n, `Chapter ${n}`, join(TMP, 'lib')]);
  await book(B1, S_MAIN, cbz('one.cbz'), 1);
  await book(B2, S_MAIN, cbz('two.cbz'), 2);
  await book(B3, S_MAIN, cbz('three.cbz'), 3);
  await book(BX, S_ADULT, cbz('x.cbz'), 1);
  await book(BR, S_RATED, cbz('r.cbz'), 1);
  // Chapter 3 was read and its bytes let go (lib/chapterCleanup): a tombstone that still counts.
  await q(`UPDATE lib_books SET pruned_at = now(), pruned_reason = 'read' WHERE id = $1`, [B3]);
  // The first-page cover fallback reads cover_book_id; the scanner sets it, this seed has to.
  await q(`UPDATE lib_series SET cover_book_id = $2 WHERE id = $1`, [S_MAIN, B1]);
  await q(`UPDATE lib_series SET cover_book_id = $2 WHERE id = $1`, [S_RATED, BR]);

  const app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    const status = err.statusCode || 500;
    if (status >= 500) { req.log.error(err); console.error('ROUTE 500:', req.url, err?.message); }
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  // As server.ts registers it: `global: false`, so only routes and plugins that opt in are limited. The compat
  // hook opts in for failed credentials through this root registration, the production shape (a bare app
  // without it gets a private registration inside the plugin; openapiCoverage exercises that path).
  await app.register(rateLimit, { global: false });
  await app.register(komgaCompat);
  await app.register(imageRoutes);
  // The real /auth/logout, for "signing out clears the Komga session cookie too".
  await app.register(authRoutes);
  // The ordinary API, guarded by the real authenticate(): what the session cookie must NOT open.
  app.get('/api/who', { preHandler: auth.authenticate }, async (req) => ({ sub: auth.userIdOf(req) }));
  await app.ready();

  const tok = {
    read: (await auth.issueApiToken(reader, 'read', ['read'], null)).token,
    write: (await auth.issueApiToken(reader, 'write', ['read', 'write'], null)).token,
    adult: (await auth.issueApiToken(reader, 'adult', ['read', 'write'], null, true)).token,
    capped: (await auth.issueApiToken(capped, 'capped', ['read', 'write'], null)).token,
    other: (await auth.issueApiToken(other, 'other', ['read', 'write'], null)).token,
    disabled: (await auth.issueApiToken(disabled, 'disabled', ['read', 'write'], null)).token,
    opds: await auth.issueOpdsToken(reader),
  };
  return { app, q, auth, session, reader, capped, other, disabled, tok };
}

async function teardown(app: any, q: any) {
  await app.close();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[READER, CAPPED, OTHER, DISABLED]]).catch(() => {});
  await q(`DELETE FROM lib_series WHERE id LIKE 's_kc_%'`).catch(() => {});
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [[LIB, ADULT_LIB]]).catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
}

test('the Komga-compatible API: credentials, the session cookie, and what a viewer may see', { skip }, async (t) => {
  const { app, q, auth, session, reader, other, disabled, tok } = await setup();
  // ⚠️ Every sub-test speaks from its own client address. The hook counts FAILED credentials per address (ten
  // per five minutes, like /auth/login), and the auth matrix below spends seven of them on purpose; one more
  // refusal added anywhere in this file would then have turned a later, unrelated sub-test into a 429 that
  // looks like nothing in its own assertions (see uchiyomi-e2e-login-rate-limit). A fresh address per
  // sub-test keeps each one's budget its own; the limiter has a sub-test of its own that spends a whole one.
  let clientSeq = 0;
  t.beforeEach(() => { clientSeq++; });
  const remoteAddress = () => `10.77.${(clientSeq >> 8) & 255}.${clientSeq & 255}`;
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers, remoteAddress: remoteAddress() });
  const put = (url: string, headers: Record<string, string>, payload: unknown) => app.inject({ method: 'PUT', url, headers, payload, remoteAddress: remoteAddress() });
  const progressRows = async (uid: string) => (await q(`SELECT book_id FROM read_progress WHERE user_id = $1 AND series_id = $2 AND completed`, [uid, S_MAIN])).length;
  try {
    // ---- the auth matrix ------------------------------------------------------------------------------
    await t.test('no credential is a 401 that asks for Basic, and it sets no cookie', async () => {
      const r = await get('/api/v1/libraries');
      assert.equal(r.statusCode, 401);
      // The extension's Basic authenticator fires on a 401 and its login check treats any non-2xx as a bad
      // login. Reintroduce by answering 403 or 200 []: this fails, and so does "log in" in the app.
      assert.equal(r.headers['www-authenticate'], 'Basic realm="Uchiyomi"');
      assert.equal(sessionCookie(r), null, 'a 401 must never mint a session');
    });

    await t.test('X-API-Key with an API token authenticates; Basic with the token as the password does too', async () => {
      // The default library ('lib', created by migrate) rides along; what matters is ours is there.
      const a = await get('/api/v1/libraries', key(tok.read));
      assert.equal(a.statusCode, 200);
      assert.ok(a.json().some((l: any) => l.id === LIB && l.name === 'Shelf'));
      const b = await get('/api/v1/libraries', { authorization: basic('anything at all', tok.read) });
      assert.equal(b.statusCode, 200);
      assert.ok(b.json().some((l: any) => l.id === LIB));
    });

    await t.test('Basic with the account password is refused even when it is right', async () => {
      // Reintroduce by adding an argon2 path against users.password_hash to the hook: this sees 200, and an
      // account protected by TOTP is reachable with the password alone, with no lockout counter.
      const r = await get('/api/v1/libraries', { authorization: basic(READER, PASSWORD) });
      assert.equal(r.statusCode, 401);
      assert.equal(sessionCookie(r), null);
    });

    await t.test('an OPDS token, a garbage key and a foreign JWT are all 401', async () => {
      assert.equal((await get('/api/v1/libraries', key(tok.opds))).statusCode, 401, 'OPDS tokens carry no scopes');
      assert.equal((await get('/api/v1/libraries', { authorization: basic('x', tok.opds) })).statusCode, 401);
      assert.equal((await get('/api/v1/libraries', key('uy_nonsense'))).statusCode, 401);
      assert.equal((await get('/api/v1/libraries', key('nonsense'))).statusCode, 401);
      const jwtToken = app.jwt.sign({ sub: reader, role: 'user' }, { expiresIn: 60 });
      assert.equal((await get('/api/v1/libraries', { authorization: `Bearer ${jwtToken}` })).statusCode, 401, 'the app JWT is not a credential here');
    });

    await t.test("a disabled account's token and cookie both stop working", async () => {
      // Reintroduce by dropping `NOT u.disabled` from TOKEN_SELECT in lib/auth.ts.
      await q(`UPDATE users SET disabled = false WHERE id = $1`, [disabled]);
      const live = await get('/api/v1/libraries', key(tok.disabled));
      assert.equal(live.statusCode, 200);
      const c = sessionCookie(live)!;
      await q(`UPDATE users SET disabled = true WHERE id = $1`, [disabled]);
      assert.equal((await get('/api/v1/libraries', key(tok.disabled))).statusCode, 401);
      assert.equal((await get('/api/v1/libraries', { cookie: `${COOKIE}=${c.value}` })).statusCode, 401);
    });

    await t.test('a read-only token may browse but not sync (403), a write token may (204)', async () => {
      const no = await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.read), { lastBookNumberSortRead: 1 });
      assert.equal(no.statusCode, 403);
      assert.match(no.json().message, /read-only/);
      assert.equal(await progressRows(reader), 0);
      const yes = await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.write), { lastBookNumberSortRead: 1 });
      assert.equal(yes.statusCode, 204);
      assert.equal(await progressRows(reader), 1);
    });

    // ---- the cookie -----------------------------------------------------------------------------------
    let cookieA = '';
    await t.test('the first credentialed request mints UCHIYOMI-SESSION with the right attributes', async () => {
      const r = await get('/api/v1/libraries', key(tok.write));
      const c = sessionCookie(r);
      assert.ok(c, 'no session cookie on a credentialed request');
      cookieA = c!.value;
      assert.match(cookieA, /^v1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]+$/, 'value is v1.<tokenId>.<exp>.<mac>');
      assert.match(c!.attrs, /HttpOnly/);
      assert.match(c!.attrs, /SameSite=Lax/);
      assert.match(c!.attrs, /Path=\//);
      assert.doesNotMatch(c!.attrs, /Domain=/, 'no Domain attribute');
      // Plain http (inject is not TLS): the WebView refuses a Secure cookie set over http, so it must be absent.
      assert.doesNotMatch(c!.attrs, /Secure/);
      const maxAge = Number(/Max-Age=(\d+)/.exec(c!.attrs)?.[1]);
      assert.ok(maxAge > 0 && maxAge <= 7 * 24 * 3600, `Max-Age ${maxAge} must be within seven days`);
      // Not re-set while the same token presents a fresh cookie: one Set-Cookie per session, not per image.
      const again = await get('/api/v1/libraries', { ...key(tok.write), cookie: `${COOKIE}=${cookieA}` });
      assert.equal(again.statusCode, 200);
      assert.equal(sessionCookie(again), null, 'a fresh cookie for the same token must not be re-minted');
    });

    await t.test('the cookie alone opens the tracker routes: details, progress GET and PUT (the Mihon case)', async () => {
      const only = { cookie: `${COOKIE}=${cookieA}`, 'user-agent': 'Mihon v0.18.0 (app.mihon)' };
      const d = await get(`/api/v1/series/${S_MAIN}`, only);
      assert.equal(d.statusCode, 200);
      assert.equal(d.json().metadata.title, 'Kc Main Title');
      const g = await get(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, only);
      assert.equal(g.statusCode, 200);
      assert.equal(g.json().booksReadCount, 1, 'the PUT above marked chapter 1');
      const p = await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, only, { lastBookNumberSortRead: 2 });
      assert.equal(p.statusCode, 204);
      assert.equal(await progressRows(reader), 2);
      const after = await get(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, only);
      assert.deepEqual(
        { count: after.json().booksCount, read: after.json().booksReadCount, last: after.json().lastReadContinuousNumberSort, max: after.json().maxNumberSort },
        { count: 3, read: 2, last: 2, max: 3 },
        'the pruned chapter 3 still counts: members\' history refers to it',
      );
      assert.equal(after.headers['cache-control'], 'no-store', 'JSON must carry no freshness for the OkHttp cache');
    });

    await t.test('a cookie for token A alongside key B is re-minted for B, and the next cookie-only PUT lands on B', async () => {
      // Reintroduce by only minting when no valid cookie is presented: the tracker keeps writing user A's
      // progress after the extension was switched to user B's token.
      const r = await get('/api/v1/libraries', { ...key(tok.other), cookie: `${COOKIE}=${cookieA}` });
      assert.equal(r.statusCode, 200);
      const c = sessionCookie(r);
      assert.ok(c, 'the cookie must be re-minted for the presented token');
      assert.notEqual(c!.value, cookieA);
      const p = await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, { cookie: `${COOKIE}=${c!.value}` }, { lastBookNumberSortRead: 1 });
      assert.equal(p.statusCode, 204);
      assert.equal(await progressRows(other), 1, 'the write landed on B');
      assert.equal(await progressRows(reader), 2, 'and not on A');
    });

    await t.test('Bearer with an API token is a credential here, and it beats a remembered cookie for another token', async () => {
      // Reintroduce by dropping the Bearer branch from the hook: the request answers as the COOKIE's owner
      // (reader), the one gap in "explicit beats remembered" -- a presented credential silently overridden.
      const bearer = { authorization: `Bearer ${tok.other}`, cookie: `${COOKIE}=${cookieA}` };
      const me = await get('/api/v2/users/me', bearer);
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().id, other, 'the presented Bearer token wins over the remembered cookie');
      const c = sessionCookie(me);
      assert.ok(c && c.value !== cookieA, 'and the cookie is re-minted for the presented token');
      // A Bearer that resolves to nothing is a 401 even with a perfectly good cookie beside it: never the cookie.
      const bad = await get('/api/v2/users/me', { authorization: 'Bearer uy_nonsense', cookie: `${COOKIE}=${cookieA}` });
      assert.equal(bad.statusCode, 401);
      assert.equal(sessionCookie(bad), null);
      // and so is an Authorization scheme this API does not speak
      assert.equal((await get('/api/v2/users/me', { authorization: 'Digest nope', cookie: `${COOKIE}=${cookieA}` })).statusCode, 401);
    });

    await t.test('a cookie whose expiry is spelled with a leading zero is refused', async () => {
      // The MAC is over the parsed number, so "0<exp>" carried the same MAC as "<exp>" and verified: a
      // malleable cookie. Reintroduce by dropping the `String(exp) !== expStr` check in verifySession: 200.
      const [v, tid, exp, mac] = cookieA.split('.');
      const forged = `${v}.${tid}.0${exp}.${mac}`;
      assert.equal(session.verifySession(forged), null, 'verifySession must refuse the non-canonical encoding');
      assert.equal((await get('/api/v1/libraries', { cookie: `${COOKIE}=${forged}` })).statusCode, 401);
      assert.equal((await get('/api/v1/libraries', { cookie: `${COOKIE}=${cookieA}` })).statusCode, 200, 'the canonical one still opens');
    });

    await t.test('signing out clears the Komga session cookie too', async () => {
      // A browser that called the compat API with an X-API-Key (the API reference's "try it") holds the
      // seven-day cookie; /auth/logout must not leave it behind. Reintroduce by dropping the clearCookie in
      // the logout handler: no Set-Cookie for UCHIYOMI-SESSION.
      const r = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: `${COOKIE}=${cookieA}` } });
      assert.equal(r.statusCode, 200);
      const cleared = sessionCookie(r);
      assert.ok(cleared, 'logout must send a Set-Cookie for the Komga session');
      assert.equal(cleared!.value, '', 'cleared, not re-minted');
      assert.match(cleared!.attrs, /Max-Age=0/);
      assert.match(cleared!.attrs, /Path=\//, 'the same path the mint used, or the browser keeps the old one');
    });

    await t.test('the eleventh bad key from one address in five minutes is a 429', async () => {
      // Reintroduce by dropping the peek and the count in the hook: the eleventh is a 401 like the first ten.
      const from = (ip: string, headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/v1/libraries', headers, remoteAddress: ip });
      const IP = '203.0.113.9', ELSEWHERE = '203.0.113.10';
      for (let i = 1; i <= 10; i++) {
        assert.equal((await from(IP, key('uy_nonsense'))).statusCode, 401, `bad key ${i} of 10 is still a 401`);
      }
      // Ten failures spent: a good key still works (good keys never count), and a request with no credential
      // is still the extension's ordinary first 401, not a 429 -- neither is a guess.
      assert.equal((await from(IP, key(tok.read))).statusCode, 200);
      assert.equal((await from(IP, {})).statusCode, 401);
      const eleventh = await from(IP, key('uy_nonsense'));
      assert.equal(eleventh.statusCode, 429, 'the eleventh bad key');
      assert.deepEqual(eleventh.json(), { error: 'too_many_requests', message: 'Too many failed API keys from this address. Try again in a few minutes.' });
      const retryAfter = Number(eleventh.headers['retry-after']);
      assert.ok(retryAfter >= 1 && retryAfter <= 300, `Retry-After ${eleventh.headers['retry-after']} is the seconds left in the five-minute window`);
      // Over budget the address is refused before the key is looked up, good or bad, as /auth/login is…
      assert.equal((await from(IP, key(tok.read))).statusCode, 429);
      assert.equal((await from(IP, { authorization: basic('x', 'uy_nonsense') })).statusCode, 429);
      // …but the tracker's cookie-only requests are not credentials being guessed and keep working, and the
      // budget is per address: another phone is unaffected.
      assert.equal((await from(IP, { cookie: `${COOKIE}=${cookieA}` })).statusCode, 200);
      assert.equal((await from(ELSEWHERE, key(tok.read))).statusCode, 200);
      assert.equal((await from(ELSEWHERE, key('uy_nonsense'))).statusCode, 401);
    });

    await t.test('a garbage or foreign cookie is "no cookie": the key still works and a fresh one is minted', async () => {
      // Reintroduce by answering 401 for an unverifiable cookie: a real Komga on the same host writing its
      // own session id into the jar would lock this server out.
      for (const bad of ['KOMGA-SESSION-lookalike', 'v1.not-a-uuid.1.x', cookieA.slice(0, -2) + 'zz', '']) {
        const r = await get('/api/v1/libraries', { ...key(tok.write), cookie: `${COOKIE}=${bad}` });
        assert.equal(r.statusCode, 200, `key + cookie ${JSON.stringify(bad)}`);
        assert.ok(sessionCookie(r), 'a fresh cookie must replace the bad one');
      }
      assert.equal((await get('/api/v1/libraries', { cookie: `${COOKIE}=${cookieA.slice(0, -2)}zz` })).statusCode, 401, 'a tampered cookie alone is nothing');
    });

    await t.test('revoking the token ends its cookie on the next request', async () => {
      const { id, token } = await auth.issueApiToken(reader, 'doomed', ['read'], null);
      const r = await get('/api/v1/libraries', key(token));
      const c = sessionCookie(r)!;
      assert.equal((await get('/api/v1/libraries', { cookie: `${COOKIE}=${c.value}` })).statusCode, 200);
      assert.equal(await auth.revokeApiToken(reader, id), true);
      assert.equal((await get('/api/v1/libraries', { cookie: `${COOKIE}=${c.value}` })).statusCode, 401);
    });

    await t.test('the cookie is capped to the token expiry and is re-minted past half its life', async () => {
      const { token } = await auth.issueApiToken(reader, 'short', ['read'], new Date(Date.now() + 3600_000));
      const r = await get('/api/v1/libraries', key(token));
      const c = sessionCookie(r)!;
      const maxAge = Number(/Max-Age=(\d+)/.exec(c.attrs)?.[1]);
      assert.ok(maxAge <= 3600 && maxAge > 3500, `Max-Age ${maxAge} must follow the token's own expiry`);
      // A cookie minted with half its life gone (the exp is inside the value, so it can be forged here only
      // because the test holds the secret) is replaced on the next credentialed request.
      const verified = session.verifySession(c.value)!;
      const stale = session.mintSession(verified.tokenId, new Date(Date.now() + 1000 * (maxAge / 2 - 60)));
      const again = await get('/api/v1/libraries', { ...key(token), cookie: `${COOKIE}=${stale.value}` });
      assert.ok(sessionCookie(again), 'a cookie past half its life must be re-minted');
    });

    // ---- the cookie value must open nothing else ------------------------------------------------------
    await t.test('the session value is not a Bearer token and not an image cookie', async () => {
      // Reintroduce by minting the cookie with app.jwt.sign: both of these see 200, and a read-only token
      // holder owns a seven-day write session that survives revocation.
      assert.equal((await get('/api/who', { authorization: `Bearer ${cookieA}` })).statusCode, 401);
      assert.equal((await get(`/img/lib/series/${S_MAIN}/thumb`, { cookie: `yomi_img=${cookieA}` })).statusCode, 401);
    });

    await t.test('a yomi_img cookie value is not an API session', async () => {
      // Reintroduce by dropping the `typ` check in authenticate(): 200.
      const img = app.jwt.sign({ sub: reader, typ: 'img' }, { expiresIn: 60 });
      assert.equal((await get('/api/who', { authorization: `Bearer ${img}` })).statusCode, 401);
      // and the genuine access token still is one
      const access = app.jwt.sign({ sub: reader, role: 'user' }, { expiresIn: 60 });
      assert.equal((await get('/api/who', { authorization: `Bearer ${access}` })).statusCode, 200);
    });

    await t.test('an access token in the yomi_img cookie does not open images', async () => {
      // Reintroduce by dropping the `typ === 'img'` condition in authorizeImageRequest: 200.
      const access = app.jwt.sign({ sub: reader, role: 'user' }, { expiresIn: 60 });
      assert.equal((await get(`/img/lib/series/${S_MAIN}/thumb`, { cookie: `yomi_img=${access}` })).statusCode, 401);
      // and the genuine image cookie still does
      const img = app.jwt.sign({ sub: reader, typ: 'img' }, { expiresIn: 60 });
      assert.equal((await get(`/img/lib/series/${S_MAIN}/thumb`, { cookie: `yomi_img=${img}` })).statusCode, 200);
    });

    // ---- who may see what -----------------------------------------------------------------------------
    await t.test('a capped member gets 404 on a hidden series everywhere: details, books, pages, bytes, thumbnails', async () => {
      const h = key(tok.capped);
      // First warm the book thumbnail and a page as the unrestricted reader, so the cache is hot.
      assert.equal((await get(`/api/v1/books/${BR}/thumbnail`, key(tok.read))).statusCode, 200);
      assert.equal((await get(`/api/v1/books/${BR}/pages/1`, key(tok.read))).statusCode, 200);
      assert.equal((await get(`/api/v1/series/${S_RATED}`, h)).statusCode, 404);
      assert.equal((await get(`/api/v1/series/${S_RATED}/books?unpaged=true`, h)).statusCode, 404);
      assert.equal((await get(`/api/v1/series/${S_RATED}/thumbnail`, h)).statusCode, 404);
      assert.equal((await get(`/api/v1/books/${BR}`, h)).statusCode, 404);
      assert.equal((await get(`/api/v1/books/${BR}/pages`, h)).statusCode, 404);
      assert.equal((await get(`/api/v1/books/${BR}/pages/1`, h)).statusCode, 404);
      // Reintroduce by moving the bookFileAbs check back inside serveLibBookThumb's producer: the warm cache
      // answers 200 to the capped member.
      assert.equal((await get(`/api/v1/books/${BR}/thumbnail`, h)).statusCode, 404, 'a capped member gets 404 on a warmed book thumbnail');
      assert.equal((await get(`/api/v2/series/${S_RATED}/read-progress/tachiyomi`, h)).statusCode, 404);
      assert.equal((await put(`/api/v2/series/${S_RATED}/read-progress/tachiyomi`, h, { lastBookNumberSortRead: 1 })).statusCode, 404);
      // and the listing never names it
      const list = await get('/api/v1/series?search=&page=0&deleted=false', h);
      assert.ok(!list.json().content.some((s: any) => s.id === S_RATED));
      // a soft-deleted series is 404 for everyone
      assert.equal((await get(`/api/v1/series/${S_HIDDEN}`, key(tok.read))).statusCode, 404);
    });

    await t.test('18+ libraries are listed only to a token minted with show_adult, and only in listings', async () => {
      // Reintroduce by binding viewCtxFor(..., { hideAdult: false }) in the hook: the plain token lists
      // Grown-ups and the adult title turns up on the Popular tab unasked.
      const plainIds = (await get('/api/v1/libraries', key(tok.read))).json().map((l: any) => l.id);
      assert.ok(plainIds.includes(LIB) && !plainIds.includes(ADULT_LIB), `plain token lists ${plainIds}`);
      const adultIds = (await get('/api/v1/libraries', key(tok.adult))).json().map((l: any) => l.id);
      assert.ok(adultIds.includes(LIB) && adultIds.includes(ADULT_LIB), `show_adult token lists ${adultIds}`);
      const plainList = await get('/api/v1/series?search=&page=0&deleted=false&sort=metadata.titleSort,asc', key(tok.read));
      assert.ok(!plainList.json().content.some((s: any) => s.id === S_ADULT));
      const adultList = await get('/api/v1/series?search=&page=0&deleted=false&sort=metadata.titleSort,asc', key(tok.adult));
      assert.ok(adultList.json().content.some((s: any) => s.id === S_ADULT));
      // by id it is still there for the plain token: the hide is a surfacing preference, not a permission
      assert.equal((await get(`/api/v1/series/${S_ADULT}`, key(tok.read))).statusCode, 200);
      // the token list shows the flag
      const rows = await auth.listApiTokens(reader);
      assert.equal(rows.find((r) => r.name === 'adult')?.showAdult, true);
      assert.equal(rows.find((r) => r.name === 'read')?.showAdult, false);
    });

    // ---- the catalog ----------------------------------------------------------------------------------
    const PAGE_KEYS = ['content', 'empty', 'first', 'last', 'number', 'numberOfElements', 'size', 'totalElements', 'totalPages'];
    await t.test('the series listing is a full Spring page and every filter form is accepted', async () => {
      const r = await get('/api/v1/series?search=&page=0&deleted=false&sort=metadata.titleSort,asc', key(tok.read));
      assert.equal(r.statusCode, 200);
      const pg = r.json();
      assert.deepEqual(Object.keys(pg).sort(), PAGE_KEYS);
      assert.equal(pg.number, 0);
      assert.equal(pg.numberOfElements, pg.content.length);
      assert.ok(pg.content.some((s: any) => s.id === S_MAIN));
      const s = pg.content.find((x: any) => x.id === S_MAIN);
      for (const k of ['id', 'libraryId', 'name', 'fileLastModified', 'booksCount', 'booksReadCount', 'booksUnreadCount', 'booksInProgressCount', 'metadata', 'booksMetadata']) {
        assert.notEqual(s[k], undefined, `SeriesDto.${k} is required by the Kotlin client`);
      }
      for (const k of ['titleSort', 'summaryLock', 'readingDirection', 'readingDirectionLock', 'publisherLock', 'ageRatingLock', 'languageLock', 'genresLock', 'tagsLock']) {
        assert.notEqual(s.metadata[k], undefined, `SeriesMetadataDto.${k} is required`);
      }
      assert.match(s.fileLastModified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'dates are yyyy-MM-ddTHH:mm:ss, no Z, no millis');
      // comma-joined AND repeated params, both accepted and flattened; unknown sort falls back rather than 500
      assert.equal((await get(`/api/v1/series?search=&page=0&library_id=${LIB},nope&status=ONGOING,ENDED&read_status=UNREAD&read_status=IN_PROGRESS&author=Someone,writer&sort=createdDate,desc`, key(tok.read))).statusCode, 200);
      assert.equal((await get('/api/v1/series?search=Kc%20Main&page=0&sort=random', key(tok.read))).json().totalElements, 1);
      assert.equal((await get('/api/v1/series/latest?page=0', key(tok.read))).statusCode, 200);
    });

    await t.test('details carry the real read counts; the chapter list honours unpaged and media_status', async () => {
      const d = await get(`/api/v1/series/${S_MAIN}`, key(tok.write));
      assert.equal(d.statusCode, 200);
      assert.equal(d.json().booksReadCount, 2);
      assert.equal(d.json().booksUnreadCount, 1);
      const ready = await get(`/api/v1/series/${S_MAIN}/books?unpaged=true&media_status=READY&deleted=false`, key(tok.read));
      assert.equal(ready.statusCode, 200);
      const rp = ready.json();
      assert.deepEqual(Object.keys(rp).sort(), PAGE_KEYS);
      assert.deepEqual(rp.content.map((b: any) => b.id).sort(), [B1, B2], 'the pruned tombstone is not READY');
      assert.deepEqual({ size: rp.size, totalPages: rp.totalPages, last: rp.last, total: rp.totalElements }, { size: 2, totalPages: 1, last: true, total: 2 });
      const all = await get(`/api/v1/series/${S_MAIN}/books?unpaged=true`, key(tok.read));
      assert.equal(all.json().totalElements, 3, 'without the filter the tombstone is listed');
      const b = rp.content.find((x: any) => x.id === B1);
      for (const k of ['id', 'seriesId', 'seriesTitle', 'name', 'number', 'fileLastModified', 'sizeBytes', 'size', 'media', 'metadata']) {
        assert.notEqual(b[k], undefined, `BookDto.${k} is required`);
      }
      assert.equal(b.metadata.numberSort, 1, 'numberSort is the join key with the progress endpoint');
      // paged: page 1 of size 1 is the second chapter
      const paged = await get(`/api/v1/series/${S_MAIN}/books?page=1&size=1`, key(tok.read));
      assert.equal(paged.json().content[0].id, B2);
      assert.equal(paged.json().last, false);
    });

    await t.test('the zero-book series answers a sane page (no NaN, no zero size)', async () => {
      // Reintroduce by dividing by the raw count: totalPages is NaN, serialised as null, refused as a Long.
      // (Spring's PageImpl answers totalPages 0 for an empty page of size 1, and so does springPage.)
      const r = await get(`/api/v1/series/${S_EMPTY}/books?unpaged=true&media_status=READY&deleted=false`, key(tok.read));
      assert.equal(r.statusCode, 200);
      const pg = r.json();
      assert.deepEqual({ content: pg.content, size: pg.size, totalPages: pg.totalPages, empty: pg.empty, last: pg.last, total: pg.totalElements }, { content: [], size: 1, totalPages: 0, empty: true, last: true, total: 0 });
      assert.ok(!JSON.stringify(pg).includes('null'), 'no field of a page may be null');
    });

    await t.test('pages are 1-based and the bytes come back with a private cache policy', async () => {
      const list = await get(`/api/v1/books/${B1}/pages`, key(tok.read));
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json().map((p: any) => [p.number, p.fileName, p.mediaType]), [[1, '001.png', 'image/png'], [2, '002.png', 'image/png']]);
      const p1 = await get(`/api/v1/books/${B1}/pages/1?convert=png`, key(tok.read));
      assert.equal(p1.statusCode, 200);
      assert.equal(p1.headers['content-type'], 'image/png');
      assert.ok(p1.rawPayload.length > 100);
      // Reintroduce by writing `public` in lib/imageCache.ts: "image bytes are cached privately".
      assert.match(String(p1.headers['cache-control']), /^private,/, 'image bytes are cached privately');
      const p2 = await get(`/api/v1/books/${B1}/pages/2`, key(tok.read));
      assert.notEqual(p1.rawPayload.length, p2.rawPayload.length, 'page 1 and page 2 are different files');
      assert.equal((await get(`/api/v1/books/${B1}/pages/0`, key(tok.read))).statusCode, 400);
      assert.equal((await get(`/api/v1/books/${B1}/pages/3`, key(tok.read))).statusCode, 404);
      assert.equal((await get(`/api/v1/books/${B3}/pages`, key(tok.read))).json().length, 0, 'a tombstone has no pages');
      assert.equal((await get(`/api/v1/series/${S_MAIN}/thumbnail`, key(tok.read))).statusCode, 200);
      assert.equal((await get(`/api/v1/books/${B1}`, key(tok.read))).json().id, B1);
    });

    await t.test('the six filter-sheet calls, the identity and the empty pages all parse', async () => {
      assert.deepEqual((await get('/api/v1/genres', key(tok.read))).json(), ['Action']);
      assert.deepEqual((await get('/api/v1/tags', key(tok.read))).json(), []);
      assert.deepEqual((await get('/api/v1/publishers', key(tok.read))).json(), []);
      assert.deepEqual((await get('/api/v1/authors', key(tok.read))).json(), [{ name: 'Someone', role: 'writer' }]);
      for (const url of ['/api/v1/collections?unpaged=true', '/api/v1/collections/c1/series?page=0', '/api/v1/readlists?search=&page=0', '/api/v1/books?search=&page=0']) {
        const r = await get(url, key(tok.read));
        assert.equal(r.statusCode, 200, url);
        assert.deepEqual(Object.keys(r.json()).sort(), PAGE_KEYS, url);
        assert.equal(r.json().empty, true);
      }
      assert.equal((await get('/api/v1/readlists/r1/read-progress/tachiyomi', key(tok.read))).statusCode, 404);
      const me = await get('/api/v2/users/me', key(tok.read));
      assert.equal(me.statusCode, 200);
      assert.deepEqual({ id: me.json().id, email: me.json().email, roles: me.json().roles, all: me.json().sharedAllLibraries }, { id: reader, email: READER, roles: ['USER'], all: true });
      assert.equal(me.headers['cache-control'], 'no-store');
    });

    await t.test('the PUT validates its body and treats zero as a no-op', async () => {
      const before = await progressRows(reader);
      assert.equal((await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.write), { lastBookNumberSortRead: 'two' })).statusCode, 400);
      assert.equal((await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.write), { lastBookNumberSortRead: -1 })).statusCode, 400);
      // Finite, non-negative, and past the range of the `real` it is bound as: a 500 "out of range for type
      // real" from any write token until the schema capped it. Reintroduce by dropping `.max(1e9)`: 500.
      assert.equal((await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.write), { lastBookNumberSortRead: 1e300 })).statusCode, 400);
      assert.equal((await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.write), {})).statusCode, 400);
      // A fresh bind sends 0.0; it must mark nothing.
      assert.equal((await put(`/api/v2/series/${S_MAIN}/read-progress/tachiyomi`, key(tok.write), { lastBookNumberSortRead: 0 })).statusCode, 204);
      assert.equal(await progressRows(reader), before);
      assert.equal((await put(`/api/v2/series/${S_HIDDEN}/read-progress/tachiyomi`, key(tok.write), { lastBookNumberSortRead: 1 })).statusCode, 404);
    });

    await t.test('a series above the 500 page-size cap still answers one honest unpaged page, and sizes ride along', async () => {
      // 8 live series are above 500 chapters (the largest 3,871). Reintroduce by dropping `{ unpaged }` from
      // the springPage call in the books route: `size` is clamped to 500 while all 501 rows sit in content,
      // and the assertions on size and last below name it. The seed goes through the same prefix teardown
      // deletes (lib_books cascades from lib_series).
      const S_BIG = 's_kc_big';
      await q(`INSERT INTO lib_series (id, source, title, folder, books_count, library_id, status, latest_mtime, created_at)
               VALUES ($1,'T!kc','Kc Big Title',$2,501,$3,'ongoing',$4,'2026-01-02T03:04:05Z')`, [S_BIG, `T!kc/${S_BIG}`, LIB, Date.parse('2026-03-04T05:06:07Z')]);
      // One row per chapter, no file on disk (the list reads rows, never bytes); chapter 7 knows its size.
      await q(`INSERT INTO lib_books (id, series_id, source, file, number, title, pages, root, size)
               SELECT 'b_kc_big_' || n, $1, 'T!kc', 'kc-big/' || n || '.cbz', n, 'Chapter ' || n, 2, $2, CASE WHEN n = 7 THEN 1536 ELSE NULL END
                 FROM generate_series(1, 501) AS n`, [S_BIG, join(TMP, 'lib')]);
      const r = await get(`/api/v1/series/${S_BIG}/books?unpaged=true&media_status=READY&deleted=false`, key(tok.read));
      assert.equal(r.statusCode, 200);
      const pg = r.json();
      assert.deepEqual(Object.keys(pg).sort(), PAGE_KEYS);
      assert.equal(pg.content.length, 501, 'every chapter is in content');
      assert.equal(pg.size, 501, 'unpaged: size is the row count, not the 500 cap');
      assert.equal(pg.last, true, 'unpaged: one page, and it is the last one');
      assert.deepEqual({ first: pg.first, number: pg.number, n: pg.numberOfElements, total: pg.totalElements, pages: pg.totalPages }, { first: true, number: 0, n: 501, total: 501, pages: 1 });
      // The envelope only: a chapter's nullable dates (`created`, `releaseDate`) are null for undated rows.
      const { content: _rows, ...envelope } = pg;
      assert.ok(!JSON.stringify(envelope).includes('null'), 'no envelope field of a page may be null');
      // The paged form is still capped: size=9999 answers 500 rows and says there is a second page.
      const capped = await get(`/api/v1/series/${S_BIG}/books?page=0&size=9999`, key(tok.read));
      assert.deepEqual({ n: capped.json().content.length, size: capped.json().size, last: capped.json().last, pages: capped.json().totalPages }, { n: 500, size: 500, last: false, pages: 2 });
      // lib_books.size reaches the wire as sizeBytes and Komga's "1.5 KiB" text, both in the list and by id.
      const seven = pg.content.find((b: any) => b.id === 'b_kc_big_7');
      assert.deepEqual([seven.sizeBytes, seven.size], [1536, '1.5 KiB'], 'a stamped size is shown, not "(0 B)"');
      const one = pg.content.find((b: any) => b.id === 'b_kc_big_1');
      assert.deepEqual([one.sizeBytes, one.size], [0, '0 B'], 'an unstamped size is 0, never null (a required Long)');
      assert.deepEqual([(await get('/api/v1/books/b_kc_big_7', key(tok.read))).json().sizeBytes], [1536]);
    });
  } finally {
    await teardown(app, q);
  }
});
