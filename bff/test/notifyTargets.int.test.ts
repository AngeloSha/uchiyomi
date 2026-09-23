// Notification targets (v0.43.0, #70), through the real routes and the real database.
//
// The routes are mounted as server.ts mounts them -- root rate limiter, `trustProxy: true`, the same error
// handler (logs a 5xx error whole, answers a 4xx with its message) -- behind a Fastify logger whose every line
// this test keeps. Each target posts to a real listener on loopback. What is proved here:
//
//   * the address and the token go in and never come out: not in an answer, not in a log line, not in an
//     audit row, not in plain text in the table -- after create, update, test and a failed send;
//   * Test takes a saved id, never an address, and is five a minute PER ADMIN whatever X-Forwarded-For says;
//   * the tenth failure in a row switches a target off and tells the admins exactly once;
//   * a health notice reaches a target on an install where web push is off;
//   * one sweep sends ONE digest per target, a person's target hears only about their favourites, and a sweep
//     that landed nothing sends nothing;
//   * a stored token or ntfy topic never follows the address to another host (a reveal by another name);
//   * the digest leaves 18+ libraries out unless the target opts in, and a person's target never names a series
//     outside their libraries or above their age cap, favourite or not;
//   * a scraped title cannot plant a masked link in a Discord channel.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  // ⚠️ A /config that cannot be written: env.ts then cannot generate VAPID keys and web push is OFF, which is
  // the install the health fan-out exists for. Asserted below, so the premise cannot silently change.
  // ⚠️ Under a regular FILE, not under /proc: `mkdirSync(dir, { recursive: true })` on /proc answers ENOENT
  // for ever and env.ts never finishes loading -- the whole file hung with no output at all. A path whose
  // parent is a file fails at once with ENOTDIR.
  const blocker = join(mkdtempSync(join(tmpdir(), 'notify-test-')), 'not-a-directory');
  writeFileSync(blocker, '');
  process.env.CONFIG_DIR = join(blocker, 'config');
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  process.env.LIBRARY_BACKEND = 'owned';
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';

// Every secret in this file contains SEKRIT, so one search finds any of them anywhere.
const TOKEN = 'SEKRIT-bearer-7f3a';
const HA_TOKEN = 'SEKRIT-ha-llat-91c2';
const DISCORD_URL = 'https://discord.com/api/webhooks/1234567890/SEKRIT-discord-token_x9';
const TOPIC = 'SEKRIT_topic_42';
const WEBHOOK_PATH = '/hook/SEKRIT-path-uuid';

interface Hit { url: string; headers: IncomingMessage['headers']; body: string }
interface Listener { server: Server; base: string; hits: Hit[] }
const listeners: Listener[] = [];
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, res) => { res.writeHead(200); res.end('{"upstream":"SEKRIT-upstream-body"}'); }): Promise<Listener> {
  const l = { hits: [] as Hit[] } as Listener;
  l.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { l.hits.push({ url: req.url || '', headers: req.headers, body }); handler(req, res); });
  });
  await new Promise<void>((r) => l.server.listen(0, '127.0.0.1', r));
  l.base = `http://127.0.0.1:${(l.server.address() as { port: number }).port}`;
  listeners.push(l);
  return l;
}
after(async () => {
  for (const l of listeners) await new Promise<void>((r) => { l.server.closeAllConnections?.(); l.server.close(() => r()); });
  if (DSN) await (await import('../src/lib/db')).pool.end().catch(() => {});
});

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh app per test: its own rate-limit store, its own captured log. */
async function app() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const rateLimit = (await import('@fastify/rate-limit')).default;
  const notifyRoutes = (await import('../src/routes/notify')).default;
  await migrate();
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  const a = Fastify({ logger: { level: 'debug', stream }, trustProxy: true });
  // server.ts's handler, in the part that matters here: a 5xx error is logged whole, a 4xx answers its message.
  a.setErrorHandler((err, req, reply) => {
    const status = (err as any).statusCode || 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal' : (err as Error).message || 'error' });
  });
  await a.register(jwt, { secret: process.env.JWT_SECRET! });
  await a.register(rateLimit, { global: false });
  await a.register(notifyRoutes);
  await a.ready();
  const user = async (name: string, role: 'admin' | 'user') => {
    await q('DELETE FROM users WHERE username = $1', [name]);
    const r = await q<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', $2, 'password') RETURNING id`, [name, role]);
    return { id: r[0].id, auth: { authorization: `Bearer ${a.jwt.sign({ sub: r[0].id, role })}` } };
  };
  return { a, q, logs, user };
}

async function clean(q: (t: string, p?: any[]) => Promise<any[]>) {
  await q('DELETE FROM notify_targets');
  await q(`DELETE FROM audit_log WHERE event LIKE 'notify.%'`);
}

test('only an admin can list, create or test notification targets', { skip }, async () => {
  const { a, q, user } = await app();
  try {
    await clean(q);
    const reader = await user('nt-reader', 'user');
    assert.equal((await a.inject({ method: 'GET', url: '/api/admin/notify-targets' })).statusCode, 401);
    assert.equal((await a.inject({ method: 'GET', url: '/api/admin/notify-targets', headers: reader.auth })).statusCode, 403);
    const r = await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: reader.auth, payload: { kind: 'webhook', name: 'x', url: 'http://10.0.0.5/' } });
    assert.equal(r.statusCode, 403);
    assert.equal((await q('SELECT 1 FROM notify_targets')).length, 0);
  } finally { await a.close(); }
});

test('THE ADDRESS AND THE TOKEN NEVER COME OUT: not in an answer, a log line, an audit row, or the table in clear', { skip }, async () => {
  // Reintroduce by auditing the create with `detail: b` (the settings PATCH's house style): the audit rows
  // carry the token and the Discord URL, and the audit assertion below names them.
  const { a, q, logs, user } = await app();
  const noisy: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...args: unknown[]) => { noisy.push(args.map(String).join(' ')); };
  try {
    await clean(q);
    const admin = await user('nt-admin-secrets', 'admin');
    const ok = await listen();
    const failing = await listen((_q, res) => { res.writeHead(500); res.end('SEKRIT-upstream-500'); });
    const answers: string[] = [];
    const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
      const r = await a.inject({ method, url, headers: admin.auth, ...(payload ? { payload } : {}) });
      answers.push(r.body);
      return r;
    };

    const made = [
      await call('POST', '/api/admin/notify-targets', { kind: 'webhook', name: 'n8n', url: `${ok.base}${WEBHOOK_PATH}`, token: TOKEN }),
      await call('POST', '/api/admin/notify-targets', { kind: 'home_assistant', name: 'HA', url: `${ok.base}/`, token: HA_TOKEN, service: 'notify.mobile_app_phone' }),
      await call('POST', '/api/admin/notify-targets', { kind: 'ntfy', name: 'phone', url: ok.base, topic: TOPIC }),
      await call('POST', '/api/admin/notify-targets', { kind: 'discord', name: 'Discord', url: DISCORD_URL }),
      await call('POST', '/api/admin/notify-targets', { kind: 'webhook', name: 'broken', url: `${failing.base}${WEBHOOK_PATH}`, token: TOKEN }),
    ];
    for (const r of made) assert.equal(r.statusCode, 201, r.body);
    const [wh, ha, , dc, broken] = made.map((r) => r.json());
    assert.equal(wh.target, `${ok.base}/…`);
    assert.equal(wh.hasToken, true);
    assert.equal(dc.target, 'https://discord.com/…');
    assert.equal(ha.service, 'notify.mobile_app_phone');

    // A malformed Discord URL is refused with a fixed sentence -- never echoed, never logged as a 5xx.
    const malformed = await call('POST', '/api/admin/notify-targets', { kind: 'discord', name: 'bad', url: 'https://discord.com/api/webhooks/1/SEKRIT-malformed%zz[' });
    assert.equal(malformed.statusCode, 400);
    // ⚠️ That one PARSES (WHATWG keeps `%zz[` in a path), so it proves only the Discord rule. These make
    // `new URL()` THROW, and Node's ERR_INVALID_URL carries the whole input in `input`, which the global
    // handler's 5xx log copies. Judged after the leak check below, so a regression names the leak first.
    // Reintroduce by parsing unguarded in guard.ts `safeUrl` (`u = new URL(raw.trim())`): the app log carries
    // the SEKRIT address and "a secret reached the app log" fails.
    const throwing = [
      await call('POST', '/api/admin/notify-targets', { kind: 'webhook', name: 'bad', url: 'http://[SEKRIT-bad-ipv6/x' }),
      await call('POST', '/api/admin/notify-targets', { kind: 'discord', name: 'bad', url: 'https://discord.com:SEKRIT/api/webhooks/1/x' }),
      await call('PATCH', `/api/admin/notify-targets/${wh.id}`, { url: 'http://[SEKRIT-bad-ipv6/y' }),
    ];
    // Update: a new token, and a new Discord address.
    assert.equal((await call('PATCH', `/api/admin/notify-targets/${wh.id}`, { token: `${TOKEN}-rotated` })).statusCode, 200);
    assert.equal((await call('PATCH', `/api/admin/notify-targets/${dc.id}`, { url: `${DISCORD_URL}-2`, name: 'Discord 2' })).statusCode, 200);
    // Test a working target and a failing one; the failing one also through the counting path a sweep uses.
    const tested = await call('POST', `/api/admin/notify-targets/${wh.id}/test`);
    assert.deepEqual(tested.json(), { ok: true, status: 200, reason: 'ok' });
    assert.equal(ok.hits.at(-1)!.headers.authorization, `Bearer ${TOKEN}-rotated`, 'the re-entered token is the one sent');
    const failed = await call('POST', `/api/admin/notify-targets/${broken.id}/test`);
    assert.deepEqual(failed.json(), { ok: false, status: 500, reason: 'server_error' }, 'a reason, never the upstream body');
    const { deliver, getTarget } = await import('../src/lib/notify');
    await deliver((await getTarget(broken.id))!, { event: 'health', title: 't', message: 'm', count: 0, series: [] }, { retry: false });
    await call('GET', '/api/admin/notify-targets');

    const audit = await q<{ event: string; detail: string }>(`SELECT event, detail::text AS detail FROM audit_log WHERE event LIKE 'notify.%'`);
    assert.ok(audit.some((r) => r.event === 'notify.target.create') && audit.some((r) => r.event === 'notify.target.update') && audit.some((r) => r.event === 'notify.target.test'),
      'the create, update and test must each be audited');
    const table = await q<{ row: string }>('SELECT row_to_json(t)::text AS row FROM notify_targets t');
    const where: Array<[string, string[]]> = [
      ['an API answer', answers], ['the app log', logs], ['the console', noisy],
      ['audit_log.detail', audit.map((r) => r.detail)], ['notify_targets in clear', table.map((r) => r.row)],
    ];
    for (const [place, texts] of where) {
      const leaks = texts.filter((t) => t.includes('SEKRIT'));
      assert.deepEqual(leaks, [], `a secret reached ${place}`);
    }
    assert.ok(logs.length > 0, 'the log capture caught nothing -- the assertion above would be vacuous');
    for (const r of throwing) {
      assert.equal(r.statusCode, 400, 'an address that does not parse is a 400, not a 500');
      assert.deepEqual(r.json(), { error: 'bad_url', message: 'That address is not a valid http(s) URL' });
    }
  } finally {
    Object.assign(console, orig);
    await a.close();
  }
});

test('Test takes a saved id, never an address, and a bad id is simply not found', { skip }, async () => {
  const { a, q, user } = await app();
  try {
    await clean(q);
    const admin = await user('nt-admin-ids', 'admin');
    const saved = await listen();
    const named = await listen();
    const t = (await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload: { kind: 'webhook', name: 'w', url: `${saved.base}/hook` } })).json();
    const r = await a.inject({ method: 'POST', url: `/api/admin/notify-targets/${t.id}/test`, headers: admin.auth, payload: { url: `${named.base}/probe`, kind: 'webhook' } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(named.hits, [], 'an address in the body was used');
    assert.equal(saved.hits.length, 1);
    assert.equal((await a.inject({ method: 'POST', url: '/api/admin/notify-targets/00000000-0000-4000-8000-000000000000/test', headers: admin.auth })).statusCode, 404);
    assert.equal((await a.inject({ method: 'POST', url: '/api/admin/notify-targets/not-a-uuid/test', headers: admin.auth })).statusCode, 404);
  } finally { await a.close(); }
});

test('SIX TESTS IN A MINUTE FROM ONE ADMIN, EACH FROM A NEW X-FORWARDED-FOR: THE SIXTH IS REFUSED', { skip }, async () => {
  // trustProxy makes req.ip the leftmost X-Forwarded-For entry, which the client writes. Reintroduce by
  // dropping `keyGenerator` (the limiter then keys on req.ip): all six answer 200.
  const { a, q, user } = await app();
  try {
    await clean(q);
    const admin = await user('nt-admin-limit', 'admin');
    const l = await listen();
    const t = (await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload: { kind: 'webhook', name: 'w', url: `${l.base}/hook` } })).json();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await a.inject({ method: 'POST', url: `/api/admin/notify-targets/${t.id}/test`, headers: { ...admin.auth, 'x-forwarded-for': `9.9.9.${i}, 203.0.113.7` } });
      codes.push(r.statusCode);
    }
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    assert.equal(l.hits.length, 5, 'the refused Test must not have sent anything');
  } finally { await a.close(); }
});

test('THE TENTH FAILURE SWITCHES A TARGET OFF AND TELLS THE ADMINS ONCE; switching it back on gives ten more tries', { skip }, async () => {
  // Reintroduce by notifying whenever `consecutive_failures >= 10` instead of on the on→off edge in
  // recordFailure: the eleventh failure sends a second notice and `notices` below counts two.
  const { a, q, user } = await app();
  try {
    await clean(q);
    const admin = await user('nt-admin-off', 'admin');
    const dead = await listen((_q, res) => { res.writeHead(503); res.end(); });
    const watcher = await listen();
    const post = (payload: object) => a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload }).then((r) => r.json());
    const t = await post({ kind: 'webhook', name: 'Dead hook', url: `${dead.base}/hook`, events: ['new_chapters'] });
    await post({ kind: 'webhook', name: 'Watcher', url: `${watcher.base}/w`, events: ['health'] });
    await q('UPDATE notify_targets SET consecutive_failures = 9 WHERE id = $1', [t.id]);
    const { deliver, getTarget } = await import('../src/lib/notify');
    const msg = { event: 'new_chapters' as const, title: 't', message: 'm', count: 1, series: [] };
    await deliver((await getTarget(t.id))!, msg, { retry: false });
    let row = (await getTarget(t.id))!;
    assert.equal(row.enabled, false, 'the tenth failure must switch it off');
    assert.equal(row.consecutive_failures, 10);
    assert.equal(row.last_error, 'server_error');
    const notices = () => watcher.hits.filter((h) => JSON.parse(h.body).title === 'A notification target was switched off');
    await until(() => notices().length === 1, 'the switch-off notice');
    assert.match(JSON.parse(notices()[0].body).message, /"Dead hook" failed 10 times in a row/);
    // Still failing while off (a Test counts nothing; this is the counting path): no second notice.
    await deliver((await getTarget(t.id))!, msg, { retry: false });
    await sleep(1500);
    assert.equal(notices().length, 1, 'a target that stays off must not be announced again');
    assert.equal((await getTarget(t.id))!.consecutive_failures, 11);
    // The admin fixes it and switches it back on: a fresh count.
    const back = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth, payload: { enabled: true } });
    assert.equal(back.json().enabled, true);
    assert.equal(back.json().consecutiveFailures, 0);
    // A failed Test is shown but does not count towards switching off.
    await a.inject({ method: 'POST', url: `/api/admin/notify-targets/${t.id}/test`, headers: admin.auth });
    row = (await getTarget(t.id))!;
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.last_error, 'server_error');
  } finally { await a.close(); }
});

test('A HEALTH NOTICE REACHES A TARGET ON AN INSTALL WITHOUT PUSH -- and only admins\' targets hear it', { skip }, async () => {
  // Reintroduce by moving the fan-out in push.ts's notifyAdmins below `if (!enabled) return;`: the target
  // never receives the notice and `until` gives up.
  const { a, q, user } = await app();
  try {
    await clean(q);
    const { pushEnabled, notifyAdmins } = await import('../src/lib/push');
    assert.equal(pushEnabled(), false, 'the premise: web push is OFF on this install');
    const admin = await user('nt-admin-health', 'admin');
    const reader = await user('nt-reader-health', 'user');
    const server = await listen();
    const readers = await listen();
    const chaptersOnly = await listen();
    const post = (payload: object) => a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload });
    await post({ kind: 'webhook', name: 'ops', url: `${server.base}/ops`, events: ['health'] });
    await post({ kind: 'webhook', name: 'reader', url: `${readers.base}/r`, events: ['health', 'new_chapters'], userId: reader.id });
    await post({ kind: 'webhook', name: 'chapters', url: `${chaptersOnly.base}/c`, events: ['new_chapters'] });
    await notifyAdmins('Cloudflare solver needs attention', 'FlareSolverr stopped answering');
    await until(() => server.hits.length === 1, 'the health notice at the server-wide target');
    assert.deepEqual(JSON.parse(server.hits[0].body), { event: 'health', title: 'Cloudflare solver needs attention', message: 'FlareSolverr stopped answering', count: 0, series: [] });
    await sleep(300);
    assert.deepEqual(readers.hits, [], 'a target aimed at a reader heard an admin notice');
    assert.deepEqual(chaptersOnly.hits, [], 'a target that did not ask for health heard it');
  } finally { await a.close(); }
});

test('ONE SWEEP, THREE SERIES, ONE MESSAGE PER TARGET -- a person hears only their favourites, an empty sweep says nothing', { skip }, async () => {
  // Reintroduce by delivering once per series in sendDigest: the server-wide target counts three messages.
  const { a, q, user } = await app();
  const S = ['s_nt_one', 's_nt_two', 's_nt_three'];
  try {
    await clean(q);
    const admin = await user('nt-admin-digest', 'admin');
    const reader = await user('nt-reader-digest', 'user');
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [S]);
    for (const id of S) await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1, 'T!nt', $1, $2)`, [id, `T!nt/${id}`]);
    await q('INSERT INTO favorites (user_id, series_id) VALUES ($1, $2)', [reader.id, S[1]]);
    const all = await listen();
    const mine = await listen();
    const healthOnly = await listen();
    const off = await listen();
    const post = (payload: object) => a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload });
    await post({ kind: 'webhook', name: 'all', url: `${all.base}/all`, template: '{count} new in {series}: {list}' });
    await post({ kind: 'webhook', name: 'mine', url: `${mine.base}/mine`, userId: reader.id });
    await post({ kind: 'webhook', name: 'health', url: `${healthOnly.base}/h`, events: ['health'] });
    await post({ kind: 'webhook', name: 'off', url: `${off.base}/off`, enabled: false });

    const { runSweep } = await import('../src/lib/updater');
    const log = { info() {}, warn() {}, error() {} };
    const result = (newChapters: Array<{ id: string; title: string; added: number }>) => async () => ({
      series: 3, visited: 3, added: newChapters.reduce((n, s) => n + s.added, 0), failed: 0, chapterFailures: 0, capped: 0,
      outcomes: { ok: 3, gone: 0, unrouted: 0, blocked: 0, source_error: 0, threw: 0, skipped: 0 }, healthy: true,
      switched: 0, partial: 0, completed: 0, newChapters,
    });
    const run = runSweep({}, log, result([
      { id: S[0], title: 'Solo Leveling', added: 3 }, { id: S[1], title: 'Omniscient Reader', added: 1 }, { id: S[2], title: 'Tower of God', added: 2 },
    ]));
    assert.ok(run, 'the sweep refused to start');
    await run;
    await until(() => all.hits.length >= 1 && mine.hits.length >= 1, 'the digest');
    await sleep(1500);
    assert.equal(all.hits.length, 1, 'the server-wide target must get ONE message for the whole sweep');
    // The title is the server's name; another test file in the same run may have renamed it.
    const title = (await q<{ n: string }>('SELECT server_name AS n FROM server_settings WHERE id = 1'))[0]?.n?.trim() || 'Uchiyomi';
    assert.deepEqual(JSON.parse(all.hits[0].body), {
      event: 'new_chapters', title, message: '6 new in 3 series: Solo Leveling, Omniscient Reader, Tower of God', count: 6,
      series: [{ id: S[0], title: 'Solo Leveling', added: 3 }, { id: S[1], title: 'Omniscient Reader', added: 1 }, { id: S[2], title: 'Tower of God', added: 2 }],
    });
    assert.equal(mine.hits.length, 1);
    const personal = JSON.parse(mine.hits[0].body);
    assert.equal(personal.message, '1 new chapter in Omniscient Reader', 'a person\'s target carries only their favourites');
    assert.deepEqual(personal.series.map((s: { id: string }) => s.id), [S[1]]);
    assert.deepEqual(healthOnly.hits, [], 'a health-only target heard the digest');
    assert.deepEqual(off.hits, [], 'a switched-off target heard the digest');

    const quiet = runSweep({}, log, result([]));
    assert.ok(quiet);
    await quiet;
    await sleep(800);
    assert.equal(all.hits.length, 1, 'a sweep that landed nothing must send nothing');
    assert.equal(mine.hits.length, 1);
  } finally {
    await q('DELETE FROM favorites WHERE series_id = ANY($1)', [S]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [S]).catch(() => {});
    await a.close();
  }
});

test('an undecryptable secret stops the send and the panel says what to do', { skip }, async () => {
  const { a, q, user } = await app();
  try {
    await clean(q);
    const admin = await user('nt-admin-rotated', 'admin');
    const l = await listen();
    const t = (await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload: { kind: 'webhook', name: 'w', url: `${l.base}/hook`, token: TOKEN } })).json();
    // What a lost /config (a regenerated JWT_SECRET) leaves behind: a sealed value nobody can open.
    await q(`UPDATE notify_targets SET secret = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA' WHERE id = $1`, [t.id]);
    const r = await a.inject({ method: 'POST', url: `/api/admin/notify-targets/${t.id}/test`, headers: admin.auth });
    assert.deepEqual(r.json(), { ok: false, status: null, reason: 'secret_unreadable' });
    assert.deepEqual(l.hits, [], 'a target whose secret could not be read was sent a request');
    const listed = (await a.inject({ method: 'GET', url: '/api/admin/notify-targets', headers: admin.auth })).json().targets[0];
    assert.equal(listed.lastError, 'secret_unreadable');
    assert.match(listed.lastErrorMessage, /enter them again/);
    // A new token alone cannot rebuild it -- the address was in the secret too -- so the answer says so.
    const p = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth, payload: { token: 'new' } });
    assert.equal(p.statusCode, 400);
    assert.equal(p.json().error, 'reenter_all');
    const fixed = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth, payload: { url: `${l.base}/hook`, token: 'new' } });
    assert.equal(fixed.statusCode, 200);
    assert.equal(fixed.json().lastError, null);
  } finally { await a.close(); }
});

test('create, rename, delete: the list follows, and delete is audited by name', { skip }, async () => {
  const { a, q, user } = await app();
  try {
    await clean(q);
    const admin = await user('nt-admin-crud', 'admin');
    const reader = await user('nt-reader-crud', 'user');
    const t = (await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload: { kind: 'home_assistant', name: 'HA', url: 'http://homeassistant.local:8123', token: HA_TOKEN, service: 'notify.phone', userId: reader.id } })).json();
    assert.equal(t.userName, 'nt-reader-crud');
    assert.deepEqual(t.events, ['new_chapters', 'health']);
    const renamed = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth, payload: { name: 'Kitchen tablet', events: ['new_chapters'], template: '{count} new', userId: null } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, 'Kitchen tablet');
    assert.equal(renamed.json().userId, null);
    assert.equal(renamed.json().hasToken, true, 'a rename keeps the token');
    const bad = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth, payload: { kind: 'webhook' } });
    assert.equal(bad.statusCode, 400, 'the kind is not editable');
    const badSvc = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth, payload: { service: '../../auth/providers' } });
    assert.equal(badSvc.json().error, 'bad_service');
    assert.equal((await a.inject({ method: 'DELETE', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth })).statusCode, 200);
    assert.equal((await a.inject({ method: 'DELETE', url: `/api/admin/notify-targets/${t.id}`, headers: admin.auth })).statusCode, 404);
    assert.deepEqual((await a.inject({ method: 'GET', url: '/api/admin/notify-targets', headers: admin.auth })).json().targets, []);
    const del = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'notify.target.delete'`);
    assert.deepEqual(del[0].detail, { id: t.id, kind: 'home_assistant', name: 'Kitchen tablet' });
  } finally { await a.close(); }
});

test('A STORED TOKEN NEVER FOLLOWS THE ADDRESS TO ANOTHER HOST -- a new host needs its token, and an ntfy server its topic, typed again', { skip }, async () => {
  // PATCH {url} alone used to merge the stored credential under the new address, so re-pointing a target and
  // pressing Test handed the new host the Home Assistant token -- a reveal of a secret that is "never shown
  // again", with an audit row that said only fields:['url'].
  // Reintroduce by merging old.token when the origin changed: B receives 'Bearer SEKRIT-ha-llat-91c2' and
  // "the stored token reached the new host" names it.
  const { a, q, user } = await app();
  try {
    await clean(q);
    // Two admins, because Test is five a minute per admin and this test presses it six times.
    const admin = await user('nt-admin-moved', 'admin');
    const second = await user('nt-admin-moved-2', 'admin');
    const A = await listen();
    const B = await listen();
    const call = (who: { auth: Record<string, string> }, method: 'POST' | 'PATCH', url: string, payload?: object) =>
      a.inject({ method, url, headers: who.auth, ...(payload ? { payload } : {}) });
    const path = (id: string) => `/api/admin/notify-targets/${id}`;

    // Home Assistant: the address alone is refused, and nothing reaches B.
    const ha = (await call(admin, 'POST', '/api/admin/notify-targets', { kind: 'home_assistant', name: 'HA', url: A.base, token: HA_TOKEN, service: 'notify.phone' })).json();
    const moved = await call(admin, 'PATCH', path(ha.id), { url: B.base });
    await call(admin, 'POST', `${path(ha.id)}/test`);
    assert.deepEqual(B.hits.map((h) => h.headers.authorization), [], 'the stored token reached the new host');
    assert.equal(A.hits.length, 1, 'the refused re-point must leave the target where it was');
    assert.equal(moved.statusCode, 400, 'a new address was accepted with the stored Home Assistant token');
    assert.deepEqual(moved.json(), { error: 'reenter_token', message: 'A new address needs its token typed again' });
    // With the token typed again it moves, and B gets the NEW token.
    const repointed = await call(admin, 'PATCH', path(ha.id), { url: B.base, token: 'fresh' });
    assert.equal(repointed.statusCode, 200, repointed.body);
    await call(admin, 'POST', `${path(ha.id)}/test`);
    assert.equal(B.hits.length, 1);
    assert.equal(B.hits[0].url, '/api/services/notify/phone');
    assert.equal(B.hits[0].headers.authorization, 'Bearer fresh');
    // The audit row of the accepted re-point says where the target points now (the host, never the path).
    const audit = await q<{ detail: any }>(`SELECT detail FROM audit_log WHERE event = 'notify.target.update' AND detail->>'id' = $1 ORDER BY id`, [ha.id]);
    assert.deepEqual(audit.map((r) => r.detail), [{ id: ha.id, fields: ['token', 'url'], host: B.base.replace('http://', '') }],
      'the accepted re-point must record the new host, and a refused one nothing');

    // ntfy: on a public server the topic IS the password, so a new server needs it typed again.
    const nt = (await call(second, 'POST', '/api/admin/notify-targets', { kind: 'ntfy', name: 'phone', url: A.base, topic: TOPIC })).json();
    const ntMoved = await call(second, 'PATCH', path(nt.id), { url: B.base });
    assert.equal(ntMoved.statusCode, 400, 'a new ntfy server was accepted with the stored topic');
    assert.equal(ntMoved.json().error, 'reenter_topic');
    assert.equal((await call(second, 'PATCH', path(nt.id), { url: B.base, topic: 'fresh_topic' })).statusCode, 200);
    await call(second, 'POST', `${path(nt.id)}/test`);
    assert.equal(B.hits.at(-1)!.url, '/fresh_topic');

    // A webhook moved along the SAME host keeps its token: that is not another party.
    const wh = (await call(second, 'POST', '/api/admin/notify-targets', { kind: 'webhook', name: 'n8n', url: `${A.base}/one`, token: TOKEN })).json();
    const samePath = await call(second, 'PATCH', path(wh.id), { url: `${A.base}/two` });
    assert.equal(samePath.statusCode, 200, 'a new path on the same host must keep its token');
    await call(second, 'POST', `${path(wh.id)}/test`);
    assert.equal(A.hits.at(-1)!.url, '/two');
    assert.equal(A.hits.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);
    // To another host: refused without a token, and a token REMOVED on purpose (null) is a choice, not a leak.
    assert.equal((await call(second, 'PATCH', path(wh.id), { url: `${B.base}/x` })).json().error, 'reenter_token');
    assert.equal((await call(second, 'PATCH', path(wh.id), { url: `${B.base}/x`, token: null })).statusCode, 200);
    await call(second, 'POST', `${path(wh.id)}/test`);
    assert.equal(B.hits.at(-1)!.url, '/x');
    assert.equal(B.hits.at(-1)!.headers.authorization, undefined);
    assert.ok(!B.hits.some((h) => JSON.stringify(h).includes('SEKRIT')), 'a stored secret reached the new host');
  } finally { await a.close(); }
});

test('THE DIGEST LEAVES 18+ LIBRARIES OUT UNLESS A TARGET OPTS IN -- and a person\'s target never names what they cannot open', { skip }, async () => {
  // A favourite does not prove access: it can predate an age cap or a revoked grant (and the plain
  // POST /api/favorites stores any id). So a person's target goes through that person's libraries and age cap,
  // which no switch overrides, and every target through the 18+ hide unless it asked for 18+.
  // Reintroduce by dropping the browsableIds filter: the server-wide target names "Adult Title".
  const { a, q, user } = await app();
  const LIBS = ['lib_nt_adult', 'lib_nt_clean'];
  const S = { adult: 's_nt_adult', clean: 's_nt_clean' };
  try {
    await clean(q);
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [Object.values(S)]);
    await q('DELETE FROM libraries WHERE id = ANY($1)', [LIBS]);
    await q(`INSERT INTO libraries (id, name, path, age_rating) VALUES ($1, 'NT adult', '/nt-adult', 18), ($2, 'NT clean', '/nt-clean', NULL)`, LIBS);
    await q(`INSERT INTO lib_series (id, source, title, folder, library_id) VALUES ($1, 'T!nt', 'Adult Title', 'T!nt/adult', $2), ($3, 'T!nt', 'Clean Title', 'T!nt/clean', $4)`,
      [S.adult, LIBS[0], S.clean, LIBS[1]]);
    const admin = await user('nt-admin-adult', 'admin');
    const capped = await user('nt-reader-capped', 'user');
    const granted = await user('nt-reader-granted', 'user');
    await q('UPDATE users SET max_age_rating = 13 WHERE id = $1', [capped.id]);
    await q('INSERT INTO user_libraries (user_id, library_id) VALUES ($1, $2)', [granted.id, LIBS[1]]);
    // Both readers favourited both -- before the cap, before the grant was narrowed.
    for (const u of [capped, granted]) await q('INSERT INTO favorites (user_id, series_id) VALUES ($1, $2), ($1, $3)', [u.id, S.adult, S.clean]);

    const L = { plain: await listen(), adult: await listen(), capped: await listen(), granted: await listen(), adminOwn: await listen() };
    const post = async (payload: object) => {
      const r = await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload });
      assert.equal(r.statusCode, 201, r.body);
      return r.json();
    };
    const plain = await post({ kind: 'webhook', name: 'server', url: `${L.plain.base}/p`, events: ['new_chapters'] });
    const opted = await post({ kind: 'webhook', name: 'server 18+', url: `${L.adult.base}/a`, events: ['new_chapters'], includeAdult: true });
    await post({ kind: 'webhook', name: 'capped', url: `${L.capped.base}/c`, events: ['new_chapters'], userId: capped.id, includeAdult: true });
    await post({ kind: 'webhook', name: 'granted', url: `${L.granted.base}/g`, events: ['new_chapters'], userId: granted.id, includeAdult: true });
    // An admin's own target: no cap and every library, so their 18+ choice alone decides.
    await q('INSERT INTO favorites (user_id, series_id) VALUES ($1, $2), ($1, $3)', [admin.id, S.adult, S.clean]);
    const own = await post({ kind: 'webhook', name: 'admin', url: `${L.adminOwn.base}/o`, events: ['new_chapters'], userId: admin.id });
    // The switch can be turned on later, and is.
    const flipped = await a.inject({ method: 'PATCH', url: `/api/admin/notify-targets/${own.id}`, headers: admin.auth, payload: { includeAdult: true } });

    const { sendDigest } = await import('../src/lib/notify');
    await sendDigest([{ id: S.adult, title: 'Adult Title', added: 2 }, { id: S.clean, title: 'Clean Title', added: 1 }]);
    const named = (l: Listener) => l.hits.flatMap((h) => JSON.parse(h.body).series.map((s: { title: string }) => s.title));
    assert.deepEqual(named(L.plain), ['Clean Title'], 'the server-wide target named an 18+ series without being asked to');
    assert.equal(JSON.parse(L.plain.hits[0].body).message, '1 new chapter in Clean Title', 'the count must not include what was left out');
    assert.deepEqual(named(L.adult), ['Adult Title', 'Clean Title'], 'Include 18+ did not include them');
    assert.deepEqual(named(L.capped), ['Clean Title'], 'a capped reader\'s target named a series above their age limit');
    assert.deepEqual(named(L.granted), ['Clean Title'], 'a reader\'s target named a series in a library they have no grant to');
    assert.deepEqual(named(L.adminOwn), ['Adult Title', 'Clean Title']);
    // The panel sees the choice, off unless asked for.
    assert.equal(plain.includeAdult, false, 'Include 18+ is off unless asked for');
    assert.equal(opted.includeAdult, true);
    assert.equal(flipped.json().includeAdult, true, flipped.body);
  } finally {
    await q('DELETE FROM favorites WHERE series_id = ANY($1)', [Object.values(S)]).catch(() => {});
    await q('DELETE FROM lib_series WHERE id = ANY($1)', [Object.values(S)]).catch(() => {});
    await q('DELETE FROM libraries WHERE id = ANY($1)', [LIBS]).catch(() => {});
    await a.close();
  }
});

test('A SCRAPED TITLE CANNOT PLANT A LINK IN DISCORD: markdown in a title arrives escaped, and only for Discord', { skip }, async () => {
  // Titles come from third-party sites and Discord renders markdown, so "[Chapter 99 is FREE here](https://…)"
  // would be a masked link in the admin's channel. Mentions were already off; this is the same rule for links.
  // Reintroduce by rendering the Discord digest from the raw titles in sendDigest: the masked link arrives intact.
  const { a, q, user } = await app();
  const S = 's_nt_md';
  const EVIL = '[Chapter 99 is FREE here](https://evil.example/login) *now*';
  try {
    await clean(q);
    await q('DELETE FROM lib_series WHERE id = $1', [S]);
    await q(`INSERT INTO lib_series (id, source, title, folder) VALUES ($1, 'T!nt', 'md', 'T!nt/md')`, [S]);
    const admin = await user('nt-admin-md', 'admin');
    const discord = await listen();
    const hook = await listen();
    // A Discord target cannot be saved pointing anywhere but discord.com, so this one is written as the
    // route would store it, with a local stand-in for Discord's address.
    const { sealSecret, sendDigest } = await import('../src/lib/notify');
    await q(`INSERT INTO notify_targets (kind, name, config, secret, events) VALUES ('discord', 'dc', $1::jsonb, $2, ARRAY['new_chapters'])`,
      [JSON.stringify({ display: 'https://discord.com/…' }), sealSecret({ url: `${discord.base}/api/webhooks/1/x` })]);
    await a.inject({ method: 'POST', url: '/api/admin/notify-targets', headers: admin.auth, payload: { kind: 'webhook', name: 'hook', url: `${hook.base}/h`, events: ['new_chapters'] } });
    await sendDigest([{ id: S, title: EVIL, added: 1 }]);
    assert.equal(discord.hits.length, 1);
    const content: string = JSON.parse(discord.hits[0].body).content;
    assert.ok(!content.includes('[Chapter 99 is FREE here](https://evil.example/login)'), `a masked link reached Discord: ${content}`);
    assert.ok(content.endsWith('1 new chapter in \\[Chapter 99 is FREE here\\]\\(https://evil.example/login\\) \\*now\\*'), content);
    // JSON is not markdown: the webhook gets the title exactly as the source spelled it.
    const sent = JSON.parse(hook.hits[0].body);
    assert.equal(sent.message, `1 new chapter in ${EVIL}`);
    assert.equal(sent.series[0].title, EVIL);
  } finally {
    await q('DELETE FROM lib_series WHERE id = $1', [S]).catch(() => {});
    await a.close();
  }
});
