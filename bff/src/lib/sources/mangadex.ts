// MangaDex built-in source — official public API (no key, no scraping, no Cloudflare). The most defensible
// source, so it's bundled in the core and always on. Docs: https://api.mangadex.org/docs/
//
// v0.52.0 (#123): one adapter per language. `mangadex` is English, always on, and asks exactly what it always
// asked, its fallback chain included. Every other language an admin turns on in Admin → Providers is an adapter
// of its own, `mangadex-es-419` / "MangaDex (ES-419)", which asks MangaDex for that one language and nothing else
// (sources/mangadexLangs.ts registers them). All of them share the one rate limit below.
import { SourceAdapter, SourceSeries, SourceChapter } from './types';
import { directionFromLanguage } from '../directionSignals';
import { canonLang, langLabel, mdLang } from '../lang';

const API = 'https://api.mangadex.org';
const HEADERS = { 'user-agent': 'Uchiyomi/1.0 (self-hosted personal reader)' };
const RATINGS = ['safe', 'suggestive', 'erotica'].map((r) => `contentRating[]=${r}`).join('&');

/** The rate group every MangaDex adapter declares (types.ts `rateGroup`): one API, one limit, however many languages. */
export const MANGADEX_GROUP = 'mangadex';

// ---- One rate limit for every MangaDex source ------------------------------------------------------------------
//
// MangaDex limits by address: about five API requests a second, and forty /at-home/server lookups a minute. Until
// v0.52.0 one adapter asked, nothing spaced its requests, and a 429 was a thrown "mangadex 429" with the headers
// that said how long to wait thrown away. With an adapter per language, a sweep, Discover's Newest and a search in
// five languages are five times the requests from one address, so every request of every language comes here:
//
//   - starts are spaced per kind, the slot reserved before the wait: two adapters may overlap, never burst;
//   - a 429 pauses EVERY language until the moment MangaDex named (X-RateLimit-Retry-After, epoch seconds, else
//     Retry-After), and a 200 that says nothing is left in the window (X-RateLimit-Remaining: 0) pauses ahead of
//     time instead of spending a request on the 429;
//   - a request that would wait longer than `maxWaitMs` is refused at once, without being sent, tagged
//     `selfTimeout`: the listing paths then record "slow" rather than a cooldown (routes/sources.ts), so a pause
//     another language earned never costs this one fifteen minutes, and abandoned requests never queue up to
//     burst the moment the pause ends. Its message says "rate limit", which the downloader reads as rate_limited.
//
// Cooldowns (source_health) stay per adapter on purpose; this pause is what holds every language back.

type Kind = 'api' | 'atHome';
interface Pacing { apiGapMs: number; atHomeGapMs: number; maxWaitMs: number }
/** About four requests a second (the limit is about five), /at-home/server about 37 a minute (of 40), ten seconds of patience. */
const PACING: Pacing = { apiGapMs: 250, atHomeGapMs: 1600, maxWaitMs: 10_000 };
/** A pause lasts at least a second and at most ten minutes, whatever the header says: past that, the next request re-tests. */
const PAUSE_MIN_MS = 1000;
const PAUSE_MAX_MS = 10 * 60_000;

let pacing: Pacing = { ...PACING };
const nextAt: Record<Kind, number> = { api: 0, atHome: 0 };
let pausedUntil = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * When MangaDex said to come back, held between a second and ten minutes from now. X-RateLimit-Retry-After is a
 * moment in epoch seconds; a small number there is read as seconds from now rather than as a moment in 1970.
 * Retry-After is seconds, or an HTTP date.
 */
function pauseEnd(h: Headers, now: number): number {
  const x = Number(h.get('x-ratelimit-retry-after'));
  const ra = h.get('retry-after');
  const secs = Number(ra);
  const at = x > 1e9 ? x * 1000
    : x > 0 ? now + x * 1000
    : ra && Number.isFinite(secs) ? now + secs * 1000
    : ra ? Date.parse(ra)
    : NaN;
  return Math.min(now + PAUSE_MAX_MS, Math.max(now + PAUSE_MIN_MS, Number.isFinite(at) ? at : 0));
}

/** Wait for this request's turn: its slot in the spacing for its kind, and the end of any pause. */
async function turn(kind: Kind): Promise<void> {
  for (;;) {
    const now = Date.now();
    const start = Math.max(now, nextAt[kind], pausedUntil);
    if (start - now > pacing.maxWaitMs) {
      const ms = start - now;
      throw Object.assign(new Error(`mangadex: rate limit, paused ~${Math.ceil(ms / 1000)}s`), { selfTimeout: true, ms });
    }
    nextAt[kind] = start + (kind === 'atHome' ? pacing.atHomeGapMs : pacing.apiGapMs);
    if (start > now) await sleep(start - now);
    // A pause that began while this request waited its turn -- another language's 429 -- holds it as well.
    if (pausedUntil <= Date.now()) return;
  }
}

/**
 * GET one MangaDex API URL as JSON, through the shared limit. `atHome` for /at-home/server, which MangaDex limits on
 * its own. Throws "mangadex <status>" for any other answer than OK, with `status` on the error.
 */
export async function mdGet(url: string, kind: Kind = 'api'): Promise<any> {
  await turn(kind);
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) {
    pausedUntil = Math.max(pausedUntil, pauseEnd(r.headers, Date.now()));
    throw Object.assign(new Error('mangadex 429'), { status: 429 });
  }
  if (!r.ok) throw Object.assign(new Error(`mangadex ${r.status}`), { status: r.status });
  if (r.headers.get('x-ratelimit-remaining') === '0') pausedUntil = Math.max(pausedUntil, pauseEnd(r.headers, Date.now()));
  return r.json();
}

/** Tests only: the spacing and the patience, field by field; `null` puts back the real ones. */
export function _setMangadexPacing(p: Partial<Pacing> | null): void {
  pacing = p ? { ...pacing, ...p } : { ...PACING };
}
/** Tests only: forget every reserved slot and any pause, so one test's 429 does not hold up the next. */
export function _resetMangadexLimiter(): void {
  nextAt.api = 0;
  nextAt.atHome = 0;
  pausedUntil = 0;
}

// ---- the adapters --------------------------------------------------------------------------------------------

function firstLang(obj: any): string {
  if (!obj) return '';
  return obj.en || obj['ja-ro'] || (Object.values(obj)[0] as string) || '';
}

/** The content ratings MangaDex gives a title. */
const CONTENT_RATINGS = new Set(['safe', 'suggestive', 'erotica', 'pornographic']);

function toSeries(m: any, source: string): SourceSeries {
  const a = m.attributes || {};
  const cover = (m.relationships || []).find((r: any) => r.type === 'cover_art');
  const author = (m.relationships || []).find((r: any) => r.type === 'author' || r.type === 'artist');
  const genres = (a.tags || [])
    .filter((t: any) => ['genre', 'theme'].includes(t.attributes?.group))
    .map((t: any) => firstLang(t.attributes?.name))
    .filter(Boolean);
  return {
    sourceId: m.id,
    // The adapter's own id: a hit from MangaDex (ES-419) is added from MangaDex (ES-419), not from English.
    source,
    title: firstLang(a.title) || (a.altTitles || []).map((t: any) => firstLang(t)).find(Boolean) || 'Untitled',
    summary: firstLang(a.description),
    status: a.status ? String(a.status).toUpperCase() : undefined,
    genres,
    author: author?.attributes?.name,
    coverUrl: cover?.attributes?.fileName ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes.fileName}` : undefined,
    url: `https://mangadex.org/title/${m.id}`,
    updatedAt: a.updatedAt || a.createdAt || undefined,
    // Japanese reads right to left, Korean and Chinese as a long strip (lib/readingDirection.ts, #102).
    readingDirection: directionFromLanguage(a.originalLanguage) ?? undefined,
    // And what kind of comic it is (lib/seriesType.ts), from the same field.
    originalLanguage: typeof a.originalLanguage === 'string' && a.originalLanguage ? a.originalLanguage : undefined,
    // MangaDex rates every title (v0.55.4, #158): the one source whose search results say whether they are 18+, which
    // Discover's search filter reads (lib/searchAll.ts ratingOf). Search asks for erotica as well as safe and suggestive.
    ...(CONTENT_RATINGS.has(a.contentRating) ? { contentRating: a.contentRating } : {}),
  };
}


/**
 * The original language of many titles at once, for the repair's reading-direction backfill
 * (lib/readingDirection.ts detectDirections). `ids[]` takes up to 100 per request, so a whole library of
 * MangaDex series is a handful of calls. Every content rating is asked for: this is a lookup by id of titles
 * already in the library, and the default filter would silently answer nothing for an adult one.
 */
export async function mangadexOriginalLanguages(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const qs = chunk.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
    const j = await mdGet(`${API}/manga?${qs}&limit=100&${RATINGS}&contentRating[]=pornographic`);
    for (const m of j.data || []) {
      const lang = m?.attributes?.originalLanguage;
      if (typeof m?.id === 'string' && typeof lang === 'string' && lang) out.set(m.id, lang);
    }
  }
  return out;
}

/**
 * Every name of many titles at once -- each language's title and every alternative title -- for the recheck of a
 * cover the art backfill took from a MangaDex search before the title check existed (v0.55.7, lib/matchCheck.ts).
 * Batched and rated like mangadexOriginalLanguages, through the same limiter; a title MangaDex does not answer for
 * is absent, and a failure throws.
 */
export async function mangadexTitles(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const qs = chunk.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
    const j = await mdGet(`${API}/manga?${qs}&limit=100&${RATINGS}&contentRating[]=pornographic`);
    for (const m of j.data || []) {
      if (typeof m?.id !== 'string') continue;
      const a = m.attributes || {};
      const names = [...Object.values(a.title || {}), ...((a.altTitles || []) as any[]).flatMap((t) => Object.values(t || {}))]
        .filter((n): n is string => typeof n === 'string' && !!n.trim());
      out.set(m.id.toLowerCase(), names);
    }
  }
  return out;
}


/**
 * Languages tried, in order, when a title has no English chapters (the English adapter only).
 *
 * Deliberately short. Each miss is a request, and a title with chapters in NONE of these is one that was
 * already unusable -- so the list buys the common cases (the Spanish- and Portuguese-language scanlation
 * scene is by far the largest after English) without turning a genuinely empty title into a dozen calls on
 * every updater sweep.
 */
const CHAPTER_LANGS = ['en', 'es-la', 'es', 'pt-br', 'fr', 'ru', 'id'] as const;

/** The groups credited on one feed row, in the order MangaDex lists them. Empty when none is attached. */
function groupsOn(c: any): string[] {
  return ((c.relationships || []) as any[])
    .filter((r) => r?.type === 'scanlation_group')
    .map((r) => (typeof r.attributes?.name === 'string' ? r.attributes.name.trim() : ''))
    .filter(Boolean);
}

/**
 * Every chapter MangaDex lists for one series in one language (MangaDex's own code), paged out, ascending by
 * number. A number with several releases comes back as several rows.
 *
 * `includes[]=scanlation_group` expands each row's group relationships from bare `{id,type}` to carry the
 * group's attributes; without it the name is a second request per group. `groups` keeps the names apart
 * because MangaDex is the one source that lists them structurally, and `scanlator` joins them the way
 * Mihon shows a joint release, so the ComicInfo Translator tag reads the same from either app.
 */
async function feedFor(seriesId: string, lang: string): Promise<SourceChapter[]> {
  const all: SourceChapter[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const j = await mdGet(`${API}/manga/${seriesId}/feed?translatedLanguage[]=${encodeURIComponent(lang)}&order[chapter]=asc&order[volume]=asc&limit=500&offset=${offset}&${RATINGS}&includes[]=scanlation_group`);
    total = j.total ?? 0;
    for (const c of j.data || []) {
      const num = parseFloat(c.attributes?.chapter);
      if (Number.isNaN(num)) continue;
      const groups = groupsOn(c);
      all.push({
        sourceId: c.id,
        number: num,
        title: c.attributes?.title || undefined,
        // The app's code, not MangaDex's: "es-la" is "es-419" here, as on the source's name (MangaDex (ES-419))
        // and on every other source, so the Versions sheet and the language guard read one spelling.
        lang: canonLang(c.attributes?.translatedLanguage) ?? undefined,
        pages: c.attributes?.pages,
        publishedAt: c.attributes?.publishAt || c.attributes?.readableAt || undefined,
        scanlator: groups.length ? groups.join(' & ') : undefined,
        groups: groups.length ? groups : undefined,
      });
    }
    offset += 500;
    if (!j.data?.length) break;
  }
  // No collapse to one row per number here any more. This used to keep a hosted copy (pages>0) over an
  // external one (pages=0) and otherwise the first seen; hosted-beats-external is now a tie-break in the
  // chooser in lib/releases.ts, which needs `pages`, already on the row, and which is the only place that
  // knows which group the reader wanted.
  return all.sort((a, b) => a.number - b.number);
}

/** How many series one Newest page shows, and how many chapter rows are read to find them (MangaDex's maximum). */
const NEWEST_SERIES = 24;
const NEWEST_FEED = 100;
/** The chapter list answers nothing past offset + limit = 10,000. */
const FEED_WINDOW = 10_000;

/** The adapter id of MangaDex in one language: `mangadex` for English, `mangadex-es-419`, `mangadex-pt-br`, … */
export function mangadexId(code: string): string {
  const app = canonLang(code) ?? code;
  return app === 'en' ? 'mangadex' : `mangadex-${app.toLowerCase()}`;
}

/**
 * MangaDex in one language, an app code from lib/lang.ts MANGADEX_LANGS ("es-419", "pt-BR", "zh-Hant").
 *
 * English is the `mangadex` adapter and is exactly what it was before v0.52.0, but for Newest: its search is
 * unfiltered and its chapter list falls back through Spanish, Portuguese and the rest when a title has no English.
 * Any other language is that language only: search and Popular find titles with chapters in it, Newest is its
 * newest chapters, and the chapter list is its chapters with no fallback -- a Spanish source that answered in
 * English would mix the languages it exists to keep apart. Throws for a code MangaDex is not offered in.
 */
export function makeMangadex(code: string): SourceAdapter {
  const app = canonLang(code);
  const md = mdLang(app);
  if (!app || !md) throw new Error(`MangaDex is not offered in "${code}"`);
  const english = app === 'en';
  const adapterId = mangadexId(app);
  const series = (m: any) => toSeries(m, adapterId);
  return {
    id: adapterId,
    name: english ? 'MangaDex' : `MangaDex (${langLabel(app)})`,
    // MangaDex hosts every language, but each adapter asks for exactly one. Reporting no language meant English
    // MangaDex joined every language group, so picking Japanese filled a third of the wall with English MangaDex
    // rows -- the "says Japanese, serves English" the owner reported, seen from the reader's side.
    lang: app,
    rateGroup: MANGADEX_GROUP,
    imageReferer: 'https://mangadex.org/', // CDN rejects image fetches without the mangadex referer
    preferredOrder: 10,

    async search(query) {
      // English searches every title, as it always has (its chapter list falls back to other languages). Another
      // language finds only titles that have chapters in it: a hit it cannot serve is a dead end.
      const only = english ? '' : `&availableTranslatedLanguage[]=${md}`;
      const j = await mdGet(`${API}/manga?title=${encodeURIComponent(query)}&limit=12&${RATINGS}&includes[]=cover_art&includes[]=author&order[relevance]=desc${only}`);
      return (j.data || []).map(series);
    },

    /**
     * Discover's Newest: the newest chapters IN THIS LANGUAGE, and the series they belong to, in that order -- two
     * requests a page. It ordered /manga by `latestUploadedChapter`, which counts a chapter in any language, so a
     * title whose last English chapter was a year old headed English Newest the day it came out in Indonesian.
     */
    async latest(page = 1) {
      const offset = (Math.max(1, page) - 1) * NEWEST_FEED;
      if (offset + NEWEST_FEED > FEED_WINDOW) return [];
      const feed = await mdGet(`${API}/chapter?translatedLanguage[]=${md}&order[readableAt]=desc&limit=${NEWEST_FEED}&offset=${offset}&includeExternalUrl=0&includeFuturePublishAt=0&includeEmptyPages=0&${RATINGS}`);
      // Feed order, each series once, at its newest chapter: that chapter's time is when the series was updated.
      const when = new Map<string, string | undefined>();
      for (const c of feed.data || []) {
        const m = ((c.relationships || []) as any[]).find((r) => r?.type === 'manga');
        if (typeof m?.id !== 'string' || when.has(m.id)) continue;
        when.set(m.id, c.attributes?.readableAt || undefined);
        if (when.size >= NEWEST_SERIES) break;
      }
      if (!when.size) return [];
      const ids = [...when.keys()];
      const j = await mdGet(`${API}/manga?${ids.map((i) => `ids[]=${encodeURIComponent(i)}`).join('&')}&limit=${ids.length}&${RATINGS}&includes[]=cover_art&includes[]=author`);
      const byId = new Map<string, any>(((j.data || []) as any[]).map((m) => [m?.id, m]));
      return ids.flatMap((i) => {
        const m = byId.get(i);
        if (!m) return [];
        const s = series(m);
        return [{ ...s, updatedAt: when.get(i) ?? s.updatedAt }];
      });
    },

    // The same endpoint and the same filters as search, ordered by how many people follow the series, among
    // titles with chapters in this language. `toSeries` does not care how the list was sorted.
    async popular(page = 1) {
      const offset = (Math.max(1, page) - 1) * 24;
      const j = await mdGet(`${API}/manga?order[followedCount]=desc&limit=24&offset=${offset}&hasAvailableChapters=true&availableTranslatedLanguage[]=${md}&${RATINGS}&includes[]=cover_art&includes[]=author`);
      return (j.data || []).map(series);
    },

    async getSeries(id) {
      const j = await mdGet(`${API}/manga/${id}?includes[]=cover_art&includes[]=author`);
      return j.data ? series(j.data) : null;
    },

    async listChapters(seriesId) {
      if (!english) return feedFor(seriesId, md);
      // English first, then a fallback order -- ONE LANGUAGE AT A TIME, never all at once.
      //
      // The bug: this asked only for `translatedLanguage[]=en`, so a title whose chapters are all Spanish or
      // Portuguese came back with zero chapters and could not be added at all. It looked like a dead series.
      //
      // Why not simply drop the filter, which is what the obvious fix does: chapter numbers repeat across
      // languages, and the chooser in lib/releases.ts picks one copy per number by group, hosting and date --
      // it has no notion of a preferred language. Pulling every language at once therefore produces a chapter
      // list whose language is decided arbitrarily, per chapter. Asking one language at a time and stopping at
      // the first that answers keeps the result single-language, so the chooser never has to arbitrate that.
      //
      // It also protects the reason this adapter declares `lang: 'en'` at all (see the comment on `lang`):
      // reporting no language made it join every language group, and picking Japanese in the UI then filled a
      // third of the wall with English MangaDex rows.
      for (const lang of CHAPTER_LANGS) {
        const found = await feedFor(seriesId, lang);
        if (found.length) return found;
      }
      return [];
    },

    async getPageUrls(chapterId) {
      const j = await mdGet(`${API}/at-home/server/${chapterId}`, 'atHome');
      const base = j.baseUrl;
      const hash = j.chapter?.hash;
      const files: string[] = j.chapter?.data || [];
      return files.map((f) => `${base}/data/${hash}/${f}`);
    },
  };
}

export const mangadex: SourceAdapter = makeMangadex('en');
