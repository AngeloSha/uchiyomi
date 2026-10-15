// Outbound fetches of URLs this server did not choose: a site's page images, a source's icon, a caller's cover.
//
// Two rules the cover proxy already followed and the other fetches did not:
//   1. every hop is a public http(s) host (assertNotPrivateHost, below), so a redirect or a URL a site names cannot
//      walk the server into the Docker network, the LAN or a cloud metadata address; and
//   2. a body is read with a byte count and refused past a cap, because fetch decodes gzip as it reads: a 49 KB
//      response became a 48 MiB buffer, and nothing but a timeout bounded how much one request could make the
//      shared process hold.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { BlockedAddress, isBlockedHost, isPrivateAddress } from './ssrfGuard';

/** A body over its cap. Callers treat it like any failed fetch. */
export class ResponseTooLarge extends Error {
  constructor(public max: number) {
    super(`response larger than ${max} bytes`);
  }
}

/** A cover or an icon is small; a page can be a long strip. Both far above real images, far below a host's memory. */
export const MAX_COVER_BYTES = 32 * 1024 * 1024;
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_HTML_BYTES = 512 * 1024;

/**
 * The body of `r`, refused as soon as it passes `max` decoded bytes. An uncompressed Content-Length over the cap is
 * refused before reading anything. Reintroduce by going back to `Buffer.from(await r.arrayBuffer())`:
 * safeFetch.test.ts reads the 48 MiB gzip body whole.
 */
export async function readCapped(r: Response, max: number): Promise<Buffer> {
  const declared = Number(r.headers.get('content-length') || 0);
  if (!r.headers.get('content-encoding') && declared > max) {
    await r.body?.cancel().catch(() => {});
    throw new ResponseTooLarge(max);
  }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLarge(max);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, n);
}

export interface PublicFetch {
  status: number;
  headers: Headers;
  /** The URL that answered, after any redirects. */
  url: string;
  body: Buffer;
}

/**
 * GET a URL on the public internet, following redirects by hand so each hop is checked, and read at most `maxBytes`.
 * Resolves null for anything that is not a fetchable public URL, any hop that is not, too many redirects, a timeout
 * or a body over the cap, so callers keep their own "no image" path. Headers go to the first hop's origin only: a
 * redirect elsewhere drops them, as a browser drops a Referer-scoped credential.
 */
export async function fetchPublic(
  url: string | URL,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes: number; maxHops?: number },
): Promise<PublicFetch | null> {
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  const first = target.origin;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  try {
    for (let hop = 0; ; hop++) {
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
      try {
        await assertNotPrivateHost(target.hostname);
      } catch (e) {
        if (e instanceof BlockedAddress) return null;
        throw e;
      }
      const headers = target.origin === first ? opts.headers : undefined;
      const r = await fetch(target, { headers, redirect: 'manual', signal });
      if (r.status >= 300 && r.status <= 399) {
        await r.body?.cancel().catch(() => {});
        const loc = r.headers.get('location');
        if (!loc || hop >= (opts.maxHops ?? 4)) return null;
        try { target = new URL(loc, target); } catch { return null; }
        continue;
      }
      return { status: r.status, headers: r.headers, url: target.toString(), body: await readCapped(r, opts.maxBytes) };
    }
  } catch {
    return null;
  }
}

/**
 * Refuse a host that is, or resolves to, anything but the public internet. Literals and local names are judged without
 * DNS, as assertPublicHost judges them. Unlike assertPublicHost, a name that does not resolve is let through: the fetch
 * right after it then fails on its own, and this guards fetches whose failure the caller already handles (a chapter
 * page). Only a private answer is the danger.
 */
export async function assertNotPrivateHost(hostname: string): Promise<void> {
  if (isBlockedHost(hostname)) throw new BlockedAddress(hostname);
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(h)) return;
  let addrs: Array<{ address: string }>;
  try { addrs = await lookup(h, { all: true }); } catch { return; }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new BlockedAddress(hostname);
}

/** Header names a redirect to another origin must not carry: they are credentials for the first one. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/**
 * fetch() for a URL a site named, with redirects followed by hand so every hop is checked by assertNotPrivateHost.
 * Resolves the final response (the caller reads its status and body, the body with readCapped); throws BlockedAddress
 * for a hop that is not public. `exemptFirst` lets the FIRST hop skip the host rule -- the extension engine's own page
 * proxy URLs, which are private by design and which only an engine-backed source hands over. Credentials go to the
 * first origin only. Reintroduce by calling fetch(u) with redirects followed: downloaderGuard.test.ts sees the
 * loopback page fetched and stored.
 */
export async function fetchFollowingPublic(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
  opts: { exemptFirst?: (u: URL) => boolean; maxHops?: number } = {},
): Promise<Response> {
  let target = new URL(url);
  const first = target.origin;
  for (let hop = 0; ; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new BlockedAddress(target.href);
    if (!(hop === 0 && opts.exemptFirst?.(target))) await assertNotPrivateHost(target.hostname);
    const headers = target.origin === first ? init.headers
      : Object.fromEntries(Object.entries(init.headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())));
    const r = await fetch(target, { headers, redirect: 'manual', signal: init.signal });
    if (r.status < 300 || r.status > 399 || r.status === 304) return r;
    const loc = r.headers.get('location');
    if (!loc || hop >= (opts.maxHops ?? 4)) return r; // an unfollowed redirect reads as the failed status it is
    await r.body?.cancel().catch(() => {});
    target = new URL(loc, target);
  }
}
