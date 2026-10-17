// Public-only outbound sockets. Validating DNS before fetch is insufficient: fetch otherwise resolves the
// name again, so a changed answer can connect to an address the guard never approved.
import { lookup } from 'node:dns/promises';
import { Agent, Dispatcher1Wrapper } from 'undici';
import { BlockedAddress, isBlockedHost, isPrivateAddress } from './ssrfGuard';

export type PublicResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: PublicResolver = (hostname) => lookup(hostname, { all: true });

/** Judge every answer and pass only those same answers to net.connect, preserving the request Host and TLS SNI. */
export function publicLookup(resolve: PublicResolver = systemResolver) {
  return (hostname: string, options: any, callback?: any): void => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options ?? {});
    if (isBlockedHost(hostname)) return cb(new BlockedAddress(hostname));
    resolve(hostname).then((all) => {
      if (!all.length || all.some((a) => isPrivateAddress(a.address))) return cb(new BlockedAddress(hostname));
      const family = opts.family === 4 || opts.family === 6 ? opts.family : 0;
      const list = family ? all.filter((a) => a.family === family) : all;
      if (!list.length) return cb(new BlockedAddress(hostname));
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    }, (error) => cb(error)); // Resolution failures never fall back to an unchecked lookup.
  };
}

// Node 24's bundled fetch uses the v1 dispatcher handler API. Undici 8 exposes its compatibility wrapper
// for exactly that consumer; passing a bare v2 Agent would reject every request before opening a socket.
// ⚠️ HTTP/1.1 only. undici 8 offers HTTP/2 unless told not to, and an HTTP/2 answer handed to Node's bundled fetch
// through the package's dispatcher arrived without its content-encoding in 8.11.0 (nodejs/undici#5811): a gzipped body
// read as raw bytes. globalFetch.test.ts guards the global dispatcher; this one is the package's too, and a cover or a
// site's page gains nothing from HTTP/2.
const dispatcher = new Dispatcher1Wrapper(new Agent({ allowH2: false, connect: { lookup: publicLookup() } }));

/** One guarded hop. Callers own redirect policy and body caps; the socket cannot re-resolve an unchecked address. */
export function fetchPublicHop(target: URL, init: { headers?: Record<string, string>; signal: AbortSignal }): Promise<Response> {
  if (!['http:', 'https:'].includes(target.protocol) || isBlockedHost(target.hostname)) {
    return Promise.reject(new BlockedAddress(target.hostname));
  }
  // Node's fetch accepts an undici-compatible dispatcher. Retain global fetch so local synthetic transports
  // can exercise the caller's redirect/header/body logic without contacting any external service.
  // @types/node and the standalone undici package carry distinct FormData types; these are bodyless GETs.
  const options: RequestInit = { ...init, redirect: 'manual', dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']> };
  return fetch(target, options);
}
