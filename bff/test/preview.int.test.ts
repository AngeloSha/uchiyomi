// Reading a chapter from a source before adding the series (#91, rebuilt): what the three routes may and may
// not do, against the real routes, the real auth hooks and the real guarded fetcher.
//
//   - a chapter is named by its NUMBER in the server's own listing; a number the listing lacks is refused, and
//     the source is never asked for any chapter the listing did not name (the first version passed the
//     caller's `chapterId` to getPageUrls, i.e. to FlareSolverr's browser);
//   - the listing the client gets carries numbers, not chapter ids or URLs;
//   - a page is served by INDEX, as the original bytes, `no-store`, and only when they are an image;
//   - a page URL on a private address is never fetched, whatever the site's page list says;
//   - an account with an age limit, or without the download permission, gets nothing; a disabled source
//     is refused.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const SRC = 'pv-src';
const USERS = ['pv-admin', 'pv-member', 'pv-capped', 'pv-nodl'];
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 1)]);
/** A public address as a literal: the guard passes it without a DNS lookup, and the fetch below is mocked. */
const PUBLIC = 'http://93.184.215.14';

/** Chapter ids the source was asked for pages of. */
const askedIds: string[] = [];
/** URLs the guarded fetcher actually requested. */
const fetched: string[] = [];

const source = {
  id: SRC, name: 'Zzz Preview Source',
  async search() { return []; },
  async getSeries(sid: string) { return { sourceId: sid, source: SRC, title: 'Zzz Preview Series' }; },
  async listChapters() {
    return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${SRC}-c${n}`, pages: 2 }));
  },
  async getPageUrls(chId: string) {
    askedIds.push(chId);
    if (chId === `${SRC}-c2`) return ['http://10.0.0.5/secret.png']; // a site pointing the server inward
    if (chId === `${SRC}-c3`) return [`${PUBLIC}/3/0.html`];        // a page that is not an image
    return [`${PUBLIC}/1/0.png`, `${PUBLIC}/1/1.png`];
  },
  async latest() { return []; },
};

let app: any, q: any;
const ids: Record<string, string> = {};

before(async () => {
  if (!DSN) return;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  await migrate();
  registerAdapter(source as any);
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const mk = async (username: string, role: string, perms: object, cap: number | null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
              VALUES ($1,$1,'x',$2,'password',$3,$4) RETURNING id`, [username, role, JSON.stringify(perms), cap]))[0].id as string;
  ids.admin = await mk('pv-admin', 'admin', {}, null);
  ids.member = await mk('pv-member', 'user', {}, null);
  ids.capped = await mk('pv-capped', 'user', {}, 13);
  ids.nodl = await mk('pv-nodl', 'user', { canDownload: false }, null);

  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    fetched.push(url);
    if (url.endsWith('.html')) return new Response('<html><script>alert(1)</script></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/sources')).default);
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
});

beforeEach(async () => {
  askedIds.length = 0;
  fetched.length = 0;
  if (!DSN) return;
  (await import('../src/routes/sources')).clearDetailCache();
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
  await q('DELETE FROM source_health WHERE source_id = $1', [SRC]).catch(() => {});
});

const qs = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
const json = (who: string, path: string, role = 'user') =>
  app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${app.jwt.sign({ sub: ids[who], role })}` } });
/** An <img> request: the image cookie, as the browser sends it (routes/auth.ts mints it with `typ: 'img'`). */
const img = async (who: string, o: Record<string, string | number>) => {
  const { IMG_COOKIE } = await import('../src/lib/auth');
  return app.inject({ method: 'GET', url: `/img/sources/preview?${qs(o)}`, cookies: { [IMG_COOKIE]: app.jwt.sign({ sub: ids[who], typ: 'img' }) } });
};
const series = { source: SRC, sourceId: 'zzz-preview-series' };

test('the listing names chapters by number, and carries no chapter id or URL', { skip }, async () => {
  const r = await json('member', `/api/sources/preview?${qs(series)}`);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.deepEqual(body.content.map((c: any) => c.number), [1, 2, 3]);
  assert.ok(!/pv-src-c|https?:/.test(JSON.stringify(body.content)), `a chapter id or URL reached the client: ${r.body}`);
  const p = await json('member', `/api/sources/preview/pages?${qs({ ...series, number: 1 })}`);
  assert.deepEqual(p.json(), { count: 2 });
});

test('a page is fetched by index, from the listing the server fetched, and served as the image it is', { skip }, async () => {
  const r = await img('member', { ...series, number: 1, i: 1 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['cache-control'], 'private, no-store');
  assert.ok(r.rawPayload.equals(PNG), 'the bytes were re-encoded or replaced');
  assert.deepEqual(fetched, [`${PUBLIC}/1/1.png`]);
  assert.deepEqual(askedIds, [`${SRC}-c1`], 'the source was asked for something the listing did not name');
});

test('a chapter the listing does not have is refused, and the source is never asked for it', { skip }, async () => {
  const r = await img('member', { ...series, number: 7, i: 0 });
  assert.equal(r.statusCode, 404);
  // The old shape is not a way in either: a chapterId parameter is ignored, and the source hears nothing.
  const sneaky = await app.inject({ method: 'GET',
    url: `/api/sources/preview/pages?${qs({ ...series, chapterId: 'http://yomi-db:5432/' })}`,
    headers: { authorization: `Bearer ${app.jwt.sign({ sub: ids.member, role: 'user' })}` } });
  assert.equal(sneaky.statusCode, 404);
  // Reintroduce the first version's route (getPageUrls(req.query.chapterId)): the source is asked for the URL.
  assert.deepEqual(askedIds, [], `the source was asked for: ${askedIds}`);
  assert.equal((await img('member', { ...series, number: 1, i: 9 })).statusCode, 404, 'a page past the end was not refused');
});

test('a page URL on a private address is never fetched, and a page that is not an image is not served', { skip }, async () => {
  const inward = await img('member', { ...series, number: 2, i: 0 });
  assert.equal(inward.statusCode, 502);
  // Reintroduce by fetching the page list's URL with a bare fetch(): 10.0.0.5 is requested.
  assert.deepEqual(fetched, [], `the server fetched ${fetched}`);
  const html = await img('member', { ...series, number: 3, i: 0 });
  assert.equal(html.statusCode, 502, 'an HTML page was served from this origin');
  assert.ok(!html.body.includes('<script>'));
});

test('an account with an age limit, or without the download permission, gets nothing; a disabled source is refused', { skip }, async () => {
  // Reintroduce by dropping the age check in previewChapters: the capped member reads the chapter list.
  assert.equal((await json('capped', `/api/sources/preview?${qs(series)}`)).statusCode, 403);
  assert.equal((await img('capped', { ...series, number: 1, i: 0 })).statusCode, 403);
  // The JSON routes sit behind the sources plugin's permission; the <img> route checks it itself.
  assert.equal((await json('nodl', `/api/sources/preview?${qs(series)}`)).statusCode, 403);
  assert.equal((await img('nodl', { ...series, number: 1, i: 0 })).statusCode, 403, 'the page route skipped the download permission');
  await q(`INSERT INTO source_health (source_id, disabled) VALUES ($1, true)
           ON CONFLICT (source_id) DO UPDATE SET disabled = true`, [SRC]);
  try {
    assert.equal((await json('member', `/api/sources/preview?${qs(series)}`)).statusCode, 403);
  } finally {
    await q('DELETE FROM source_health WHERE source_id = $1', [SRC]);
  }
  assert.deepEqual(askedIds, [], 'the source was asked while every request was refused');
});
