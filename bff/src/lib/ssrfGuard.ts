/**
 * Is this URL safe for the SERVER to fetch on a caller's behalf?
 *
 * The cover proxy (`GET /img/sources/cover?u=…`) exists so the browser never talks to a manga CDN directly:
 * a cross-origin <img> is unreliable in a standalone iOS PWA, and several CDNs require a Referer. The cost
 * of that design is that an authenticated caller chooses a URL the server then fetches -- server-side
 * request forgery, and CodeQL is right to call it critical.
 *
 * What made it sharp rather than theoretical, before this guard:
 *
 *   * the app sits on a Docker network with `yomi-db:5432`, `yomi-suwayomi:4567` (whose auth is optional),
 *     and `flaresolverr:8191` on it, plus the host LAN and 169.254.169.254;
 *   * the fetch failure reflected the UPSTREAM status verbatim, so 404-vs-500-vs-timeout was a clean port
 *     and path oracle;
 *   * anything `sharp` could decode came back to the caller re-encoded as webp.
 *
 * The rule here is deliberately an ALLOWLIST OF THE PUBLIC INTERNET rather than a blocklist of things we
 * happen to run: a blocklist has to be updated every time the compose file gains a service.
 *
 * ⚠️ Residual risk, stated rather than hidden: this resolves the hostname and rejects private answers, but
 * does not pin the connection to the address it checked, so a DNS entry that changes between the check and
 * the connection (rebinding) is not covered. Closing that needs a custom undici dispatcher that connects to
 * a pinned IP while keeping SNI and Host intact. It is a much narrower attack than the direct one -- it
 * needs an attacker-controlled authoritative nameserver with a ~1s TTL -- and it is worth doing separately
 * rather than pretending this covers it.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Hostnames that never belong to the public internet, whatever DNS says. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const v4Private = (ip: string): boolean => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable: refuse
  const [a, b] = p;
  return (
    a === 0 ||                                  // "this network"
    a === 10 ||                                 // RFC1918
    a === 127 ||                                // loopback
    (a === 100 && b >= 64 && b <= 127) ||       // RFC6598 carrier-grade NAT
    (a === 169 && b === 254) ||                 // link-local, incl. 169.254.169.254 cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||        // RFC1918
    (a === 192 && b === 168) ||                 // RFC1918
    (a === 192 && b === 0) ||                   // IETF protocol assignments / 192.0.2.0 TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) ||    // benchmarking
    (a === 198 && b === 51) ||                  // TEST-NET-2
    (a === 203 && b === 0) ||                   // TEST-NET-3
    a >= 224                                    // multicast (224/4) and reserved (240/4), incl. broadcast
  );
};

const v6Private = (ip: string): boolean => {
  const s = ip.toLowerCase().split('%')[0];     // strip any zone id
  // An IPv4-mapped address is an IPv4 address wearing a hat: ::ffff:127.0.0.1 must be judged as IPv4.
  //
  // ⚠️ In BOTH notations. `new URL()` normalises the dotted form to hex -- `http://[::ffff:127.0.0.1]/`
  // arrives here as `::ffff:7f00:1` -- so matching only the readable spelling catches nothing that a URL
  // actually produces, which is exactly the input this guard sees.
  if (s.startsWith('::ffff:')) {
    const tail = s.slice(7);
    if (tail.includes('.')) return v4Private(tail);
    const g = tail.split(':');
    if (g.length === 2 && g.every((h) => /^[0-9a-f]{1,4}$/.test(h))) {
      const [hi, lo] = g.map((h) => parseInt(h, 16));
      return v4Private(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return true; // a mapped address we cannot read is not one we will trust
  }
  return (
    s === '::' || s === '::1' ||                // unspecified, loopback
    s.startsWith('fc') || s.startsWith('fd') || // fc00::/7 unique-local
    s.startsWith('fe8') || s.startsWith('fe9') ||
    s.startsWith('fea') || s.startsWith('feb') || // fe80::/10 link-local
    s.startsWith('ff')                          // ff00::/8 multicast
  );
};

/** True if this literal IP address is anything other than a public internet address. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v === 6) return v6Private(ip);
  return true; // not an IP at all: the caller should not have asked
}

/**
 * True if the hostname is one we refuse without even resolving it -- a literal private IP, or a name whose
 * suffix means "this machine / this network" by definition.
 *
 * Synchronous, so the cheap URL predicate can use it without becoming async.
 */
export function isBlockedHost(hostname: string): boolean {
  // URL keeps IPv6 literals in brackets; a trailing dot names the same host (`localhost.` IS localhost).
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (isIP(h)) return isPrivateAddress(h);
  // A name with no dot is never a public internet host: it resolves only through a search domain or, where
  // this runs, Docker's embedded DNS -- which is exactly where `yomi-db` and `uchiyomi-suwayomi` live. This was
  // once left to the DNS half on purpose, and that held only while nothing touched the network before the DNS
  // half ran. In v0.45.0 the Cloudflare solver did, and a bare name went straight to it.
  if (!h.includes('.')) return true;
  return false;
}

/**
 * Resolve the hostname and refuse if ANY answer is a private address.
 *
 * Any, not the first: a name that returns one public and one internal address would otherwise be a coin
 * flip decided by resolver ordering.
 *
 * A name that does not resolve is refused too -- there is nothing to fetch, and answering differently for
 * NXDOMAIN than for "blocked" would hand back the existence oracle this guard exists to remove.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isBlockedHost(hostname)) throw new BlockedAddress(hostname);
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(h)) return; // a public literal: already judged, and lookup() would just echo it back
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    throw new BlockedAddress(hostname);
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new BlockedAddress(hostname);
}

/** A host the server refuses to fetch on someone else's behalf. */
export class BlockedAddress extends Error {
  constructor(readonly host: string) { super(`refusing to fetch a non-public address: ${host}`); }
}
