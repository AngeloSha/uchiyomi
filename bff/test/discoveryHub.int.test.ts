import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
let app: any, q: typeof import('../src/lib/db').q, root: string, a: string, b: string, capped: string, fixtureAdmin: string;
let hub: typeof import('../src/lib/discoveryHub');
let visibility: typeof import('../src/lib/visibility');
let oldTrends: any[];
const realFetch = globalThis.fetch;
let networkCalls = 0;
const SAFE = { id: 1987654001, title: 'A safe discovery', cover: 'https://s4.anilist.co/safe.jpg',
  description: 'The actual catalog synopsis', genres: ['Adventure'], score: 84, chapters: 20, status: 'FINISHED' };
const ADULT = { ...SAFE, id: 1987654002, title: 'Restricted discovery', adult: true, genres: ['Adult-fixture'] };
const UNKNOWN = { id: '1987654003', title: 'Unrated discovery', cover: 'https://s4.anilist.co/unrated.jpg', altTitles: [], votes: 2 };
const headers = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });
const req = (method: string, path: string, who = a, payload?: unknown) => app.inject({ method, url: path, headers: headers(who), ...(payload !== undefined ? { payload } : {}) });
const choice = (key: string, change: unknown, who = a) => req('PUT', `/api/discover/items/${encodeURIComponent(key)}`, who, change);

before(async () => {
  if (!DSN) return;
  root = await mkdtemp(join(tmpdir(), 'uchiyomi-discovery-hub-'));
  Object.assign(process.env, { DATABASE_URL: DSN, CONFIG_DIR: root, JWT_SECRET: 'discovery-hub-test-secret-32-chars', LIBRARY_BACKEND: 'owned', UCHIYOMI_PING_URL: '' });
  globalThis.fetch = (async () => { networkCalls++; throw new Error('Discover feedback must remain local'); }) as typeof fetch;
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  hub = await import('../src/lib/discoveryHub');
  visibility = await import('../src/lib/visibility');
  oldTrends = await q('SELECT country,items,fetched_at FROM anilist_trending');
  await q('DELETE FROM anilist_trending');
  await q('INSERT INTO anilist_trending(country,items,fetched_at) VALUES($1,$2::jsonb,now())', ['KR', JSON.stringify([SAFE])]);
  await q('INSERT INTO tracker_rec_cache(provider,seed_id,recs) VALUES($1,$2,$3::jsonb)', ['anilist', 'discovery-hub-fixture', JSON.stringify([ADULT, UNKNOWN])]);
  const make = async (max: number | null) => (await q<{ id: string }>(`INSERT INTO users(username,display_name,password_hash,role,max_age_rating) VALUES($1,$1,'x','user',$2) RETURNING id`, [`hub-${randomUUID()}`, max]))[0].id;
  fixtureAdmin = await make(null);
  await q(`UPDATE users SET role='admin' WHERE id=$1`, [fixtureAdmin]);
  a = await make(null); b = await make(null); capped = await make(12);
  app = (await import('fastify')).default();
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/discoveryHub')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
});
beforeEach(async () => {
  if (!DSN) return;
  await q('DELETE FROM discover_feedback WHERE user_id=ANY($1::uuid[])', [[a, b, capped]]);
  await q('DELETE FROM app_settings WHERE user_id=ANY($1::uuid[])', [[a, b, capped]]);
});
after(async () => {
  if (!DSN) return;
  globalThis.fetch = realFetch;
  await app?.close();
  await q('DELETE FROM tracker_rec_cache WHERE provider=$1 AND seed_id=$2', ['anilist', 'discovery-hub-fixture']);
  await q('DELETE FROM anilist_trending');
  for (const old of oldTrends) await q('INSERT INTO anilist_trending(country,items,fetched_at) VALUES($1,$2::jsonb,$3)', [old.country, JSON.stringify(old.items), old.fetched_at]);
  await q('DELETE FROM users WHERE id=ANY($1::uuid[])', [[a, b, capped, fixtureAdmin]]);
  await rm(root, { recursive: true, force: true });
});

test('Discover state and writes require authentication and add-series permission', { skip }, async () => {
  assert.equal((await app.inject('/api/discover/state')).statusCode, 401);
  await q(`UPDATE users SET perms='{"canDownload":false}'::jsonb WHERE id=$1`, [b]);
  try {
    for (const [method, path, payload] of [
      ['GET', '/api/discover/state', undefined], ['PATCH', '/api/discover/state', { tab: 'sources' }],
      ['PUT', '/api/discover/items/al:1987654001', { saved: true }], ['DELETE', '/api/discover/hidden', undefined],
    ] as const) assert.equal((await req(method, path, b, payload)).statusCode, 403);
  } finally { await q(`UPDATE users SET perms='{}'::jsonb WHERE id=$1`, [b]); }
});

test('tab preference is per account and merges other settings without replacing them', { skip }, async () => {
  await q(`INSERT INTO app_settings(user_id,data) VALUES($1,'{"locale":"ar","reader":{"direction":"rtl"}}'::jsonb)`, [a]);
  assert.equal((await req('GET', '/api/discover/state')).json().tab, 'for-you');
  const r = await req('PATCH', '/api/discover/state', a, { tab: 'sources' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { tab: 'sources' });
  assert.equal((await req('GET', '/api/discover/state')).json().tab, 'sources');
  assert.equal((await req('GET', '/api/discover/state', b)).json().tab, 'for-you');
  const [row] = await q<{ data: any }>('SELECT data FROM app_settings WHERE user_id=$1', [a]);
  assert.equal(row.data.locale, 'ar'); assert.equal(row.data.reader.direction, 'rtl');
  assert.equal((await req('PATCH', '/api/discover/state', a, { tab: 'bogus' })).statusCode, 400);
});

test('saving persists authoritative metadata without adding a series or calling external services', { skip }, async () => {
  const [before] = await q<{ count: number }>('SELECT count(*)::int AS count FROM lib_series');
  const r = await choice(`al:${SAFE.id}`, { saved: true, item: { title: 'Fake safe title', adult: false, cover: 'https://attacker.test/art', description: 'fake', country: 'JP' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true, key: `al:${SAFE.id}`, saved: true, hidden: false });
  const state = await req('GET', '/api/discover/state');
  assert.match(state.headers['cache-control'], /no-store/); assert.equal(state.headers.vary, '*');
  assert.equal(state.json().saved.length, 1);
  const saved = state.json().saved[0];
  assert.equal(saved.title, SAFE.title); assert.equal(saved.cover, SAFE.cover); assert.equal(saved.description, SAFE.description); assert.equal(saved.country, 'KR');
  assert.equal((await req('GET', '/api/discover/state', b)).json().saved.length, 0);
  const [after] = await q<{ count: number }>('SELECT count(*)::int AS count FROM lib_series');
  assert.equal(after.count, before.count); assert.equal(networkCalls, 0);
  await (await import('../src/lib/migrate')).migrate();
  assert.equal((await req('GET', '/api/discover/state')).json().saved[0].title, SAFE.title, 'rerunning migrations retains choices');
});

test('a capped viewer cannot save an adult or unknown work using forged safe metadata', { skip }, async () => {
  for (const id of [ADULT.id, Number(UNKNOWN.id), 1987654999]) {
    const r = await choice(`al:${id}`, { saved: true, item: { title: 'Safe', adult: false, genres: [] } }, capped);
    assert.equal(r.statusCode, 404, r.body);
  }
  assert.equal((await choice(`al:${SAFE.id}`, { saved: true }, capped)).statusCode, 200);
  assert.equal((await req('GET', '/api/discover/state', capped)).json().saved.length, 1);
  const r = await req('PUT', `/api/discover/items/al:${ADULT.id}?adult=1`, a, { saved: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await req('GET', '/api/discover/state?adult=1')).json().saved.length, 1);
  await q('UPDATE users SET max_age_rating=12 WHERE id=$1', [a]);
  try { assert.equal((await req('GET', '/api/discover/state?adult=1')).json().saved.length, 0, 'a cap applies even to a previous unrestricted save'); }
  finally { await q('UPDATE users SET max_age_rating=NULL WHERE id=$1', [a]); }
});

test('saved cards are rejudged against current adult genre preferences', { skip }, async () => {
  const { invalidateAdultFilter } = await import('../src/lib/visibility');
  const setting = await q<{ adult_genres: string[] }>('SELECT adult_genres FROM server_settings WHERE id=1');
  await req('PUT', `/api/discover/items/al:${SAFE.id}?adult=1`, a, { saved: true });
  try {
    await q(`UPDATE server_settings SET adult_genres='["Adventure"]'::jsonb WHERE id=1`);
    invalidateAdultFilter();
    assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 0);
    assert.equal((await req('GET', '/api/discover/state?adult=1')).json().saved.length, 1);
  } finally { await q('UPDATE server_settings SET adult_genres=$1::jsonb WHERE id=1', [JSON.stringify(setting[0]?.adult_genres ?? [])]); invalidateAdultFilter(); }
});

test('a later trusted adult rating replaces an old safe saved snapshot and survives cache pruning', { skip }, async () => {
  await choice(`al:${SAFE.id}`, { saved: true }, capped);
  assert.equal((await req('GET', '/api/discover/state?adult=1', capped)).json().saved.length, 1);
  try {
    await q('UPDATE anilist_trending SET items=$1::jsonb,fetched_at=now() WHERE country=$2', [JSON.stringify([{ ...SAFE, adult: true, genres: ['Restricted'] }]), 'KR']);
    assert.equal((await req('GET', '/api/discover/state?adult=1', capped)).json().saved.length, 0);
    const [record] = await q<{ snapshot: { adult: boolean } }>('SELECT snapshot FROM discover_feedback WHERE user_id=$1 AND work_key=$2', [capped, `al:${SAFE.id}`]);
    assert.equal(record.snapshot.adult, true, 'the newly learned restriction is retained');
    await q('UPDATE anilist_trending SET items=$1::jsonb WHERE country=$2', ['[]', 'KR']);
    assert.equal((await req('GET', '/api/discover/state?adult=1', capped)).json().saved.length, 0, 'pruning a catalog cache cannot restore an obsolete safe rating');
    assert.equal(networkCalls, 0);
  } finally { await q('UPDATE anilist_trending SET items=$1::jsonb WHERE country=$2', [JSON.stringify([SAFE]), 'KR']); }
});

test('MAL IDs never impersonate an AniList identity even when numeric IDs overlap', { skip }, async () => {
  const malOnly = { ...SAFE, id: '1987654010', title: 'MAL-only discovery', adult: false };
  const overlap = { ...ADULT, id: String(SAFE.id), title: 'Different MAL work', adult: true };
  await q('INSERT INTO tracker_rec_cache(provider,seed_id,recs) VALUES($1,$2,$3::jsonb)', ['myanimelist', 'discovery-hub-fixture', JSON.stringify([malOnly, overlap])]);
  try {
    assert.equal((await choice('al:1987654010', { saved: true, item: { title: malOnly.title, adult: false } }, capped)).statusCode, 404);
    assert.equal((await choice(`al:${SAFE.id}`, { saved: true }, capped)).statusCode, 200, 'an unrelated MAL adult work must not become this AniList work');
    const titleSave = await choice('t:malonlydiscovery', { saved: true, item: { title: malOnly.title } }, capped);
    assert.equal(titleSave.statusCode, 200, titleSave.body);
    const item = (await req('GET', '/api/discover/state', capped)).json().saved.find((it: any) => it.title === malOnly.title);
    assert.equal(item.id, null); assert.equal(item.key, 't:malonlydiscovery');
  } finally { await q('DELETE FROM tracker_rec_cache WHERE provider=$1 AND seed_id=$2', ['myanimelist', 'discovery-hub-fixture']); }
});

test('hidden choices suppress canonical and title aliases only for their owner and undo preserves saves', { skip }, async () => {
  await choice(`al:${SAFE.id}`, { saved: true });
  await choice(`al:${SAFE.id}`, { hidden: true });
  const state = (await req('GET', '/api/discover/state')).json();
  assert.equal(state.saved.length, 1, 'saving and hiding are independent');
  assert.ok(state.hidden.includes(`al:${SAFE.id}`)); assert.ok(state.hidden.includes('t:asafediscovery'));
  const cards = [{ id: SAFE.id, title: 'Alternate official name' }, { title: SAFE.title }, { title: 'Another work' }];
  assert.deepEqual(await hub.withoutHiddenDiscover(a, cards), [{ title: 'Another work' }]);
  assert.deepEqual(await hub.withoutHiddenDiscover(b, cards), cards);
  assert.deepEqual(await hub.withoutHiddenDiscover(a, [{ title: 'Alternate', sources: [{ url: `https://anilist.co/manga/${SAFE.id}/a` }] }]), []);
  assert.deepEqual((await req('GET', '/api/discover/trending?country=KR')).json().content, []);
  assert.equal((await req('GET', '/api/discover/trending?country=KR', b)).json().content[0]?.title, SAFE.title);
  assert.equal((await choice(`al:${SAFE.id}`, { hidden: false })).statusCode, 200);
  assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 1);
  assert.deepEqual((await req('GET', '/api/discover/state')).json().hidden, []);
});

test('title and canonical ID actions converge on one choice and a title-key undo retains its save', { skip }, async () => {
  await Promise.all([
    choice('t:asafediscovery', { saved: true, item: { title: SAFE.title } }),
    choice(`al:${SAFE.id}`, { hidden: true }),
  ]);
  const [n] = await q<{ count: number }>('SELECT count(*)::int AS count FROM discover_feedback WHERE user_id=$1', [a]);
  assert.equal(n.count, 1);
  const state = (await req('GET', '/api/discover/state')).json();
  assert.equal(state.saved.length, 1); assert.ok(state.hidden.includes(`al:${SAFE.id}`));
  const undo = await choice('t:asafediscovery', { hidden: false });
  assert.equal(undo.statusCode, 200, undo.body);
  assert.equal(undo.json().saved, true); assert.equal(undo.json().hidden, false);
  assert.deepEqual((await req('GET', '/api/discover/state')).json().hidden, []);
  await req('DELETE', '/api/discover/items/t:asafediscovery');
  assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 0);
});

test('concurrent tabs cannot exceed the choice limit and can still update an existing choice', { skip }, async () => {
  await q(`INSERT INTO discover_feedback(user_id,work_key,hidden)
    SELECT $1, 'al:' || n::text, true FROM generate_series(1,999) n`, [a]);
  const answers = await Promise.all([choice('al:1001', { hidden: true }), choice('al:1002', { hidden: true })]);
  assert.deepEqual(answers.map((r: any) => r.statusCode).sort(), [200, 409]);
  const [n] = await q<{ count: number }>('SELECT count(*)::int AS count FROM discover_feedback WHERE user_id=$1', [a]);
  assert.equal(n.count, 1000);
  assert.equal((await choice('al:1', { hidden: true })).statusCode, 200);
  assert.equal((await choice('al:1', { hidden: false })).statusCode, 200);
  assert.equal((await choice('al:1003', { hidden: true })).statusCode, 200);
});

test('reset hidden choices retains saved choices and cannot change another account', { skip }, async () => {
  await choice(`al:${SAFE.id}`, { saved: true, hidden: true });
  await choice('t:unknownlocaltitle', { hidden: true });
  await choice(`al:${SAFE.id}`, { hidden: true }, b);
  assert.equal((await req('DELETE', '/api/discover/hidden')).statusCode, 200);
  const state = (await req('GET', '/api/discover/state')).json();
  assert.equal(state.saved.length, 1); assert.deepEqual(state.hidden, []);
  assert.ok((await req('GET', '/api/discover/state', b)).json().hidden.includes(`al:${SAFE.id}`));
  assert.equal((await req('DELETE', `/api/discover/items/al:${SAFE.id}`)).statusCode, 200);
  assert.deepEqual((await req('GET', '/api/discover/state')).json().saved, []);
});

test('Unicode title fallback resolves trusted metadata and repeated choices are idempotent', { skip }, async () => {
  const title = '마법의 旅 ２';
  const key = 't:마법의旅2';
  await q('UPDATE anilist_trending SET items=items || $1::jsonb WHERE country=$2', [JSON.stringify([{ ...SAFE, id: null, title }]), 'KR']);
  try {
    assert.equal((await choice(key, { saved: true, item: { title } })).statusCode, 200);
    assert.equal((await choice(key, { saved: true, item: { title } })).statusCode, 200);
    assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 1);
    assert.equal((await choice(key, { hidden: true })).statusCode, 200);
    assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 1);
  } finally { await q('UPDATE anilist_trending SET items=$1::jsonb WHERE country=$2', [JSON.stringify([SAFE]), 'KR']); }
});

test('malformed keys, boolean coercion and excess fields cannot write choices', { skip }, async () => {
  for (const key of ['al:0', 'al:01', 'al:2147483648', 't:', 't:Title', 'bad:key', "t:' OR 1=1"]) assert.equal((await choice(key, { hidden: true })).statusCode, 400, key);
  for (const change of [{}, { saved: 'true' }, { saved: true, userId: b }, { hidden: true, item: { title: '' } }]) assert.equal((await choice(`al:${SAFE.id}`, change)).statusCode, 400);
  assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 0);
});

test('removing a user cascades only their saved/hidden rows', { skip }, async () => {
  const [temp] = await q<{ id: string }>(`INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'temporary','x','user') RETURNING id`, [`hub-temp-${randomUUID()}`]);
  await choice(`al:${SAFE.id}`, { saved: true }, temp.id);
  await choice(`al:${SAFE.id}`, { saved: true }, a);
  await q('DELETE FROM users WHERE id=$1', [temp.id]);
  assert.equal((await q('SELECT user_id FROM discover_feedback WHERE user_id=$1', [temp.id])).length, 0);
  assert.equal((await req('GET', '/api/discover/state')).json().saved.length, 1);
});
