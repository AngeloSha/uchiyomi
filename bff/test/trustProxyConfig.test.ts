// What TRUST_PROXY may say, and what boot says about it (lib/auth.ts trustProxySetting, trustProxyProblems,
// trustProxyWarnings; server.ts). An entry Fastify cannot read used to stop the server after the migrations, in
// proxy-addr's words and without naming the setting; a stray comma stopped it the same way. No database.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.CONFIG_DIR ||= '/tmp/uchiyomi-test-config';

test('every value the server reads today is still accepted', async () => {
  // The default, the documented examples (docs/CONFIGURATION.md), the netmask spelling and an IPv4-mapped address:
  // proxy-addr takes them all, and a check that refused any of them would stop an install that works.
  const { trustProxyProblems } = await import('../src/lib/auth');
  for (const v of [
    'loopback, linklocal, uniquelocal', 'loopback, linklocal, uniquelocal, 203.0.113.9', '172.18.0.5',
    '10.0.0.0/8, 203.0.113.9', '10.0.0.0/255.0.0.0', '::ffff:10.0.0.1', 'fd00::/8', 'true', 'false', '',
  ]) assert.deepEqual(trustProxyProblems(v), [], v);
});

test('an entry Fastify cannot read is named, one sentence each', async () => {
  const { trustProxyProblems } = await import('../src/lib/auth');
  const p = trustProxyProblems('loopbak, 10.0.0.300, 172.18.0.5, 10.0.0.0/33');
  assert.equal(p.length, 3, p.join('\n'));
  for (const bad of ['loopbak', '10.0.0.300', '10.0.0.0/33']) {
    assert.ok(p.some((s) => s.startsWith(`TRUST_PROXY: "${bad}"`)), `nothing names ${bad}: ${p.join(' | ')}`);
  }
  // `true` inside a list is an entry like any other, not the switch.
  assert.equal(trustProxyProblems('true, 10.0.0.1').length, 1);
});

test('a stray comma is not an entry', async () => {
  // Reintroduce by passing the list as written: Fastify reads the empty entry as an address and refuses it.
  const { trustProxySetting, trustProxyProblems } = await import('../src/lib/auth');
  assert.equal(trustProxySetting('loopback, , 10.0.0.2,'), 'loopback, 10.0.0.2');
  assert.deepEqual(trustProxyProblems('loopback, , 10.0.0.2,'), []);
  assert.equal(trustProxySetting(' , '), false);
  const Fastify = (await import('fastify')).default;
  assert.doesNotThrow(() => Fastify({ trustProxy: trustProxySetting('loopback, linklocal, uniquelocal,') }));
});

test('true and a bare number are said at every start, and are not refused', async () => {
  const { trustProxyProblems, trustProxyWarnings } = await import('../src/lib/auth');
  assert.equal(trustProxyWarnings('true').length, 1);
  assert.match(trustProxyWarnings('TRUE')[0], /every peer/);
  // Express spells "one hop" as 1; here it is the address 0.0.0.1, which boots, and trusts no proxy at all.
  assert.deepEqual(trustProxyProblems('1'), []);
  assert.match(trustProxyWarnings('1')[0], /^TRUST_PROXY: "1" is read as an address/);
  assert.match(trustProxyWarnings('loopback, 2')[0], /"2"/);
  for (const v of ['loopback, linklocal, uniquelocal', 'false', '', '172.18.0.5']) assert.deepEqual(trustProxyWarnings(v), [], v);
});
