/**
 * Which hosts may the Cloudflare solver open on a CALLER'S behalf?
 *
 * The solver (FlareSolverr) is a real Chrome on the same Docker network as the extension engine and the
 * database. It follows redirects by itself and runs the JavaScript of whatever page it opens. So checking that
 * a caller's host resolves to a public address is necessary and not enough: a public page an outsider controls
 * can redirect it, or script it, straight into the network. The cover proxy (`/img/sources/cover?u=`) takes its
 * URL from the caller, so a URL from there reaches the solver only on a host the SOURCE vouched for:
 *
 *   - its own site -- `base`, which an admin typed in when adding it; or
 *   - a host the source has actually served covers from, learned where every adapter enters the app
 *     (`registerAdapter` wraps the methods that return series).
 *
 * Why not its own site alone: covers often live on a separate CDN, and some of those CDNs are behind Cloudflare
 * too. Aqua's covers are on img-r2.2xstorage.com, which answers 403 to a request without clearance (measured
 * 2026-09-25), on a domain that has nothing to do with the site's own.
 *
 * Library covers are not caller-supplied (they come from series_art) and never go through this check.
 *
 * ⚠️ The learned hosts live in memory, so after a restart a caller-supplied cover on a CDN the source has not
 * served since is fetched without clearance until that source is browsed again. That costs a tile for a
 * minute, never a cached placeholder: the cover route does not store a failure.
 */
import type { SourceAdapter, SourceSeries } from './types';

/** More than any real source uses (usually one or two); the cap only stops a runaway source growing it. */
const MAX_HOSTS_PER_SOURCE = 64;

const learned = new Map<string, Set<string>>();

/** Hostnames compared case-blind, without a trailing dot, and with `www.` treated as the bare domain. */
const norm = (h: string): string => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** Remember that `sourceId` served an image from this URL's host. Anything that is not an http(s) URL is ignored. */
export function noteImageHost(sourceId: string, url: string | null | undefined): void {
  if (!url) return;
  let u: URL;
  try { u = new URL(url); } catch { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  const h = norm(u.hostname);
  if (!h) return;
  let set = learned.get(sourceId);
  if (!set) learned.set(sourceId, (set = new Set()));
  set.delete(h); // re-inserted below, so the oldest host is the one the cap drops
  set.add(h);
  if (set.size > MAX_HOSTS_PER_SOURCE) set.delete(set.values().next().value as string);
}

/**
 * True if the solver may open `hostname` for a cover of this source: the source's own site or a subdomain of
 * it, or a host the source itself has served a cover from. Anything else gets the plain fetch only.
 */
export function solverMayVisit(src: Pick<SourceAdapter, 'id' | 'base'>, hostname: string): boolean {
  const h = norm(hostname);
  if (!h) return false;
  if (src.base) {
    try {
      const own = norm(new URL(src.base).hostname);
      // `.` + own, not own alone: `evilsite.com` ends with `site.com`.
      if (own && (h === own || h.endsWith(`.${own}`))) return true;
    } catch { /* an unparseable base vouches for nothing */ }
  }
  return learned.get(src.id)?.has(h) ?? false;
}

const SERIES_METHODS = ['search', 'getSeries', 'latest', 'popular'] as const;

/**
 * Wrap the adapter's series-returning methods so every cover it hands out teaches `solverMayVisit` its host.
 * Called once, from `registerAdapter`, which every source goes through -- custom sites, built-ins, the
 * extension engine and plugins alike -- so no caller can reach a source's results without passing here.
 */
export function learnImageHosts(a: SourceAdapter): void {
  for (const m of SERIES_METHODS) {
    const orig = (a as any)[m];
    if (typeof orig !== 'function') continue; // optional methods stay absent: callers test for them
    (a as any)[m] = async (...args: unknown[]) => {
      const out = await orig.apply(a, args);
      try {
        for (const s of Array.isArray(out) ? out : out ? [out] : []) noteImageHost(a.id, (s as SourceSeries)?.coverUrl);
      } catch { /* learning is best-effort; the result is what the caller asked for */ }
      return out;
    };
  }
}
