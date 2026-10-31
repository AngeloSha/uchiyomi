// Title artwork is looked up by a checked manga identity, never by a fuzzy anime/title search. Wikimedia's Action
// API keeps this independent of the public SPARQL service. Missing artwork is ordinary; an outage is not a miss.
import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import { plainText } from './htmlText';
import { fetchPublic, type PublicFetch } from './safeFetch';

export interface TitleLogoCandidate {
  bytes: Buffer;
  /** A qualified, known language code; null means that the provider did not identify it. */
  language: string | null;
  showReadableTitle: boolean;
  attribution: {
    provider: 'wikimedia'; pageUrl: string; fileName: string;
    author: string | null; license: string | null; licenseUrl: string | null;
  };
}
export type TitleLogoLookupResult = { kind: 'found'; candidate: TitleLogoCandidate } | { kind: 'missing' };
export interface TitleLogoLookupOptions {
  /** Only an explicit administrator's Find logo action; queued/implicit lookups keep the background maxlag policy. */
  interactive?: boolean;
}

/** The queue can postpone this lookup rather than retaining an outage as "no logo". */
export class TitleLogoProviderUnavailable extends Error {
  constructor(message: string, public retryAfterMs = 5 * 60_000) {
    super(message);
    this.name = 'TitleLogoProviderUnavailable';
  }
}

type Json = Record<string, any>;
type Dependencies = { fetchPublic?: typeof fetchPublic; sleep?: (ms: number) => Promise<unknown>; now?: () => number };
const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'Uchiyomi-title-art/1 (+https://github.com/AngeloSha/uchiyomi)';
const API_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_PIXELS = 8_000_000;
// Wikipedia usage verifies a Commons discovery against the exact manga item, never a search-result title.
const CANONICAL_WIKIS: Record<string, string> = {
  enwiki: 'en.wikipedia.org', eswiki: 'es.wikipedia.org', jawiki: 'ja.wikipedia.org', kowiki: 'ko.wikipedia.org',
  zhwiki: 'zh.wikipedia.org', frwiki: 'fr.wikipedia.org', dewiki: 'de.wikipedia.org', ptwiki: 'pt.wikipedia.org',
  itwiki: 'it.wikipedia.org', arwiki: 'ar.wikipedia.org', rowiki: 'ro.wikipedia.org',
};
const DISCOVERY_SEARCH_LIMIT = 8;
const DISCOVERY_FILE_LIMIT = 3;
const DISCOVERY_WIKI_LIMIT = 2;
const LANGUAGES: Record<string, string> = {
  Q1860: 'en', Q5287: 'ja', Q9176: 'ko', Q7850: 'zh', Q727694: 'zh',
  Q150: 'fr', Q188: 'de', Q1321: 'es', Q7737: 'ru', Q13955: 'ar', Q9288: 'he',
  Q5146: 'pt', Q652: 'it', Q9240: 'id', Q9199: 'vi', Q9217: 'th',
};
const records = (v: unknown): Json[] => Array.isArray(v) ? v.filter((r) => r && typeof r === 'object') : [];
const claims = (item: Json, property: string): Json[] => records(item.claims?.[property]).filter((c) => c.rank !== 'deprecated');
const values = (cs: Json[]): unknown[] => cs.filter((c) => c.mainsnak?.snaktype === 'value').map((c) => c.mainsnak?.datavalue?.value);
const entityIds = (cs: Json[]): string[] => values(cs).map((v: any) => v?.id).filter((v): v is string => typeof v === 'string' && /^Q\d+$/.test(v));
const text = (v: unknown, limit = 500): string | null => {
  if (typeof v !== 'string') return null;
  return plainText(plainText(v.slice(0, 5000))).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) || null;
};
const apiUrl = (base: string, params: Record<string, string>, interactive: boolean) => `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', ...(interactive ? {} : { maxlag: '5' }), ...params })}`;

function retryAfter(r: PublicFetch, now: number): number | undefined {
  const raw = r.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? seconds * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.max(60_000, ms) : undefined;
}

/** Commons may return an unscaled original PNG as thumburl; SVG originals are never accepted. */
function rasterUrl(value: unknown, originalPng = false): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hash) return null;
    if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(u.hostname)) return null;
    if (!/\.png$/i.test(u.pathname)) return null;
    if (!u.pathname.startsWith('/wikipedia/commons/thumb/') && !(originalPng && u.hostname === 'upload.wikimedia.org'
      && /^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+\.png$/i.test(u.pathname))) return null;
    return u.href;
  } catch { return null; }
}

function imageUrl(image: Json): string | null {
  const originalPng = image.mime === 'image/png' && Number.isInteger(image.size) && image.size > 0 && image.size <= IMAGE_MAX_BYTES
    && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width >= 16 && image.height >= 8
    && image.width * image.height <= IMAGE_MAX_PIXELS;
  return rasterUrl(image.thumburl, originalPng) ?? (originalPng ? rasterUrl(image.url, true) : null);
}

const canonicalFile = (value: unknown) => typeof value === 'string' ? value.replace(/^File:/i, '').replace(/_/g, ' ').normalize('NFC') : '';
const canonicalTitle = (value: unknown) => typeof value === 'string' ? value.replace(/_/g, ' ').normalize('NFC') : '';
const words = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
function discoveryName(name: string, names: string[]): boolean {
  const stem = words(name.replace(/\.[^.]+$/, ''));
  // Discovery is deliberately narrower than a P154 claim: only an exact known work name plus a logo label.
  // In particular, films, numbered variants, seasons and anime adaptations do not become a base manga's logo.
  return names.some((n) => ['logo', 'logotype', 'wordmark'].some((mark) => stem === `${words(n)} ${mark}` || stem === `${mark} ${words(n)}`));
}

function licenseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value.trim());
    // Licences are links, never fetched. Keep the recognised public licensing hosts and no credentials/other ports.
    if (!['creativecommons.org', 'www.creativecommons.org', 'commons.wikimedia.org', 'www.gnu.org', 'gnu.org'].includes(u.hostname)) return null;
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    return u.href;
  } catch { return null; }
}

function fileName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f<>\[\]{}|#]/.test(value)) return null;
  const name = value.trim();
  return /\.(?:svg|png|webp|jpe?g|gif|tiff?)$/i.test(name) ? name : null;
}

/** Explicit season/sequel artwork is not a parent manga's title. A manga actually bearing that marker may keep it. */
function unrelatedVariant(name: string, description: string, knownNames: string[]): boolean {
  const source = `${name} ${description}`.normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ');
  const names = knownNames.join(' ').normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ');
  const marks = source.match(/\b(?:final\s+season|season\s*(?:\d+|[ivx]+|one|two|three|four|five)|(?:\d+)(?:st|nd|rd|th)\s+season|cour\s*\d+|(?:part|movie|film)\s*(?:[2-9]\d*|ii\b|iii\b|iv\b)|sequel|spin\s*off|(?:\w+\s+){0,2}arc)\b/g) ?? [];
  return marks.some((mark) => !names.includes(mark));
}

interface Choice { name: string; language: string | null; score: number }
function choices(item: Json): { logos: Choice[]; names: string[] } {
  const original = new Set(entityIds([...claims(item, 'P364'), ...claims(item, 'P407')]));
  const names = [...Object.values(item.labels ?? {}).map((v: any) => v?.value),
    ...Object.values(item.aliases ?? {}).flatMap((v) => records(v).map((a) => a.value))].filter((v): v is string => typeof v === 'string');
  const seen = new Set<string>();
  const logos = claims(item, 'P154').flatMap((c): Choice[] => {
    if (c.mainsnak?.snaktype !== 'value') return [];
    const name = fileName(c.mainsnak?.datavalue?.value);
    if (!name || unrelatedVariant(name, '', names)) return [];
    const ids = records(c.qualifiers?.P407).map((v) => v.datavalue?.value?.id).filter((v): v is string => typeof v === 'string');
    const english = ids.includes('Q1860');
    const own = ids.find((id) => original.has(id));
    // A clearly identified translation that is neither English nor an original language is not an automatic choice.
    if (ids.length && !english && original.size && !own) return [];
    const language = english ? 'en' : ids.length === 1 ? LANGUAGES[ids[0]] ?? null : own ? LANGUAGES[own] ?? null : null;
    const score = (english ? 300 : own ? 200 : ids.length ? 0 : 100) + (c.rank === 'preferred' ? 10 : 0);
    return [{ name, language, score }];
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).filter((logo) => {
    if (seen.has(logo.name)) return false;
    seen.add(logo.name);
    return true;
  });
  return { logos: logos.slice(0, 4), names };
}

async function rasterLogo(bytes: Buffer): Promise<boolean> {
  if (bytes.length > IMAGE_MAX_BYTES || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
  try {
    const image = sharp(bytes, { limitInputPixels: IMAGE_MAX_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (meta.format !== 'png' || !meta.hasAlpha || !meta.width || !meta.height || meta.width < 16 || meta.height < 8 || (meta.pages ?? 1) > 1) return false;
    const stats = await image.stats(); // Decode under the pixel cap: a PNG header is not proof of a valid image.
    return !stats.isOpaque && (stats.channels[stats.channels.length - 1]?.max ?? 0) > 0;
  } catch { return false; }
}

/** Injectable transport/clock for tests; the normal client always uses the shared SSRF-guarded public fetch. */
export function createTitleLogoProvider(deps: Dependencies = {}): (anilistId: string, options?: TitleLogoLookupOptions) => Promise<TitleLogoLookupResult> {
  const fetcher = deps.fetchPublic ?? fetchPublic;
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  let serial: Promise<unknown> = Promise.resolve();
  let lastStart: number | null = null;
  let unavailableUntil = 0;
  const assertAvailable = (): void => {
    const remaining = unavailableUntil - now();
    // A local refusal must not extend the server's deadline when another manga or an admin asks again.
    if (remaining > 0) throw new TitleLogoProviderUnavailable('Wikimedia title artwork is resting', remaining);
  };
  const unavailable = (message: string, retryAfterMs = 5 * 60_000): TitleLogoProviderUnavailable => {
    unavailableUntil = Math.max(unavailableUntil, now() + retryAfterMs);
    return new TitleLogoProviderUnavailable(message, Math.max(0, unavailableUntil - now()));
  };
  const get = (url: string, maxBytes: number): Promise<PublicFetch> => {
    const next = serial.then(async () => {
      assertAvailable();
      if (lastStart != null) await sleep(Math.max(0, 1000 - (now() - lastStart)));
      assertAvailable();
      lastStart = now();
      // No redirects: even an otherwise public redirect must not turn this fixed-provider client into another fetcher.
      let r: PublicFetch | null;
      try {
        r = await fetcher(url, { maxBytes, timeoutMs: 10_000, maxHops: 0, headers: { 'user-agent': USER_AGENT, accept: maxBytes === IMAGE_MAX_BYTES ? 'image/png' : 'application/json' } });
      } catch { throw unavailable('Wikimedia title artwork is unavailable'); }
      if (!r || r.url !== url || r.body.length > maxBytes) throw unavailable('Wikimedia title artwork is unavailable');
      if (r.status === 429 || r.status === 403 || r.status >= 500) throw unavailable(`Wikimedia title artwork returned ${r.status}`, retryAfter(r, now()));
      return r;
    });
    serial = next.then(() => undefined, () => undefined);
    return next;
  };
  const json = async (url: string): Promise<Json> => {
    const r = await get(url, API_MAX_BYTES);
    if (r.status !== 200) throw unavailable(`Wikimedia metadata returned ${r.status}`, retryAfter(r, now()));
    let body: Json;
    try { body = JSON.parse(r.body.toString('utf8')); } catch { throw unavailable('Wikimedia metadata was not JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.error) throw unavailable('Wikimedia metadata is temporarily unavailable', retryAfter(r, now()));
    return body;
  };
  return async (anilistId: string, options: TitleLogoLookupOptions = {}): Promise<TitleLogoLookupResult> => {
    if (!/^[1-9]\d{0,9}$/.test(anilistId)) return { kind: 'missing' };
    assertAvailable();
    // MediaWiki explicitly distinguishes a person waiting for a result from background clients yielding to maxlag.
    // This changes metadata's maxlag parameter only; both modes retain pacing, SSRF/image guards and 429 backoff.
    const interactive = options.interactive === true;
    const search = await json(apiUrl(WIKIDATA, { action: 'query', list: 'search', srsearch: `haswbstatement:P8731=${anilistId}`, srnamespace: '0', srlimit: '5' }, interactive));
    if (!Array.isArray(search.query?.search)) throw unavailable('Wikimedia identity search was incomplete');
    if (Number(search.query.searchinfo?.totalhits) > 5 || search.continue) return { kind: 'missing' };
    const ids = [...new Set(records(search.query.search).map((r) => r.title).filter((id): id is string => typeof id === 'string' && /^Q[1-9]\d*$/.test(id)))].slice(0, 5);
    if (!ids.length) return { kind: 'missing' };
    const body = await json(apiUrl(WIKIDATA, { action: 'wbgetentities', ids: ids.join('|'), props: 'claims|labels|aliases|sitelinks',
      languages: 'en|ja|ko|zh', sitefilter: Object.keys(CANONICAL_WIKIS).join('|') }, interactive));
    if (!body.entities || typeof body.entities !== 'object') throw unavailable('Wikimedia identities were incomplete');
    if (ids.some((id) => !body.entities[id] || (!body.entities[id].missing && !body.entities[id].claims))) throw unavailable('Wikimedia identities were incomplete');
    const matches = ids.map((id) => body.entities[id]).filter((e): e is Json => e && typeof e === 'object' && values(claims(e, 'P8731')).includes(anilistId));
    if (matches.length !== 1) return { kind: 'missing' }; // Duplicated or changed identities need a human choice.
    const item = matches[0];
    const { logos, names } = choices(item);
    const imageParams = { iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1200', iiurlheight: '600',
      iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|ImageDescription' };
    const candidate = async (logo: Choice, page: Json): Promise<TitleLogoLookupResult | null> => {
      const image = records(page.imageinfo)[0];
      if (!image) return null;
      const meta = image.extmetadata ?? {};
      if (unrelatedVariant(logo.name, text(meta.ImageDescription?.value, 2000) ?? '', names)) return null;
      const url = imageUrl(image);
      if (!url) return null;
      const r = await get(url, IMAGE_MAX_BYTES);
      if (r.status === 404 || r.status === 410) return null;
      if (r.status !== 200) throw unavailable(`Wikimedia artwork returned ${r.status}`, retryAfter(r, now()));
      if ((r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'image/png' || !(await rasterLogo(r.body))) return null;
      return { kind: 'found', candidate: {
        bytes: r.body, language: logo.language, showReadableTitle: logo.language !== 'en',
        attribution: { provider: 'wikimedia', fileName: logo.name, pageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(logo.name).replace(/%20/g, '_')}`,
          author: text(meta.Artist?.value), license: text(meta.LicenseShortName?.value, 200), licenseUrl: licenseUrl(meta.LicenseUrl?.value) },
      } };
    };
    for (const logo of logos) {
      const info = await json(apiUrl(COMMONS, { action: 'query', titles: `File:${logo.name}`, prop: 'imageinfo', ...imageParams }, interactive));
      if (!Array.isArray(info.query?.pages)) throw unavailable('Wikimedia image metadata was incomplete');
      const page = records(info.query.pages).find((p) => canonicalFile(p.title) === canonicalFile(logo.name) && !p.missing);
      if (!page) continue;
      const result = await candidate(logo, page);
      if (result) return result;
    }

    // P154 is often absent even when Commons has the title. A search can discover candidates, but can never
    // authorize one: its use on a canonical wiki page must resolve back to this exact AniList-verified item.
    const links = Object.entries(item.sitelinks ?? {}).filter(([site, link]: [string, any]) => Object.hasOwn(CANONICAL_WIKIS, site)
      && typeof link?.title === 'string' && link.title.length <= 500);
    if (!links.length || typeof item.id !== 'string' || !ids.includes(item.id)) return { kind: 'missing' };
    const commonsName = values(claims(item, 'P373')).find((name): name is string => typeof name === 'string' && names.some((n) => words(n) === words(name)));
    const label = commonsName ?? item.labels?.en?.value ?? names[0];
    const term = typeof label === 'string' ? words(label).slice(0, 180) : '';
    if (!term) return { kind: 'missing' };
    const found = await json(apiUrl(COMMONS, { action: 'query', list: 'search', srnamespace: '6',
      srsearch: `intitle:"${term}" intitle:logo`, srlimit: String(DISCOVERY_SEARCH_LIMIT) }, interactive));
    if (!Array.isArray(found.query?.search)) throw unavailable('Wikimedia artwork search was incomplete');
    const candidates = [...new Set(records(found.query.search).slice(0, DISCOVERY_SEARCH_LIMIT).map((p) => fileName(canonicalFile(p.title)))
      .filter((name): name is string => !!name && discoveryName(name, names) && !unrelatedVariant(name, '', names)))].slice(0, DISCOVERY_FILE_LIMIT);
    if (!candidates.length) return { kind: 'missing' };
    const info = await json(apiUrl(COMMONS, { action: 'query', titles: candidates.map((name) => `File:${name}`).join('|'),
      prop: 'imageinfo|globalusage', gulimit: '20', guprop: 'url', ...imageParams }, interactive));
    if (!Array.isArray(info.query?.pages)) throw unavailable('Wikimedia discovered artwork metadata was incomplete');
    const verified = new Map<string, boolean>();
    for (const name of candidates) {
      const page = records(info.query.pages).find((p) => canonicalFile(p.title) === name && !p.missing);
      if (!page || !Array.isArray(page.globalusage) || !imageUrl(records(page.imageinfo)[0] ?? {})) continue;
      const description = text(records(page.imageinfo)[0]?.extmetadata?.ImageDescription?.value, 2000) ?? '';
      if (unrelatedVariant(name, description, names) || /\b(?:anime|animated|television|tv series|film|movie|live.action|adaptation)\b/i.test(description)) continue;
      let exact = false;
      for (const use of records(page.globalusage).slice(0, 20)) {
        // GlobalUsage's `wiki` is a hostname (es.wikipedia.org), whereas Wikidata sitelinks use a site id (eswiki).
        const link = links.find(([site, l]: [string, any]) => CANONICAL_WIKIS[site] === use.wiki && canonicalTitle(l.title) === canonicalTitle(use.title));
        if (!link) continue;
        const key = `${link[0]}:${canonicalTitle(use.title)}`;
        if (!verified.has(key)) {
          if (verified.size >= DISCOVERY_WIKI_LIMIT) continue;
          const identity = await json(apiUrl(`https://${CANONICAL_WIKIS[link[0]]}/w/api.php`, { action: 'query',
            titles: canonicalTitle(use.title), prop: 'pageprops', ppprop: 'wikibase_item' }, interactive));
          if (!Array.isArray(identity.query?.pages)) throw unavailable('Wikimedia canonical page identity was incomplete');
          verified.set(key, records(identity.query.pages).some((p) => !p.missing && canonicalTitle(p.title) === canonicalTitle(use.title)
            && p.pageprops?.wikibase_item === item.id));
        }
        if (verified.get(key)) { exact = true; break; }
      }
      if (!exact) continue;
      const result = await candidate({ name, language: null, score: 0 }, page);
      if (result) return result;
    }
    return { kind: 'missing' };
  };
}

export const lookupTitleLogo = createTitleLogoProvider();
