// Automatic hero banners (v0.51.0, lib/autoHero.ts): who sees one, when there is none, and Shuffle.
//
// Driven through the real routes -- GET /img/series/:id/hero, POST /api/admin/series/:id/hero/shuffle and the series
// payload's `autoHero` -- over real CBZ chapters scanned into the library, because what has to hold is the whole
// path: the cover route's gate, then the rules about which series may have one at all, then the image itself.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = join(tmpdir(), `uchiyomi-autohero-${process.pid}`);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = join(ROOT, 'library');
  process.env.DL_ROOT = join(ROOT, 'downloads');
  // The image routes write their variants here; the default is the container's /cache volume.
  process.env.CACHE_DIR = join(ROOT, 'cache');
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let app: any, q: any, sharp: any, autoHeroFor: (ids: string[]) => Promise<Map<string, { seed: number }>>;
let art = '', blank = '';
let adminCookie = '', memberCookie = '', adminAuth: Record<string, string> = {}, memberAuth: Record<string, string> = {};
const LIBS = ['ah-private', 'ah-adult'];

/** A page of drawn art: colour waves that move independently, and soft hatching. Nothing a banner would refuse. */
async function artPage(w: number, h: number, phase: number): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, hatch = (x + y) % 9 < 2 ? 30 : 0;
    px[i] = 120 + 90 * Math.sin(x / 13 + y / 29 + phase) - hatch;
    px[i + 1] = 110 + 80 * Math.cos(y / 11 - x / 31 + phase) - hatch;
    px[i + 2] = 120 + 90 * Math.sin((x + y) / 17 + phase) - hatch;
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

/** A series folder of five chapters, eight pages each (or as many as `size` says), from `page`. */
async function seriesOf(folder: string, page: (ch: number, n: number) => Promise<Buffer>, size = { chapters: 5, pages: 8 }) {
  await mkdir(join(ROOT, 'library', folder), { recursive: true });
  for (let ch = 1; ch <= size.chapters; ch++) {
    const zip = new AdmZip();
    for (let n = 1; n <= size.pages; n++) zip.addFile(`${String(n).padStart(3, '0')}.jpg`, await page(ch, n));
    await writeFile(join(ROOT, 'library', folder, `Chapter ${ch}.cbz`), zip.toBuffer());
  }
}

before(async () => {
  if (!DSN) return;
  sharp = (await import('sharp')).default;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  ({ autoHeroFor } = await import('../src/lib/autoHero'));
  const { IMG_COOKIE } = await import('../src/lib/auth');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, 'downloads'), { recursive: true });
  await q(`DELETE FROM lib_series WHERE folder IN ('Hero Art', 'Hero Blank', 'Hero Four')`);
  await seriesOf('Hero Art', (ch, n) => artPage(600, 1500, ch + n / 3));
  // Every page paper: nothing on it can make a banner.
  await seriesOf('Hero Blank', () => sharp({ create: { width: 600, height: 1500, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
  await (await import('../src/lib/library')).persistScan();
  const id = async (folder: string) => (await q(`SELECT id FROM lib_series WHERE folder = $1`, [folder]))[0].id as string;
  art = await id('Hero Art');
  blank = await id('Hero Blank');
  // The AniList lookup has happened and found no banner: the state 199 of the owner's 283 series are in.
  for (const s of [art, blank]) await q(`INSERT INTO series_art (series_id) VALUES ($1) ON CONFLICT (series_id) DO NOTHING`, [s]);

  await q(`DELETE FROM users WHERE username LIKE 'ah-%'`);
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [LIBS]);
  await q(`INSERT INTO libraries (id, name, path) VALUES ('ah-private', 'Private', '/nowhere')`);
  await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ('ah-adult', 'Adult', '/nowhere-adult', 18)`);
  const mk = async (name: string, role: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  const adminId = await mk('ah-admin', 'admin');
  const memberId = await mk('ah-member', 'member');
  // The member may read a different library only, so the series are outside their grants.
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1, 'ah-private')`, [memberId]);

  const Fastify = (await import('fastify')).default;
  app = Fastify();
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/images')).default);
  await app.register((await import('../src/routes/catalog')).default);
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  adminCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: adminId, typ: 'img' })}`;
  memberCookie = `${IMG_COOKIE}=${app.jwt.sign({ sub: memberId, typ: 'img' })}`;
  adminAuth = { authorization: `Bearer ${app.jwt.sign({ sub: adminId, role: 'admin' })}` };
  memberAuth = { authorization: `Bearer ${app.jwt.sign({ sub: memberId, role: 'member' })}` };
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_series WHERE folder IN ('Hero Art', 'Hero Blank', 'Hero Four')`);
  await q(`DELETE FROM users WHERE username LIKE 'ah-%'`);
  await q(`DELETE FROM libraries WHERE id = ANY($1)`, [LIBS]);
  await q(`UPDATE server_settings SET adult_genres = '[]'::jsonb, adult_sources = '[]'::jsonb WHERE id = 1`);
  await rm(ROOT, { recursive: true, force: true });
  await (await import('../src/lib/db')).pool.end();
});

const hero = (id: string, cookie: string, ar = '') =>
  app.inject({ method: 'GET', url: `/img/series/${id}/hero${ar ? `?ar=${ar}` : ''}`, headers: { cookie } });
const payload = async (id: string) => (await app.inject({ method: 'GET', url: `/api/series/${id}`, headers: adminAuth })).json();

test('an admin gets the banner, wide and tall, made once and recorded', { skip }, async () => {
  const r = await hero(art, adminCookie);
  assert.equal(r.statusCode, 200, r.body.slice(0, 160));
  assert.equal(r.headers['content-type'], 'image/jpeg');
  const wide = await sharp(r.rawPayload).metadata();
  assert.deepEqual([wide.width, wide.height], [1920, 640]);
  const tall = await sharp((await hero(art, adminCookie, 'tall')).rawPayload).metadata();
  assert.deepEqual([tall.width, tall.height], [1080, 1440]);
  const row = (await q(`SELECT seed, made_at, failed_at FROM series_hero WHERE series_id = $1`, [art]))[0];
  assert.ok(row?.made_at && !row.failed_at, 'the made banner is recorded');
  // And the series payload says so, with the seed the web's URL carries.
  assert.deepEqual((await payload(art)).autoHero, { seed: 0 });
});

test('a member without access to its library gets 404, even once it is made', { skip }, async () => {
  // Reintroduce by dropping the seriesVisible check from the route: the cached banner is a 200 for them.
  assert.equal((await hero(art, memberCookie)).statusCode, 404);
});

test('an 18+ series has no automatic banner, even for an admin, by every rule', { skip }, async () => {
  // Each rule on its own, against a banner already in the cache: what is refused is the series, not a fresh make.
  // Reintroduce by dropping any one rule from heroEligible: its case is a 200 and named below.
  const rules: Array<[string, string, string]> = [
    ['its own rating', `UPDATE lib_series SET age_rating = 18 WHERE id = $1`, `UPDATE lib_series SET age_rating = NULL WHERE id = $1`],
    ['an admin\'s rating', `INSERT INTO series_overrides (series_id, age_rating) VALUES ($1, 18)`, `DELETE FROM series_overrides WHERE series_id = $1`],
    ['an 18+ library', `UPDATE lib_series SET library_id = 'ah-adult' WHERE id = $1`, `UPDATE lib_series SET library_id = 'lib' WHERE id = $1`],
    ['an 18+ genre', `UPDATE lib_series SET genres = '{Smut}' WHERE id = $1`, `UPDATE lib_series SET genres = '{}' WHERE id = $1`],
    ['an adult source', `UPDATE lib_series SET source_id = 'ah-adult-src' WHERE id = $1`, `UPDATE lib_series SET source_id = NULL WHERE id = $1`],
  ];
  await q(`UPDATE server_settings SET adult_genres = '["smut"]'::jsonb, adult_sources = '["ah-adult-src"]'::jsonb WHERE id = 1`);
  try {
    for (const [why, set, unset] of rules) {
      await q(set, [art]);
      try {
        assert.equal((await hero(art, adminCookie)).statusCode, 404, `an automatic banner was served for a series with ${why}`);
        assert.equal((await autoHeroFor([art])).get(art), undefined, `the payload offers one for a series with ${why}`);
      } finally {
        await q(unset, [art]);
      }
    }
  } finally {
    await q(`UPDATE server_settings SET adult_genres = '[]'::jsonb, adult_sources = '[]'::jsonb WHERE id = 1`);
  }
  assert.equal((await hero(art, adminCookie)).statusCode, 200, 'with every rule lifted it is served again');
});

test('a real banner wins: AniList\'s or an admin\'s', { skip }, async () => {
  // Reintroduce by dropping the series_art.banner test from heroEligible: the first assertion is a 200.
  await q(`UPDATE series_art SET banner = 'https://example.invalid/banner.jpg' WHERE series_id = $1`, [art]);
  try {
    assert.equal((await hero(art, adminCookie)).statusCode, 404, 'an automatic banner was served beside AniList\'s');
    assert.equal((await payload(art)).autoHero, null);
  } finally {
    await q(`UPDATE series_art SET banner = NULL WHERE series_id = $1`, [art]);
  }
  await q(`INSERT INTO series_overrides (series_id, banner) VALUES ($1, 'upload')`, [art]);
  try {
    assert.equal((await hero(art, adminCookie)).statusCode, 404, 'an automatic banner was served beside an admin\'s');
  } finally {
    await q(`DELETE FROM series_overrides WHERE series_id = $1`, [art]);
  }
});

test('Shuffle is an admin\'s, and it changes the seed', { skip }, async () => {
  const shuffle = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `/api/admin/series/${art}/hero/shuffle`, headers });
  // Admin-only because it is a child of routes/admin.ts. Reintroduce by registering routes/autoHero.ts from catalog.ts
  // (signed in only) instead: the member is not refused as a member.
  assert.equal((await shuffle(memberAuth)).statusCode, 403);
  const r = await shuffle(adminAuth);
  assert.equal(r.statusCode, 200, r.body);
  const { ok, seed } = r.json();
  assert.equal(ok, true);
  assert.ok(Number.isInteger(seed) && seed > 0, `a new seed, not ${seed}`);
  // Reintroduce by leaving out shuffleHero's write of the seed: the stored seed is still 0.
  assert.equal((await q(`SELECT seed FROM series_hero WHERE series_id = $1`, [art]))[0].seed, seed);
  assert.deepEqual((await payload(art)).autoHero, { seed }, 'the payload carries the new seed for the web\'s URL');
  assert.equal((await hero(art, adminCookie)).statusCode, 200);
  // Not for a series that may not have one: a 409 says why, and nothing changes.
  await q(`UPDATE series_art SET banner = 'https://example.invalid/banner.jpg' WHERE series_id = $1`, [art]);
  try {
    assert.equal((await shuffle(adminAuth)).statusCode, 409);
  } finally {
    await q(`UPDATE series_art SET banner = NULL WHERE series_id = $1`, [art]);
  }
});

test('a series whose pages make no banner: 404, recorded, and left alone after that', { skip }, async () => {
  const first = await hero(blank, adminCookie);
  assert.equal(first.statusCode, 404, 'the web keeps today\'s look');
  // Reintroduce by not recording a failed try in heroImages: there is no failed_at, and every view tries again.
  const row = (await q(`SELECT failed_at, fail_reason, made_at FROM series_hero WHERE series_id = $1`, [blank]))[0];
  assert.ok(row?.failed_at, 'the failed try is recorded');
  assert.equal(row.fail_reason, 'not_enough_art');
  assert.equal(row.made_at, null);
  // Reintroduce by dropping the failedLately filter from autoHeroFor: the payload still offers it.
  assert.equal((await autoHeroFor([blank])).get(blank), undefined, 'the payload stops offering a banner that is not there');
  assert.equal((await hero(blank, adminCookie)).statusCode, 404);
  const again = (await q(`SELECT failed_at FROM series_hero WHERE series_id = $1`, [blank]))[0];
  assert.equal(String(again.failed_at), String(row.failed_at), 'tried again on the next view');
});

test('Shuffle on a short series gives another banner when its pages hold one, and says so when they do not', { skip }, async () => {
  // v0.52.0. A short series has every page read whatever the seed, and Shuffle drew the same four crops every time
  // while the page said "Banner changed". Hero Art is short too: five chapters of eight pages, twenty crops of art.
  const shuffle = (id: string) => app.inject({ method: 'POST', url: `/api/admin/series/${id}/hero/shuffle`, headers: adminAuth });
  const was = (await hero(art, adminCookie)).rawPayload as Buffer;
  const r = await shuffle(art);
  assert.equal(r.statusCode, 200, r.body);
  // Reintroduce by ranking crops on their score alone (chooseCrops without the seed's choice): every seed draws the
  // same four, and this reads `same`.
  assert.equal(r.json().same, undefined, `Hero Art's pages hold other crops, and Shuffle found none: ${r.body}`);
  const now = (await hero(art, adminCookie)).rawPayload as Buffer;
  assert.ok(!now.equals(was), 'Shuffle answered a new seed and the banner is the same picture');

  // Four chapters of five pages: one page each past the credits, so four crops and no other banner.
  await seriesOf('Hero Four', (ch, n) => artPage(600, 1500, ch * 2 + n / 3), { chapters: 4, pages: 5 });
  await (await import('../src/lib/library')).persistScan();
  const four = (await q(`SELECT id FROM lib_series WHERE folder = 'Hero Four'`))[0].id as string;
  await q(`INSERT INTO series_art (series_id) VALUES ($1) ON CONFLICT (series_id) DO NOTHING`, [four]);
  const same = await shuffle(four);
  assert.equal(same.statusCode, 200, same.body);
  // Reintroduce by taking the first new seed in shuffleHero: it answers a new seed for the same four crops.
  assert.deepEqual(same.json(), { ok: true, seed: 0, same: true }, 'Shuffle claims a new banner where the pages give no other');
  assert.equal((await q(`SELECT seed FROM series_hero WHERE series_id = $1`, [four]))[0]?.seed ?? 0, 0, 'the seed changed for nothing');
});
