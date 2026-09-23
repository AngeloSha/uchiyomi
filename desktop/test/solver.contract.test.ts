// Contract tests for the desktop solver's HTTP API (design-shell.md §3.2), with NO browser: a fake backend
// stands in for browser.ts so every byte on the wire can be held against the two real clients.
//
//   - the bff: its REAL client module (bff/src/lib/sources/flaresolverr.ts) and its REAL madara + manganato
//     engines are imported and pointed at this server, so "the bff parses it" is the bff's code saying so;
//   - Suwayomi: the response is decoded by a strict port of kotlinx.serialization's rules, driven by the
//     verbatim DTOs from CloudflareInterceptor.kt at v2.3.2243 (fixtures/suwayomi-*.kt), with the request
//     bodies both clients really send (fixtures/solver-requests.json, from the live FlareSolverr's log).
//
// Run: cd desktop-spike-solver && node --import tsx --test ../desktop/test/solver.contract.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSolverServer, type SolverServer } from '../src/solver/server';
import { MSG, SolveError, pySeconds, type SolverBackend, type SolveRequest, type SolveResult } from '../src/solver/protocol';
import * as detect from '../src/solver/detect';
import { chromeShaped, parseUaMode, greaseBrands, secChUa, chPlatform } from '../src/solver/userAgent';

const FIX = join(__dirname, 'fixtures');
const REQ = JSON.parse(readFileSync(join(FIX, 'solver-requests.json'), 'utf8'));
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36';

// ---- the fake browser ----------------------------------------------------------------------------------

type Handler = (r: SolveRequest) => Promise<SolveResult> | SolveResult;
class FakeBackend implements SolverBackend {
  seen: SolveRequest[] = [];
  handler: Handler = (r) => page(r.url, '<html><head><title>ok</title></head><body>ok</body></html>');
  inFlight = 0;
  maxInFlight = 0;
  sessions = new Set<string>();
  async solve(r: SolveRequest): Promise<SolveResult> {
    this.seen.push(r);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try { return await this.handler(r); } finally { this.inFlight--; }
  }
  async sessionsCreate(n: string) { const fresh = !this.sessions.has(n); this.sessions.add(n); return fresh; }
  sessionsList() { return [...this.sessions]; }
  async sessionsDestroy(n: string) { return this.sessions.delete(n); }
  userAgent() { return UA; }
}

const cookie = (name: string, value: string, domain = '.madara.test') => ({
  name, value, domain, path: '/', expires: 1790000000.5, size: name.length + value.length,
  httpOnly: true, secure: true, session: false, sameSite: 'None' as const,
});
function page(url: string, html: string, extra: Partial<SolveResult> = {}): SolveResult {
  return { url, originStatus: 200, response: html, cookies: [cookie('cf_clearance', 'clear-1'), cookie('wpmanga-reading', 'x', 'madara.test')], userAgent: UA, challenged: true, ...extra };
}
/** How Chromium serialises a JSON document's DOM (captured from Electron 44 in solver.electron.test.ts). */
const chromeJson = (obj: unknown) =>
  `<html><head><meta name="color-scheme" content="light dark"><meta charset="utf-8"></head><body><pre>${JSON.stringify(obj).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre><div class="json-formatter-container"></div></body></html>`;

let fake: FakeBackend;
let srv: SolverServer;
let bff: typeof import('../../bff/src/lib/sources/flaresolverr');

before(async () => {
  fake = new FakeBackend();
  srv = await startSolverServer({ backend: fake, token: TOKEN, appVersion: '0.43.0-test' });
  // The bff reads FLARESOLVERR_URL once, at import. A trailing slash on purpose: the bff strips it (flaresolverr.ts:3).
  process.env.FLARESOLVERR_URL = `${srv.url}/`;
  bff = await import('../../bff/src/lib/sources/flaresolverr');
});
after(async () => { await srv.close(); });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.url}/v1`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ---- the bff, with its own code ------------------------------------------------------------------------

test('bff solverPing: GET {FS}/ answers a "ready" msg (flaresolverr.ts:143-152)', async () => {
  const r = await bff.solverPing();
  assert.equal(r.ok, true);
  assert.equal(r.version, 'uchiyomi-desktop-0.43.0-test');
  // Not semver-shaped, so the bff's "solver is out of date" check stays quiet (design-shell.md §3.2).
  assert.doesNotMatch(String(r.version), /^v?\d+\.\d+\.\d+$/);
});

test('bff cfGet sends exactly {cmd,url,maxTimeout:60000} and gets the page back', async () => {
  fake.seen = [];
  const html = await bff.cfGet('https://madara.test/manga/a/');
  assert.match(html, /<title>ok<\/title>/);
  const r = fake.seen[0];
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://madara.test/manga/a/');
  assert.equal(r.maxTimeoutMs, 60000);
  assert.equal(r.postData, undefined);
  assert.equal(r.session, undefined);
  assert.equal(r.returnOnlyCookies, false);
});

test('bff cfPost with an EMPTY body (madara.ts:181) is a POST with postData ""', async () => {
  fake.seen = [];
  await bff.cfPost('https://madara.test/manga/a/ajax/chapters/', '');
  assert.equal(fake.seen[0].method, 'POST');
  assert.equal(fake.seen[0].postData, '');
});

test('bff cfSession: the cookie jar and UA of the last solve for that origin (flaresolverr.ts:52,93-111)', async () => {
  await bff.cfGet('https://madara.test/manga/b/');
  const s = await bff.cfSession('https://madara.test/wp-content/uploads/1.jpg');
  assert.equal(s.cookie, 'cf_clearance=clear-1; wpmanga-reading=x');
  assert.equal(s.userAgent, UA);
});

test('the REAL madara engine lists chapters through the empty-body POST', async () => {
  const { makeMadara } = await import('../../bff/src/lib/sources/engines/madara');
  fake.seen = [];
  fake.handler = (r) => page(r.url, r.method === 'POST'
    ? `<html><head></head><body><ul><li class="wp-manga-chapter"><a href="https://madara.test/manga/some-series/chapter-2/">Chapter 2</a></li><li class="wp-manga-chapter"><a href="https://madara.test/manga/some-series/chapter-1/">Chapter 1</a></li></ul></body></html>`
    : '<html></html>');
  const src = makeMadara({ id: 't', name: 'T', base: 'https://madara.test' });
  const ch = await src.listChapters('https://madara.test/manga/some-series/');
  assert.deepEqual(ch.map((c) => c.number), [1, 2]);
  assert.deepEqual(fake.seen.map((r) => [r.method, r.url, r.postData]), [['POST', 'https://madara.test/manga/some-series/ajax/chapters/', '']]);
});

test("the REAL manganato engine parses Chromium's <pre>-wrapped JSON (manganato.ts:104-106)", async () => {
  const { makeManganato } = await import('../../bff/src/lib/sources/engines/manganato');
  const api = { success: true, data: { chapters: [
    { chapter_name: 'Chapter 2 <b>&amp; "more"</b>', chapter_slug: 'chapter-2', chapter_num: 2, updated_at: '2026-09-01T00:00:00Z' },
    { chapter_name: "Chapter 1 'x'", chapter_slug: 'chapter-1', chapter_num: 1, updated_at: '2026-08-01T00:00:00Z' },
  ], pagination: { total: 2, limit: 200, offset: 0, has_more: false } } };
  fake.seen = [];
  fake.handler = (r) => page(r.url, chromeJson(api));
  const src = makeManganato({ id: 'n', name: 'N', base: 'https://nato.test' });
  const ch = await src.listChapters('https://nato.test/manga/some-slug');
  assert.deepEqual(ch.map((c) => c.number), [1, 2]);
  assert.equal(fake.seen[0].url, 'https://nato.test/api/manga/some-slug/chapters?limit=200&offset=0');
});

test('an empty solved page is still the bff\'s "empty body" throw, carrying the status (flaresolverr.ts:71-79)', async () => {
  fake.handler = (r) => page(r.url, '', { challenged: false });
  await assert.rejects(bff.cfGet('https://madara.test/x'), /flaresolverr: empty body \(HTTP 200\) from madara\.test/);
});

// ---- errors: FlareSolverr's exact words, and the bff diagnoses them the same ----------------------------

test('error wording is FlareSolverr\'s, and sourceDiagnosis files ours exactly where it files the real ones', async () => {
  const { diagnose } = await import('../../bff/src/lib/sourceDiagnosis');
  const facts = (lastError: string) => ({ status: 'blocked' as const, lastError, consecutive: 1, lastOkAt: null, emptyStreak: 0, blockedUntil: null, disabled: false });
  // Real strings from the live FlareSolverr's log (2026-09-13..23: 299 blocked, 122 timeouts).
  const real = {
    blocked: 'flaresolverr: Error: Error solving the challenge. Cloudflare has blocked this request. Probably your IP is banned for this site, check in your web browser.',
    timeout: 'flaresolverr: Error: Error solving the challenge. Timeout after 60.0 seconds.',
  };
  fake.handler = () => { throw new SolveError('blocked', ''); };
  let r = await post(REQ.bffGet);
  assert.equal(r.status, 500);
  let j: any = await r.json();
  assert.equal(`flaresolverr: ${j.message}`, real.blocked);
  await assert.rejects(bff.cfGet('https://madara.test/blocked'), (e: Error) => e.message === real.blocked);
  assert.equal(diagnose(facts(`flaresolverr: ${j.message}`)).code, diagnose(facts(real.blocked)).code);

  fake.handler = (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new SolveError('timeout', ''))));
  r = await post({ ...REQ.bffGet, maxTimeout: 1000 });
  j = await r.json();
  assert.equal(r.status, 500);
  assert.equal(j.message, 'Error: Error solving the challenge. Timeout after 1.0 seconds.');
  assert.equal(pySeconds(60000), '60.0');
  assert.equal(pySeconds(45500), '45.5');
  const ours60 = `flaresolverr: Error: Error solving the challenge. Timeout after ${pySeconds(60000)} seconds.`;
  assert.equal(ours60, real.timeout);
  assert.equal(diagnose(facts(ours60)).code, 'solver_timeout');

  // Our one new sentence must still land in the same class as a timeout.
  fake.handler = () => { throw new SolveError('human', ''); };
  j = await (await post(REQ.bffGet)).json();
  assert.equal(j.message, `Error: Error solving the challenge. ${MSG.humanCheck}`);
  assert.equal(diagnose(facts(`flaresolverr: ${j.message}`)).code, diagnose(facts(real.timeout)).code);
  // Every error envelope carries FlareSolverr's fields.
  for (const k of ['status', 'message', 'startTimestamp', 'endTimestamp', 'version']) assert.ok(k in j, k);
  assert.equal(j.status, 'error');
});

test('a backend that ignores the abort cannot hold the client past maxTimeout + 2 s', async () => {
  fake.handler = () => new Promise(() => {});
  const t = Date.now();
  const r = await post({ ...REQ.bffGet, maxTimeout: 1000 });
  assert.equal(r.status, 500);
  assert.match((await r.json() as any).message, /Timeout after 1\.0 seconds\./);
  assert.ok(Date.now() - t < 4500, `took ${Date.now() - t} ms`);
});

// ---- Suwayomi: strict kotlinx decoding of the verbatim DTOs --------------------------------------------

type KType = { base: string; args: KType[]; nullable: boolean };
interface KField { name: string; json: string; type: KType; hasDefault: boolean }
function parseKType(s: string): KType {
  s = s.trim();
  const nullable = s.endsWith('?');
  if (nullable) s = s.slice(0, -1);
  const m = s.match(/^(\w+)(?:<(.*)>)?$/);
  if (!m) throw new Error(`type ${s}`);
  const args: KType[] = [];
  if (m[2]) {
    let depth = 0, cur = '';
    for (const ch of m[2]) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) { args.push(parseKType(cur)); cur = ''; } else cur += ch;
    }
    args.push(parseKType(cur));
  }
  return { base: m[1], args, nullable };
}
function parseDtos(src: string): Map<string, KField[]> {
  const out = new Map<string, KField[]>();
  for (const m of src.matchAll(/data class (\w+)\(([\s\S]*?)\n\s*\)/g)) {
    const fields: KField[] = [];
    let serialName: string | undefined;
    for (const line of m[2].split('\n')) {
      const sn = line.match(/@SerialName\("([^"]+)"\)/);
      if (sn) { serialName = sn[1]; continue; }
      const f = line.match(/val (\w+): ([^=]+?)(\s*=\s*[^,]+)?,?\s*(\/\/.*)?$/);
      if (!f) continue;
      fields.push({ name: f[1], json: serialName ?? f[1], type: parseKType(f[2]), hasDefault: !!f[3] });
      serialName = undefined;
    }
    out.set(m[1], fields);
  }
  return out;
}
// CRLF-safe: a Windows checkout rewrites the fixture's line endings.
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
const DTOS = parseDtos(fixture('suwayomi-v2.3.2243-FlareSolverDtos.kt'));

/** kotlinx.serialization with ignoreUnknownKeys=true, explicitNulls=false, isLenient=false. Throws like it would. */
function kDecode(v: unknown, t: KType, path: string): void {
  if (v === null || v === undefined) { if (t.nullable) return; throw new Error(`${path}: null for non-null ${t.base}`); }
  switch (t.base) {
    case 'String': if (typeof v !== 'string') throw new Error(`${path}: expected String`); return;
    case 'Boolean': if (typeof v !== 'boolean') throw new Error(`${path}: expected Boolean`); return;
    case 'Int': if (!Number.isInteger(v) || Math.abs(v as number) > 2 ** 31) throw new Error(`${path}: expected Int, got ${v}`); return;
    case 'Long': if (!Number.isSafeInteger(v)) throw new Error(`${path}: expected Long, got ${v}`); return;
    case 'Double': if (typeof v !== 'number') throw new Error(`${path}: expected Double`); return;
    case 'List': if (!Array.isArray(v)) throw new Error(`${path}: expected List`); v.forEach((x, i) => kDecode(x, t.args[0], `${path}[${i}]`)); return;
    case 'Map': if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected Map`); for (const [k, x] of Object.entries(v as object)) kDecode(x, t.args[1], `${path}.${k}`); return;
  }
  const fields = DTOS.get(t.base);
  if (!fields) throw new Error(`unknown type ${t.base}`);
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected object ${t.base}`);
  for (const f of fields) {
    const x = (v as Record<string, unknown>)[f.json];
    if (x === undefined && !f.hasDefault && !f.type.nullable) throw new Error(`${path}.${f.json}: missing required field`);
    kDecode(x, f.type, `${path}.${f.json}`);
  }
}

test('the Kotlin DTO fixture parsed into the fields Suwayomi requires', () => {
  const need = (cls: string) => DTOS.get(cls)!.filter((f) => !f.type.nullable && !f.hasDefault).map((f) => f.json);
  assert.deepEqual(need('FlareSolverResponse'), ['solution', 'status', 'message', 'startTimestamp', 'endTimestamp', 'version']);
  assert.deepEqual(need('FlareSolverSolution'), ['url', 'status', 'cookies', 'userAgent']);
  assert.deepEqual(need('FlareSolverSolutionCookie'), ['name', 'value', 'domain']);
  // and the request: what Suwayomi sends (the fixture's field list is the one Kotlin serialises in order)
  assert.deepEqual(DTOS.get('FlareSolverRequest')!.map((f) => f.json), ['cmd', 'url', 'maxTimeout', 'session', 'session_ttl_minutes', 'cookies', 'returnOnlyCookies', 'proxy', 'postData']);
});

for (const name of ['suwayomiGetWithCookies', 'suwayomiGetNoCookies', 'suwayomiPost'] as const) {
  test(`Suwayomi ${name}: 2xx, decodes strictly, cookies usable, no body when returnOnlyCookies`, async () => {
    fake.seen = [];
    fake.handler = (r) => page(r.url, '<html>should not be sent</html>', { challenged: true });
    const res = await post(REQ[name]);
    assert.equal(res.status, 200); // awaitSuccess() throws on anything else (OkHttpExtensions.kt:119-127)
    const j: any = await res.json();
    kDecode(j, { base: 'FlareSolverResponse', args: [], nullable: false }, '$');
    assert.equal(j.status, 'ok');
    assert.ok(j.solution.status >= 200 && j.solution.status <= 299); // CloudflareInterceptor.kt:246
    assert.equal(j.solution.response, undefined);
    assert.equal(j.solution.userAgent, UA);
    assert.ok(j.solution.cookies.every((c: any) => typeof c.domain === 'string' && c.domain.length));
    const seen = fake.seen[0];
    assert.equal(seen.session, 'suwayomi');
    assert.equal(seen.sessionTtlMinutes, 15);
    assert.deepEqual(seen.cookies, REQ[name].cookies);
    assert.equal(seen.method, name === 'suwayomiPost' ? 'POST' : 'GET');
  });
}

test('Suwayomi "not detected" branch: message contains it (CloudflareInterceptor.kt:67)', async () => {
  fake.handler = (r) => page(r.url, '<html></html>', { challenged: false });
  const j: any = await (await post(REQ.suwayomiGetNoCookies)).json();
  assert.equal(j.message, 'Challenge not detected!');
  assert.ok(j.message.toLowerCase().includes('not detected'));
});

test('solution.status stays 200 whatever the origin said; the truth is in X-Origin-Status', async () => {
  fake.handler = (r) => page(r.url, '<html>404</html>', { originStatus: 404, challenged: false });
  const r = await post(REQ.bffGet);
  const j: any = await r.json();
  assert.equal(j.solution.status, 200);
  assert.equal(r.headers.get('x-origin-status'), '404');
  assert.deepEqual(Object.keys(j.solution), ['url', 'status', 'headers', 'response', 'cookies', 'userAgent']);
  assert.deepEqual(j.solution.headers, {});
});

test('sessions.create / list / destroy in FlareSolverr\'s shapes', async () => {
  let j: any = await (await post({ cmd: 'sessions.create', session: 's1' })).json();
  assert.deepEqual([j.status, j.message, j.session], ['ok', 'Session created successfully.', 's1']);
  j = await (await post({ cmd: 'sessions.create', session: 's1' })).json();
  assert.equal(j.message, 'Session already exists.');
  j = await (await post({ cmd: 'sessions.list' })).json();
  assert.ok(j.sessions.includes('s1'));
  j = await (await post({ cmd: 'sessions.destroy', session: 's1' })).json();
  assert.equal(j.message, 'The session has been removed.');
  const r = await post({ cmd: 'sessions.destroy', session: 's1' });
  assert.equal(r.status, 500);
  assert.equal((await r.json() as any).message, "Error: The session doesn't exist.");
});

// ---- validation and security ----------------------------------------------------------------------------

test('bad commands get FlareSolverr\'s messages', async () => {
  const msg = async (b: unknown) => ((await (await post(b)).json()) as any).message;
  assert.equal(await msg({}), "Error: Request parameter 'cmd' is mandatory.");
  assert.equal(await msg({ cmd: 'nope' }), "Error: Request parameter 'cmd' = 'nope' is invalid.");
  assert.equal(await msg({ cmd: 'request.get' }), "Error: Request parameter 'url' is mandatory in 'request.get' command.");
  assert.equal(await msg({ cmd: 'request.post', url: 'https://a.test/' }), "Error: Request parameter 'postData' is mandatory in 'request.post' command.");
  assert.equal(await msg('{not json'), 'Error: Request body is not valid JSON.');
});

test('only http(s) targets reach the browser', async () => {
  fake.seen = [];
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://gpu', 'data:text/html,hi', 'ftp://x.test/']) {
    const r = await post({ cmd: 'request.get', url });
    assert.equal(r.status, 500, url);
  }
  assert.equal(fake.seen.length, 0);
});

test('the token is required, compared exactly, and nothing else is served', async () => {
  const base = srv.url.replace(`/${TOKEN}`, '');
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/v1`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/${TOKEN.slice(0, -1)}1/`)).status, 404);
  assert.equal((await fetch(`${srv.url}/health`)).status, 200);
  assert.equal((await fetch(`${srv.url}/v1`)).status, 405);
  assert.equal((await fetch(`${srv.url}/nope`)).status, 404);
});

test('Host must be 127.0.0.1:<port> (DNS rebinding), any Origin is refused (CSRF)', async () => {
  const http = await import('node:http');
  const raw = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: `/${TOKEN}/`, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await raw({ host: `localhost:${srv.port}` }), 421);
  assert.equal(await raw({ host: `evil.test:${srv.port}` }), 421);
  assert.equal(await raw({ host: `127.0.0.1:${srv.port}`, origin: 'https://evil.test' }), 403);
  assert.equal(await raw({ host: `127.0.0.1:${srv.port}`, origin: 'null' }), 403);
  assert.equal(await raw({ host: `127.0.0.1:${srv.port}` }), 200);
});

test('a body over 1 MB is refused before parsing', async () => {
  const big = JSON.stringify({ cmd: 'request.post', url: 'https://a.test/', postData: 'x'.repeat(1024 * 1024) });
  const r = await post(big);
  assert.equal(r.status, 413);
});

test('concurrency: 4 session-less solves at once, Suwayomi gets its own 5th slot, a wedged solve gives its slot back', async () => {
  // Its own server: the shared fake above has a deliberately wedged solve from the abort test.
  const gate: Array<() => void> = [];
  let inFlight = 0, maxInFlight = 0, wedge = true;
  const backend: SolverBackend = {
    solve: (r) => {
      if (r.url.endsWith('/wedged') && wedge) { wedge = false; return new Promise(() => {}); } // never settles
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => gate.push(() => { inFlight--; resolve(page(r.url, '<html>x</html>')); }));
    },
    sessionsCreate: async () => true, sessionsList: () => [], sessionsDestroy: async () => true, userAgent: () => UA,
  };
  const s2 = await startSolverServer({ backend, token: TOKEN, appVersion: 't' });
  const p2 = (b: unknown) => fetch(`${s2.url}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const wedged = await p2({ ...REQ.bffGet, url: 'https://madara.test/wedged', maxTimeout: 1000 });
    assert.equal(wedged.status, 500); // after 1 s + the 2 s grace
    const calls = Array.from({ length: 6 }, (_, i) => p2({ ...REQ.bffGet, url: `https://madara.test/p${i}` }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(inFlight, 4, 'the wedged solve must not still hold a slot');
    const suwa = p2(REQ.suwayomiGetNoCookies);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(inFlight, 5);
    for (let k = 0; k < 200 && (inFlight > 0 || gate.length); k++) { gate.shift()?.(); await new Promise((r) => setTimeout(r, 20)); }
    const all = await Promise.all([...calls, suwa]);
    assert.ok(all.every((r) => r.status === 200));
    assert.equal(maxInFlight, 5);
  } finally {
    await s2.close();
  }
});

// ---- the pure pieces -----------------------------------------------------------------------------------

test("detection lists are FlareSolverr 3.5.2's, verbatim", () => {
  const py = fixture('flaresolverr-3.5.2-detection-lists.py');
  const list = (name: string) => {
    const body = py.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\n\\]`))![1];
    return [...body.replace(/^\s*#.*$/gm, '').matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  };
  assert.deepEqual(detect.ACCESS_DENIED_TITLES, list('ACCESS_DENIED_TITLES'));
  assert.deepEqual(detect.ACCESS_DENIED_SELECTORS, list('ACCESS_DENIED_SELECTORS'));
  assert.deepEqual(detect.CHALLENGE_TITLES, list('CHALLENGE_TITLES'));
  assert.deepEqual(detect.CHALLENGE_SELECTORS, list('CHALLENGE_SELECTORS'));
  assert.deepEqual(detect.TURNSTILE_SELECTORS, list('TURNSTILE_SELECTORS'));
});

test('detection semantics: title startsWith for blocks, case-insensitive equality for challenges', () => {
  const p = (title: string, extra: Partial<detect.Probe> = {}): detect.Probe => ({ title, href: '', readyState: 'complete', denied: [], challenge: [], turnstile: [], ...extra });
  assert.equal(detect.isAccessDenied(p('Access denied | madara.test used Cloudflare to restrict access')), true);
  assert.equal(detect.isAccessDenied(p('Attention Required! | Cloudflare')), true);
  assert.equal(detect.isChallenge(p('Just a moment...')), true);
  assert.equal(detect.isChallenge(p('just a moment...')), true);
  assert.equal(detect.isChallenge(p('Just a moment... please')), false);
  assert.equal(detect.isChallenge(p('Chapter 1', { challenge: ['.lds-ring'] })), true);
  assert.equal(detect.challengeReason(p('x', { challenge: ['#challenge-spinner'] })), 'selector:#challenge-spinner');
});

test('UA mode B removes the Electron and app tokens and nothing else', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Uchiyomi/0.43.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36';
  assert.equal(chromeShaped(win), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Uchiyomi/0.43.0 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36';
  assert.equal(chromeShaped(mac), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36');
  assert.equal(chromeShaped(chromeShaped(win)), chromeShaped(win));
  assert.equal(parseUaMode('A'), 'native');
  assert.equal(parseUaMode('b'), 'chrome');
});

test('Sec-CH-UA the solver adds matches what Electron 44 (Chromium 152) reports in navigator.userAgentData', () => {
  // Measured through the solver on an HTTPS page: brands [{"Not?A_Brand","24"},{"Chromium","152"}], and no
  // Sec-CH-UA request headers at all from Electron itself (httpbin.org/headers).
  assert.deepEqual(greaseBrands(152), [{ brand: 'Not?A_Brand', version: '24' }, { brand: 'Chromium', version: '152' }]);
  assert.equal(secChUa(greaseBrands(152)), '"Not?A_Brand";v="24", "Chromium";v="152"');
  assert.deepEqual([chPlatform('win32'), chPlatform('darwin'), chPlatform('linux')], ['Windows', 'macOS', 'Linux']);
});
