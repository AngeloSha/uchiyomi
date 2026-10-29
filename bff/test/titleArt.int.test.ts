// Real DB/file/image/auth checks. Provider bytes are synthetic; no library title or image leaves this test.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TitleLogoCandidate } from '../src/lib/titleLogoProvider';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `yomi-title-core-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.CONFIG_DIR = ROOT;
  process.env.CACHE_DIR = join(ROOT, 'cache');
  process.env.LIBRARY_ROOT = join(ROOT, 'library');
  process.env.DL_ROOT = join(ROOT, 'downloads');
  process.env.JWT_SECRET = 'title-core-test-secret-at-least-16';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const LIB = 'title-core-lib'; const QUIET = 'title-core-quiet'; const SID = 's_title_core';
let q: any, pool: any, app: any, art: typeof import('../src/lib/titleArt'), sharp: typeof import('sharp').default;
let admin: string, member: string, limited: string, png: Buffer, other: Buffer;
const imageCookies: Record<string, string> = {};
let memberId: string;
let calls = 0;
const realFetch = globalThis.fetch;
const candidate = (bytes = png): TitleLogoCandidate => ({ bytes, language: 'en', showReadableTitle: false,
  attribution: { provider: 'wikimedia', pageUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.png', fileName: 'Fixture.png',
    author: 'Fixture artist', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' } });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const put = (body: any, token = admin) => app.inject({ method: 'PUT', url: `/api/admin/series/${SID}/art`, headers: auth(token), payload: { kind: 'logo', ...body } });
const refresh = (token = admin) => app.inject({ method: 'POST', url: `/api/admin/series/${SID}/logo/refresh`, headers: auth(token), payload: {} });
const upload = (bytes = png) => ({ mode: 'upload', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
const state = async () => (await art.titleArtsFor([SID])).get(SID)!;
const settle = () => art.titleLogoQueueSettled();
async function seedLink(id = '87216', checked = true) {
  await q(`INSERT INTO series_trackers(series_id,provider,external_id,checked_at) VALUES($1,'anilist',$2,$3)
    ON CONFLICT(series_id,provider) DO UPDATE SET external_id=$2,checked_at=$3,linked_by=NULL`, [SID, id, checked ? new Date() : null]);
}
before(async () => {
  if (!DSN) return;
  sharp = (await import('sharp')).default;
  // A nontrivial alpha border and opaque colored title strokes, not a rectangular photograph.
  png = await sharp({ create: { width: 60, height: 24, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 40, height: 12, channels: 4, background: '#ef54c9ff' } }).png().toBuffer(), left: 10, top: 6 },
      { input: await sharp({ create: { width: 8, height: 22, channels: 4, background: '#ef54c9ff' } }).png().toBuffer(), left: 26, top: 1 }]).png().toBuffer();
  other = await sharp(png).modulate({ hue: 120 }).png().toBuffer();
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { Media: null, Page: { media: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  ({ q, pool } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  art = await import('../src/lib/titleArt');
  await q(`INSERT INTO libraries(id,name,path,anilist_lookup) VALUES($1,'Title art fixture',$1,true),($2,'Private fixture',$2,false) ON CONFLICT(id) DO UPDATE SET anilist_lookup=EXCLUDED.anilist_lookup`, [LIB, QUIET]);
  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await q("DELETE FROM users WHERE username LIKE 'title-core-%'");
  for (const [name, role, age] of [['title-core-admin', 'admin', null], ['title-core-member', 'user', null], ['title-core-limited', 'user', 12]] as const) {
    const [u] = await q(`INSERT INTO users(username,display_name,password_hash,role,max_age_rating) VALUES($1,$1,'x',$2,$3) RETURNING id`, [name, role, age]);
    const token = app.jwt.sign({ sub: u.id, role });
    const key = role === 'admin' ? 'admin' : age ? 'limited' : 'member';
    imageCookies[key] = `yomi_img=${app.jwt.sign({ sub: u.id, role, typ: 'img' })}`;
    if (role === 'admin') admin = token; else if (age) limited = token; else { member = token; memberId = u.id; }
  }
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
});
beforeEach(async () => {
  if (!DSN) return;
  await settle();
  await q('DELETE FROM lib_series WHERE id=$1', [SID]);
  await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id) VALUES($1,'T!title','Logo Tale',$1,0,$2)`, [SID, LIB]);
  await q('UPDATE libraries SET anilist_lookup=true WHERE id=$1', [LIB]);
  await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1');
  calls = 0;
  art.setTitleLogoLookupForTests(async () => { calls++; return { kind: 'found', candidate: candidate() }; });
});
after(async () => {
  if (DSN) {
    await settle(); art.setTitleLogoLookupForTests(); await app?.close();
    await q('DELETE FROM lib_series WHERE id=$1', [SID]);
    await q('DELETE FROM libraries WHERE id=ANY($1)', [[LIB, QUIET]]);
    await q("DELETE FROM users WHERE username LIKE 'title-core-%'");
    await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1');
    await pool.end();
  }
  globalThis.fetch = realFetch;
  await rm(ROOT, { recursive: true, force: true });
});

test('online-logo setting is off by default, admin-only and round-trips through its public settings fields', { skip }, async () => {
  const initial = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: auth(admin) });
  assert.equal(initial.statusCode, 200); assert.equal(initial.json().automatic_title_logos, false);
  const change = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth(admin), payload: { automaticTitleLogos: true } });
  assert.equal(change.statusCode, 200); assert.equal(change.json().automatic_title_logos, true);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: auth(member), payload: { automaticTitleLogos: false } })).statusCode, 403);
});
test('actual detail and featured APIs carry the same title-art metadata without enqueueing opted-out lookups', { skip }, async () => {
  await q('UPDATE libraries SET anilist_lookup=false WHERE id=$1', [LIB]);
  await q('UPDATE lib_series SET books_count=1 WHERE id=$1', [SID]);
  await q(`INSERT INTO lib_books(id,series_id,source,file,number,title,root,pages) VALUES('b_title_core',$1,'T!title','fixture.cbz',1,'Chapter 1',$2,1)`, [SID, ROOT]);
  assert.equal((await put({ mode: 'style', style: 'fantasy' })).statusCode, 200);
  const detail = await app.inject({ method: 'GET', url: `/api/series/${SID}`, headers: auth(admin) });
  assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().titleArt.style, 'fantasy');
  const featured = await app.inject({ method: 'GET', url: '/api/featured', headers: auth(admin) });
  assert.equal(featured.statusCode, 200, featured.body);
  const found = featured.json().content.find((s: any) => s.id === SID); assert.ok(found, 'fixture must appear in the actual featured response');
  assert.deepEqual(found.titleArt, detail.json().titleArt); assert.equal(calls, 0);
});
test('default off, unchecked link, library opt-out and first-page-only choices make no provider request', { skip }, async () => {
  await seedLink(); await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 0);
  await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
  await seedLink('87216', false); await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 0);
  await seedLink(); await q('UPDATE lib_series SET library_id=$2 WHERE id=$1', [SID, QUIET]);
  await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 0);
  await q('UPDATE lib_series SET library_id=$2 WHERE id=$1', [SID, LIB]);
  await q("INSERT INTO series_overrides(series_id,cover) VALUES($1,'first_page')", [SID]);
  await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 0);
  assert.equal((await q('SELECT count(*)::int n FROM series_title_art WHERE series_id=$1', [SID]))[0].n, 0, 'opt-out stores no negative cache');
});
test('one asynchronous lookup preserves alpha, publishes attribution and is reused without more requests', { skip }, async () => {
  await seedLink(); await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  art.setTitleLogoLookupForTests(async (_id, opts) => { calls++; assert.equal(opts, undefined, 'background callers keep maxlag policy'); await gate; return { kind: 'found', candidate: candidate() }; });
  await art.queueTitleLogos([SID]); assert.equal((await state()).status, 'pending');
  await art.queueTitleLogos([SID]); release(); await settle(); assert.equal(calls, 1);
  const title = await state(); assert.equal(title.status, 'ready'); assert.equal(title.language, 'en'); assert.equal(title.showReadableTitle, false);
  assert.equal(title.attribution?.artist, 'Fixture artist');
  const bytes = (await art.readTitleLogo(SID))!.bytes;
  assert.equal((await sharp(bytes).metadata()).hasAlpha, true);
  await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 1);
});
test('manual one-shot refresh bypasses online opt-outs but never overrides custom/text choices', { skip }, async () => {
  await seedLink(); await q('UPDATE lib_series SET library_id=$2 WHERE id=$1', [SID, QUIET]);
  art.setTitleLogoLookupForTests(async (_id, opts) => { calls++; assert.equal(opts?.interactive, true); return { kind: 'found', candidate: candidate() }; });
  await q("INSERT INTO series_overrides(series_id,cover) VALUES($1,'first_page')", [SID]);
  assert.equal((await refresh()).statusCode, 200); await settle(); assert.equal(calls, 1); assert.ok((await state()).logoUrl);
  assert.equal((await put(upload())).statusCode, 200);
  assert.equal((await refresh()).statusCode, 409);
  assert.equal((await put({ mode: 'text' })).statusCode, 200); assert.equal((await refresh()).statusCode, 409);
  const reset = await put({ mode: 'reset' }); assert.equal(reset.statusCode, 200); assert.equal(reset.json().titleArt.style, 'auto');
});
test('unknown logo language stays unknown and a known original-language logo retains its readable caption', { skip }, async () => {
  await seedLink();
  for (const language of [null, 'ja']) {
    art.setTitleLogoLookupForTests(async () => ({ kind: 'found', candidate: { ...candidate(), language, showReadableTitle: true } }));
    assert.equal((await refresh()).statusCode, 200); await settle();
    assert.equal((await state()).language, language == null ? null : 'original');
    assert.equal((await state()).showReadableTitle, true);
  }
});
test('invalid imports keep the old good logo; source URL import refuses local addresses and raw SVG', { skip }, async () => {
  assert.equal((await put(upload())).statusCode, 200); const before = await state(); const bytes = (await art.readTitleLogo(SID))!.bytes;
  assert.equal((await put({ mode: 'upload', dataUrl: 'data:image/png;base64,bm90YW5pbWFnZQ==' })).statusCode, 400);
  assert.equal((await put({ mode: 'upload', dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString('base64')}` })).statusCode, 400);
  assert.equal((await put({ mode: 'url', url: 'http://127.0.0.1/private.png' })).statusCode, 400);
  assert.deepEqual(await state(), before); assert.deepEqual((await art.readTitleLogo(SID))!.bytes, bytes);
});
test('matching-name symlinks and oversized sparse files are not served, and a symlink is not a warm automatic cache hit', { skip }, async () => {
  await seedLink(); await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
  await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 1);
  const file = (await q('SELECT auto_file FROM series_title_art WHERE series_id=$1', [SID]))[0].auto_file;
  const path = join(ROOT, 'series-art', file); const secret = join(ROOT, 'private.txt');
  await writeFile(secret, 'private fixture data'); await rm(path); await symlink(secret, path);
  assert.equal(await art.readTitleLogo(SID), null);
  const url = (await state()).logoUrl!;
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.admin } })).statusCode, 404);
  await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, 2, 'a symlink must not suppress cache repair');
  assert.equal((await lstat(path)).isFile(), true); assert.equal(await readFile(secret, 'utf8'), 'private fixture data');
  const sparse = await open(path, 'w'); try { await sparse.truncate(11 * 1024 * 1024 + 1); } finally { await sparse.close(); }
  assert.equal(await art.readTitleLogo(SID), null, 'oversized local bytes are refused without reading the full file');
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.admin } })).statusCode, 404);
});
test('replacement versions change; failed refresh keeps good bytes; transient retry and real misses are distinct', { skip }, async () => {
  await seedLink(); assert.equal((await refresh()).statusCode, 200); await settle(); const before = await state(); const bytes = (await art.readTitleLogo(SID))!.bytes;
  art.setTitleLogoLookupForTests(async () => { calls++; throw Object.assign(new Error('provider offline'), { retryAfterMs: 49 * 3600_000 }); });
  assert.equal((await refresh()).statusCode, 200); await settle(); const failed = await state();
  assert.equal(failed.status, 'error'); assert.equal(failed.logoUrl, before.logoUrl); assert.deepEqual((await art.readTitleLogo(SID))!.bytes, bytes);
  assert.equal((await q('SELECT retry_at>now()+interval \'48 hours\' AS delayed FROM series_title_art WHERE series_id=$1', [SID]))[0].delayed, true, 'a Retry-After longer than a day must survive a restart');
  const busy = await refresh(); assert.equal(busy.statusCode, 429); assert.match(busy.headers['retry-after'], /^[0-9]+$/);
  await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1'); await seedLink('90001');
  art.setTitleLogoLookupForTests(async () => { calls++; return { kind: 'missing' }; });
  await art.queueTitleLogos([SID]); await settle(); const count = calls; await art.queueTitleLogos([SID]); await settle(); assert.equal(calls, count);
  assert.equal((await q('SELECT retry_at>now()+interval \'6 days\' AS delayed FROM series_title_art WHERE series_id=$1', [SID]))[0].delayed, true);
  assert.equal((await state()).logoUrl, null, 'a relink never shows the previous work logo');
});
test('a concurrent move to a private library, first-page choice, relink or manual style prevents stale publication', { skip }, async () => {
  for (const action of ['global', 'private', 'first_page', 'relink', 'style', 'custom'] as const) {
    await q('DELETE FROM series_title_art WHERE series_id=$1', [SID]); await q('DELETE FROM series_overrides WHERE series_id=$1', [SID]);
    await q('UPDATE lib_series SET library_id=$2 WHERE id=$1', [SID, LIB]); await seedLink();
    await q('UPDATE server_settings SET automatic_title_logos=true WHERE id=1');
    art.setTitleLogoLookupForTests(async () => {
      calls++;
      if (action === 'global') await q('UPDATE server_settings SET automatic_title_logos=false WHERE id=1');
      if (action === 'private') await q('UPDATE lib_series SET library_id=$2 WHERE id=$1', [SID, QUIET]);
      if (action === 'first_page') await q("INSERT INTO series_overrides(series_id,cover) VALUES($1,'first_page')", [SID]);
      if (action === 'relink') await seedLink('999999');
      if (action === 'style') assert.equal((await put({ mode: 'style', style: 'noir' })).statusCode, 200);
      if (action === 'custom') assert.equal((await put(upload(other))).statusCode, 200);
      return { kind: 'found', candidate: candidate() };
    });
    await art.queueTitleLogos([SID]); await settle(); const current = await state();
    if (action === 'custom') { assert.equal(current.mode, 'custom'); assert.equal(current.attribution, null); }
    else assert.equal(current.logoUrl, null, `stale ${action} result was published`);
  }
});
test('image route enforces login, admin mutation, viewer age limits and hidden/merged series, with private caching', { skip }, async () => {
  assert.equal((await put(upload(), member)).statusCode, 403);
  assert.equal((await put(upload())).statusCode, 200);
  const url = (await state()).logoUrl!;
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  const good = await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.member } }); assert.equal(good.statusCode, 200); assert.equal(good.headers['content-type'], 'image/webp');
  assert.match(good.headers['cache-control'], /^private,/);
  await q('INSERT INTO user_libraries(user_id,library_id) VALUES($1,$2)', [memberId, QUIET]);
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.member } })).statusCode, 404);
  await q('DELETE FROM user_libraries WHERE user_id=$1', [memberId]);
  await q('UPDATE lib_series SET age_rating=18 WHERE id=$1', [SID]);
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.limited } })).statusCode, 404);
  await q('UPDATE lib_series SET deleted_at=now() WHERE id=$1', [SID]);
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.admin } })).statusCode, 404);
  await q('UPDATE lib_series SET deleted_at=NULL,merged_into=$1 WHERE id=$1', [SID]);
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: imageCookies.admin } })).statusCode, 404);
});
test('style/text/reset changes are durable and hard retirement cleans all versioned title files', { skip }, async () => {
  assert.equal((await put(upload())).statusCode, 200); const first = await state();
  assert.equal((await put(upload(other))).statusCode, 200); const second = await state(); assert.ok(second.version > first.version); assert.notEqual(second.logoUrl, first.logoUrl);
  assert.equal((await put({ mode: 'style', style: 'fantasy' })).statusCode, 200); assert.equal((await state()).style, 'fantasy');
  assert.equal((await put({ mode: 'text' })).statusCode, 200); assert.equal((await state()).logoUrl, null);
  await art.dropTitleArt(SID); assert.equal((await q('SELECT count(*)::int n FROM series_title_art WHERE series_id=$1', [SID]))[0].n, 0);
  const files = await readdir(join(ROOT, 'series-art')).catch(() => []); assert.equal(files.filter((f) => f.startsWith('title-')).length, 0);
});
test('actual soft-delete/restore preserves custom title art and its bytes', { skip }, async () => {
  assert.equal((await put(upload())).statusCode, 200); const before = (await art.readTitleLogo(SID))!.bytes;
  const { deleteSeries, restoreSeries } = await import('../src/lib/libraryAdmin');
  await deleteSeries(SID); assert.equal(await art.readTitleLogo(SID), null);
  await restoreSeries(SID); assert.deepEqual((await art.readTitleLogo(SID))!.bytes, before);
});
test('actual merge retires absorbed logo files while preserving the survivor logo', { skip }, async () => {
  const target = SID + '_target';
  await q('DELETE FROM lib_series WHERE id=$1', [target]);
  await q(`INSERT INTO lib_series(id,source,title,folder,books_count,library_id) VALUES($1,'T!title','Target',$1,0,$2)`, [target, LIB]);
  try {
    assert.equal((await put(upload())).statusCode, 200);
    const response = await app.inject({ method: 'PUT', url: `/api/admin/series/${target}/art`, headers: auth(admin), payload: { kind: 'logo', ...upload(other) } });
    assert.equal(response.statusCode, 200); const kept = (await art.readTitleLogo(target))!.bytes;
    await (await import('../src/lib/libraryAdmin')).mergeSeries(SID, target);
    assert.equal(await art.readTitleLogo(SID), null); assert.deepEqual((await art.readTitleLogo(target))!.bytes, kept);
    assert.equal((await q('SELECT count(*)::int n FROM series_title_art WHERE series_id=$1', [SID]))[0].n, 0);
    assert.equal((await readdir(join(ROOT, 'series-art'))).filter((f) => f.startsWith('title-')).length, 1);
  } finally { await q('DELETE FROM lib_series WHERE id=$1', [target]); await art.dropTitleArt(target); }
});
