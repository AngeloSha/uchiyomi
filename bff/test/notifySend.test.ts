// Notification targets (v0.43.0, #70): what actually goes over the wire, and what never does.
//
// A real HTTP listener on loopback for every case, and the real send path -- undici's fetch through the
// connection-time lookup in lib/notify/guard.ts. A mock that "returns a 302" or "resolves to 169.254.169.254"
// would only prove the mock was consulted (engineRedirect.test.ts, the precedent). No database: the send path
// is pure, and the one case that goes through `deliver` finds the database unreachable and carries on.
//
// Every guard here names the edit that brings its bug back.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

process.env.DATABASE_URL = 'postgres://x:x@127.0.0.1:1/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';

interface Hit { method: string; url: string; headers: IncomingMessage['headers']; body: string }
interface Listener { server: Server; base: string; port: number; hits: Hit[] }

async function listen(handler: (req: IncomingMessage, res: ServerResponse, l: Listener) => void = (_q, res) => { res.writeHead(200); res.end('ok'); }): Promise<Listener> {
  const l = { hits: [] as Hit[] } as Listener;
  l.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      l.hits.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      handler(req, res, l);
    });
  });
  await new Promise<void>((r) => l.server.listen(0, '127.0.0.1', r));
  l.port = (l.server.address() as { port: number }).port;
  l.base = `http://127.0.0.1:${l.port}`;
  return l;
}
const close = (l: Listener) => new Promise<void>((r) => { l.server.closeAllConnections?.(); l.server.close(() => r()); });

let guard: typeof import('../src/lib/notify/guard');
let kinds: typeof import('../src/lib/notify/kinds');
let send: typeof import('../src/lib/notify/send');
let template: typeof import('../src/lib/notify/template');
let notify: typeof import('../src/lib/notify');
let secretbox: typeof import('../src/lib/secretbox');
/** A listener on the port this "server" believes it listens on, so a self-POST would be SEEN, not assumed. */
let self: Listener;
const opened: Listener[] = [];
const fresh = async (h?: Parameters<typeof listen>[0]) => { const l = await listen(h); opened.push(l); return l; };

const MSG = {
  event: 'new_chapters' as const, title: 'Uchiyomi', message: '4 new chapters in 2 series', count: 4,
  series: [{ id: 's1', title: 'Solo Leveling', added: 3 }, { id: 's2', title: 'Omniscient Reader', added: 1 }],
};

before(async () => {
  self = await listen();
  // ⚠️ Before any import: env.ts parses process.env once, at load.
  process.env.PORT = String(self.port);
  guard = await import('../src/lib/notify/guard');
  kinds = await import('../src/lib/notify/kinds');
  send = await import('../src/lib/notify/send');
  template = await import('../src/lib/notify/template');
  notify = await import('../src/lib/notify');
  secretbox = await import('../src/lib/secretbox');
});
after(async () => {
  await close(self);
  for (const l of opened) await close(l);
  (await import('../src/lib/db')).pool.end().catch(() => {});
});

/** Validate as the create route does, then build and send as the delivery path does. */
async function viaTarget(kind: import('../src/lib/notify/kinds').Kind, input: import('../src/lib/notify/kinds').TargetInput, opts: import('../src/lib/notify/send').SendOptions = {}) {
  const v = kinds.validateTarget(kind, input);
  assert.ok(v.ok, `validation refused a good ${kind} target: ${JSON.stringify(v)}`);
  const req = kinds.buildRequest(kind, v.secret, v.config, MSG);
  assert.ok(req, `no request built for ${kind}`);
  return send.sendRequest(req, opts);
}

// ---------------------------------------------------------------------------------------------------
// Each kind's request, exactly

test('a webhook gets one JSON POST with the digest and the bearer token', async () => {
  const l = await fresh();
  const r = await viaTarget('webhook', { url: `${l.base}/hooks/uchiyomi?k=1`, token: 'wh-token-123' });
  assert.deepEqual(r, { ok: true, status: 200, reason: 'ok' });
  assert.equal(l.hits.length, 1);
  const h = l.hits[0];
  assert.equal(h.method, 'POST');
  assert.equal(h.url, '/hooks/uchiyomi?k=1');
  assert.equal(h.headers.authorization, 'Bearer wh-token-123');
  assert.match(String(h.headers['content-type']), /application\/json/);
  assert.deepEqual(JSON.parse(h.body), { event: 'new_chapters', title: 'Uchiyomi', message: '4 new chapters in 2 series', count: 4, series: MSG.series });
});

test('Home Assistant gets its service path REBUILT from the stored origin, whatever path was typed', async () => {
  const l = await fresh();
  const r = await viaTarget('home_assistant', { url: `${l.base}/lovelace/0?edit=1`, token: 'ha-llat', service: 'notify.mobile_app_pixel_8' });
  assert.equal(r.ok, true);
  assert.equal(l.hits.length, 1);
  assert.equal(l.hits[0].url, '/api/services/notify/mobile_app_pixel_8', 'the typed path must be discarded');
  assert.equal(l.hits[0].headers.authorization, 'Bearer ha-llat');
  assert.deepEqual(JSON.parse(l.hits[0].body), { title: 'Uchiyomi', message: '4 new chapters in 2 series' });
});

test('A HOME ASSISTANT SERVICE THAT IS A PATH IS REFUSED, and a hand-edited one builds no request', async () => {
  // Reintroduce by concatenating `/api/services/notify/${service}` from what was typed: '../../auth/providers'
  // is normalised by URL into /auth/providers on the same origin, with the long-lived token attached.
  for (const service of ['../../auth/providers', 'notify/../../x', 'notify.mobile_app_x?x=', 'Notify.Phone', 'notify']) {
    const v = kinds.validateTarget('home_assistant', { url: 'http://192.168.1.50:8123', token: 't', service });
    assert.equal(v.ok, false, `service ${JSON.stringify(service)} must be refused`);
    assert.equal((v as { error: string }).error, 'bad_service');
  }
  const l = await fresh();
  const req = kinds.buildRequest('home_assistant', { url: l.base, token: 't' }, { display: l.base, service: '../../auth/providers' }, MSG);
  assert.equal(req, null, 'a stored service that fails the grammar must build nothing');
  assert.deepEqual(l.hits, []);
});

test('ntfy gets the text to its topic, the title in a header, and a non-ASCII title does not break the send', async () => {
  const l = await fresh();
  const v = kinds.validateTarget('ntfy', { url: `${l.base}/`, topic: 'uchi_reads-42', token: 'tk_abc' });
  assert.ok(v.ok);
  const r = await send.sendRequest(kinds.buildRequest('ntfy', v.secret, v.config, { ...MSG, title: 'ウチヨミ' })!);
  assert.equal(r.ok, true, `the send failed: ${r.reason}`);
  assert.equal(l.hits[0].url, '/uchi_reads-42');
  assert.equal(l.hits[0].body, '4 new chapters in 2 series');
  assert.equal(l.hits[0].headers.authorization, 'Bearer tk_abc');
  // fetch throws on a header character above U+00FF; RFC 2047 is what ntfy decodes.
  assert.equal(l.hits[0].headers.title, `=?UTF-8?B?${Buffer.from('ウチヨミ').toString('base64')}?=`);
  assert.equal(kinds.validateTarget('ntfy', { url: l.base, topic: 'a/b' }).ok, false, 'a topic with a slash is a path');
});

test('Discord gets {content} with mentions switched off, and only a Discord webhook address is accepted', async () => {
  const l = await fresh();
  // The stored address is Discord's in real life; the builder is exercised against a local stand-in.
  const req = kinds.buildRequest('discord', { url: `${l.base}/api/webhooks/123/abc_DEF-9` }, { display: 'x' }, { ...MSG, message: 'New in @everyone Academy' });
  const r = await send.sendRequest(req!);
  assert.equal(r.ok, true);
  assert.equal(l.hits[0].url, '/api/webhooks/123/abc_DEF-9');
  assert.deepEqual(JSON.parse(l.hits[0].body), { content: '**Uchiyomi**\nNew in @everyone Academy', allowed_mentions: { parse: [] } });
  assert.equal(kinds.validateTarget('discord', { url: 'https://discord.com/api/webhooks/123/abc_DEF-9' }).ok, true);
  for (const url of ['https://example.com/api/webhooks/1/x', 'http://discord.com/api/webhooks/1/x', 'https://discord.com/api/channels/1', 'https://discord.com:8443/api/webhooks/1/x']) {
    assert.equal(kinds.validateTarget('discord', { url }).ok, false, `${url} is not a Discord webhook`);
  }
});

test('the panel is shown scheme and host only, never the path, the query or the topic that carry a secret', () => {
  const cases: Array<[import('../src/lib/notify/kinds').Kind, import('../src/lib/notify/kinds').TargetInput, string]> = [
    ['discord', { url: 'https://discord.com/api/webhooks/123/SEKRIT-token' }, 'https://discord.com/…'],
    ['webhook', { url: 'http://n8n.lan:5678/webhook/SEKRIT-uuid?x=1', token: 'SEKRIT2' }, 'http://n8n.lan:5678/…'],
    ['webhook', { url: 'http://node-red.lan:1880' }, 'http://node-red.lan:1880'],
    ['ntfy', { url: 'https://ntfy.sh', topic: 'SEKRIT_topic' }, 'https://ntfy.sh'],
    ['home_assistant', { url: 'http://homeassistant.local:8123/lovelace', token: 'SEKRIT', service: 'notify.phone' }, 'http://homeassistant.local:8123'],
  ];
  for (const [kind, input, display] of cases) {
    const v = kinds.validateTarget(kind, input);
    assert.ok(v.ok, `${kind} refused`);
    assert.equal(v.config.display, display);
    assert.ok(!JSON.stringify(v.config).includes('SEKRIT'), `${kind}'s public config carries the secret: ${JSON.stringify(v.config)}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// The address rule

test('A REDIRECT IS NEVER FOLLOWED: the second listener receives nothing at all', async () => {
  // Reintroduce by dropping `redirect: 'error'` from send.ts: bHits becomes ['/stolen'] -- fetch turns the
  // 302'd POST into a GET and goes. (It would drop the Authorization header on this cross-origin hop by
  // itself, which is why the assertion is on ANY request reaching B, not on the token.)
  const b = await fresh();
  const a = await fresh((req, res) => { res.writeHead(302, { location: `${b.base}/stolen` }); res.end(); });
  const r = await send.sendRequest(kinds.buildRequest('webhook', { url: `${a.base}/hook`, token: 'SEKRIT' }, { display: '' }, MSG)!);
  assert.deepEqual(b.hits.map((h) => h.url), [], 'the redirect target was requested');
  assert.deepEqual(a.hits.map((h) => h.url), ['/hook']);
  assert.deepEqual(r, { ok: false, status: null, reason: 'redirect' });
});

test('A SAME-ORIGIN 307 IS NOT FOLLOWED EITHER: the digest and the token are not re-POSTed to a path nobody set', async () => {
  // Reintroduce by dropping `redirect: 'error'`: a.hits becomes ['/hook', '/elsewhere'], the second carrying
  // the body and the Bearer header -- a same-origin hop keeps both.
  const a = await fresh((req, res) => { if (req.url === '/hook') { res.writeHead(307, { location: '/elsewhere' }); res.end(); } else { res.writeHead(200); res.end(); } });
  const r = await send.sendRequest(kinds.buildRequest('webhook', { url: `${a.base}/hook`, token: 'SEKRIT' }, { display: '' }, MSG)!);
  assert.deepEqual(a.hits.map((h) => h.url), ['/hook']);
  assert.equal(r.reason, 'redirect');
});

test('A NAME THAT ANSWERS PUBLIC AND METADATA IS REFUSED, at connect time, and nothing is sent', async () => {
  // The resolver hands back a reachable address FIRST and 169.254.169.254 second: judging only the first
  // answer, or checking in a separate lookup from the one the socket uses, lets this through.
  // Reintroduce by judging `all[0]` alone in guardedLookup: the listener receives the POST.
  const l = await fresh();
  const resolve = async (host: string) => host === 'mixed.test'
    ? [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }];
  const req = (host: string) => kinds.buildRequest('webhook', { url: `http://${host}:${l.port}/hook`, token: 'SEKRIT' }, { display: '' }, MSG)!;
  const bad = await send.sendRequest(req('mixed.test'), { resolve });
  assert.deepEqual(bad, { ok: false, status: null, reason: 'blocked' });
  assert.deepEqual(l.hits, [], 'a name with a metadata answer reached the listener');
  // The same resolver, a clean name: the path works, so the refusal above is the rule and not a broken rig.
  const good = await send.sendRequest(req('ok.test'), { resolve });
  assert.equal(good.ok, true);
  assert.equal(l.hits.length, 1);
  // IPv6 metadata and an IPv4-mapped one in the hex form URL produces, from a resolver.
  for (const address of ['fd00:ec2::254', '::ffff:a9fe:a9fe', 'fe80::1']) {
    const r = await send.sendRequest(req('v6.test'), { resolve: async () => [{ address: '127.0.0.1', family: 4 }, { address, family: 6 }] });
    assert.equal(r.reason, 'blocked', `${address} must be refused`);
  }
  assert.equal(l.hits.length, 1);
});

test('a literal metadata address or name is refused before any socket, in every notation', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/', 'http://[fd00:ec2::254]/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata.google.internal./', 'http://metadata.goog/',
    'http://100.100.100.200/latest/meta-data/',
  ]) {
    assert.equal(kinds.validateTarget('webhook', { url }).ok, false, `${url} was accepted at save`);
    assert.equal((kinds.validateTarget('webhook', { url }) as { error: string }).error, 'blocked_address');
    const r = await send.sendRequest({ url, headers: {}, body: '' });
    assert.equal(r.reason, 'blocked', `${url} was not refused at send`);
  }
  for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:70/', 'ftp://x/', 'http://user:pass@192.168.1.5/', 'not a url', '']) {
    assert.equal((kinds.validateTarget('webhook', { url }) as { error?: string }).error, 'bad_url', `${url} is not an http(s) address`);
  }
});

test('PRIVATE ADDRESSES ARE ALLOWED ON PURPOSE (#70: a self-hosted Home Assistant lives on the LAN)', () => {
  // Reintroduce by refusing through ssrfGuard's isBlockedHost/assertPublicHost in guard.ts `refusal`: every
  // address below is refused and the feature cannot reach the one thing issue #70 asked for.
  for (const url of ['http://192.168.1.50:8123', 'http://10.0.0.5:8123', 'http://homeassistant.local:8123', 'http://172.20.0.3', 'http://127.0.0.1:8123', 'http://ha.internal', 'http://[fd12::5]:8123']) {
    const v = kinds.validateTarget('home_assistant', { url, token: 'llat', service: 'notify.mobile_app_phone' });
    assert.equal(v.ok, true, `#70: ${url} must be ALLOWED for a notification target, got ${JSON.stringify(v)}`);
  }
});

test('THIS SERVER\'S OWN PORT ON LOOPBACK IS REFUSED -- by literal, by name, and at connect time', async () => {
  // Reintroduce by deleting the `self` branch of `refusal` and the ESELF check in guardedLookup: `self`, the
  // listener on the port this server believes it serves, receives the POST.
  for (const url of [`http://127.0.0.1:${self.port}/api/admin/settings`, `http://localhost:${self.port}/`, `http://[::1]:${self.port}/`, `http://0.0.0.0:${self.port}/`]) {
    assert.equal((kinds.validateTarget('webhook', { url }) as { error?: string }).error, 'self_target', `${url} is this server`);
    assert.equal((await send.sendRequest({ url, headers: {}, body: '' })).reason, 'blocked');
  }
  // A name that resolves to loopback, on our port: only the connection's own lookup can see this one.
  const r = await send.sendRequest({ url: `http://looks-harmless.test:${self.port}/`, headers: {}, body: '' }, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(r.reason, 'blocked');
  assert.deepEqual(self.hits, [], 'this server was sent its own notification');
});

// ---------------------------------------------------------------------------------------------------
// Failure handling

test('a 401 is an answer and is not retried; a 500 is retried once; a 5xx on a Test is not retried', async () => {
  const denied = await fresh((_q, res) => { res.writeHead(401); res.end('{"message":"SEKRIT upstream body"}'); });
  const r401 = await send.sendRequest({ url: `${denied.base}/`, headers: {}, body: '' }, { retry: true, retryDelayMs: 5 });
  assert.deepEqual(r401, { ok: false, status: 401, reason: 'unauthorized' }, 'the answer is a reason, never the upstream body');
  assert.equal(denied.hits.length, 1);
  const broken = await fresh((_q, res) => { res.writeHead(502); res.end(); });
  const r502 = await send.sendRequest({ url: `${broken.base}/`, headers: {}, body: '' }, { retry: true, retryDelayMs: 5 });
  assert.equal(r502.reason, 'server_error');
  assert.equal(broken.hits.length, 2, 'one retry on a 5xx');
  await send.sendRequest({ url: `${broken.base}/`, headers: {}, body: '' }, { retry: false });
  assert.equal(broken.hits.length, 3, 'no retry when the caller (the Test button) asked for none');
});

test('a target that never answers times out with a reason, and a closed port is "refused"', async () => {
  const silent = await fresh(() => { /* never answers */ });
  const r = await send.sendRequest({ url: `${silent.base}/`, headers: {}, body: '' }, { timeoutMs: 200 });
  assert.deepEqual(r, { ok: false, status: null, reason: 'timeout' });
  const gone = await fresh();
  const port = gone.port;
  await close(gone);
  opened.splice(opened.indexOf(gone), 1);
  assert.equal((await send.sendRequest({ url: `http://127.0.0.1:${port}/`, headers: {}, body: '' })).reason, 'refused');
});

test('AN UNDECRYPTABLE SECRET SENDS NOTHING AND SAYS WHY -- never a request without its token', async () => {
  // Reintroduce by building the request from what is left when `openSecret` returns null -- e.g.
  // `openSecret(row.secret) ?? { url: row.config.display }`: the listener receives an unauthenticated POST.
  const l = await fresh();
  const plain = JSON.stringify({ url: `${l.base}/hook`, token: 'SEKRIT' });
  // Sealed under a JWT_SECRET this server no longer has, exactly as secretbox would have sealed it.
  const k = scryptSync('a-rotated-jwt-secret-from-before', 'uchiyomi.notify.v1', 32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const rotated = ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  assert.equal(notify.openSecret(rotated), null);
  const row = {
    id: '00000000-0000-4000-8000-000000000001', kind: 'webhook' as const, name: 'rotated', config: { display: `${l.base}/…` },
    secret: rotated, user_id: null, events: ['new_chapters'], template: null, enabled: true, consecutive_failures: 0,
    last_ok_at: null, last_error: null, last_error_at: null, created_at: '', updated_at: '',
  };
  const r = await notify.deliver(row, MSG, { retry: false });
  assert.deepEqual(r, { ok: false, status: null, reason: 'secret_unreadable' });
  assert.deepEqual(l.hits, [], 'a target whose secret could not be read was sent a request');
  assert.match(send.REASON_TEXT.secret_unreadable, /enter them again/);
});

test('the notify key is not the tracker key: a tracker ciphertext does not open as a notification secret', () => {
  // Reintroduce by sealing notification secrets under the tracker salt: the notify-purpose open succeeds.
  const tracker = secretbox.seal(JSON.stringify({ url: 'http://x/' }));
  assert.equal(secretbox.open(tracker, 'notify'), null);
  assert.equal(secretbox.open(tracker), JSON.stringify({ url: 'http://x/' }), 'the tracker default must keep opening what it always opened');
  const n = notify.sealSecret({ url: 'http://x/', token: 't' });
  assert.equal(secretbox.open(n), null, 'a notify secret opened under the tracker key');
  assert.deepEqual(notify.openSecret(n), { url: 'http://x/', token: 't' });
});

test('a tracker token sealed by the pre-0.43 single-salt code still opens through the default', () => {
  // The frozen salt: every stored tracker token was sealed this way, and changing it would disconnect them all.
  const k = scryptSync(process.env.JWT_SECRET!, 'uchiyomi.tracker.v1', 32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update('anilist-token', 'utf8'), c.final()]);
  const old = ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
  assert.equal(secretbox.open(old), 'anilist-token');
});

// ---------------------------------------------------------------------------------------------------
// The message

test('the digest template: the default, the variables, the list cut at ten, unknown placeholders literal', () => {
  const s = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Series ${i + 1}`, added: 1 }));
  assert.equal(template.renderDigest(null, [{ title: 'Solo Leveling', added: 3 }]), '3 new chapters in Solo Leveling');
  assert.equal(template.renderDigest(null, [{ title: 'Solo Leveling', added: 1 }]), '1 new chapter in Solo Leveling');
  assert.equal(template.renderDigest('', s(3)), '3 new chapters in 3 series');
  assert.equal(template.renderDigest('{count} new: {list}', s(3)), '3 new: Series 1, Series 2, Series 3');
  assert.equal(template.renderDigest('{list}', s(12)), `${s(10).map((x) => x.title).join(', ')} …and 2 more`);
  assert.equal(template.renderDigest('{chapters} in {series}', s(2)), '{chapters} in 2 series', 'an unknown placeholder stays visible');
  assert.equal(template.renderDigest('{count}\n{list}', s(1)), '1\nSeries 1', 'a line break the admin wrote is kept');
});

test('a title that looks like a placeholder is not expanded, and a title cannot forge a line', () => {
  // Reintroduce by chaining one .replace per variable with {list} before the others (template.ts names the
  // exact chain): the titles "{count}" and "{series}" inside {list} are expanded a second time.
  assert.equal(template.renderDigest('{list} | {series} | {count}', [{ title: '{count}', added: 1 }, { title: '{series}', added: 1 }]),
    '{count}, {series} | 2 series | 2');
  assert.equal(template.renderDigest('{series} / {list}', [{ title: '{list}', added: 1 }]), '{list} / {list}');
  assert.equal(template.renderDigest('{list}', [{ title: 'Evil\nFAKE: admin password reset\u0007', added: 1 }]), 'Evil FAKE: admin password reset');
  const long = template.renderDigest('{list}', [{ title: 'x'.repeat(5000), added: 1 }]);
  assert.equal(long.length, template.MESSAGE_MAX);
  assert.ok(long.endsWith('…'));
});
