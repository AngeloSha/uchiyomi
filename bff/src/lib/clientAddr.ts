// Who a visitor is, and whether they are at home.
//
// A profile without a password opens from the local network only: from outside, only a credential gets in. "Home" is
// LOCAL_NETWORKS, the networks the operator declares (env.ts); with none declared nobody is at home, and a profile
// without a password opens in the desktop app alone. There is no default on purpose: a trusted reverse proxy that does
// not pass X-Forwarded-For hands every visitor its own private address, and a default of "the private networks" would
// then put the whole internet at home.
import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { env } from '../env';
import { isDesktop } from './desktop';

/**
 * Client IP, as Fastify resolved it under `trustProxy` (server.ts, env.TRUST_PROXY).
 *
 * This used to read the first X-Forwarded-For entry whatever `trustProxy` said, and the first entry is the one a
 * client writes itself -- a proxy appends to the header, it does not replace it. `req.ip` walks the chain from the
 * socket back through the trusted proxies only, so it is the address the nearest untrusted hop connected from.
 */
export function clientIp(req: FastifyRequest): string | null {
  return (req.ip || '').slice(0, 64) || null;
}

export type Zone = 'local' | 'remote';

/** The names TRUST_PROXY knows. LOCAL_NETWORKS refuses them: home is written out, not "every private network". */
const ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

const entries = (raw: string): string[] => raw.split(',').map((e) => e.trim()).filter(Boolean);

/** One LOCAL_NETWORKS entry as [address, prefix, family], or why it is not one. */
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

/** LOCAL_NETWORKS as a list the zone is judged by. Entries that do not parse are left out (boot refuses them anyway). */
export function localNetworks(raw: string): BlockList {
  const list = new BlockList();
  for (const e of entries(raw)) {
    const p = parseEntry(e);
    if (typeof p !== 'string') list.addSubnet(p[0], p[1], p[2]);
  }
  return list;
}

/**
 * Why the server cannot start with this LOCAL_NETWORKS, one sentence each (server.ts, beside trustProxyProblems).
 * `TRUST_PROXY=true` lets anyone who reaches the port say they are any address, so with a home declared it would let
 * anyone say they are at home.
 */
export function localNetworksProblems(raw: string, trustProxyRaw: string): string[] {
  const out = entries(raw).map(parseEntry).filter((p): p is string => typeof p === 'string');
  if (entries(raw).length && trustProxyRaw.trim().toLowerCase() === 'true') {
    out.push('LOCAL_NETWORKS cannot be used with TRUST_PROXY=true: every peer could claim a home address. '
      + 'Name your proxy in TRUST_PROXY instead.');
  }
  return out;
}

/**
 * What LOCAL_NETWORKS tells the operator at every start. A proxy named in TRUST_PROXY by address that is also inside
 * LOCAL_NETWORKS is at home itself: if it ever forwards a request without X-Forwarded-For, that request is at home
 * too, whoever sent it.
 */
export function localNetworksWarnings(raw: string, trustProxyRaw: string): string[] {
  if (!entries(raw).length) return [];
  const home = localNetworks(raw);
  return entries(trustProxyRaw)
    .map((e) => e.split('/')[0])
    .filter((a) => isIP(a) && home.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4'))
    .map((a) => `LOCAL_NETWORKS includes the proxy ${a} (TRUST_PROXY): a request it forwards without X-Forwarded-For `
      + 'counts as at home. Make sure it always sets the header, or leave its address out of LOCAL_NETWORKS.');
}

/**
 * Where this request comes from, judged against `home`. Doubt is outside:
 *   1. X-Forwarded-For from a peer TRUST_PROXY does not name: something we do not trust is forwarding, so the address
 *      we see is not the visitor's. Outside. (`req.ips` holds the peer alone when the peer is not trusted.)
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

let home: BlockList | null = null;

/** zoneOf against LOCAL_NETWORKS. The desktop app's server is this computer's alone: always at home. */
export function clientZone(req: FastifyRequest): Zone {
  if (isDesktop()) return 'local';
  home ??= localNetworks(env.LOCAL_NETWORKS);
  return zoneOf(req, home);
}
