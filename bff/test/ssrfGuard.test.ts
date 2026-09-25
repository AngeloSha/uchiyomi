// The cover proxy fetches a URL the caller chose. This is the guard that decides which ones.
//
// Before it, `/img/sources/cover?u=…` would fetch anything with an http(s) scheme, on behalf of any
// authenticated account or any OPDS token holder, with no per-route rate limit. The app sits on a Docker
// network with yomi-db:5432, yomi-suwayomi:4567 (auth optional) and flaresolverr:8191 on it, plus the host
// LAN and 169.254.169.254. And it was not blind: the upstream status was reflected verbatim, so
// 404-vs-500-vs-hang was a port and path oracle, and anything sharp could decode came back as webp.
//
// Pure unit tests -- no database, no network. They run everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isBlockedHost } from '../src/lib/ssrfGuard';

test('every private IPv4 range is refused', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3',          // loopback
    '10.0.0.1', '10.255.255.255',      // RFC1918
    '172.16.0.1', '172.31.255.255',    // RFC1918
    '192.168.1.1',                     // RFC1918
    '169.254.169.254',                 // ⚠️ cloud metadata: the single most valuable SSRF target
    '0.0.0.0', '255.255.255.255',
    '100.64.0.1',                      // carrier-grade NAT
    '224.0.0.1', '240.0.0.1',          // multicast, reserved
  ]) assert.equal(isPrivateAddress(ip), true, `${ip} must be refused`);
});

test('public IPv4 is allowed, including addresses adjacent to private ranges', () => {
  // Reintroduce by widening a range in v4Private -- e.g. `a === 172` instead of the 16-31 second-octet
  // check: 172.32.x is a public address and covers hosted there would stop loading.
  for (const ip of [
    '1.1.1.1', '8.8.8.8', '104.21.0.1',
    '172.15.0.1', '172.32.0.1',        // either side of 172.16/12
    '192.167.0.1', '192.169.0.1',      // either side of 192.168/16
    '100.63.0.1', '100.128.0.1',       // either side of 100.64/10
    '11.0.0.1', '126.0.0.1', '128.0.0.1',
  ]) assert.equal(isPrivateAddress(ip), false, `${ip} is public and must be allowed`);
});

test('IPv6 loopback, unique-local, link-local and multicast are refused', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1'])
    assert.equal(isPrivateAddress(ip), true, `${ip} must be refused`);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false, 'public IPv6 must be allowed');
});

test('THE HAT TRICK: an IPv4-mapped IPv6 address is judged as IPv4', () => {
  // Reintroduce by dropping the ::ffff: branch in v6Private: `::ffff:127.0.0.1` stops looking private,
  // and loopback is reachable again through a notation change alone.
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'a mapped PUBLIC address is still public');
});

test('anything that is not an IP at all is refused', () => {
  for (const junk of ['', 'not-an-ip', '999.999.999.999', '10.0.0', '::gg'])
    assert.equal(isPrivateAddress(junk), true, `${junk} must not be treated as public`);
});

test('hostnames that mean "this machine" or "this network" are refused without resolving', () => {
  // Reintroduce by deleting the LOCAL_SUFFIXES check: `http://anything.localhost/` resolves to loopback on
  // most systems and would sail through the literal-IP test, which only sees a name.
  for (const h of ['localhost', 'LOCALHOST', 'foo.localhost', 'db.internal', 'nas.local', 'x.home.arpa'])
    assert.equal(isBlockedHost(h), true, `${h} must be refused`);
});

test('literal private hosts are refused, in both notations, including bracketed IPv6', () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '[::1]', '[fd00::1]'])
    assert.equal(isBlockedHost(h), true, `${h} must be refused`);
  for (const h of ['cdn.example.com', 'mangadex.org', '8.8.8.8', '[2606:4700::1111]'])
    assert.equal(isBlockedHost(h), false, `${h} is public and must be allowed`);
});

test('a bare container hostname is refused by the sync check, not left to DNS', () => {
  // This asserted the opposite until v0.45.1, on purpose: `yomi-db` is just a name until it resolves, and
  // assertPublicHost did the resolving. That division of labour held only while nothing reached the network
  // before the DNS half ran -- and in v0.45.0 the Cloudflare solver did, so `http://uchiyomi-suwayomi:4567/`
  // went to FlareSolverr's browser unchecked (coverSolverGuard.test.ts). No public host is a single label, so
  // refusing one here costs nothing and closes that class of mistake for whatever comes next.
  // Reintroduce by deleting the dotless-name line in isBlockedHost: every one of these is allowed again.
  for (const h of ['yomi-db', 'yomi-suwayomi', 'uchiyomi-suwayomi', 'uchiyomi-flaresolverr', 'nas', 'YOMI-DB'])
    assert.equal(isBlockedHost(h), true, `${h} must be refused`);
});

test('a trailing dot names the same host', () => {
  for (const h of ['localhost.', 'yomi-db.', '127.0.0.1.', 'db.internal.'])
    assert.equal(isBlockedHost(h), true, `${h} must be refused`);
  assert.equal(isBlockedHost('cdn.example.com.'), false, 'a public name with a trailing dot is still public');
});
