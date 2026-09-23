/**
 * Where a notification target may point (v0.43.0, #70).
 *
 * ⚠️ THIS IS NOT `ssrfGuard.ts`, AND THE TWO MUST NOT BE UNIFIED. That guard is an allowlist of the public
 * internet for the cover proxy, where ANY signed-in reader names the URL, and it refuses `.local` and all of
 * RFC1918 -- which is exactly where a self-hosted Home Assistant lives (`http://homeassistant.local:8123`,
 * `http://192.168.1.50:8123`). Reusing it here would ship #70 unable to reach the one thing it was asked for.
 * A shared function with a "mode" flag is how the wrong rule reaches the cover proxy one day, so this is a
 * separate file with its own rule, and `notifySend.test.ts` asserts that a LAN address is ALLOWED, naming the
 * issue, so a future "security cleanup" fails CI instead of silently breaking the feature.
 *
 * The threat model is different, not absent. A target is written once, by an admin -- someone who can
 * already run jobs, change library roots and read the audit log -- and the method, headers and body are
 * ours, never theirs. What remains worth refusing:
 *
 *   * any scheme but http(s), and a URL carrying user:password (fetch refuses it with an error message that
 *     QUOTES THE URL, credentials and all, and the global error handler logs a 5xx error whole);
 *   * cloud metadata -- 169.254.0.0/16 (169.254.169.254 on AWS, GCP, Azure, Oracle), fe80::/10,
 *     fd00:ec2::254 (AWS over IPv6), 100.100.100.200 (Alibaba), the names metadata.google.internal and
 *     metadata.goog -- in every notation a URL or a resolver can produce, IPv4-mapped IPv6 included;
 *   * this server's own listening port on loopback (or its own public origin). A footgun guard, not a
 *     boundary: the request carries no cookie and every /api route is behind `authenticate`, so a self-POST
 *     is a confusing loop, not an escalation. It is refused so the loop never starts.
 *
 * And, the rule that carries the real weight, in send.ts: `redirect: 'error'` on every send. Without it a
 * public host 302s the Bearer token to 169.254.169.254 and every check in this file is decorative.
 *
 * ⚠️ THE METADATA CHECK RUNS INSIDE THE CONNECTION'S OWN DNS LOOKUP (`guardedLookup`), not as a separate
 * `dns.lookup` before the fetch. Two lookups are two answers: a name can resolve public at the check and to
 * 169.254.169.254 at connect time, which is the rebinding gap ssrfGuard.ts admits it leaves open. Here the
 * addresses judged ARE the addresses the socket connects to, and a name is refused if ANY of them is a
 * metadata address -- not the first, or resolver ordering decides. An IP literal never reaches a lookup
 * (net.connect skips it), so literals are judged by `refusal()` before the request is built.
 *
 * Accepted and stated: a Test from the admin panel can still tell open from filtered ports by timing. The
 * route is admin-only, rate-limited, audited and answers from a closed set of reasons, never a body.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { env } from '../../env';

/** Resolve a hostname to every address it has. Injectable so a test can hand back [public, metadata]. */
export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true });

const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);

/** An IPv4 address in the metadata set: all of link-local 169.254/16, plus Alibaba's 100.100.100.200. */
function v4Metadata(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unreadable: refuse
  return (p[0] === 169 && p[1] === 254) || ip === '100.100.100.200';
}

/** A dotted IPv4 address inside an IPv4-mapped IPv6 one, in either notation, or null if it is not one. */
function mappedV4(s: string): string | null {
  if (!s.startsWith('::ffff:')) return null;
  const tail = s.slice(7);
  if (tail.includes('.')) return tail;
  // ⚠️ `new URL()` normalises `http://[::ffff:169.254.169.254]/` to `::ffff:a9fe:a9fe`, so the readable
  // spelling alone catches nothing a URL actually produces (the same trap ssrfGuard.ts documents).
  const g = tail.split(':');
  if (g.length === 2 && g.every((h) => /^[0-9a-f]{1,4}$/.test(h))) {
    const [hi, lo] = g.map((h) => parseInt(h, 16));
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return '999.0.0.0'; // a mapped form we cannot read is judged unreadable, which v4Metadata refuses
}

/** True if this literal address belongs to a cloud metadata service (or is link-local, where they live). */
export function isMetadataAddress(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v = isIP(s);
  if (v === 4) return v4Metadata(s);
  if (v === 6) {
    const m = mappedV4(s);
    if (m) return v4Metadata(m);
    return /^fe[89ab]/.test(s) || s === 'fd00:ec2::254';
  }
  return false;
}

/** Loopback or "any" -- an address that means this machine. */
function isLoopbackAddress(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v = isIP(s);
  if (v === 4) return s.startsWith('127.') || s === '0.0.0.0';
  if (v === 6) {
    const m = mappedV4(s);
    if (m) return m.startsWith('127.') || m === '0.0.0.0';
    return s === '::1' || s === '::';
  }
  return false;
}

const isLoopbackHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || isLoopbackAddress(h);
};

export const effectivePort = (u: URL): number => Number(u.port || (u.protocol === 'https:' ? 443 : 80));

/**
 * Parse an address someone typed, WITHOUT ever letting the parse throw.
 *
 * ⚠️ Node's ERR_INVALID_URL carries the whole input in an `input` property, and the global error handler
 * logs a 5xx error through pino's serializer, which copies that property. A bare `new URL(body.url)` that
 * reached it would write a Discord webhook URL -- a credential -- into the log. So every parse of an address
 * goes through here, and a bad one is `null` and a fixed sentence, never an echo.
 */
export function safeUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // fetch's own refusal quotes the URL, credentials and all
  if (!u.hostname) return null;
  return u;
}

/** Why this address is refused before any socket opens, or null. Synchronous: literals and names only. */
export function refusal(u: URL): 'blocked' | 'self' | null {
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (METADATA_NAMES.has(host)) return 'blocked';
  if (isIP(host) && isMetadataAddress(host)) return 'blocked';
  const port = effectivePort(u);
  if (isLoopbackHost(host) && port === env.PORT) return 'self';
  const own = safeUrl(env.PUBLIC_ORIGIN);
  if (own && own.hostname.toLowerCase() === host && effectivePort(own) === port) return 'self';
  return null;
}

/** An error the connection's lookup raises. The code is what send.ts classifies; the message is fixed. */
class Refused extends Error {
  constructor(readonly code: 'EMETADATA' | 'ESELF') {
    super(code === 'EMETADATA' ? 'refusing a cloud metadata address' : 'refusing to notify this server itself');
  }
}

/**
 * The `lookup` a notify connection uses, for a request to `port`.
 *
 * Every answer is judged and the name is refused if ANY is a metadata address -- or a loopback address on
 * this server's own port. Otherwise the answers are passed through in the shape the caller asked for: the
 * array when `options.all` is set (what net.connect asks for since Node 20's family autoselection), one
 * address and family otherwise.
 * Reintroduce by judging `all[0]` alone: "a name that answers public and metadata is refused" in
 * notifySend.test.ts reaches the listener.
 */
export function guardedLookup(resolve: Resolver, port: number) {
  return (hostname: string, options: any, callback?: any): void => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    resolve(hostname).then((all) => {
      if (all.some((a) => isMetadataAddress(a.address))) return cb(new Refused('EMETADATA'));
      if (port === env.PORT && all.some((a) => isLoopbackAddress(a.address))) return cb(new Refused('ESELF'));
      const fam = opts.family === 4 || opts.family === 6 ? opts.family : 0;
      const list = fam ? all.filter((a) => a.family === fam) : all;
      if (!list.length) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }));
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    }, (err) => cb(err));
  };
}
