// The cover proxy fetches our own extension engine, and still refuses everything else on the network.
//
// Suwayomi proxies every cover through itself, so an extension source's cover URL is an absolute URL on the
// engine's own origin — `http://yomi-suwayomi:4567/...`. That resolves to a private address, which is exactly
// what the v0.21.0 SSRF guard exists to refuse, so EVERY cover from EVERY extension source came back as the
// grey placeholder: whole rails of Discover, permanently, cached for a year. Extension icons never had the
// problem only because their route fetches the engine directly and never consults the guard.
//
// ⚠️ THE FIX IS ONE PATH SHAPE ON ONE ORIGIN, NOT A CLASS OF ADDRESS, and that is the entire safety
// argument. `?u=` is caller-supplied: a rule like "allow private addresses" would hand back the exact
// capability v0.21.0 removed — any signed-in reader turning this route into a scanner of the Docker network.
// And the origin alone was not enough either: the engine fetch carries the engine's Basic credentials, so
// "any path on the engine origin" (which this file asserted as intended until v0.37.0) let a reader make the
// server issue authenticated GETs to any engine endpoint. So the interesting assertions here are the NEGATIVE
// ones, and they name real neighbours: the database, the cloud metadata service, an unrelated private host —
// and the engine's own non-thumbnail paths.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

const ENGINE = 'http://yomi-suwayomi:4567';

// ⚠️ THE SHIPPED PREDICATE, imported — not a copy of it restated here. A guard asserted against a
// reimplementation of itself passes no matter what the app actually does.
let isEngineOrigin: typeof import('../src/routes/images').isEngineOrigin;
let engineCoverUrl: typeof import('../src/routes/images').engineCoverUrl;
let suwayomiBase: typeof import('../src/lib/sources/suwayomi/client').suwayomiBase;
before(async () => {
  ({ isEngineOrigin, engineCoverUrl } = await import('../src/routes/images'));
  ({ suwayomiBase } = await import('../src/lib/sources/suwayomi/client'));
});

const onEngineOrigin = (u: string) => isEngineOrigin(u, ENGINE);
const exempt = (u: string, engine = ENGINE) => engineCoverUrl(u, engine)?.href ?? null;

test('a cover on the configured engine origin is on the engine origin', () => {
  assert.equal(onEngineOrigin('http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail'), true);
  assert.equal(onEngineOrigin('http://yomi-suwayomi:4567/anything/at/all.png'), true);
});

test("the engine's thumbnail path is exempt, and it is fetched as rebuilt from the operator base", () => {
  assert.equal(exempt('http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail'), 'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail');
  assert.equal(exempt('http://yomi-suwayomi:4567/api/v1/manga/3596/thumbnail'), 'http://yomi-suwayomi:4567/api/v1/manga/3596/thumbnail');
  // A trailing slash on the operator's value is the most common way to write it, and must not double up.
  assert.equal(exempt('http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail', 'http://yomi-suwayomi:4567/'), 'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail');
  // An engine reverse-proxied under a sub-path produces covers under that sub-path (suwayomiUrl appends to
  // the whole base), and those are the engine's thumbnails too. The prefix has to be the operator's, though.
  assert.equal(exempt('http://proxy/suwayomi/api/v1/manga/1/thumbnail', 'http://proxy/suwayomi'), 'http://proxy/suwayomi/api/v1/manga/1/thumbnail');
  assert.equal(exempt('http://proxy/other/api/v1/manga/1/thumbnail', 'http://proxy/suwayomi'), null, 'a different prefix is not the engine\'s thumbnail');
  assert.equal(exempt('http://proxy/api/v1/manga/1/thumbnail', 'http://proxy/suwayomi'), null, 'nor is the path with the prefix missing');
});

test('an operator base that is not already clean still yields exempt thumbnails', () => {
  // Reintroduce by comparing the raw env string -- `(engine || '').replace(/\/$/, '')` as the base inside
  // engineCoverUrl instead of `suwayomiBase(engine)`: a doubled trailing slash rebuilds `//api/v1/...`, a
  // query or a fragment lands in front of the path, the round-trip fails, and all three below come back null.
  // That is what every extension cover did under such a value: fell through to the SSRF guard, resolved
  // private, grey placeholder, nothing logged. The stored side is the same function, so `suwayomiUrl` and the
  // proxy can only disagree if one of them stops reading it.
  const clean = 'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail';
  for (const [base, why] of [
    ['http://yomi-suwayomi:4567//', 'a doubled trailing slash'],
    ['http://yomi-suwayomi:4567/?q', 'a query string on the base'],
    ['http://yomi-suwayomi:4567#f', 'a fragment on the base'],
  ] as const) {
    assert.equal(suwayomiBase(base), 'http://yomi-suwayomi:4567', `${why} is normalised away for the stored cover`);
    assert.equal(exempt(clean, base), clean, `${why} must not refuse the cover the adapter itself produced`);
  }
  // And a sub-path base keeps its path through the same normalisation: only the trailing slashes go.
  assert.equal(suwayomiBase('http://proxy/suwayomi//'), 'http://proxy/suwayomi');
  assert.equal(exempt('http://proxy/suwayomi/api/v1/manga/1/thumbnail', 'http://proxy/suwayomi/?q#f'), 'http://proxy/suwayomi/api/v1/manga/1/thumbnail');
  // Normalising never widens the exemption: the origin and shape checks still run on the caller's value.
  assert.equal(exempt('http://yomi-suwayomi:4567/api/v1/extension/list', 'http://yomi-suwayomi:4567//'), null);
  assert.equal(exempt('http://yomi-db:5432/api/v1/manga/1/thumbnail', 'http://yomi-suwayomi:4567//'), null);
  // A value that is not an http(s) URL is handed back unchanged bar trailing slashes, not invented into one.
  assert.equal(suwayomiBase('yomi-suwayomi:4567/'), 'yomi-suwayomi:4567');
  assert.equal(suwayomiBase(''), '');
});

test('ANYTHING ELSE ON THE ENGINE ORIGIN IS NOT EXEMPT, even though it is the engine', () => {
  // Reintroduce by matching the origin alone (`isEngineOrigin(u)` deciding the fetch, the way it did through
  // v0.36.0): every one of these is fetched with the engine's Basic credentials on behalf of any signed-in
  // reader, and the first assertion below fails.
  for (const u of [
    'http://yomi-suwayomi:4567/anything/at/all.png',
    'http://yomi-suwayomi:4567/api/v1/extension/list',                 // the engine's own REST API
    'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail/../../update', // a traversal that normalises elsewhere
    'http://yomi-suwayomi:4567/api/v1/manga/abc/thumbnail',            // not a numeric id
    'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail/extra',        // a suffix
    'http://yomi-suwayomi:4567/prefix/api/v1/manga/1/thumbnail',       // a prefix the operator did not set
    'http://yomi-suwayomi:4567/',
  ]) {
    assert.equal(exempt(u), null, `${u} is on the engine origin but must never be fetched un-guarded`);
  }
});

test('a query string or fragment on the thumbnail path is dropped, never forwarded', () => {
  // The URL on the wire is rebuilt from the base and the id; nothing else the caller wrote survives.
  assert.equal(exempt('http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail?x=1#f'), 'http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail');
});

test('nothing else on the network is', () => {
  // Reintroduce by matching on "is this a private address" instead of "is this the configured origin":
  // every one of these passes, and the cover proxy is a Docker-network scanner again.
  for (const u of [
    'http://yomi-db:5432/',                       // the database, on the same compose network
    'http://169.254.169.254/latest/meta-data/',   // cloud instance metadata
    'http://127.0.0.1:8191/v1',                   // the solver, on loopback
    'http://192.168.1.1/',                        // something else on the operator's LAN
    'http://10.0.0.5/admin',                      // ditto
  ]) {
    assert.equal(onEngineOrigin(u), false, `${u} must never be exempted`);
  }
});

test('a near-miss on the engine origin is not the engine', () => {
  // Origin is scheme + host + PORT. An attacker who can name the host must not inherit the exemption for
  // every port on it, and https:// is a different origin from http:// even for the same name.
  assert.equal(onEngineOrigin('http://yomi-suwayomi:5432/'), false, 'a different port is a different origin');
  assert.equal(onEngineOrigin('https://yomi-suwayomi:4567/'), false, 'a different scheme is a different origin');
  assert.equal(onEngineOrigin('http://yomi-suwayomi.evil.com:4567/'), false, 'a suffix is not the host');
  assert.equal(onEngineOrigin('http://evil.com/?x=http://yomi-suwayomi:4567/'), false, 'nor is a query string');
});

test('a value that is not a URL is never the engine', () => {
  for (const u of ['', 'not a url', '/relative/path.png', 'javascript:alert(1)', 'file:///etc/passwd']) {
    assert.equal(onEngineOrigin(u), false);
  }
});

test('with no engine configured, nothing is exempt', () => {
  // Reintroduce by dropping the `want !== null` check: an unconfigured engine and an unparseable URL both
  // yield null, null === null, and every malformed value on the internet becomes exempt.
  assert.equal(isEngineOrigin('http://yomi-suwayomi:4567/x', ''), false);
  assert.equal(isEngineOrigin('http://yomi-suwayomi:4567/x', undefined as never), false);
  assert.equal(isEngineOrigin('not a url', ''), false, 'two unparseable values must not compare equal');
  assert.equal(exempt('http://yomi-suwayomi:4567/api/v1/manga/1/thumbnail', ''), null, 'not even a well-shaped thumbnail');
});

test('the thumbnail shape never exempts a host that is not the engine', () => {
  // Shape is the second check, not a substitute for the first: a well-shaped path on the database, the
  // metadata service or a LAN host is still refused, and so is the engine's host on another port or scheme.
  for (const u of [
    'http://yomi-db:5432/api/v1/manga/1/thumbnail',
    'http://169.254.169.254/api/v1/manga/1/thumbnail',
    'http://yomi-suwayomi:5432/api/v1/manga/1/thumbnail',
    'https://yomi-suwayomi:4567/api/v1/manga/1/thumbnail',
  ]) {
    assert.equal(exempt(u), null, `${u} must never be exempted`);
  }
});
