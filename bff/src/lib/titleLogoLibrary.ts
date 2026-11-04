// The Uchiyomi logo library (v0.103.0): title logos chosen and cut out by hand, one per AniList manga, published as a
// public repository. Its index.json names each logo's file and SHA-256. A logo is downloaded only for an id the index
// lists and used only when its bytes hash to that entry. The library is asked before Wikimedia; a library that cannot
// be reached is no answer, never a miss.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fetchPublic } from './safeFetch';
import type { TitleLogoCandidate } from './titleLogoProvider';

export const DEFAULT_TITLE_LOGO_LIBRARY = 'https://raw.githubusercontent.com/AngeloSha/uchiyomi-title-logos/main/';
export interface LibraryEntry { file: string; sha256: string; lang: string | null }
/** `attempt` (`<anilistId>:<sha256>`) names the library logo that was tried, found or not; null when none was listed. */
export interface LibraryAnswer { candidate: TitleLogoCandidate | null; attempt: string | null }

const USER_AGENT = 'Uchiyomi-title-art/1 (+https://github.com/AngeloSha/uchiyomi)';
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
const LOGO_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 8_000_000;
const MAX_ENTRIES = 50_000;
const FRESH_MS = 24 * 3600_000;
const RETRY_MS = 3600_000;
const ID = /^[1-9]\d{0,9}$/;

/** An https base without credentials, query or fragment; every library file is read relative to it. */
export function libraryBase(raw: string): URL | null {
  if (!raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u;
  } catch { return null; }
}

/** Where a person reads about the library: the repository for GitHub's raw files, else the mirror itself. */
export function libraryPage(base: URL): string {
  const m = base.hostname === 'raw.githubusercontent.com' ? base.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\//) : null;
  return m ? `https://github.com/${m[1]}/${m[2]}` : base.href;
}

/** Entries that are not exactly `logos/<id>.webp` with a SHA-256 are skipped, not trusted. */
export function parseLibraryIndex(body: Buffer | string): Map<string, LibraryEntry> | null {
  let raw: unknown;
  try { raw = JSON.parse(body.toString()); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = new Map<string, LibraryEntry>();
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (entries.size >= MAX_ENTRIES) break;
    if (!ID.test(id) || !v || typeof v !== 'object' || v.file !== `logos/${id}.webp`) continue;
    if (typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) continue;
    entries.set(id, { file: v.file, sha256: v.sha256, lang: typeof v.lang === 'string' && /^[a-z]{2,3}$/.test(v.lang) ? v.lang : null });
  }
  return entries;
}

async function transparentWebp(bytes: Buffer): Promise<boolean> {
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (meta.format !== 'webp' || !meta.hasAlpha || !meta.width || !meta.height || meta.width < 16 || meta.height < 8 || (meta.pages ?? 1) > 1) return false;
    const stats = await image.stats(); // Decode under the pixel cap: a header is not proof of a valid image.
    return !stats.isOpaque && (stats.channels[stats.channels.length - 1]?.max ?? 0) > 0;
  } catch { return false; }
}

type Dependencies = { fetchPublic?: typeof fetchPublic; now?: () => number; url?: () => string };
/** Injectable transport, clock and URL for tests; the server reads TITLE_LOGO_LIBRARY_URL (empty turns it off). */
export function createTitleLogoLibrary(deps: Dependencies = {}) {
  const fetcher = deps.fetchPublic ?? fetchPublic;
  const now = deps.now ?? Date.now;
  const configured = deps.url ?? (() => process.env.TITLE_LOGO_LIBRARY_URL ?? DEFAULT_TITLE_LOGO_LIBRARY);
  let index: { base: string; entries: Map<string, LibraryEntry>; at: number } | null = null;
  let failed: { base: string; at: number } | null = null;
  let loading: Promise<void> | null = null;
  const base = () => libraryBase(configured());

  async function load(from: URL): Promise<void> {
    const r = await fetcher(new URL('index.json', from), { maxBytes: INDEX_MAX_BYTES, timeoutMs: 15_000, maxHops: 0,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' } }).catch(() => null);
    const entries = r?.status === 200 ? parseLibraryIndex(r.body) : null;
    if (entries) { index = { base: from.href, entries, at: now() }; failed = null; }
    else failed = { base: from.href, at: now() };
  }
  /** The index is read once a day, and at most hourly while the library cannot be reached. */
  async function refresh(): Promise<void> {
    const from = base();
    if (!from || (index?.base === from.href && now() - index.at < FRESH_MS) || (failed?.base === from.href && now() - failed.at < RETRY_MS)) return;
    loading ??= load(from).finally(() => { loading = null; });
    await loading;
  }
  /** The configured library's index if it was read in the last two days; null when off or not reached. No network. */
  function snapshot(): Map<string, LibraryEntry> | null {
    const from = base();
    return from && index?.base === from.href && now() - index.at < 2 * FRESH_MS ? index.entries : null;
  }
  async function lookup(anilistId: string): Promise<LibraryAnswer> {
    if (!ID.test(anilistId)) return { candidate: null, attempt: null };
    await refresh();
    const from = base(); const entry = snapshot()?.get(anilistId);
    if (!from || !entry) return { candidate: null, attempt: null };
    const attempt = `${anilistId}:${entry.sha256}`;
    const r = await fetcher(new URL(entry.file, from), { maxBytes: LOGO_MAX_BYTES, timeoutMs: 20_000, maxHops: 0,
      headers: { 'user-agent': USER_AGENT, accept: 'image/webp' } }).catch(() => null);
    // A changed, truncated or substituted file never publishes: only the exact bytes the index names.
    if (r?.status !== 200 || createHash('sha256').update(r.body).digest('hex') !== entry.sha256 || !(await transparentWebp(r.body))) {
      return { candidate: null, attempt };
    }
    return { attempt, candidate: { bytes: r.body, language: entry.lang, showReadableTitle: entry.lang !== 'en',
      attribution: { provider: 'library', pageUrl: libraryPage(from), fileName: entry.file, author: null, license: null, licenseUrl: null } } };
  }
  return { refresh, snapshot, lookup };
}

export const titleLogoLibrary = createTitleLogoLibrary();
