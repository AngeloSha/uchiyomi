// Who is at home (lib/clientAddr.ts): LOCAL_NETWORKS, what boot says about it, and the zone a request is judged in.
// A profile without a password opens from home only, so a request wrongly judged at home is that profile open to the
// internet. No database.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

const HOME = '192.168.1.0/24, fd12:3456::/64';

async function appWith(trustProxy: string) {
  const { trustProxySetting } = await import('../src/lib/auth');
  const { zoneOf, localNetworks } = await import('../src/lib/clientAddr');
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ trustProxy: trustProxySetting(trustProxy) });
  const home = localNetworks(HOME);
  app.get('/', async (req) => ({ zone: zoneOf(req, home) }));
  await app.ready();
  const zone = async (remoteAddress: string, xff?: string) =>
    (await app.inject({ url: '/', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} })).json().zone;
  return { app, zone };
}

test('LOCAL_NETWORKS takes addresses and CIDR ranges, and refuses what would not mean one home', async () => {
  const { localNetworksProblems } = await import('../src/lib/clientAddr');
  for (const ok of ['', '192.168.1.0/24', '192.168.1.20', HOME, '10.0.0.0/8, 192.168.1.0/24,']) {
    assert.deepEqual(localNetworksProblems(ok, 'loopback, linklocal, uniquelocal'), [], ok);
  }
  for (const bad of ['uniquelocal', 'loopback', '0.0.0.0/0', '::/0', '192.168.1.0/33', '192.168.1.300', 'home', '10.0.0.0/8/1']) {
    const p = localNetworksProblems(bad, 'loopback');
    assert.equal(p.length, 1, `${bad}: ${p.join(' | ')}`);
    assert.match(p[0], /^LOCAL_NETWORKS: /);
  }
});

test('a home cannot be declared while every peer may say who it is', async () => {
  // TRUST_PROXY=true believes X-Forwarded-For from anyone who reaches the port: with a home declared, anyone could say
  // they are in it. Reintroduce by dropping the check: this sees no problem.
  const { localNetworksProblems } = await import('../src/lib/clientAddr');
  assert.equal(localNetworksProblems('192.168.1.0/24', 'true').length, 1);
  assert.deepEqual(localNetworksProblems('', 'true'), [], 'no home declared: nothing to protect');
});

test('a proxy named by address inside the home is said at start', async () => {
  const { localNetworksWarnings } = await import('../src/lib/clientAddr');
  assert.equal(localNetworksWarnings('192.168.1.0/24', 'loopback, 192.168.1.2').length, 1);
  // The default names no address: nothing to say, though uniquelocal covers the home.
  assert.deepEqual(localNetworksWarnings('192.168.1.0/24', 'loopback, linklocal, uniquelocal'), []);
  assert.deepEqual(localNetworksWarnings('192.168.1.0/24', '172.18.0.5'), []);
  assert.deepEqual(localNetworksWarnings('', '192.168.1.2'), []);
});

test('at home is the resolved address inside LOCAL_NETWORKS, and nothing else', async () => {
  const { app, zone } = await appWith('loopback, linklocal, uniquelocal');
  try {
    assert.equal(await zone('192.168.1.20'), 'local', 'a device on the home network, straight to the port');
    assert.equal(await zone('::ffff:192.168.1.20'), 'local', 'the same device over IPv4-mapped IPv6');
    assert.equal(await zone('fd12:3456::9'), 'local');
    assert.equal(await zone('192.168.2.20'), 'remote', 'another private network is not home');
    assert.equal(await zone('203.0.113.5'), 'remote');
    // Behind the reverse proxy: the visitor is the address it forwards.
    assert.equal(await zone('172.18.0.5', '192.168.1.20'), 'local');
    assert.equal(await zone('172.18.0.5', '198.51.100.7'), 'remote');
    assert.equal(await zone('172.18.0.5', '192.168.1.20, 198.51.100.7'), 'remote', 'the entry a visitor prepends is not read');
  } finally {
    await app.close();
  }
});

test('forwarded by a peer TRUST_PROXY does not name: outside, whatever the header says', async () => {
  // Rule 1 of zoneOf. Without it a visitor reaching the port from outside could not say they are at home -- their
  // header is ignored -- but a peer on the home network that forwards for someone else (a second proxy nobody named)
  // would put that someone at home. Reintroduce by dropping the rule: the last case reads local.
  const { app, zone } = await appWith('172.18.0.5');
  try {
    assert.equal(await zone('203.0.113.5', '192.168.1.20'), 'remote', 'an outside visitor claiming a home address');
    assert.equal(await zone('192.168.1.20'), 'local', 'the same home device, forwarding nothing');
    assert.equal(await zone('192.168.1.30', '198.51.100.7'), 'remote', 'a home device forwarding for someone outside');
  } finally {
    await app.close();
  }
});

test('with no trusted proxy at all, any forwarding means outside', async () => {
  const { app, zone } = await appWith('false');
  try {
    assert.equal(await zone('192.168.1.20'), 'local');
    assert.equal(await zone('192.168.1.20', '192.168.1.21'), 'remote');
  } finally {
    await app.close();
  }
});

test('with `none` as the home, nobody is at home', async () => {
  const { zoneOf, localNetworks, localNetworksProblems } = await import('../src/lib/clientAddr');
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  const homes = [localNetworks('none'), localNetworks('NONE'), localNetworks('')];
  app.get('/', async (req) => ({ zones: homes.map((h) => zoneOf(req, h)) }));
  try {
    for (const ra of ['127.0.0.1', '192.168.1.20', '10.0.0.2']) {
      assert.deepEqual((await app.inject({ url: '/', remoteAddress: ra })).json().zones, ['remote', 'remote', 'remote'], ra);
    }
    assert.deepEqual(localNetworksProblems('none', 'true'), [], '`none` declares no home, so it has nothing to protect');
  } finally {
    await app.close();
  }
});

// ---- where the home and the trusted proxies come from (Admin -> Settings -> Server -> Home network) ----

/** An app judged by the settings in force, as server.ts builds it: `trustProxy` is trustsPeer. */
async function liveApp() {
  const { trustsPeer, clientZone, clientIp } = await import('../src/lib/clientAddr');
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ trustProxy: trustsPeer });
  app.get('/', async (req) => ({ zone: clientZone(req), ip: clientIp(req) }));
  await app.ready();
  const ask = async (remoteAddress: string, xff?: string) =>
    (await app.inject({ url: '/', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} })).json();
  return { app, zone: async (ra: string, xff?: string) => (await ask(ra, xff)).zone as string, ask };
}

test('nothing set anywhere: the private networks are home, and private peers are trusted proxies', async () => {
  // Like Sonarr's "local addresses". Reintroduce the empty default: every case below that reads local reads remote.
  const { networkConfig, useNetworkSettings, atHome } = await import('../src/lib/clientAddr');
  useNetworkSettings({ localNetworks: null, trustedProxies: null });
  const c = networkConfig();
  assert.deepEqual([c.localNetworks.source, c.trustedProxies.source], ['default', 'default']);
  for (const ip of ['192.168.1.20', '10.1.2.3', '172.20.0.5', '127.0.0.1', '169.254.3.4', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.20']) {
    assert.ok(atHome(ip), `${ip} is private: at home`);
  }
  for (const ip of ['203.0.113.5', '172.32.0.1', '11.0.0.1', '2001:db8::1', '::ffff:203.0.113.5']) assert.ok(!atHome(ip), `${ip} is public`);
  const { app, zone, ask } = await liveApp();
  try {
    assert.equal(await zone('192.168.1.20'), 'local');
    assert.equal(await zone('203.0.113.5'), 'remote');
    assert.equal(await zone('172.18.0.5', '203.0.113.5'), 'remote', 'Nginx Proxy Manager in Docker, forwarding a visitor from outside');
    assert.deepEqual(await ask('172.18.0.5', '192.168.1.30'), { zone: 'local', ip: '192.168.1.30' });
  } finally {
    await app.close();
  }
});

test('what the settings page saves is in force at the next request, the trusted proxies included', async () => {
  // Reintroduce a cache that outlives a save (useNetworkSettings): each change below answers as the one before.
  const { useNetworkSettings, networkConfig } = await import('../src/lib/clientAddr');
  const { app, zone, ask } = await liveApp();
  try {
    useNetworkSettings({ localNetworks: '192.168.1.0/24', trustedProxies: '172.18.0.5' });
    assert.equal(networkConfig().localNetworks.source, 'settings');
    assert.equal(await zone('192.168.1.20'), 'local');
    assert.equal(await zone('10.0.0.5'), 'remote', 'private, but not the home that was saved');
    assert.deepEqual(await ask('172.18.0.5', '192.168.1.30'), { zone: 'local', ip: '192.168.1.30' }, 'the saved proxy says who it forwards');
    assert.equal(await zone('172.18.0.9', '192.168.1.30'), 'remote', 'a proxy nobody named, forwarding');
    assert.equal((await ask('172.18.0.9', '192.168.1.30')).ip, '172.18.0.9', 'and its header is not read');

    useNetworkSettings({ localNetworks: 'none', trustedProxies: '172.18.0.5' });
    assert.equal(await zone('192.168.1.20'), 'remote', '`none`: nobody is at home');

    useNetworkSettings({ localNetworks: null, trustedProxies: null });
    assert.equal(await zone('10.0.0.5'), 'local', 'back to the default');
  } finally {
    useNetworkSettings({ localNetworks: null, trustedProxies: null });
    await app.close();
  }
});

test('with every peer trusted as a proxy, nobody is at home', async () => {
  // TRUST_PROXY=true lets anyone say any address: a home would be anyone's. Reintroduce by dropping the check in
  // clientZone: the visitor below, claiming a home address from outside, reads local.
  const { useNetworkSettings, networkWarnings } = await import('../src/lib/clientAddr');
  const { app, zone } = await liveApp();
  try {
    useNetworkSettings({ localNetworks: null, trustedProxies: 'true' });
    assert.equal(await zone('203.0.113.5', '192.168.1.20'), 'remote');
    assert.equal(await zone('192.168.1.20'), 'remote');
    assert.deepEqual(networkWarnings(), [{ code: 'trust_all' }]);
  } finally {
    useNetworkSettings({ localNetworks: null, trustedProxies: null });
    await app.close();
  }
});

test('the settings page refuses what boot refuses, and a proxy list that is not addresses', async () => {
  const { networkSettingProblem, tidyNetworkSetting } = await import('../src/lib/clientAddr');
  for (const ok of ['192.168.1.0/24', '192.168.1.0/24, 10.8.0.0/24', 'none', 'fd12:3456::/64']) {
    assert.equal(networkSettingProblem('localNetworks', ok), null, ok);
  }
  for (const bad of ['uniquelocal', '0.0.0.0/0', '192.168.1.0/33', 'home']) {
    assert.ok(networkSettingProblem('localNetworks', bad), bad);
  }
  for (const ok of ['loopback, linklocal, uniquelocal', '172.18.0.5', '172.18.0.0/16, 10.0.0.2']) {
    assert.equal(networkSettingProblem('trustedProxies', ok), null, ok);
  }
  // `true` would trust everyone, `false` and `none` nobody, a number the address 0.0.0.1: none of them is a proxy.
  for (const bad of ['true', 'false', 'none', '1', 'loopback, 2', 'loopbak', '10.0.0.0/33']) {
    assert.ok(networkSettingProblem('trustedProxies', bad), bad);
  }
  assert.equal(tidyNetworkSetting(' 192.168.1.0/24, ,10.8.0.0/24 ,'), '192.168.1.0/24, 10.8.0.0/24');
  assert.equal(tidyNetworkSetting(' , '), null, 'empty is the default');
  assert.equal(tidyNetworkSetting('NONE'), 'none');
});

test('a proxy named by address inside the home is said on the settings page', async () => {
  const { useNetworkSettings, networkWarnings } = await import('../src/lib/clientAddr');
  try {
    useNetworkSettings({ localNetworks: '192.168.1.0/24', trustedProxies: 'loopback, 192.168.1.2' });
    assert.deepEqual(networkWarnings(), [{ code: 'proxy_at_home', ip: '192.168.1.2' }]);
    useNetworkSettings({ localNetworks: null, trustedProxies: null });
    assert.deepEqual(networkWarnings(), [], 'the defaults name no proxy by address');
  } finally {
    useNetworkSettings({ localNetworks: null, trustedProxies: null });
  }
});

test('one network: the same /24 of IPv4, the same /48 of IPv6', async () => {
  const { sameNetwork } = await import('../src/lib/clientAddr');
  assert.equal(sameNetwork('198.51.100.20', '198.51.100.99'), true);
  assert.equal(sameNetwork('198.51.100.20', '198.51.101.20'), false);
  assert.equal(sameNetwork('::ffff:198.51.100.20', '198.51.100.7'), true, 'an IPv4-mapped address is its IPv4 one');
  assert.equal(sameNetwork('2001:db8:1:2::5', '2001:db8:1:ffff::9'), true);
  assert.equal(sameNetwork('2001:db8:1::5', '2001:db8:2::5'), false);
  assert.equal(sameNetwork('198.51.100.20', '2001:db8::1'), false);
  assert.equal(sameNetwork('not an address', '198.51.100.20'), false);
});
