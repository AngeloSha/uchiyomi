// Open site's routes (v0.91.0, #314; routes/admin.ts, lib/sources/suwayomi/siteSessions.ts), mounted for real against the
// strict fake engine, with a fake engine browser in place of the engine's websocket.
//
// What this holds to:
// - admins only: it is a browser on the server;
// - it opens the source's own home page, as the engine names it, and refuses a source with no site or none at all;
// - input is the page's own and nothing else: an unknown kind, an extra field or a page that is not theirs is refused
//   (`seen`, since v0.91.1, paces the pictures and never reaches the page);
// - the live stream says what the page shows and ends when Done leaves it, which is when the engine saves its cookies;
// - opening and Done are audited.
//
// Skipped unless TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

type Sent = Record<string, unknown>;

async function setup() {
  const { startFakeSuwayomi, SOURCE_IDS } = await import('./fixtures/fakeSuwayomi');
  const fake = await startFakeSuwayomi();
  // ⚠️ Before anything from src: env.ts reads these once.
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = fake.url;
  process.env.EXTENSION_ENGINE = '1';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const site = await import('../src/lib/sources/suwayomi/siteSessions');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();

  const pages: Array<{ sent: Sent[]; closed: number; events: import('../src/lib/sources/suwayomi/engineBrowser').BrowserEvents }> = [];
  site.setBrowserOpener((async (events: never) => {
    const p = { sent: [] as Sent[], closed: 0, events };
    pages.push(p);
    return { open: true, send: (m: Sent) => { p.sent.push(m); }, close: async () => { p.closed++; } };
  }) as never);

  await q('DELETE FROM suwayomi_sources');
  await q(`INSERT INTO suwayomi_sources (source_id, name, lang, enabled) VALUES ($1, 'Webtoons.com', 'en', true)`, [SOURCE_IDS.webtoons]);
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['site-admin', 'site-admin2', 'site-member']]);
  const ids: Record<string, string> = {};
  for (const [u, role] of [['site-admin', 'admin'], ['site-admin2', 'admin'], ['site-member', 'user']] as const) {
    ids[u] = (await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [u, role],
    ))[0].id;
  }
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  const as = (u: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: ids[u], role: u.startsWith('site-admin') ? 'admin' : 'user' })}` });
  return { fake, q, site, app, as, ids, pages, SOURCE_IDS };
}

test('Open site, as the sheet drives it', { skip }, async (t) => {
  const { fake, q, site, app, as, ids, pages, SOURCE_IDS } = await setup();
  const open = (u: string, id: string, payload: unknown = { width: 390, height: 700 }) =>
    app.inject({ method: 'POST', url: `/api/admin/extensions/sources/${id}/site`, headers: as(u), payload: payload as never });
  const input = (u: string, session: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/admin/extensions/site/${session}/input`, headers: as(u), payload: payload as never });
  const done = (u: string, session: string) => app.inject({ method: 'DELETE', url: `/api/admin/extensions/site/${session}`, headers: as(u) });
  try {
    await t.test('THE RULE: admins only -- it is a browser on the server', async () => {
      const r = await open('site-member', SOURCE_IDS.webtoons);
      assert.equal(r.statusCode, 403);
      assert.equal(pages.length, 0, 'and no page was opened');
    });

    await t.test('it opens the source\'s own home page, at the sheet\'s size', async () => {
      const r = await open('site-admin', SOURCE_IDS.webtoons);
      assert.equal(r.statusCode, 200, r.body);
      const b = r.json();
      assert.equal(b.name, 'Webtoons.com (EN)', 'the engine\'s own display name');
      assert.equal(b.site, 'www.webtoons.com');
      assert.deepEqual(pages[0].sent[0], { type: 'loadUrl', url: 'https://www.webtoons.com', width: 390, height: 700 });
      const audit = await q<{ detail: { id: string; site: string } }>(
        `SELECT detail FROM audit_log WHERE event = 'source.site_open' AND user_id = $1 ORDER BY id DESC LIMIT 1`, [ids['site-admin']]);
      assert.equal(audit[0]?.detail.site, 'www.webtoons.com', 'audited');
      assert.equal((await done('site-admin', b.session)).statusCode, 200);
    });

    await t.test('no page for a source the engine does not have, one with no site, or a size it cannot be', async () => {
      assert.equal((await open('site-admin', '999999')).statusCode, 404);
      const local = await open('site-admin', SOURCE_IDS.local);
      assert.equal(local.statusCode, 422, 'the local source reads no site');
      assert.equal(local.json().error, 'no_site');
      assert.equal((await open('site-admin', SOURCE_IDS.webtoons, { width: 'wide' })).statusCode, 400);
      assert.equal(site.siteSessionActive(), false);
    });

    await t.test('input is the page\'s own, from its own admin, and nothing else', async () => {
      const { session } = (await open('site-admin', SOURCE_IDS.webtoons)).json();
      const page = pages.at(-1)!;
      const ok = await input('site-admin', session, { input: [
        { type: 'event', eventType: 'mousedown', clickX: 12, clickY: 34, button: 0 },
        { type: 'event', eventType: 'keydown', clickX: 0, clickY: 0, key: 'a' },
        { type: 'paste', data: 'reader@example.org' },
        { type: 'home' },
        { type: 'seen', seq: 0 },
      ] });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(page.sent.slice(1).map((m) => m.type === 'event' ? m.eventType : m.type), ['mousedown', 'keydown', 'paste', 'loadUrl'],
        '`seen` paces the pictures and never reaches the page');
      for (const bad of [
        { input: [{ type: 'loadUrl', url: 'http://yomi-db:5432/' }] },
        { input: [{ type: 'seen', seq: -1 }] },
        { input: [{ type: 'seen', seq: 1, url: 'http://yomi-db:5432/' }] },
        { input: [{ type: 'event', eventType: 'mousedown', clickX: 1, clickY: 1, script: 'x' }] },
        { input: [{ type: 'event', eventType: 'click', clickX: 1, clickY: 1 }] },
        { input: [] },
        {},
      ]) {
        assert.equal((await input('site-admin', session, bad)).statusCode, 400, JSON.stringify(bad));
      }
      assert.equal(page.sent.length, 5, 'none of those reached the page');
      assert.equal((await input('site-admin2', session, { input: [{ type: 'home' }] })).statusCode, 404, 'another admin\'s page is nothing to them');
      assert.equal((await open('site-admin2', SOURCE_IDS.webtoons)).statusCode, 409, 'nor can they take it while it is in use');
      assert.equal((await done('site-admin2', session)).statusCode, 404);
      assert.equal((await done('site-admin', session)).statusCode, 200);
    });

    await t.test('the live stream says what the page shows, and ends when Done leaves the page', async () => {
      const { session } = (await open('site-admin', SOURCE_IDS.webtoons)).json();
      const page = pages.at(-1)!;
      page.events.address?.('https://www.webtoons.com/en/', 'WEBTOON');
      const streaming = app.inject({ method: 'GET', url: `/api/admin/extensions/site/${session}/stream`, headers: as('site-admin') });
      await new Promise((r) => setTimeout(r, 50));
      const sharp = (await import('sharp')).default;
      page.events.frame?.(await sharp({ create: { width: 8, height: 6, channels: 3, background: '#2a6' } }).png().toBuffer());
      await new Promise((r) => setTimeout(r, 400));
      page.events.load?.({ url: 'https://www.webtoons.com/en/', title: 'WEBTOON', status: 200 });
      const bye = await done('site-admin', session);
      assert.equal(bye.statusCode, 200);
      assert.equal(bye.json().saved, true);
      assert.equal(page.closed, 1, 'Done left the page: the engine saves its cookies then');
      const r = await streaming;
      assert.equal(r.statusCode, 200);
      assert.match(String(r.headers['content-type']), /application\/x-ndjson/);
      assert.equal(r.headers['x-accel-buffering'], 'no', 'a proxy is asked not to hold the stream back');
      const lines = r.body.trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => l.type), ['address', 'frame', 'load', 'closed']);
      assert.equal(Buffer.from(lines[1].jpeg, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff', 'the page as a JPEG, not the engine\'s PNG (v0.91.1)');
      assert.equal(lines[3].reason, 'done');
      const audit = await q(`SELECT 1 FROM audit_log WHERE event = 'source.site_close' AND user_id = $1`, [ids['site-admin']]);
      assert.equal(audit.length > 0, true, 'Done is audited');
      const row = await q<{ site_opened_at: Date | null }>('SELECT site_opened_at FROM suwayomi_sources WHERE source_id = $1', [SOURCE_IDS.webtoons]);
      assert.ok(row[0]?.site_opened_at, 'and the source is remembered as one whose site was opened, for its quiet visits');
      assert.equal(site.siteWasOpened(SOURCE_IDS.webtoons), true);
      const gone = await app.inject({ method: 'GET', url: `/api/admin/extensions/site/${session}/stream`, headers: as('site-admin') });
      assert.equal(gone.statusCode, 404, 'a page that was left streams nothing');
    });
  } finally {
    site.setBrowserOpener();
    await app.close();
    await fake.stop();
    await q(`DELETE FROM users WHERE username = ANY($1)`, [['site-admin', 'site-admin2', 'site-member']]).catch(() => {});
  }
});
