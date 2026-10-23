// Which peers may set the client address (env.TRUST_PROXY, server.ts trustProxy, lib/auth.ts clientIp; v0.69.1).
//
// Every peer used to be trusted, and clientIp read the first X-Forwarded-For entry -- the one a client writes itself.
// The audit's sign-in check: 14 POSTs to a 10-per-5-minutes route with a rotating X-Forwarded-For all answered 401 and
// none 429. Now only loopback, link-local and private-network peers (a Docker proxy, nginx, NPM) are trusted by
// default. A Fastify app with the real setting and a stand-in route; no database.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

async function appWith(trust: string) {
  const { trustProxySetting, clientIp } = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ trustProxy: trustProxySetting(trust) });
  await app.register((await import('@fastify/rate-limit')).default, { global: false });
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => reply.code(401).send({ ip: clientIp(req) }));
  await app.ready();
  return app;
}

test('a client on the app port cannot choose its own address with X-Forwarded-For', async () => {
  // Reintroduce `trustProxy: true` (or TRUST_PROXY=true): every one of these answers 401, none 429.
  const { env } = await import('../src/env');
  const app = await appWith(env.TRUST_PROXY);
  const st: number[] = [];
  for (let i = 0; i < 14; i++) {
    const r = await app.inject({ method: 'POST', url: '/login', remoteAddress: '203.0.113.5', headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    st.push(r.statusCode);
    if (r.statusCode === 401) assert.equal(r.json().ip, '203.0.113.5', 'the address is the peer, not the header');
  }
  assert.equal(st.filter((s) => s === 429).length, 4, `statuses: ${st}`);
  await app.close();
});

test('behind a proxy on a private network the forwarded address is believed', async () => {
  const { env } = await import('../src/env');
  const app = await appWith(env.TRUST_PROXY);
  const r = await app.inject({ method: 'POST', url: '/login', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(r.json().ip, '198.51.100.7');
  // and a client that prepends its own entry is not believed: the proxy appended the real one last
  const spoof = await app.inject({ method: 'POST', url: '/login', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.8' } });
  assert.equal(spoof.json().ip, '198.51.100.8');
  await app.close();
});

test('two trusted proxies in a row: the visitor is the first untrusted entry from the right', async () => {
  // A Cloudflare tunnel container in front of Nginx Proxy Manager in front of the app: both hops are private.
  const { env } = await import('../src/env');
  const app = await appWith(env.TRUST_PROXY);
  const r = await app.inject({ method: 'POST', url: '/login', remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.9, 10.0.0.2' } });
  assert.equal(r.json().ip, '198.51.100.9');
  await app.close();
});

test('only X-Forwarded-For is read: X-Real-IP and CF-Connecting-IP never name the visitor', async () => {
  // Reintroduce a reader of either header and the untrusted peer below chooses its own address.
  const { env } = await import('../src/env');
  const app = await appWith(env.TRUST_PROXY);
  const spoof = { 'x-real-ip': '9.9.9.9', 'cf-connecting-ip': '8.8.8.8', 'true-client-ip': '7.7.7.7' };
  const direct = await app.inject({ method: 'POST', url: '/login', remoteAddress: '203.0.113.5', headers: spoof });
  assert.equal(direct.json().ip, '203.0.113.5');
  const proxied = await app.inject({ method: 'POST', url: '/login', remoteAddress: '172.18.0.5', headers: { ...spoof, 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(proxied.json().ip, '198.51.100.7');
  await app.close();
});

test('a proxy reached over IPv4-mapped IPv6 is the same proxy', async () => {
  const { env } = await import('../src/env');
  const app = await appWith(env.TRUST_PROXY);
  const r = await app.inject({ method: 'POST', url: '/login', remoteAddress: '::ffff:172.18.0.5', headers: { 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(r.json().ip, '198.51.100.7');
  await app.close();
});

test('X-Forwarded-Proto from an untrusted peer does not make the session cookies Secure', async () => {
  // cookieOptions() (lib/auth.ts) is `secure: 'auto'`, which reads the protocol Fastify resolved under the same trustProxy
  // as the address. A client on the app port that says https must not decide it, any more than it decides its address.
  const { env } = await import('../src/env');
  const { trustProxySetting, cookieOptions } = await import('../src/lib/auth');
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ trustProxy: trustProxySetting(env.TRUST_PROXY) });
  await app.register((await import('@fastify/cookie')).default);
  app.get('/c', async (_req, reply) => reply.setCookie('yomi_rt', 'x', cookieOptions()).send({ ok: true }));
  await app.ready();
  const cookie = async (remoteAddress: string) =>
    String((await app.inject({ url: '/c', remoteAddress, headers: { 'x-forwarded-proto': 'https' } })).headers['set-cookie']);
  assert.doesNotMatch(await cookie('203.0.113.5'), /;\s*Secure/i);
  assert.match(await cookie('172.18.0.5'), /;\s*Secure/i);
  await app.close();
});

test('TRUST_PROXY reads true, false or an address list', async () => {
  const { trustProxySetting } = await import('../src/lib/auth');
  assert.equal(trustProxySetting('true'), true);
  assert.equal(trustProxySetting('false'), false);
  assert.equal(trustProxySetting('10.0.0.0/8, 203.0.113.9'), '10.0.0.0/8, 203.0.113.9');
});
