// An extension's own settings over HTTP (#116, routes/numbering.ts), against the fake v2.3.2243 engine: what the
// settings sheet reads, what a write is allowed to send, and what a numbering setting does to the series of that
// source -- a remap queued on every series that uses the source's numbers, and nothing on the posting-order ones.
//
// The routes are mounted through routes/admin.ts, as the server mounts them, so the admin gate is the real one.
// Skipped automatically unless TEST_DATABASE_URL is set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSuwayomi, SOURCE_IDS, SEQUENTIAL_KEY, PKG, type FakeSuwayomi } from './fixtures/fakeSuwayomi';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.UCHIYOMI_PING_URL = '';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

const WT = SOURCE_IDS.webtoons;
const SW = `sw:${WT}`;
const PLAIN = 's_xp_plain', POSTED = 's_xp_posted', OTHER = 's_xp_other', GONE = 's_xp_gone';
const ALL = [PLAIN, POSTED, OTHER, GONE];

let fake: FakeSuwayomi | null = null;
let app: any, q: any, admin = '', member = '';

before(async () => {
  if (!DSN) return;
  fake = await startFakeSuwayomi();
  // ⚠️ Before anything from src is imported: env.ts reads SUWAYOMI_URL once.
  process.env.SUWAYOMI_URL = fake.url;
  const { migrate } = await import('../src/lib/migrate');
  await migrate();
  ({ q } = (await import('../src/lib/db')) as any);
  const { registerAdapter } = await import('../src/lib/sources');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const { gql } = await import('../src/lib/sources/suwayomi/client');
  registerAdapter(makeSuwayomiAdapter({ id: WT, name: 'Webtoons.com', lang: 'en', supportsLatest: false }, gql));

  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]);
  const series = (id: string, source: string, extra: string) => q(
    `INSERT INTO lib_series (id, source, title, folder, books_count, source_id, source_series_id${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1, 'Webtoons.com', $1, $2, 0, $3, '1'${extra ? ', ' + extra.split('=')[1] : ''})`, [id, `Webtoons.com/${id}`, source]);
  await series(PLAIN, SW, '');
  await series(POSTED, SW, "numbering='posting_order'");
  await series(OTHER, 'mangadex', '');
  await series(GONE, SW, 'deleted_at=now()');

  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.register((await import('../src/routes/sources')).default);
  await app.ready();
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['xp-admin', 'xp-member']]);
  const mk = async (name: string, role: string) => (await q(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1,$1,'x',$2,'password') RETURNING id`, [name, role]))[0].id;
  admin = `Bearer ${app.jwt.sign({ sub: await mk('xp-admin', 'admin'), role: 'admin' })}`;
  member = `Bearer ${app.jwt.sign({ sub: await mk('xp-member', 'user'), role: 'user' })}`;
});

after(async () => {
  if (!DSN) return;
  await app?.close();
  await fake?.close();
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [ALL]).catch(() => {});
  await q(`DELETE FROM users WHERE username = ANY($1)`, [['xp-admin', 'xp-member']]).catch(() => {});
});

const URL = `/api/admin/extensions/sources/${WT}/preferences`;
const get = (auth = admin) => app.inject({ method: 'GET', url: URL, headers: { authorization: auth } });
const post = (payload: unknown, auth = admin) => app.inject({ method: 'POST', url: URL, headers: { authorization: auth }, payload });
const pending = async () => Object.fromEntries((await q('SELECT id, numbering_pending FROM lib_series WHERE id = ANY($1)', [ALL])).map((r: any) => [r.id, r.numbering_pending]));

test('the settings sheet reads every preference by key, with no position to send back', { skip }, async () => {
  fake!.reset();
  const r = await get();
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.source.pkgName, PKG.webtoons);
  assert.deepEqual(b.preferences.map((p: any) => p.type), ['switch', 'checkbox', 'list', 'multiselect', 'text', 'switch']);
  // Reintroduce by answering the raw SourcePref (drop `wire`): a client could echo a position back, and a
  // position is exactly what must never address a write.
  assert.ok(b.preferences.every((p: any) => !('position' in p)), 'no position leaves the server');
  assert.deepEqual(b.preferences.filter((p: any) => p.numbering).map((p: any) => p.key), [SEQUENTIAL_KEY]);
  assert.deepEqual([b.usedBy, b.renumbers], [2, 1], 'two live series use the source; one of them uses its numbers');

  assert.equal((await get(member)).statusCode, 403, 'admins only');
  assert.equal((await post({ key: SEQUENTIAL_KEY, value: true }, member)).statusCode, 403, 'admins only');
  const bad = await app.inject({ method: 'GET', url: '/api/admin/extensions/sources/not-a-number/preferences', headers: { authorization: admin } });
  assert.equal(bad.statusCode, 400);
  const unknown = await app.inject({ method: 'GET', url: '/api/admin/extensions/sources/42/preferences', headers: { authorization: admin } });
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(unknown.json().error, 'unknown_source');

  // The extension's sources, for the sheet opened from a catalogue row that knows only the package.
  const list = await app.inject({ method: 'GET', url: `/api/admin/extensions/sources?pkg=${encodeURIComponent(PKG.webtoons)}`, headers: { authorization: admin } });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json().content.map((s: any) => [s.id, s.pkgName]), [[WT, PKG.webtoons]]);
});

test('a write is checked against the preference before it is sent', { skip }, async () => {
  fake!.reset();
  for (const [body, code] of [
    [{ key: 'imageQuality', value: 'ultra' }, 'bad_value'],
    [{ key: SEQUENTIAL_KEY, value: 'on' }, 'bad_value'],
    [{ key: 'nope', value: true }, 'unknown_pref'],
    [{ key: 'legacyViewer', value: true }, 'disabled'],
    [{ key: 'imageQuality' }, 'bad_request'],
  ] as const) {
    const r = await post(body);
    assert.equal(r.statusCode, 400, `${JSON.stringify(body)}: ${r.body}`);
    assert.equal(r.json().error, code, JSON.stringify(body));
    // v0.49.1: the refusal's sentence as its code too (lib/said.ts `pref.*`), so the sheet says it in the reader's
    // language; its English reads back from the code alone. Reintroduce `{ error: e.code, message: e.message }`:
    // this finds no code.
    if (code !== 'bad_request') {
      const { englishOf } = await import('../src/lib/said');
      assert.match(r.json().messageSaid?.code ?? '', /^pref\./, `${JSON.stringify(body)}: no code for the sheet to word`);
      assert.equal(englishOf(r.json().messageSaid), r.json().message, `${JSON.stringify(body)}: the code says something else`);
    }
  }
  assert.deepEqual(fake!.prefWrites, [], 'nothing refused reached the engine');
  assert.deepEqual(await pending(), { [PLAIN]: null, [POSTED]: null, [OTHER]: null, [GONE]: null });

  const ok = await post({ key: 'imageQuality', value: 'low' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual([ok.json().changed, ok.json().applied, ok.json().remap], [true, true, 0], 'not a numbering setting: nothing is queued');
  assert.equal(fake!.source(WT).prefValues.imageQuality, 'low');
  assert.deepEqual(await pending(), { [PLAIN]: null, [POSTED]: null, [OTHER]: null, [GONE]: null });

  // A text setting is logged by its length: extensions keep logins and keys in them.
  await post({ key: 'customUserAgent', value: 'secret-token-123' });
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'source.extension_pref' ORDER BY id DESC LIMIT 1`))[0].detail;
  assert.equal(audit.key, 'customUserAgent');
  assert.deepEqual(audit.to, { length: 16 });
  assert.doesNotMatch(JSON.stringify(audit), /secret-token/, 'the text itself is not in the audit log');
});

test('a numbering setting queues a remap on the series that use the source\'s numbers', { skip }, async () => {
  fake!.reset();
  const detail = async () => {
    const r = await app.inject({ method: 'GET', url: `/api/sources/detail?source=${encodeURIComponent(SW)}&sourceId=${fake!.manga('Istrevelia').id}`, headers: { authorization: admin } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  // Episode numbers: the detector numbers the 226 posts itself.
  assert.equal((await detail()).numbering.applied, 'posting_order');

  const r = await post({ key: SEQUENTIAL_KEY, value: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(fake!.source(WT).prefValues[SEQUENTIAL_KEY], true, 'the extension has the setting');
  // Reintroduce by dropping the remap UPDATE in the route: the plain series stays unmarked, and its files keep
  // naming the source's OLD numbers while the listing moves to the new ones.
  assert.deepEqual(await pending(), { [PLAIN]: 'remap', [POSTED]: null, [OTHER]: null, [GONE]: null },
    'only the live series on this source that use its numbers; a posting-order series keeps its posts\' numbers');
  assert.deepEqual([r.json().changed, r.json().applied, r.json().remap], [true, true, 1]);
  const audit = (await q(`SELECT detail FROM audit_log WHERE event = 'source.extension_pref' ORDER BY id DESC LIMIT 1`))[0].detail;
  assert.deepEqual([audit.key, audit.from, audit.to, audit.numbering, audit.remap], [SEQUENTIAL_KEY, false, true, true, 1]);

  // Reintroduce by dropping clearDetailCacheFor from the route: the add dialog keeps counting the old numbers
  // (the cached list still reads 13 episode numbers, so posting order still applies).
  const after = await detail();
  assert.equal(after.numbering.applied, 'source', 'the next detail reads the new numbers: 1..226 of their own');
  assert.deepEqual([after.count, after.first, after.last], [226, 1, 226]);

  // The same value again changes nothing and queues nothing.
  await q(`UPDATE lib_series SET numbering_pending = NULL WHERE id = $1`, [PLAIN]);
  const again = await post({ key: SEQUENTIAL_KEY, value: true });
  assert.deepEqual([again.json().changed, again.json().remap], [false, 0]);
  assert.deepEqual(await pending(), { [PLAIN]: null, [POSTED]: null, [OTHER]: null, [GONE]: null });
});

test('an engine that does not answer is a 502, not an empty sheet', { skip }, async () => {
  fake!.reset();
  fake!.setMode('down');
  try {
    const r = await get();
    assert.equal(r.statusCode, 502, r.body);
    assert.equal(r.json().error, 'unreachable');
    assert.deepEqual(r.json().messageSaid, { code: 'pref.unreachable' });
  } finally {
    fake!.setMode('up');
  }
});

test("an extension's own exception is not the engine being down", { skip }, async () => {
  // The engine answered, with the exception the extension's preference screen threw: the misattribution #115 exists
  // to fix, on the settings sheet (#116 review). Reintroduce the one 502 (routes/numbering.ts engineFailure): this
  // reads 'unreachable', "the extension server did not answer", over an engine that did.
  fake!.reset();
  fake!.source(WT).fail.preferences = 'Unable to build the settings of this source';
  try {
    const r = await get();
    assert.equal(r.statusCode, 502, r.body);
    assert.equal(r.json().error, 'extension_error', "an extension's own exception is not the engine being down");
    assert.equal(r.json().message, 'The extension failed: Unable to build the settings of this source');
    // The extension's own words ride as a parameter, for the page to put inside its own sentence.
    assert.deepEqual(r.json().messageSaid, { code: 'pref.extensionFailed', params: { error: 'Unable to build the settings of this source' } });
  } finally {
    fake!.reset();
  }
});

test('a numbering setting the engine did not take queues nothing', { skip }, async () => {
  // Only a setting the engine really took moves the numbers: a write it answered and did not store queued a remap on
  // every series of the source, each held until an admin confirmed it (#116 review). Reintroduce by dropping
  // `w.applied` from the route's remap: the plain series is marked.
  fake!.reset();
  fake!.source(WT).preferences.find((p) => p.key === SEQUENTIAL_KEY)!.keeps = true;
  try {
    const r = await post({ key: SEQUENTIAL_KEY, value: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual([r.json().changed, r.json().applied, r.json().remap], [true, false, 0], 'asked, and not taken');
    assert.deepEqual(await pending(), { [PLAIN]: null, [POSTED]: null, [OTHER]: null, [GONE]: null }, 'a write the engine did not take queues nothing');
  } finally {
    fake!.reset();
  }
});
