// Test-only source adapters backed by web/test/e2e/fakeSource.mjs.
//
// Nothing is registered unless FAKE_SOURCE_URLS is set. Keeping the gate here, rather than in the e2e
// compose script alone, is what makes an ordinary install incapable of discovering a host-side test stub
// by accident. The value is a comma-separated list of `adapter-id=http://host:port` pairs.
import type { SourceAdapter, SourceChapter, SourceSeries } from './types';
import { offlineNotice, siteOffline } from './offline';

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

async function json(base: string, path: string, missing = false): Promise<any> {
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
  if (/^text\/html/i.test(r.headers.get('content-type') || '')) {
    const said = offlineNotice(await r.text(), FAKE_MARKUP);
    if (said) throw siteOffline(said);
    throw Object.assign(new Error(`fake source answered HTML, not JSON (${r.status})`), { status: r.status });
  }
  return r.json();
}

const arrayOf = <T>(body: any): T[] => Array.isArray(body) ? body : Array.isArray(body?.content) ? body.content : [];
const objectOf = (body: any): Json | null => body && typeof body === 'object' && !Array.isArray(body)
  ? (body.content && typeof body.content === 'object' && !Array.isArray(body.content) ? body.content : body)
  : null;

/** Build one adapter. Deliberately no pageConcurrency/pageGapMs: the downloader's defaults are under test. */
export function makeFakeSource(id: string, base: string): SourceAdapter {
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
    requiresCloudflare: false,
    async search(query) {
      return arrayOf<any>(await json(base, `/search?q=${encodeURIComponent(query)}`))
        .filter((v) => v && v.sourceId && v.title)
        .map(series);
    },
    async getSeries(sourceId) {
      const body = await json(base, `/series/${encodeURIComponent(sourceId)}`, true);
      const value = objectOf(body);
      return value?.sourceId && value?.title ? series(value) : null;
    },
    async listChapters(seriesId) {
      return arrayOf<any>(await json(base, `/chapters/${encodeURIComponent(seriesId)}`))
        .map(chapter)
        .filter((v) => v.sourceId && Number.isFinite(v.number));
    },
    async getPageUrls(chapterId) {
      return arrayOf<unknown>(await json(base, `/pages/${encodeURIComponent(chapterId)}`))
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

/** Read the env at registration time so reload-all honours a knob changed before the reload. */
export function fakeSources(raw = process.env.FAKE_SOURCE_URLS || '', nsfwRaw = process.env.FAKE_SOURCE_NSFW || ''): SourceAdapter[] {
  const nsfw = fakeNsfwIds(nsfwRaw);
  return fakeSourceConfig(raw).map(({ id, base }) => {
    const adapter = makeFakeSource(id, base);
    // Set only when asked for: an absent `isNsfw` is what every built-in and custom site reports, and
    // `sourceAllowedFor` reads absent as "not adult" on purpose (lib/visibility.ts).
    return nsfw.has(id) ? { ...adapter, isNsfw: true } : adapter;
  });
}
