// Discover: one card per work, and what the library holds left out while browsing (v0.56.0, lib/discoverIdentity.ts).
//
// The owner: the same series showed several times, because every source names it differently, and series the library
// already held showed at all. Held was decided by the library's own title alone, by an ASCII-only key; cards folded by
// the same key. These pin each way an item is now known to be held, and each way two names are known to be one work.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
let root = '';
if (DSN) {
  root = mkdtempSync(join(tmpdir(), 'yomi-di-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(root, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  process.env.DL_ROOT = root;
  process.env.LIBRARY_ROOT = join(root, 'library');
  mkdirSync(process.env.LIBRARY_ROOT, { recursive: true });
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const A = 'di-a', B = 'di-b';
const ADMIN = 'di-admin';
// The library: one series added from A, one followed on B under B's own name, one linked to its AniList entry.
const HELD = 's_di_held', FOLLOWED = 's_di_followed', LINKED = 's_di_linked';
const SERIES = [HELD, FOLLOWED, LINKED];

/** What each fake source lists, and what its own page calls each series. */
const LISTS: Record<string, Array<{ sourceId: string; title: string }>> = {
  [A]: [
    { sourceId: 'a-held', title: 'Held Tale' },
    { sourceId: 'a-solo', title: 'Solo Leveling' },
    { sourceId: 'a-new', title: 'Brand New Tale' },
    { sourceId: 'a-onb', title: 'Followed Work On B' },
    { sourceId: 'a-right', title: 'Right?' },
  ],
  [B]: [
    { sourceId: 'b-held2', title: 'Held Tale Other Name' },
    { sourceId: 'b-solo', title: 'Only I Level Up' },
    { sourceId: 'b-follow', title: 'Something Else Entirely' },
    { sourceId: 'b-linked', title: 'Totally Different Name' },
  ],
};
function fake(id: string) {
  const list = LISTS[id];
  const titleOf = (sid: string) => list.find((x) => x.sourceId === sid)?.title ?? sid;
  return {
    id, name: `Fake ${id}`, lang: 'en',
    async search() { return list.map((x) => ({ ...x, source: id })); },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: titleOf(sid) }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return list.map((x) => ({ ...x, source: id })); },
  };
}

// ---- the online services, scripted ----
type Script = { anilist?: any[]; mangadex?: any[]; mu?: any[]; muSeries?: Record<string, any>; fail?: 'anilist' };
let script: Record<string, Script> = {};
const asked: string[] = [];
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let q: any, app: any, di: typeof import('../src/lib/discoverIdentity');
const H: Record<string, string> = {};
const call = (method: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: H, ...(payload === undefined ? {} : { payload }) });
const quiet = { info() {}, warn() {} };

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.includes('example.invalid')) return new Response(Buffer.alloc(400, 7), { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.includes('graphql.anilist.co')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      // Only the identity lookup is scripted; the add's art lookup is off-subject.
      if (!String(body.query).includes('format_not_in')) return new Response('{}', { status: 503 });
      const s = String(body.variables?.s ?? '');
      asked.push(`anilist:${s}`);
      if (script[s]?.fail === 'anilist') return new Response('down', { status: 503 });
      return json({ data: { Page: { media: script[s]?.anilist ?? [] } } });
    }
    if (url.includes('api.mangadex.org/manga?title=')) {
      const s = decodeURIComponent(/title=([^&]+)/.exec(url)![1]);
      asked.push(`mangadex:${s}`);
      return json({ data: script[s]?.mangadex ?? [] });
    }
    if (url.includes('api.mangaupdates.com/v1/series/search')) {
      const s = JSON.parse(String(init?.body ?? '{}')).search;
      asked.push(`mu:${s}`);
      return json({ results: script[s]?.mu ?? [] });
    }
    const muSeries = /api\.mangaupdates\.com\/v1\/series\/(\w+)$/.exec(url);
    if (muSeries) {
      for (const sc of Object.values(script)) if (sc.muSeries?.[muSeries[1]]) return json(sc.muSeries[muSeries[1]]);
      return json({}, 404);
    }
    if (/github\.com/.test(url)) return new Response('{}', { status: 503 });
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  di = await import('../src/lib/discoverIdentity');
  const { registerAdapter } = await import('../src/lib/sources');
  const { _setMangadexPacing } = await import('../src/lib/sources/mangadex');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();
  _setMangadexPacing({ apiGapMs: 0 });
  di._setDiscoverPacing(0);
  registerAdapter(fake(A) as any);
  registerAdapter(fake(B) as any);

  await q('DELETE FROM lib_series WHERE id = ANY($1) OR source_id = ANY($2)', [SERIES, [A, B]]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  await q('DELETE FROM source_health WHERE source_id = ANY($1)', [[A, B]]);
  const admin = (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
                          VALUES ($1,$1,'x','admin','password','{}') RETURNING id`, [ADMIN]))[0].id;
  await q(`INSERT INTO lib_series (id, source, title, folder, source_id, source_series_id, lang) VALUES
             ($1, 'Fake di-a', 'Held Tale', 'Fake di-a/Held Tale', $4, 'a-held', 'en'),
             ($2, 'Fake di-a', 'Followed Work', 'Fake di-a/Followed Work', $4, 'a-followed', 'en'),
             ($3, 'Fake di-a', 'Linked Work', 'Fake di-a/Linked Work', $4, 'a-linked', 'en')`, [HELD, FOLLOWED, LINKED, A]);
  await q(`INSERT INTO series_alt_titles (series_id, norm, title, origin) VALUES ($1, 'heldtaleothername', 'Held Tale Other Name', 'admin'),
             ($1, 'right', 'Right?', 'description')`, [HELD]);
  await q(`INSERT INTO series_sources (series_id, source_id, source_series_id, title) VALUES ($1, $2, 'b-follow', 'Followed Work On B')`, [FOLLOWED, B]);
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, linked_by) VALUES ($1, 'anilist', '777', $2)`, [LINKED, admin]);

  app = Fastify();
  await app.register(cookie);
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.setErrorHandler((err: any, req: any, reply: any) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request' });
    const status = err.statusCode || 500;
    if (status >= 500) console.error('ROUTE 500:', req.url, err?.message);
    return reply.code(status).send({ error: status >= 500 ? 'internal' : err.message || 'error' });
  });
  await app.register(rateLimit, { global: false });
  for (const mod of ['sources', 'admin']) await app.register((await import(`../src/routes/${mod}`)).default);
  await app.ready();
  H.authorization = `Bearer ${app.jwt.sign({ sub: admin, role: 'admin' })}`;
});

beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM title_works');
  await q('UPDATE server_settings SET discover_lookups = true WHERE id = 1');
  di.resetDiscoverIdentity();
  di._setDiscoverPacing(0);
  // As server.ts does: the asking runs only once started.
  di.startTitleWorks(quiet);
  script = {};
  asked.length = 0;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!DSN) return;
  await q('DELETE FROM lib_series WHERE id = ANY($1) OR source_id = ANY($2)', [SERIES, [A, B]]);
  await q('DELETE FROM users WHERE username = $1', [ADMIN]);
  await q('DELETE FROM title_works');
  if (root) rmSync(root, { recursive: true, force: true });
});

const latest = async (source: string) => {
  const r = await call('GET', `/api/sources/latest?source=${source}`);
  assert.equal(r.statusCode, 200, r.body);
  return new Map((r.json().content as any[]).map((x) => [x.sourceId, x]));
};

test('held by its source series, by another name, by a followed source and by its AniList entry', { skip }, async () => {
  // The name the work is known by online, placed as an answer would place it (resolveName below).
  await q(`INSERT INTO title_works (key, work, via) VALUES ('totallydifferentname', 'al:777', 'anilist')`);
  di.resetDiscoverIdentity();
  const a = await latest(A);
  const b = await latest(B);
  // Reintroduce the title-only rule (heldFor answering by the library's own title): every line but the first reads false.
  assert.equal(a.get('a-held').owned, true, 'its very source series');
  assert.equal(b.get('b-held2').owned, true, 'a name the series goes by (Edit details → other names)');
  assert.equal(b.get('b-follow').owned, true, 'the series a followed source has it as, under that source\'s own name');
  assert.equal(a.get('a-onb').owned, true, 'the name a followed source gives it, on another source');
  assert.equal(b.get('b-linked').owned, true, 'the work its AniList link says, under a name the library never used');
  assert.equal(a.get('a-new').owned, false);
  // A short other name holds nothing: a description's reading split "…Makes Sense, Right?" into "Right?", an anthology's
  // name. Reintroduce by keeping every other name in libraryIndex: true.
  assert.equal(a.get('a-right').owned, false, 'a short other name holds nothing');
  assert.equal(a.get('a-new').work, 'n:brandnewtale', 'an unknown work is its name');
  assert.equal(a.get('a-held').work, b.get('b-held2').work, 'two names of one held series fold as one card');
  // The per-language answer the search's ribbon reads is unchanged beside it.
  assert.equal(a.get('a-held').inLibrary, true);
});

test('two sites naming one work differently are one search card, once the names are placed', { skip }, async () => {
  const before = await call('GET', '/api/sources/search-all?q=solo&wait=3000');
  const cards0 = (before.json().content as any[]).filter((g) => g.providers.some((p: any) => p.sourceId === 'a-solo' || p.sourceId === 'b-solo'));
  assert.equal(cards0.length, 2, 'PREMISE: unknown names are two cards');
  await q(`INSERT INTO title_works (key, work, via) VALUES ('sololeveling', 'al:151025', 'anilist'), ('onlyilevelup', 'al:151025', 'anilist:names')`);
  di.resetDiscoverIdentity();
  const r = await call('GET', '/api/sources/search-all?q=solo-again&wait=3000');
  const cards = (r.json().content as any[]).filter((g) => g.providers.some((p: any) => p.sourceId === 'a-solo' || p.sourceId === 'b-solo'));
  // Reintroduce the title key in groupByTitle (drop keyOf): two cards.
  assert.equal(cards.length, 1, 'one card');
  assert.deepEqual(cards[0].providers.map((p: any) => p.source).sort(), [A, B], 'carrying both sites');
  assert.equal(cards[0].work, 'al:151025');
  assert.equal(cards[0].owned, false);
});

test('a name is asked of AniList, then MangaDex, then MangaUpdates, and only an answer that IS the name is kept', { skip }, async () => {
  script = {
    // AniList answers with a spin-off: not the name. MangaDex has it, linked to its AniList entry, with a Korean name.
    'Brand New Tale': {
      anilist: [{ id: 5, title: { romaji: 'Brand New Tale: Ragnarok' }, synonyms: [] }],
      mangadex: [{ id: 'MD-1', attributes: { title: { en: 'Brand New Tale' }, altTitles: [{ ko: '브랜드 뉴 테일' }, { en: 'BNT Remastered Edition' }], links: { al: '9' } } }],
    },
    // Neither AniList nor MangaDex: MangaUpdates, by an associated name.
    'Only MU Knows': {
      mu: [{ record: { series_id: 42, title: 'Only MU Knows' }, hit_title: 'Only MU Knows' }],
      muSeries: { 42: { series_id: 42, title: 'Only MU Knows', associated: [{ title: 'MU Alias Name' }] } },
    },
  };
  await di.resolveName('brandnewtale', 'Brand New Tale');
  await di.resolveName('onlymuknows', 'Only MU Knows');
  await di.resolveName('nobodyknowsthis', 'Nobody Knows This');
  const rows = new Map((await q('SELECT key, work, via FROM title_works')).map((r: any) => [r.key, r]));
  // Reintroduce the search's first answer (drop the namesMatch test): brandnewtale reads al:5, the spin-off's.
  assert.equal(rows.get('brandnewtale')?.work, 'al:9', 'MangaDex knew it, and its AniList link names the work');
  assert.equal(rows.get('브랜드뉴테일')?.work, 'al:9', 'every other name the answer gave is placed with it');
  assert.equal(rows.get('bntremasterededition')?.via, 'mangadex:names');
  assert.equal(rows.get('onlymuknows')?.work, 'mu:42');
  assert.equal(rows.get('mualiasname')?.work, 'mu:42');
  assert.equal(rows.get('nobodyknowsthis')?.work, null, 'asked of all three and no one knew it: stored as unknown');
  assert.deepEqual(asked.filter((x) => x.endsWith('Brand New Tale')), ['anilist:Brand New Tale', 'mangadex:Brand New Tale'],
    'AniList first; MangaUpdates never asked once MangaDex knew it');
});

test("two services' answers for one work become one, whichever is asked first", { skip }, async () => {
  // The owner's Sword Clan series: one name on AniList, the other only on MangaUpdates, whose answer lists both.
  const anilist = { anilist: [{ id: 183855, title: { english: 'Regressing As The Bastard Of The Sword Clan' }, synonyms: [] }] };
  const mu = {
    mu: [{ record: { series_id: 99, title: 'Regressed Life of the Ignoble Reincarnator' }, hit_title: 'Regressed Life of the Ignoble Reincarnator' }],
    muSeries: { 99: { series_id: 99, associated: [{ title: 'Regressing As The Bastard Of The Sword Clan' }] } },
  };
  script = { 'Regressing As The Bastard Of The Sword Clan': anilist, 'Regressed Life of the Ignoble Reincarnator': mu };
  await di.resolveName('regressingasthebastardoftheswordclan', 'Regressing As The Bastard Of The Sword Clan');
  await di.resolveName('regressedlifeoftheignoblereincarnator', 'Regressed Life of the Ignoble Reincarnator');
  // Reintroduce by storing each answer's own id (drop `joined`): the second reads mu:99, a card of its own.
  assert.equal(di.workForKey('regressedlifeoftheignoblereincarnator'), 'al:183855', 'MangaUpdates joins the AniList work');
  assert.equal((await q(`SELECT count(*)::int AS n FROM title_works WHERE work = 'mu:99'`))[0].n, 0, 'nothing left under the other id');

  // The other order: MangaUpdates first places the AniList name under mu:, so it is never asked -- still one work.
  await q('DELETE FROM title_works');
  di.resetDiscoverIdentity();
  di._setDiscoverPacing(0);
  await di.resolveName('regressedlifeoftheignoblereincarnator', 'Regressed Life of the Ignoble Reincarnator');
  assert.equal(di.workForKey('regressingasthebastardoftheswordclan'), di.workForKey('regressedlifeoftheignoblereincarnator'));

  // Two AniList entries sharing a long name are two works: nothing is joined.
  await q('DELETE FROM title_works');
  di.resetDiscoverIdentity();
  di._setDiscoverPacing(0);
  script = {
    'First Shared Work': { anilist: [{ id: 1, title: { english: 'First Shared Work' }, synonyms: ['A Very Shared Name'] }] },
    'Second Shared Work': { anilist: [{ id: 2, title: { english: 'Second Shared Work' }, synonyms: ['A Very Shared Name'] }] },
  };
  await di.resolveName('firstsharedwork', 'First Shared Work');
  await di.resolveName('secondsharedwork', 'Second Shared Work');
  assert.equal(di.workForKey('firstsharedwork'), 'al:1');
  assert.equal(di.workForKey('secondsharedwork'), 'al:2', 'two AniList entries are never joined');
});

test('a name placed while it waited is not asked about', { skip }, async () => {
  script = { 'Queued First Name': { anilist: [{ id: 31, title: { english: 'Queued First Name' }, synonyms: ['Queued Second Name'] }] } };
  await di.libraryIndex();
  di.noteTitles(['Queued First Name', 'Queued Second Name']);
  for (let i = 0; i < 100 && !di.workForKey('queuedsecondname'); i++) await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(di.workForKey('queuedsecondname'), 'al:31', 'placed by the first name\'s answer');
  assert.deepEqual(asked.filter((x) => x.startsWith('anilist:')), ['anilist:Queued First Name'], 'the second name was never asked about');
});

test('a service that fails is not a miss: nothing is stored and the name is asked again', { skip }, async () => {
  script = { 'Shaky Name': { fail: 'anilist' } };
  await assert.rejects(di.resolveName('shakyname', 'Shaky Name'));
  assert.equal((await q(`SELECT count(*)::int AS n FROM title_works WHERE key = 'shakyname'`))[0].n, 0);
});

test('switched off, no name leaves the server', { skip }, async () => {
  await q('UPDATE server_settings SET discover_lookups = false WHERE id = 1');
  di.lookupsChanged();
  await di.lookupsOn();
  await latest(A);
  await new Promise((r) => setTimeout(r, 300));
  // Reintroduce by dropping the setting check in drain/noteTitles: AniList is asked about every name on the wall.
  assert.deepEqual(asked, [], 'nothing asked');
  assert.equal((await q('SELECT count(*)::int AS n FROM title_works'))[0].n, 0);
});

test('nothing is asked until the server starts the asking', { skip }, async () => {
  // A process that never started it -- every other bff test file, a script that builds the routes alone -- sends no
  // title anywhere, and has nothing in flight to outlive its tests by.
  di.resetDiscoverIdentity();
  const wall = await latest(A);
  await new Promise((r) => setTimeout(r, 300));
  // Reintroduce by queueing before the start (drop `!started` in noteTitles): AniList is asked about the wall's names.
  assert.deepEqual(asked, [], 'nothing asked');
  const keys = [...wall.values()].map((x: any) => x.work);
  assert.equal(di.pendingOf(keys), 0, 'and nothing reads as waiting');
  // Started, as server.ts does: the wall's new names are asked about.
  di.startTitleWorks(quiet);
  await latest(A);
  // Every name falls through to MangaUpdates (about a second each, its own pacing): wait for the wall to be done.
  for (let i = 0; i < 500 && !(asked.includes('anilist:Brand New Tale') && di.pendingOf(keys) === 0); i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(asked.includes('anilist:Brand New Tale'), `started, a new name is asked about (asked: ${asked.join(', ')})`);
});

test('an n: key placed with a work since comes back as that work, and a held one as held', { skip }, async () => {
  await q(`INSERT INTO title_works (key, work, via) VALUES ('latename', 'al:777', 'anilist'), ('otherlatename', 'al:888', 'anilist')`);
  di.resetDiscoverIdentity();
  const r = await call('GET', '/api/discover/works?keys=n:latename,n:otherlatename,n:nothingknown,lib:x');
  assert.equal(r.statusCode, 200, r.body);
  const { works, pending } = r.json();
  assert.equal(works['n:latename'].owned, true, "al:777 is the linked series'");
  assert.match(works['n:latename'].work, /^lib:/);
  assert.deepEqual(works['n:otherlatename'], { work: 'al:888', owned: false });
  assert.deepEqual(works['n:nothingknown'], { work: 'n:nothingknown', owned: false });
  assert.equal(typeof pending, 'number');
});

test('the names a source page lists fold its cards with the one under its title', { skip }, async () => {
  await di.learnPageNames('Page Title Here', ['Page Alias Name', 'Tiny']);
  const idx = await di.libraryIndex();
  const byAlias = di.workOf(idx, { source: A, sourceId: 'p-1', title: 'Page Alias Name' });
  const byTitle = di.workOf(idx, { source: B, sourceId: 'p-2', title: 'Page Title Here' });
  assert.equal(byAlias, byTitle, 'one card');
  assert.equal(di.workOf(idx, { source: A, sourceId: 'p-3', title: 'Tiny' }), 'n:tiny', 'a short name is too generic to be placed');
});

test('a series you hold under another name is a duplicate', { skip }, async () => {
  const r = await call('POST', '/api/sources/add', { source: B, sourceId: 'b-held2', chapterFrom: 'none' });
  // Reintroduce by dropping the index check in addSeriesFromSource: 200, a second copy of Held Tale.
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'duplicate');
  assert.equal(r.json().existing?.title, 'Held Tale');
});
