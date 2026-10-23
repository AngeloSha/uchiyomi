// Who a visitor is, and whether they are at home.
//
// A profile without a password opens from the home network only: from outside, only a credential gets in. Two settings
// decide it, each from the first of three places that says something: the environment (LOCAL_NETWORKS, TRUST_PROXY),
// then Admin -> Settings -> Server -> Home network (server_settings), then the default.
//
//   - Home: by default the private networks, as Sonarr and Radarr read "local addresses". `none` makes nobody at home.
//   - Trusted proxies: the peers that may say who is connecting (X-Forwarded-For). By default loopback, link-local and
//     the private networks (v0.69.1).
//
// What the private default cannot see is a proxy or a NAT that hides the visitor without saying who it is -- Docker
// Desktop's port forwarding, a proxy that drops X-Forwarded-For: every visitor then looks private, and is at home. The
// settings page shows the address the server sees for each live session so that shows (GET /api/admin/network).
import { BlockList, isIP } from 'node:net';
import { createRequire } from 'node:module';
import Fastify, { type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { env } from '../env';
import { q, one } from './db';
import { isDesktop } from './desktop';

/**
 * Client IP, as Fastify resolved it under `trustProxy` (server.ts, trustsPeer).
 *
 * This used to read the first X-Forwarded-For entry whatever `trustProxy` said, and the first entry is the one a
 * client writes itself -- a proxy appends to the header, it does not replace it. `req.ip` walks the chain from the
 * socket back through the trusted proxies only, so it is the address the nearest untrusted hop connected from.
 */
export function clientIp(req: FastifyRequest): string | null {
  return (req.ip || '').slice(0, 64) || null;
}

export type Zone = 'local' | 'remote';

/** Home when nothing says otherwise: the private, loopback and link-local networks of IPv4 and IPv6. */
export const PRIVATE_NETWORKS = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, fc00::/7, fe80::/10, ::1/128';
/** The trusted proxies when nothing says otherwise (env.ts TRUST_PROXY's default). */
export const DEFAULT_TRUSTED_PROXIES = 'loopback, linklocal, uniquelocal';

/** The names TRUST_PROXY knows. A home refuses them: it is written as networks, or left to the default. */
const ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const entries = (raw: string): string[] => raw.split(',').map((e) => e.trim()).filter(Boolean);
/** `none`: no network is home. */
const isNone = (raw: string): boolean => raw.trim().toLowerCase() === 'none';

/** One home entry as [address, prefix, family], or why it is not one. */
function parseEntry(entry: string): [string, number, 'ipv4' | 'ipv6'] | string {
  if (ALIASES.has(entry.toLowerCase())) {
    return `LOCAL_NETWORKS: "${entry}" is a name, not a network. Write the network your home uses, e.g. 192.168.1.0/24.`;
  }
  const [addr, bits, ...rest] = entry.split('/');
  const v = isIP(addr);
  const max = v === 6 ? 128 : 32;
  const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : NaN;
  if (!v || rest.length || !(prefix >= 1 && prefix <= max)) {
    return `LOCAL_NETWORKS: "${entry}" is not an address or a CIDR range (a /0 would make the whole internet home).`;
  }
  return [addr, prefix, v === 6 ? 'ipv6' : 'ipv4'];
}

/** A home as the list the zone is judged by. Entries that do not parse are left out (they are refused before use). */
export function localNetworks(raw: string): BlockList {
  const list = new BlockList();
  if (isNone(raw)) return list;
  for (const e of entries(raw)) {
    const p = parseEntry(e);
    if (typeof p !== 'string') list.addSubnet(p[0], p[1], p[2]);
  }
  return list;
}

/**
 * Why this home cannot be used, one sentence each: boot stops on them for LOCAL_NETWORKS (server.ts), the settings
 * page refuses them (PATCH /api/admin/network). `TRUST_PROXY=true` lets anyone who reaches the port say they are any
 * address, so with a home declared it would let anyone say they are at home.
 */
export function localNetworksProblems(raw: string, trustProxyRaw: string): string[] {
  if (isNone(raw)) return [];
  const out = entries(raw).map(parseEntry).filter((p): p is string => typeof p === 'string');
  if (entries(raw).length && trustProxyRaw.trim().toLowerCase() === 'true') {
    out.push('LOCAL_NETWORKS cannot be used with TRUST_PROXY=true: every peer could claim a home address. '
      + 'Name your proxy in TRUST_PROXY instead.');
  }
  return out;
}

/**
 * The proxies named by address that are inside the home: each is at home itself, so if it ever forwards a request
 * without X-Forwarded-For, that request is at home too, whoever sent it. Said at every start and on the settings page.
 */
export function proxiesAtHome(raw: string, trustProxyRaw: string): string[] {
  if (!entries(raw).length || isNone(raw)) return [];
  const home = localNetworks(raw);
  return entries(trustProxyRaw)
    .map((e) => e.split('/')[0])
    .filter((a) => isIP(a) && home.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4'));
}

/** proxiesAtHome, in the operator's words at every start (server.ts). */
export function localNetworksWarnings(raw: string, trustProxyRaw: string): string[] {
  return proxiesAtHome(raw, trustProxyRaw).map((a) => `LOCAL_NETWORKS includes the proxy ${a} (TRUST_PROXY): a request it `
    + 'forwards without X-Forwarded-For counts as at home. Make sure it always sets the header, or leave its address out of LOCAL_NETWORKS.');
}

// ---- trusted proxies ----

/** TRUST_PROXY's comma list, each entry trimmed, empty ones dropped. */
const trustProxyEntries = (raw: string): string[] => raw.split(',').map((e) => e.trim()).filter(Boolean);

/**
 * TRUST_PROXY as Fastify's `trustProxy` option: true, false, or the address list.
 *
 * A stray comma ("loopback, , 10.0.0.2", or one at the end) is an empty entry, which Fastify's parser refuses as an
 * address and stopped the server over. It names nothing, so it is dropped. Reintroduce by passing the list as written:
 * "a stray comma is not an entry" in trustProxyConfig.test.ts sees the empty one.
 */
export function trustProxySetting(raw: string): FastifyServerOptions['trustProxy'] {
  const v = raw.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  const list = trustProxyEntries(raw);
  return list.length ? list.join(', ') : false;
}

/**
 * Why the server cannot use this TRUST_PROXY, one sentence each; empty when it can. Boot stops on any of them
 * (server.ts), before the migrations, and the settings page refuses them.
 *
 * An entry Fastify cannot read stopped the server anyway -- it throws while the app is built -- but only after the
 * migrations, in proxy-addr's words ("invalid IP address: loopbak"), with nothing naming the setting. Each entry is put
 * to Fastify itself, so this can never refuse a value the server would take, nor take one it would refuse: a parser of
 * our own (ipaddr.js reads more spellings of an address than node:net does) would one day stop an install that works.
 */
export function trustProxyProblems(raw: string): string[] {
  if (typeof trustProxySetting(raw) !== 'string') return [];
  const out: string[] = [];
  for (const entry of trustProxyEntries(raw)) {
    try {
      Fastify({ trustProxy: entry });
    } catch {
      out.push(`TRUST_PROXY: "${entry}" is not an address, a CIDR range or one of loopback, linklocal, uniquelocal.`);
    }
  }
  return out;
}

/**
 * What TRUST_PROXY tells the operator at every start (server.ts), one line each: settings that work, but not as
 * whoever wrote them is likely to think.
 *
 *  - `true` believes X-Forwarded-For from every peer, the setting v0.69.1 stopped being the default for.
 *  - A bare number is not a count of proxies (Express's spelling): the parser reads `1` as the address 0.0.0.1, so it
 *    trusts no proxy at all, silently, and the activity log shows the proxy's own address for everyone.
 */
export function trustProxyWarnings(raw: string): string[] {
  if (trustProxySetting(raw) === true) {
    return ['TRUST_PROXY=true believes X-Forwarded-For from every peer: anyone who can reach the app\'s port directly '
      + 'chooses the address the sign-in limits and the activity log see, and nobody counts as at home. Name your proxy\'s '
      + 'address or network instead.'];
  }
  return trustProxyEntries(raw).filter((e) => /^\d+$/.test(e)).map((e) =>
    `TRUST_PROXY: "${e}" is read as an address, not as a number of proxies, so it trusts no proxy. Name your proxy's `
    + 'address or network instead.');
}

/** Fastify's own reader of trusted proxies, resolved from Fastify itself: the one `trustProxy` would compile. */
const proxyAddr = createRequire(require.resolve('fastify'))('@fastify/proxy-addr') as {
  compile(list: string[]): (addr: string, hop: number) => boolean;
};

/** A TRUST_PROXY value as the function proxy-addr asks of each hop. */
function compileTrust(raw: string): (addr: string, hop: number) => boolean {
  const s = trustProxySetting(raw);
  if (s === true) return () => true;
  if (typeof s !== 'string') return () => false;
  return proxyAddr.compile(trustProxyEntries(s));
}

// ---- where the two settings come from ----

export type Source = 'env' | 'settings' | 'default';
export interface NetworkConfig {
  localNetworks: { value: string; source: Source };
  trustedProxies: { value: string; source: Source };
}

/** Admin -> Settings' values (server_settings): null is "the default". Loaded at boot and after every save. */
let saved: { localNetworks: string | null; trustedProxies: string | null } = { localNetworks: null, trustedProxies: null };
let home: BlockList | null = null;
let trust: ((addr: string, hop: number) => boolean) | null = null;
let named: ((addr: string, hop: number) => boolean) | null = null;

/**
 * The home network and the trusted proxies in force, and where each comes from. The environment outranks the settings
 * page, which then shows the value and cannot change it: what docker-compose says is what runs. TRUST_PROXY counts as
 * set only when the environment has it -- env.ts fills in its default otherwise.
 */
export function networkConfig(): NetworkConfig {
  const envHome = env.LOCAL_NETWORKS.trim();
  const envTrust = (process.env.TRUST_PROXY ?? '').trim();
  return {
    localNetworks: envHome ? { value: envHome, source: 'env' }
      : saved.localNetworks !== null ? { value: saved.localNetworks, source: 'settings' }
      : { value: PRIVATE_NETWORKS, source: 'default' },
    trustedProxies: envTrust ? { value: envTrust, source: 'env' }
      : saved.trustedProxies !== null ? { value: saved.trustedProxies, source: 'settings' }
      : { value: DEFAULT_TRUSTED_PROXIES, source: 'default' },
  };
}

/** Put these settings in force (and in a test, without a database). The next request is judged by them. */
export function useNetworkSettings(next: { localNetworks: string | null; trustedProxies: string | null }): void {
  saved = next;
  home = null;
  trust = null;
  named = null;
}

/** Read Admin -> Settings' values: at boot, after the migrations (server.ts), and after a save. */
export async function loadNetworkSettings(): Promise<void> {
  const row = await one<{ local_networks: string | null; trusted_proxies: string | null }>(
    'SELECT local_networks, trusted_proxies FROM server_settings WHERE id = 1');
  useNetworkSettings({ localNetworks: row?.local_networks ?? null, trustedProxies: row?.trusted_proxies ?? null });
}

/** A value from the settings page as it is kept: its entries trimmed, empty ones dropped, `none` lower case; empty is the default (null). */
export function tidyNetworkSetting(v: string | null | undefined): string | null | undefined {
  if (v == null) return v;
  const t = v.split(',').map((e) => e.trim()).filter(Boolean).join(', ');
  return !t ? null : isNone(t) ? 'none' : t;
}

/**
 * Why the settings page cannot save this value, or null (PATCH /api/admin/network). What boot refuses in the
 * environment is refused here too; and for the proxies `true`, `false`, `none` and bare numbers, which the environment
 * reads as something other than an address -- trusting everyone, nobody, or 0.0.0.1. Reintroduce by dropping a check:
 * its case in clientZone.test.ts is saved.
 */
export function networkSettingProblem(key: 'localNetworks' | 'trustedProxies', value: string): string | null {
  if (key === 'localNetworks') return localNetworksProblems(value, 'false')[0] ?? null;
  const word = entries(value).find((e) => /^(true|false|none|\d+)$/i.test(e));
  if (word) return `"${word}" is not an address: name the proxy's address or network, e.g. 172.18.0.0/16.`;
  return trustProxyProblems(value)[0] ?? null;
}

/** Save Admin -> Settings' values (null: back to the default) and put them in force at once. */
export async function saveNetworkSettings(patch: { localNetworks?: string | null; trustedProxies?: string | null }): Promise<void> {
  if (patch.localNetworks !== undefined) await q('UPDATE server_settings SET local_networks = $1, updated_at = now() WHERE id = 1', [patch.localNetworks]);
  if (patch.trustedProxies !== undefined) await q('UPDATE server_settings SET trusted_proxies = $1, updated_at = now() WHERE id = 1', [patch.trustedProxies]);
  await loadNetworkSettings();
}

/**
 * Fastify's `trustProxy` (server.ts): whether this hop may say who is connecting, by the trusted proxies in force.
 * Asked of every request, so a save on the settings page takes effect without a restart.
 */
export function trustsPeer(addr: string, hop: number): boolean {
  trust ??= compileTrust(networkConfig().trustedProxies.value);
  return trust(addr, hop);
}

/**
 * The first proxy this request came through that the trusted proxies cover only by a name -- loopback, linklocal,
 * uniquelocal -- not by its address or a range written out; null when there is none.
 *
 * Those names trust every private peer, and a chain of private hops is what Docker Desktop's port forwarding, or a
 * proxy behind a router, makes of a visitor from anywhere: each hop is trusted, so the X-Forwarded-For entry the
 * visitor wrote is the address read, and the visitor chooses to be at home. Fine for the sign-in limits and the
 * activity log the names were made for (v0.69.1); not for deciding who opens a profile without a password.
 * (`req.ips` runs from the socket to the visitor: every entry but the last is a proxy the request came through.)
 */
export function unnamedHop(req: FastifyRequest): string | null {
  if (!named) {
    const s = trustProxySetting(networkConfig().trustedProxies.value);
    const list = typeof s === 'string' ? trustProxyEntries(s).filter((e) => !ALIASES.has(e.toLowerCase())) : [];
    named = list.length ? proxyAddr.compile(list) : () => false;
  }
  const hops = (req.ips ?? []).slice(0, -1);
  return hops.find((a, i) => !named!(a, i)) ?? null;
}

/** What the operator is told about the settings in force: at every start (server.ts) and on the settings page. */
export function networkWarnings(c: NetworkConfig = networkConfig()): Array<{ code: 'trust_all' } | { code: 'proxy_at_home'; ip: string }> {
  if (trustProxySetting(c.trustedProxies.value) === true) return [{ code: 'trust_all' }];
  return proxiesAtHome(c.localNetworks.value, c.trustedProxies.value).map((ip) => ({ code: 'proxy_at_home' as const, ip }));
}

/** Whether `ip` is in the home in force. */
export function atHome(ip: string | null): boolean {
  const v = ip ? isIP(ip) : 0;
  if (!v) return false;
  home ??= localNetworks(networkConfig().localNetworks.value);
  return home.check(ip!, v === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Where this request comes from, judged against `home`. Doubt is outside:
 *   1. X-Forwarded-For from a peer the trusted proxies do not name: something we do not trust is forwarding, so the
 *      address we see is not the visitor's. Outside. (`req.ips` holds the peer alone when the peer is not trusted.)
 *   2. The address Fastify resolved is in `home`: at home.
 *   3. Anything else, a missing address included: outside.
 */
export function zoneOf(req: FastifyRequest, home: BlockList): Zone {
  // The header is looked at, never read: only whether it is there.
  if (req.headers['x-forwarded-for'] !== undefined && (req.ips?.length ?? 1) <= 1) return 'remote';
  const ip = clientIp(req);
  const v = ip ? isIP(ip) : 0;
  return v && home.check(ip!, v === 6 ? 'ipv6' : 'ipv4') ? 'local' : 'remote';
}

/**
 * Whether two addresses are on one network: the same /24 of IPv4, the same /48 of IPv6 (an IPv4-mapped address is its
 * IPv4 one). What the soft audit line on a session that moves reads (routes/auth.ts /auth/refresh): a phone going from
 * Wi-Fi to mobile data, or a copied cookie used from elsewhere, looks the same from here, so it is said, never acted on.
 */
export function sameNetwork(a: string, b: string): boolean {
  const plain = (x: string) => (x.startsWith('::ffff:') && isIP(x.slice(7)) === 4 ? x.slice(7) : x);
  const x = plain(a);
  const y = plain(b);
  const v = isIP(x);
  if (!v || v !== isIP(y)) return false;
  if (v === 4) return x.split('.').slice(0, 3).join('.') === y.split('.').slice(0, 3).join('.');
  const net = new BlockList();
  net.addSubnet(x, 48, 'ipv6');
  return net.check(y, 'ipv6');
}

/**
 * Whether this request crossed Cloudflare's edge -- a Cloudflare Tunnel, or its proxy (the orange cloud): the edge adds
 * CF-Connecting-IP and CF-Ray to every request it passes on, and a proxy after it forwards them. Such a request came from
 * the internet, whatever address the hops after the edge report: cloudflared runs at home, so to the proxy behind it
 * every visitor from anywhere looks like a home address. The headers are looked at, never read; a visitor who adds them
 * only puts themselves outside.
 */
export function viaCloudflare(req: FastifyRequest): boolean {
  return req.headers['cf-connecting-ip'] !== undefined || req.headers['cf-ray'] !== undefined;
}

/**
 * zoneOf against the home in force. The desktop app's server is this computer's alone: always at home. With every peer
 * trusted as a proxy (TRUST_PROXY=true) anyone can say any address, so nobody is; through Cloudflare nobody is
 * (viaCloudflare); and through a proxy the trusted proxies name only by loopback/linklocal/uniquelocal, nobody is either
 * (unnamedHop). Reintroduce by dropping any: its case in clientZone.test.ts reads a visitor from outside as at home.
 */
export function clientZone(req: FastifyRequest): Zone {
  if (isDesktop()) return 'local';
  const c = networkConfig();
  if (trustProxySetting(c.trustedProxies.value) === true) return 'remote';
  if (viaCloudflare(req)) return 'remote';
  if (unnamedHop(req)) return 'remote';
  home ??= localNetworks(c.localNetworks.value);
  return zoneOf(req, home);
}
