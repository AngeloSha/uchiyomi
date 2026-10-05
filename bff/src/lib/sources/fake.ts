// Test-only source adapters backed by web/test/e2e/fakeSource.mjs.
//
// Nothing is registered unless FAKE_SOURCE_URLS is set. Keeping the gate here, rather than in the e2e
// compose script alone, is what makes an ordinary install incapable of discovering a host-side test stub
// by accident. The value is a comma-separated list of `adapter-id=http://host:port` pairs.
import type { SourceAdapter, SourceChapter, SourceSeries } from './types';
import { offlineNotice, siteOffline } from './offline';
import { cfGet } from './flaresolverr';

type Json = Record<string, unknown>;

const trimBase = (value: string): string => value.trim().replace(/\/+$/, '');

/**
 * The stub's own markup, for offlineNotice (lib/sources/offline.ts): every answer a WORKING stub gives about a series
 * or a chapter is JSON naming a `sourceId`. An HTML page carrying one is the site working, whatever its title says.
 */
export const FAKE_MARKUP = /"sourceId"\s*:/;

/** Parse the test knob without accepting an entry that cannot be an adapter id and an absolute URL. */
export function fakeSourceConfig(raw = process.env.FAKE_SOURCE_URLS || ''): Array<{ id: string; base: string }> {
  const out: Array<{ id: string; base: string }> = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const id = entry.slice(0, at).trim();
    const base = trimBase(entry.slice(at + 1));
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id) || seen.has(id)) continue;
    try {
      const u = new URL(base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      seen.add(id);
      out.push({ id, base: u.toString().replace(/\/$/, '') });
    } catch { /* A malformed test entry is ignored just like a malformed source plugin. */ }
  }
  return out;
}

function endpoint(base: string, path: string): string {
  return new URL(path.replace(/^\//, ''), `${base}/`).toString();
}

async function json(base: string, path: string, missing = false, cloudflare = false): Promise<any> {
  if (cloudflare) return viaSolver(base, path, missing);
  const r = await fetch(endpoint(base, path), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (missing && r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error(`fake source ${r.status}`), { status: r.status });
  // Rig-only (v0.49.1): the stub's `offline` behaviour answers every route with a small HTML page, the way aqua has
  // since 2026-09-23. A site engine that parses such a page to nothing asks the REAL offlineNotice whether it is the
  // site's own notice and throws the classified error when it is (madara.ts, manganato.ts); this asks the same
  // question of the same function, so the walk (web/test/e2e/walk491.mjs) sees Health's "The site says it is
  // offline", its evidence and its diagnosis come out of the product's own path. Any other HTML is a plain failure.
  if (/^text\/html/i.test(r.headers.get('content-type') || '')) return htmlFailure(await r.text(), r.status);
  return r.json();
}

function htmlFailure(html: string, status?: number): never {
  const said = offlineNotice(html, FAKE_MARKUP);
  if (said) throw siteOffline(said);
  throw Object.assign(new Error(`fake source answered HTML, not JSON (${status ?? 'through the solver'})`), status ? { status } : {});
}

/**
 * Rig-only (v0.55.3): a stub behind a fake Cloudflare (fakeSource.mjs --cloudflare) answers nothing without a solver's
 * cf_clearance, so every page of it is asked of the Cloudflare solvers, as a Madara site's adapter asks them (cfGet: the
 * main, then the backup, the per-site memory, the solver-busy retries) -- the backup solver's walk drives the product's
 * own solver client through it. A solver hands back the stub's JSON as its page; the stub's own "not found" is the 404
 * a plain fetch would read.
 */
async function viaSolver(base: string, path: string, missing: boolean): Promise<any> {
  const text = await cfGet(endpoint(base, path));
  if (/^\s*</.test(text)) return htmlFailure(text);
  const body = JSON.parse(text);
  if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
    if (missing && body.error === 'not_found') return null;
    throw new Error(`fake source ${body.error}`);
  }
  return body;
}

const arrayOf = <T>(body: any): T[] => Array.isArray(body) ? body : Array.isArray(body?.content) ? body.content : [];
const objectOf = (body: any): Json | null => body && typeof body === 'object' && !Array.isArray(body)
  ? (body.content && typeof body.content === 'object' && !Array.isArray(body.content) ? body.content : body)
  : null;

/**
 * Build one adapter. Deliberately no pageConcurrency/pageGapMs: the downloader's defaults are under test. `cloudflare`:
 * behind the stub's fake Cloudflare (FAKE_SOURCE_CLOUDFLARE), every page through the solvers and its images with their
 * cookie (downloader.ts cfSession).
 */
export function makeFakeSource(id: string, base: string, cloudflare = false): SourceAdapter {
  const series = (value: any): SourceSeries => ({
    ...(value as SourceSeries),
    sourceId: String(value?.sourceId ?? ''),
    source: id,
    title: String(value?.title ?? ''),
  });
  const chapter = (value: any): SourceChapter => {
    const out: SourceChapter = {
      ...(value as SourceChapter),
      sourceId: String(value?.sourceId ?? ''),
      number: Number(value?.number),
    };
    // The stub's posting position (#116's `--extra v49` series), kept only when it is one. An absent order
    // must stay ABSENT, not become a key holding undefined: a listing without it is one the numbering can
    // only warn about, and the older walks' listings never had it.
    const order = typeof value?.order === 'number' || typeof value?.order === 'string' ? Number(value.order) : NaN;
    if (Number.isFinite(order) && order > 0) out.order = order;
    else delete out.order;
    return out;
  };

  return {
    id,
    name: id,
    base,
    requiresCloudflare: cloudflare,
    async search(query) {
      return arrayOf<any>(await json(base, `/search?q=${encodeURIComponent(query)}`, false, cloudflare))
        .filter((v) => v && v.sourceId && v.title)
        .map(series);
    },
    async getSeries(sourceId) {
      const body = await json(base, `/series/${encodeURIComponent(sourceId)}`, true, cloudflare);
      const value = objectOf(body);
      return value?.sourceId && value?.title ? series(value) : null;
    },
    async listChapters(seriesId) {
      return arrayOf<any>(await json(base, `/chapters/${encodeURIComponent(seriesId)}`, false, cloudflare))
        .map(chapter)
        .filter((v) => v.sourceId && Number.isFinite(v.number));
    },
    async getPageUrls(chapterId) {
      return arrayOf<unknown>(await json(base, `/pages/${encodeURIComponent(chapterId)}`, false, cloudflare))
        .filter((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v));
    },
  };
}

/**
 * Which of the gated adapters declare themselves ADULT, as a comma-separated list of their ids.
 *
 * `isNsfw` is otherwise only ever set by a Suwayomi extension (lib/sources/suwayomi/register.ts), so
 * without this knob there is no way to drive the 18+ rules end to end in a browser: the v0.42.0 walk has
 * to prove that the "Show 18+" reveal keeps an adult PROVIDER off Discover (issue #64), and an instance
 * with no adult provider would pass every one of those checks for the wrong reason.
 *
 * ⚠️ Separate from FAKE_SOURCE_URLS rather than folded into its syntax, because that string is parsed by
 * `fakeSourceConfig` above and read by the v0.40 and v0.41 walks' own rigs; a new field in it would change
 * what those two see. An id here that is not in FAKE_SOURCE_URLS simply marks nothing.
 */
export function fakeNsfwIds(raw = process.env.FAKE_SOURCE_NSFW || ''): Set<string> {
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean));
}

/**
 * Which of the gated adapters sit behind a fake Cloudflare (v0.55.3, the backup solver's walk, web/test/e2e/
 * solverWalk.mjs), as a comma-separated list of their ids, as FAKE_SOURCE_NSFW is: up.sh's E2E_SOLVERS=1 names fake-b,
 * and starts its stub with --cloudflare. An id here that is not in FAKE_SOURCE_URLS marks nothing.
 */
export function fakeCloudflareIds(raw = process.env.FAKE_SOURCE_CLOUDFLARE || ''): Set<string> {
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean));
}

/** Read the env at registration time so reload-all honours a knob changed before the reload. */
export function fakeSources(
  raw = process.env.FAKE_SOURCE_URLS || '', nsfwRaw = process.env.FAKE_SOURCE_NSFW || '', cfRaw = process.env.FAKE_SOURCE_CLOUDFLARE || '',
): SourceAdapter[] {
  const nsfw = fakeNsfwIds(nsfwRaw);
  const cloudflare = fakeCloudflareIds(cfRaw);
  return fakeSourceConfig(raw).map(({ id, base }) => {
    const adapter = makeFakeSource(id, base, cloudflare.has(id));
    // Set only when asked for: an absent `isNsfw` is what every built-in and custom site reports, and
    // `sourceAllowedFor` reads absent as "not adult" on purpose (lib/visibility.ts).
    return nsfw.has(id) ? { ...adapter, isNsfw: true } : adapter;
  });
}
