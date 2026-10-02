// Language editions of one work (v0.52.0, #72), driven through the real routes.
//
// p3t3t3 held Blue Lock in English and could not add it in Spanish: Discover folded the Spanish provider under an
// "In library" card that opened the English series, and the add path's title check called the Spanish copy a
// duplicate. An edition is now a series of its own -- its own folder, chapters, sources and reading progress --
// linked with the others by lib_series.work_id, and everything that groups (the Library's one card, the series
// page's switcher, Komga's labels, Health's duplicates, the 18+ rating, merge and forget) does so at the edges.
// The fake adapters declare their languages, as Suwayomi's do; every add is a "Nothing yet" one, so nothing is
// downloaded and the tests stay about the linking.
//
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Static, as in komgaCompat.int.test.ts: a dynamic zod is another module instance than the routes' own.
import { ZodError } from 'zod';

const DSN = process.env.TEST_DATABASE_URL;
let root = '';
if (DSN) {
  root = mkdtempSync(join(tmpdir(), 'yomi-ed-'));
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.CACHE_DIR = join(root, 'cache');
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
  process.env.DL_ROOT = root;
  // Forget stats every root before it erases anything: both must be there.
  process.env.LIBRARY_ROOT = join(root, 'library');
  mkdirSync(process.env.LIBRARY_ROOT, { recursive: true });
  process.env.MIN_FREE_GB = '0';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const TITLE = 'Edition Tale';
const EN = 'ed-en', ES = 'ed-es', ES2 = 'ed-es2', PT = 'ed-pt', FR = 'ed-fr', BARE = 'ed-bare';
const ADMIN = 'ed-admin', MEMBER = 'ed-member', CAPPED = 'ed-capped', NARROW = 'ed-narrow';
const OTHER_LIB = 'lib_ed_other';
// Series seeded by hand rather than added: Health's, merge's and forget's fixtures, and the on-disk paths'.
const C = 's_ed_copy', X = 's_ed_x', Y = 's_ed_y', F1 = 's_ed_f1', F2 = 's_ed_f2', M1 = 's_ed_m1', M2 = 's_ed_m2', M3 = 's_ed_m3', Z = 's_ed_z', Z2 = 's_ed_z2';
const SEEDED = [C, X, Y, F1, F2, M1, M2, M3, Z, Z2];
const DISK = '/library-ed';

let q: any, app: any, linkEdition: any, runHealthChecks: any, findingOf: any;
const H: Record<string, Record<string, string>> = {};
let komgaKey = '';
/** The two series the routes create: A, added from the English source, and B, its Spanish edition. */
let A = '', B = '';

const realFetch = globalThis.fetch;
function fake(id: string, name: string, lang: string | null) {
  return {
    id, name, ...(lang ? { lang } : {}),
    async search() { return [{ sourceId: `${id}-s`, source: id, title: TITLE }]; },
    async getSeries(sid: string) { return { sourceId: sid, source: id, title: TITLE }; },
    async listChapters() { return [1, 2, 3].map((n) => ({ number: n, title: `Chapter ${n}`, sourceId: `${id}-c${n}`, pages: 1 })); },
    async getPageUrls(chId: string) { return [`https://example.invalid/${chId}/p1.png`]; },
    async latest() { return [{ sourceId: `${id}-s`, source: id, title: TITLE }]; },
  };
}

const call = (method: string, url: string, who = ADMIN, payload?: unknown) =>
  app.inject({ method, url, headers: H[who], ...(payload === undefined ? {} : { payload }) });
/** A "Nothing yet" add of the title from `source`, with whatever else the test sends. */
const add = (source: string, extra: Record<string, unknown> = {}, who = ADMIN) =>
  call('POST', '/api/sources/add', who, { source, sourceId: `${source}-s`, chapterFrom: 'none', ...extra });
const row = async (id: string) => (await q('SELECT id, folder, lang, work_id, library_id FROM lib_series WHERE id = $1', [id]))[0];
const seed = (id: string, title: string, lang: string | null, extra = '') =>
  q(`INSERT INTO lib_series (id, source, title, folder, lang, created_at) VALUES ($1,'Seeded',$2,$3,$4, now() ${extra})`, [id, title, `Seeded/${id}`, lang]);

before(async () => {
  if (!DSN) return;
  globalThis.fetch = (async (u: any, init?: any) => {
    if (String(u).includes('example.invalid')) return new Response(Buffer.alloc(400, 7), { status: 200, headers: { 'content-type': 'image/png' } });
    // AniList's art lookup on every add, and Health's release check: off-subject, answered here.
    if (/anilist\.co|github\.com/.test(String(u))) return new Response('{}', { status: 503 });
    return realFetch(u, init);
  }) as typeof fetch;
  const { migrate } = await import('../src/lib/migrate');
  ({ q } = (await import('../src/lib/db')) as any);
  ({ linkEdition } = (await import('../src/lib/editions')) as any);
  ({ runHealthChecks, findingOf } = (await import('../src/lib/health')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  const auth = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  await migrate();

  registerAdapter(fake(EN, 'Fake EN', 'en') as any);
  registerAdapter(fake(ES, 'Fake ES', 'es-419') as any);
  registerAdapter(fake(ES2, 'Fake ES Two', 'es-419') as any);
  registerAdapter(fake(PT, 'Fake PT', 'pt-BR') as any);
  registerAdapter(fake(FR, 'Fake FR', 'fr') as any);
  registerAdapter(fake(BARE, 'Fake Bare', null) as any);

  await q(`DELETE FROM lib_series WHERE source_id LIKE 'ed-%' OR id = ANY($1)`, [SEEDED]);
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, CAPPED, NARROW]]);
  await q('DELETE FROM source_health WHERE source_id LIKE $1', ['ed-%']);
  await q(`INSERT INTO libraries (id, name, path) VALUES ($1, 'Other', '/ed-other') ON CONFLICT (id) DO NOTHING`, [OTHER_LIB]);
  const user = async (name: string, role: string, cap: number | null) =>
    (await q(`INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms, max_age_rating)
              VALUES ($1,$1,'x',$2,'password','{}',$3) RETURNING id`, [name, role, cap]))[0].id as string;
  const ids: Record<string, string> = {
    [ADMIN]: await user(ADMIN, 'admin', null), [MEMBER]: await user(MEMBER, 'user', null),
    [CAPPED]: await user(CAPPED, 'user', 16), [NARROW]: await user(NARROW, 'user', null),
  };
  // The narrow member may open the main library only.
  await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [ids[NARROW], 'lib']);

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
  for (const mod of ['sources', 'admin', 'catalog', 'komgaCompat']) await app.register((await import(`../src/routes/${mod}`)).default);
  await app.ready();
  for (const [name, id] of Object.entries(ids)) {
    H[name] = { authorization: `Bearer ${app.jwt.sign({ sub: id, role: name === ADMIN ? 'admin' : 'user' })}` };
  }
  komgaKey = (await auth.issueApiToken(ids[MEMBER], 'ed-komga', ['read'], null)).token;

  // A: the English series, as p3t3t3 had it.
  const a = await add(EN);
  assert.equal(a.statusCode, 200, `PREMISE: the English add answered ${a.statusCode}: ${a.body}`);
  A = a.json().seriesId;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
  if (!DSN) return;
  await app?.close();
  await q(`DELETE FROM lib_series WHERE source_id LIKE 'ed-%' OR id = ANY($1)`, [SEEDED]).catch(() => {});
  await q('DELETE FROM series_trackers WHERE external_id LIKE $1', ['ed-%']).catch(() => {});
  await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN, MEMBER, CAPPED, NARROW]]).catch(() => {});
  await q('DELETE FROM libraries WHERE id = $1', [OTHER_LIB]).catch(() => {});
});

// ---- the add path ---------------------------------------------------------------------------------------------

test('Discover owns a title only in the language it is held in', { skip }, async () => {
  const en = (await call('GET', `/api/sources/latest?source=${EN}`)).json().content[0];
  assert.equal(en.inLibrary, true, 'the English source\'s copy is the series already here');
  assert.equal(en.librarySeriesId, A);
  // Reintroduce by answering `inLibrary: !!held.length` in routes/sources.ts owned(): this reads true, and the
  // Spanish provider is folded under an "In library" card that opens the English series again.
  const es = (await call('GET', `/api/sources/latest?source=${ES}`)).json().content[0];
  assert.equal(es.inLibrary, false, 'a Spanish provider of a title held in English is not owned');
  assert.deepEqual(es.libraryLangs, ['en'], 'and says which language the library holds it in');
  assert.equal(es.lang, 'es-419', 'and which language it is in');
  assert.equal(es.librarySeriesId, A, 'with the entry to open');
  // A search card folds every provider of the title: owned only when each one's language is held. Reintroduce by
  // `providers.some` in ownedGroup: the card reads owned while its Spanish provider is not.
  const card = (await call('GET', `/api/sources/search-all?q=${encodeURIComponent(TITLE)}`)).json().content.find((g: any) => g.title === TITLE);
  assert.equal(card.providers.find((p: any) => p.source === EN).inLibrary, true);
  assert.equal(card.providers.find((p: any) => p.source === ES).inLibrary, false);
  assert.equal(card.inLibrary, false, 'a card with a provider in a language not held stays addable');
  assert.deepEqual(card.libraryLangs, ['en']);
});

test('a Spanish copy of a title held in English is offered as an edition, not refused as a copy', { skip }, async () => {
  // Reintroduce by dropping the offer in addSeriesFromSource's duplicate branch: `edition` is absent.
  const r = await add(ES);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'duplicate', 'without asking for an edition it is still the duplicate prompt');
  assert.deepEqual(r.json().edition, { of: A, heldLangs: ['en'], lang: 'es-419' }, 'with the server\'s offer');
});

test('an edition is a series of its own, in its own folder, linked with the original as one work', { skip }, async () => {
  // Reintroduce by ignoring `edition` in the add: the duplicate prompt answers 409.
  const r = await add(ES, { edition: { of: A } });
  assert.equal(r.statusCode, 200, r.body);
  B = r.json().seriesId;
  assert.ok(B && B !== A, 'a second series');
  assert.equal(r.json().edition.lang, 'es-419', 'in the language the source declares');
  const [a, b] = [await row(A), await row(B)];
  assert.equal(b.folder, 'Fake ES/Edition Tale (ES-419)', 'its folder carries its language, so it never lands in the original\'s');
  assert.equal(b.lang, 'es-419');
  assert.equal(a.lang, 'en', 'the original states its language as it joins the work');
  assert.ok(a.work_id && a.work_id === b.work_id, 'one work');
  assert.equal(r.json().edition.workId, a.work_id);
  // Added again, it is the same edition: its own folder answers "already in library".
  const again = await add(ES, { edition: { of: A } });
  assert.equal(again.statusCode, 409, 'the work holds the language now');
});

test('a language the work holds is refused, a removed edition\'s too', { skip }, async () => {
  // Reintroduce by dropping the pre-check in addSeriesFromSource: the second Spanish edition is added on its own
  // (200, unlinked: taken) instead of being refused.
  const r = await add(ES2, { edition: { of: A } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'edition_exists');
  assert.equal(r.json().existing.id, B, 'naming the edition that holds it');
  assert.equal((await call('DELETE', `/api/admin/series/${B}`)).statusCode, 200);
  try {
    const hidden = await add(ES2, { edition: { of: A } });
    assert.equal(hidden.statusCode, 409, hidden.body);
    assert.equal(hidden.json().error, 'edition_hidden', 'a removed edition keeps its slot, so Put back never collides');
    assert.equal(hidden.json().existing.id, B, 'an admin is told which, to put it back');
  } finally {
    assert.equal((await call('POST', `/api/admin/series/${B}/restore`)).statusCode, 200);
  }
});

test('an edition from a source that does not say its language must say it', { skip }, async () => {
  // Reintroduce by defaulting the language to the unstated one: this is added as English and collides.
  const r = await add(BARE, { edition: { of: A } });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error, 'edition_lang');
  const ja = await add(BARE, { edition: { of: A, lang: 'ja' } });
  assert.equal(ja.statusCode, 200, ja.body);
  assert.equal((await row(ja.json().seriesId)).lang, 'ja', 'the language the person chose');
  await q('DELETE FROM lib_series WHERE id = $1', [ja.json().seriesId]);
});

// ---- what the library shows -----------------------------------------------------------------------------------

test('the Library shows one card per work: the edition read last, else the original', { skip }, async () => {
  const search = async (who: string, body: Record<string, unknown>) =>
    (await call('POST', '/api/series/search', who, { size: 40, ...body })).json();
  await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages) VALUES ('b_ed_b1', $1, 'Fake ES', 'Fake ES/x/1.cbz', 'Chapter 1', 1, 1)
           ON CONFLICT (id) DO NOTHING`, [B]);
  const member = (await q('SELECT id FROM users WHERE username = $1', [MEMBER]))[0].id;
  await q(`INSERT INTO read_progress (user_id, book_id, series_id, page, completed) VALUES ($1,'b_ed_b1',$2,1,true)
           ON CONFLICT (user_id, book_id) DO NOTHING`, [member, B]);
  try {
    const plain = await search(ADMIN, { query: TITLE });
    assert.equal(plain.content.filter((s: any) => s.id === A || s.id === B).length, 2, 'PREMISE: two series with this title');
    // Reintroduce by returning the plain search for `collapseEditions`: two cards.
    const fresh = await search(ADMIN, { query: TITLE, collapseEditions: true });
    const mine = fresh.content.filter((s: any) => s.id === A || s.id === B).map((s: any) => s.id);
    assert.deepEqual(mine, [A], 'one card, the original, for a viewer who read neither');
    assert.equal(fresh.content.length, fresh.totalElements, 'the total counts works');
    assert.deepEqual(fresh.content.find((s: any) => s.id === A)?.edition, { langs: ['en', 'es-419'] }, 'with the languages it is in');
    const reader = await search(MEMBER, { query: TITLE, collapseEditions: true });
    assert.deepEqual(reader.content.filter((s: any) => s.id === A || s.id === B).map((s: any) => s.id), [B], 'the edition this reader read last');
    // A title only the Spanish edition carries still finds it: the window runs over what passed the filters.
    await q(`INSERT INTO series_overrides (series_id, title) VALUES ($1, 'Cuento de Ediciones') ON CONFLICT (series_id) DO UPDATE SET title = EXCLUDED.title`, [B]);
    const es = await search(ADMIN, { query: 'Cuento de Ediciones', collapseEditions: true });
    assert.deepEqual(es.content.map((s: any) => s.id), [B]);
    assert.equal(es.totalElements, 1);
  } finally {
    await q(`UPDATE series_overrides SET title = NULL WHERE series_id = $1`, [B]);
    await q(`DELETE FROM read_progress WHERE book_id = 'b_ed_b1'`);
  }
});

test('a viewer is shown only the editions they may open', { skip }, async () => {
  const detail = async (who: string, id: string) => (await call('GET', `/api/series/${id}`, who)).json();
  const a = await detail(ADMIN, A);
  assert.equal(a.lang, 'en');
  assert.deepEqual(a.edition.editions.map((e: any) => [e.seriesId, e.lang, e.current]), [[A, 'en', true], [B, 'es-419', false]]);
  assert.equal(a.langStated, true, 'an admin is told the language is the series\' own');
  // Reintroduce by gating the edition list with visibleToAll: the narrow member sees the edition in a library
  // they were never granted.
  await q('UPDATE lib_series SET library_id = $2 WHERE id = $1', [B, OTHER_LIB]);
  try {
    assert.equal((await detail(NARROW, A)).edition, null, 'a member restricted to A\'s library gets a plain series');
    assert.equal((await detail(MEMBER, A)).edition.editions.length, 2, 'while one who may open both sees both');
  } finally {
    await q(`UPDATE lib_series SET library_id = 'lib' WHERE id = $1`, [B]);
  }
});

test('Komga titles an edition with its language while a sibling is in sight', { skip }, async () => {
  await seed(C, 'Copy Tale', null);
  const komga = async (id: string) => (await app.inject({ method: 'GET', url: `/api/v1/series/${id}`, headers: { 'x-api-key': komgaKey } })).json();
  // Reintroduce by dropping `labelled` in routes/komgaCompat.ts: the two read "Edition Tale" and Mihon cannot tell them apart.
  const b = await komga(B);
  assert.equal(b.name, 'Edition Tale (ES-419)');
  assert.equal(b.metadata.title, 'Edition Tale (ES-419)');
  assert.equal(b.metadata.language, 'es-419', 'and says its language');
  assert.equal((await komga(A)).name, 'Edition Tale (EN)');
  const c = await komga(C);
  assert.equal(c.name, 'Copy Tale', 'a series on its own is titled as it always was');
  assert.equal(c.metadata.language, 'en', 'in the unstated language');
});

// ---- Health, merge, forget, the 18+ rating -------------------------------------------------------------------

test('two editions of one work are no duplicate; a copy beside them is, and a pair in two languages is linked', { skip }, async () => {
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1,'anilist','ed-101','Edition Tale'), ($2,'anilist','ed-101','Edition Tale')
           ON CONFLICT (series_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id`, [A, B]);
  // Reintroduce by grouping the check by series again (`HAVING count(*) > 1`): the work's two editions are a finding.
  assert.equal(await findingOf('duplicates', 'anilist:ed-101'), null, 'one work on one entry is no duplicate');
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1,'anilist','ed-101','Copy Tale')`, [C]);
  await seed(X, 'Linkable Tale', null);
  await seed(Y, 'Cuento Enlazable', 'pt-BR');
  await q(`INSERT INTO series_trackers (series_id, provider, external_id, title) VALUES ($1,'anilist','ed-303','x'), ($2,'anilist','ed-303','y')`, [X, Y]);
  const dupes = (await runHealthChecks()).checks.find((c: any) => c.id === 'duplicates');
  const copy = dupes.items.find((i: any) => i.key === 'anilist:ed-101');
  assert.ok(copy, 'an English copy beside the work is a duplicate');
  assert.deepEqual([...copy.seriesIds].sort(), [A, C].sort(), 'of the English edition, its own language');
  assert.equal(copy.actions[0], 'merge');
  const pair = dupes.items.find((i: any) => i.key === 'anilist:ed-303');
  assert.equal(pair.actions[0], 'link_editions', 'a pair in two languages is linked, never merged');
  assert.equal(pair.detailSaid?.[0]?.code, 'dupes.languages');
  assert.deepEqual(pair.langs, ['pt-BR', 'en'], 'beside the language of each');
  await q('DELETE FROM series_trackers WHERE series_id = $1', [C]);
});

test('an admin links two series as editions, and unlinking one dissolves the work', { skip }, async () => {
  assert.equal((await call('POST', `/api/admin/series/${X}/editions`, ADMIN, { with: C })).json().error, 'same_lang', 'two English series are merged, not linked');
  const r = await call('POST', `/api/admin/series/${Y}/editions`, ADMIN, { with: X });
  assert.equal(r.statusCode, 200, r.body);
  const [x, y] = [await row(X), await row(Y)];
  assert.ok(x.work_id && x.work_id === y.work_id, 'one work');
  assert.equal(x.lang, 'en', 'the series without a language states its inferred one');
  assert.equal(await findingOf('duplicates', 'anilist:ed-303'), null, 'and Health has nothing to say about them');
  const un = await call('DELETE', `/api/admin/series/${Y}/edition`);
  assert.equal(un.statusCode, 200, un.body);
  assert.equal((await row(X)).work_id, null, 'a work left with one edition dissolves');
  assert.equal((await row(Y)).work_id, null);
});

test('a merge inside one work is refused', { skip }, async () => {
  // Reintroduce by dropping the same_work check in the merge route: 200, and the Spanish chapters land on the English series.
  const r = await call('POST', `/api/admin/series/${A}/merge`, ADMIN, { into: B });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json().error, 'same_work');
  assert.equal((await row(A)).work_id, (await row(B)).work_id, 'nothing moved');
});

test('the work\'s age rating covers every edition, a new one too', { skip }, async () => {
  const meta = (id: string, ageRating: number | null) =>
    call('PUT', `/api/admin/series/${id}/meta`, ADMIN, { title: null, summary: null, author: null, status: null, genres: null, ageRating });
  try {
    assert.equal((await meta(A, 18)).statusCode, 200);
    // Reintroduce by dropping the sibling write in the meta PUT: the capped account opens the Spanish copy.
    assert.equal((await call('GET', `/api/series/${B}`, CAPPED)).statusCode, 404, 'rating one edition 18+ hides the other from a capped account');
    // Reintroduce by dropping copyRating in lib/editions.ts linkEdition: an edition added later is open to them.
    const fr = await add(FR, { edition: { of: A } });
    assert.equal(fr.statusCode, 200, fr.body);
    assert.equal((await call('GET', `/api/series/${fr.json().seriesId}`, CAPPED)).statusCode, 404, 'a new edition takes the rating');
    await q('DELETE FROM lib_series WHERE id = $1', [fr.json().seriesId]);
  } finally {
    await meta(A, null);
  }
  assert.equal((await call('GET', `/api/series/${B}`, CAPPED)).statusCode, 200, 'and clearing it clears it on every edition');
});

test('forgetting an edition, or merging one away, dissolves its work', { skip }, async () => {
  for (const [id, lang] of [[F1, 'en'], [F2, 'es'], [M1, 'en'], [M2, 'es'], [M3, 'fr'], [Z, 'es'], [Z2, 'fr']] as const) await seed(id, `Gone ${id}`, lang);
  assert.equal(typeof (await linkEdition(F2, { of: F1, lang: 'es' })), 'object');
  assert.equal(typeof (await linkEdition(M2, { of: M1, lang: 'es' })), 'object');
  assert.equal(typeof (await linkEdition(M3, { of: M1, lang: 'fr' })), 'object');
  // Reintroduce by dropping dissolveLoneWork in lib/libraryAdmin.ts forgetSeries: F1 stays in a work of one.
  assert.equal((await call('DELETE', `/api/admin/series/${F2}`)).statusCode, 200);
  const forget = await call('POST', `/api/admin/series/${F2}/forget`, ADMIN, { confirm: `Gone ${F2}` });
  assert.equal(forget.statusCode, 200, forget.body);
  assert.equal((await row(F1)).work_id, null, 'forgetting an edition dissolves the work');
  assert.equal((await call('GET', `/api/series/${F1}`)).json().edition, null);
  // Reintroduce by dropping the work_id clear in mergeSeries: the Spanish row merged away keeps its work and its slot,
  // and the work can never take a Spanish edition again.
  const merge = await call('POST', `/api/admin/series/${M2}/merge`, ADMIN, { into: Z });
  assert.equal(merge.statusCode, 200, merge.body);
  assert.equal((await row(M2)).work_id, null, 'a row merged away is no edition');
  assert.ok((await row(M1)).work_id && (await row(M1)).work_id === (await row(M3)).work_id, 'the other two stay one work');
  // Reintroduce by dropping dissolveLoneWork in mergeSeries: M1 keeps a work whose only other row is merged away.
  assert.equal((await call('POST', `/api/admin/series/${M3}/merge`, ADMIN, { into: Z2 })).statusCode, 200);
  assert.equal((await row(M1)).work_id, null, 'and the edition a merge leaves alone stands on its own');
});

// ---- the admin's controls -------------------------------------------------------------------------------------

test('an edition always states its language, and one the work holds is refused', { skip }, async () => {
  // Reintroduce by dropping the `edition_lang` refusal in PATCH /api/admin/series/:id: B's language is cleared.
  const none = await call('PATCH', `/api/admin/series/${B}`, ADMIN, { lang: null });
  assert.equal(none.statusCode, 409, none.body);
  assert.equal(none.json().error, 'edition_lang');
  assert.equal((await call('PATCH', `/api/admin/series/${B}`, ADMIN, { lang: 'en' })).json().error, 'edition_exists');
  assert.equal((await call('PATCH', `/api/admin/series/${B}`, ADMIN, { lang: 'two words' })).json().error, 'bad_lang');
  assert.equal((await row(B)).lang, 'es-419', 'unchanged');
  const c = await call('PATCH', `/api/admin/series/${C}`, ADMIN, { lang: 'de' });
  assert.equal(c.statusCode, 200, c.body);
  assert.equal((await row(C)).lang, 'de', 'a series on its own may say anything');
  await call('PATCH', `/api/admin/series/${C}`, ADMIN, { lang: null });
  assert.equal((await row(C)).lang, null, 'and go back to automatic');
});

test('Mark caught up floors a series above its newest chapter, and Undo puts the floor back', { skip }, async () => {
  for (let n = 1; n <= 30; n++) {
    await q(`INSERT INTO series_listing (series_id, number, source_id, chosen) VALUES ($1, $2, 'ed-en', '{}'::jsonb) ON CONFLICT DO NOTHING`, [C, n]);
  }
  for (let n = 1; n <= 5; n++) {
    await q(`INSERT INTO lib_books (id, series_id, source, file, title, number, pages, root) VALUES ($1,$2,'Seeded',$3,$4,$5,1,$6) ON CONFLICT (id) DO NOTHING`,
      [`b_ed_c${n}`, C, `Seeded/${C}/${n}.cbz`, `Chapter ${n}`, n, DISK]);
  }
  // Reintroduce by measuring from the chapters held (lib_books) alone: the floor lands at 5.001 and the sweep goes
  // on to fetch 6..30, the back catalogue the person said they had read elsewhere.
  const r = await call('PATCH', `/api/admin/series/${C}`, ADMIN, { chapterFloor: 'caught_up' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().chapterFloor.previous, null);
  assert.ok(Math.abs(r.json().chapterFloor.floor - 30.001) < 1e-6, `a hair above the newest listed chapter: ${r.json().chapterFloor.floor}`);
  const listing = (await call('GET', `/api/series/${C}/listing`)).json();
  assert.equal(listing.content.find((g: any) => g.number === 6)?.why, 'floor', 'the back catalogue reads as older chapters, not missing ones');
  const undo = await call('PATCH', `/api/admin/series/${C}`, ADMIN, { chapterFloor: r.json().chapterFloor.previous });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal((await q('SELECT chapter_floor FROM lib_series WHERE id = $1', [C]))[0].chapter_floor, null, 'Undo puts the old floor back');
  assert.equal((await call('PATCH', `/api/admin/series/${X}`, ADMIN, { chapterFloor: 'caught_up' })).json().error, 'nothing_listed', 'nothing to be above');
});

test('an admin is told where a series and its chapters are on disk; a member is not (#136)', { skip }, async () => {
  // Reintroduce by dropping `out.paths` in GET /api/series/:id: undefined.
  assert.deepEqual((await call('GET', `/api/series/${C}`)).json().paths, [join(DISK, `Seeded/${C}`)], 'one path per root its chapters are under');
  assert.deepEqual((await call('GET', `/api/series/${A}`)).json().paths, [join(root, (await row(A)).folder)], 'a series holding nothing: where its chapters will land');
  assert.equal((await call('GET', `/api/series/${C}`, MEMBER)).json().paths, undefined, 'a member is not told where anything is on the host');
  const books = (await call('GET', `/api/series/${C}/books`)).json().content;
  assert.equal(books[0].path, join(DISK, `Seeded/${C}/1.cbz`), 'each chapter\'s file, in full');
  assert.equal((await call('GET', `/api/series/${C}/books`, MEMBER)).json().content[0].path, undefined);
});

test('the languages a series could be added in, and a search in one of them', { skip }, async () => {
  const r = await call('GET', `/api/sources/edition-candidates?seriesId=${A}`);
  assert.equal(r.statusCode, 200, r.body);
  const langs = r.json().languages.map((l: any) => l.lang);
  // Reintroduce by not leaving out the languages the work holds: es-419 is offered for a work that has it.
  assert.ok(!langs.includes('en') && !langs.includes('es-419'), `the languages the work holds are not offered: ${langs}`);
  assert.ok(langs.includes('pt-BR') && langs.includes('fr'), `the others are: ${langs}`);
  assert.ok(r.json().unstated.some((s: any) => s.id === BARE), 'a source that does not say is a row of its own');
  assert.deepEqual(r.json().held.map((h: any) => h.lang).sort(), ['en', 'es-419']);
  const pt = (await call('GET', `/api/sources/edition-candidates?seriesId=${A}&lang=pt-BR`)).json();
  assert.deepEqual(pt.providers.map((p: any) => [p.source, p.sourceId, p.lang]), [[PT, `${PT}-s`, 'pt-BR']], 'the search asks that language\'s sources');
  assert.equal((await call('GET', `/api/sources/edition-candidates?seriesId=${A}`, NARROW)).statusCode, 200, 'a member who may download may ask');
  assert.equal((await call('GET', '/api/sources/edition-candidates?seriesId=nope')).statusCode, 404);
});
