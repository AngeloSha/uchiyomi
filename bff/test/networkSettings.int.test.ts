// Admin -> Settings -> Server -> Home network (GET/PATCH /api/admin/network; lib/clientAddr.ts): the home network and
// the trusted proxies, saved on the settings page where the environment does not set them, and in force at the next
// request. Here TRUST_PROXY comes from the environment and the home from the page: one of each. Skipped unless
// TEST_DATABASE_URL is set.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.TRUST_PROXY = 'loopback, 172.18.0.5';
  delete process.env.LOCAL_NETWORKS;
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const PREFIX = 'ns-';

test('the home network on the settings page', { skip }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, one } = await import('../src/lib/db');
  const auth = await import('../src/lib/auth');
  const net = await import('../src/lib/clientAddr');
  await migrate();
  await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
  const user = async (name: string, role: string) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind) VALUES ($1, $1, 'x', $2, 'password') RETURNING id`,
    [`${PREFIX}${name}`, role]))[0].id;
  const admin = await user('admin', 'admin');
  const member = await user('member', 'user');
  const reset = async () => {
    await q('UPDATE server_settings SET local_networks = NULL, trusted_proxies = NULL WHERE id = 1');
    await net.loadNetworkSettings();
  };
  await reset();

  // As server.ts builds it: the trusted proxies are asked of each request.
  const app = (await import('fastify')).default({ trustProxy: net.trustsPeer });
  await app.register((await import('@fastify/cookie')).default);
  await app.register((await import('@fastify/jwt')).default, { secret: process.env.JWT_SECRET! });
  await app.register((await import('../src/routes/admin')).default);
  await app.ready();
  const bearer = (id: string, role: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` });
  const asAdmin = bearer(admin, 'admin');
  const get = (remoteAddress: string, xff?: string, headers = asAdmin) => app.inject({
    method: 'GET', url: '/api/admin/network', remoteAddress, headers: { ...headers, ...(xff ? { 'x-forwarded-for': xff } : {}) },
  });
  const patch = (payload: object, headers = asAdmin) =>
    app.inject({ method: 'PATCH', url: '/api/admin/network', remoteAddress: '192.168.1.20', headers, payload });
  const saved = async () => one<{ local_networks: string | null; trusted_proxies: string | null }>(
    'SELECT local_networks, trusted_proxies FROM server_settings WHERE id = 1');

  try {
    await t.test('nothing saved: the private networks are home, and the page says where each value comes from', async () => {
      const r = (await get('192.168.1.20')).json();
      assert.equal(r.zone, 'local');
      assert.deepEqual(r.localNetworks, { value: net.PRIVATE_NETWORKS, source: 'default' });
      assert.deepEqual(r.trustedProxies, { value: 'loopback, 172.18.0.5', source: 'env' });
      assert.equal(r.suggestion, '192.168.1.0/24', 'Use my network: the admin\'s own /24');
      const away = (await get('203.0.113.5')).json();
      assert.equal(away.zone, 'remote');
      assert.equal(away.suggestion, null, 'a public address is nobody\'s home network');
    });

    await t.test('a saved home is in force at the next request', async () => {
      const res = await patch({ localNetworks: ' 192.168.1.0/24, ,10.8.0.0/24 ' });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json().localNetworks, { value: '192.168.1.0/24, 10.8.0.0/24', source: 'settings' });
      assert.equal((await saved())?.local_networks, '192.168.1.0/24, 10.8.0.0/24');
      assert.equal((await get('192.168.2.20')).json().zone, 'remote', 'private, but not the home that was saved');
      assert.equal((await get('10.8.0.3')).json().zone, 'local');
      const proxied = (await get('172.18.0.5', '192.168.1.30')).json();
      assert.deepEqual([proxied.zone, proxied.ip, proxied.viaProxy], ['local', '192.168.1.30', true], 'through the trusted proxy');

      assert.equal((await patch({ localNetworks: 'NONE' })).json().localNetworks.value, 'none');
      assert.equal((await get('192.168.1.20')).json().zone, 'remote', '`none`: nobody is at home');
      const back = (await patch({ localNetworks: null })).json();
      assert.equal(back.localNetworks.source, 'default');
      assert.equal((await saved())?.local_networks, null);
    });

    await t.test('what boot would refuse is refused here, and nothing is saved', async () => {
      for (const bad of ['uniquelocal', '0.0.0.0/0', '192.168.1.0/33', 'home']) {
        const res = await patch({ localNetworks: bad });
        assert.equal(res.statusCode, 400, bad);
        assert.equal(res.json().error, 'bad_network');
      }
      assert.equal((await saved())?.local_networks, null);
    });

    await t.test('a value the environment sets is not the page\'s to change', async () => {
      // Reintroduce by dropping the check: the proxies below are saved over TRUST_PROXY, and the next boot reads them.
      const res = await patch({ trustedProxies: '172.18.0.0/16' });
      assert.equal(res.statusCode, 409);
      assert.deepEqual([res.json().error, res.json().setting], ['set_by_env', 'TRUST_PROXY']);
      assert.equal((await saved())?.trusted_proxies, null);
    });

    await t.test('an admin\'s page only', async () => {
      const asMember = bearer(member, 'user');
      assert.equal((await get('192.168.1.20', undefined, asMember)).statusCode, 403);
      assert.equal((await patch({ localNetworks: '10.0.0.0/8' }, asMember)).statusCode, 403);
      assert.equal((await saved())?.local_networks, null);
    });

    await t.test('the address of every live session, and its zone', async () => {
      await auth.issueRefreshToken(member, { ip: '192.168.1.44', via: 'password' });
      await auth.issueRefreshToken(member, { ip: '198.51.100.8', via: 'password' });
      const recent = (await get('192.168.1.20')).json().recent as Array<{ ip: string; zone: string; name: string }>;
      const atHome = recent.find((r) => r.ip === '192.168.1.44');
      assert.deepEqual([atHome?.zone, atHome?.name], ['local', `${PREFIX}member`]);
      assert.equal(recent.find((r) => r.ip === '198.51.100.8')?.zone, 'remote');
    });

    await t.test('through Cloudflare the page says nobody is at home, and why', async () => {
      const r = (await app.inject({
        method: 'GET', url: '/api/admin/network', remoteAddress: '172.18.0.5',
        headers: { ...asAdmin, 'x-forwarded-for': '79.23.184.6, 172.19.0.3', 'cf-ray': '8a1b2c3d4e5f6a7b-MXP', 'cf-connecting-ip': '79.23.184.6' },
      })).json();
      assert.equal(r.zone, 'remote');
      assert.ok(r.warnings.some((w: any) => w.code === 'via_cloudflare'), JSON.stringify(r.warnings));
    });

    await t.test('through a proxy with home still the private networks, the page asks for the real one', async () => {
      // Reintroduce by dropping the warning: a tunnel's container, private, stays home and nobody is told.
      const via = async () => (await get('172.18.0.5', '192.168.1.30')).json().warnings.map((w: any) => w.code);
      assert.ok((await via()).includes('home_default_proxy'));
      assert.equal((await patch({ localNetworks: '192.168.1.0/24' })).statusCode, 200);
      assert.ok(!(await via()).includes('home_default_proxy'), 'a home written out is what it asks for');
      await patch({ localNetworks: null });
      assert.ok(!(await get('192.168.1.20')).json().warnings.some((w: any) => w.code === 'home_default_proxy'), 'straight to the port: nothing to say');
    });

    await t.test('a save is written down', async () => {
      await patch({ localNetworks: '192.168.1.0/24' });
      const row = await one<{ user_id: string; detail: any }>(
        `SELECT user_id, detail FROM audit_log WHERE event = 'settings.network' ORDER BY id DESC LIMIT 1`);
      assert.equal(row?.user_id, admin);
      assert.equal(row?.detail?.localNetworks, '192.168.1.0/24');
    });
  } finally {
    await reset();
    await q('DELETE FROM audit_log WHERE user_id = $1', [admin]).catch(() => {});
    await q('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
    await app.close();
  }
});
