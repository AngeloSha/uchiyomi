// MangaUpdates, for the one question Discover asks it (v0.56.0, lib/discoverIdentity.ts): which work is this name? It
// keeps the most complete list of the names a series goes by -- every scanlation title a manhwa was ever posted under --
// which is exactly what tells two sites naming one series differently apart. Free, no key. Asked only after AniList and
// MangaDex found nothing, and paced well under its limits: one request a second, from this module alone.
import { normTitle } from './titleMatch';

/**
 * Where MangaUpdates is: MANGAUPDATES_API_URL moves it (a test points it at a fake), as ANILIST_API_URL moves AniList.
 * Read once at module load; unset, it is MangaUpdates' own API (docs/CONFIGURATION.md).
 */
const MU = (process.env.MANGAUPDATES_API_URL || 'https://api.mangaupdates.com/v1').replace(/\/+$/, '');
let gapMs = 1000;
let nextAt = 0;

/**
 * Wait for this request's turn: one a second, whoever asks -- Discover's name lookups here and, since #244, the
 * MangaUpdates tracker (lib/trackerProviders.ts), which goes through this same gate so one person's list import or a
 * burst of pushes cannot get the server's address throttled for everyone else's lookups.
 */
export async function muTurn(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextAt);
  nextAt = start + gapMs;
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
}

/** Tests only: a shorter gap, so a suite of calls does not take a second each. */
export function setMangaUpdatesGap(ms: number): void { gapMs = ms; nextAt = 0; }

/** One MangaUpdates call as JSON. Throws on anything but an answer: a network error, a 429 or a 5xx is not a miss. */
async function muFetch(path: string, init?: RequestInit): Promise<any> {
  await muTurn();
  const r = await fetch(`${MU}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Uchiyomi/1.0 (self-hosted personal reader)' },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error(`mangaupdates ${r.status}`), { status: r.status });
  return r.json();
}

/** A MangaUpdates series as Discover needs it: its id, and every name it goes by (its title and associated names). */
export interface MangaUpdatesWork { id: string; names: string[] }

/**
 * The series a name is, by MangaUpdates: up to five search hits, each read as its title and the name the search matched
 * on (`hit_title`, which may be an associated name), then -- for the first hit `accept` takes -- its full list of
 * associated names. Null when no hit is that name. Throws on a transient failure, so the caller asks again later rather
 * than storing a miss.
 */
export async function searchMangaUpdates(title: string, accept: (names: string[]) => boolean): Promise<MangaUpdatesWork | null> {
  const s = title.trim();
  if (!s) return null;
  const j = await muFetch('/series/search', { method: 'POST', body: JSON.stringify({ search: s, perpage: 5 }) });
  const results: any[] = Array.isArray(j?.results) ? j.results : [];
  for (const res of results) {
    const rec = res?.record;
    const id = rec?.series_id;
    if (id === undefined || id === null) continue;
    const seen = [rec.title, res.hit_title].filter((t): t is string => typeof t === 'string' && !!t.trim());
    if (!accept(seen)) continue;
    const full = await muFetch(`/series/${encodeURIComponent(String(id))}`);
    const associated: string[] = Array.isArray(full?.associated)
      ? full.associated.map((a: any) => a?.title).filter((t: unknown): t is string => typeof t === 'string' && !!t.trim())
      : [];
    return { id: String(id), names: [...new Set([...seen, ...associated])] };
  }
  return null;
}

/** How long the groups found for a series are kept: a series' translators change over months, not hours. */
const GROUPS_KEEP_MS = 7 * 24 * 3600_000;
const groupsSeen = new Map<string, { at: number; groups: string[] }>();

/** Tests only. */
export function _forgetMangaUpdatesGroups(): void { groupsSeen.clear(); }

/**
 * The scanlation groups MangaUpdates says release a series (v0.83.0): what puts a repository extension named after one of
 * them first when the scout tries extensions for a series no installed source has (lib/sourceScout.ts storeLook). Most
 * sources name no group on their chapters, so without this a series has none to go by, and the ranking falls back to
 * how often each extension is downloaded -- which put MANGA Plus and a Western-comics site first for a Korean webtoon on
 * the owner's library, and Flame Comics, which MangaUpdates says translates it, third.
 *
 * Found by its names: the series' title and other names (`names`) against the hit's own title and the name it matched on,
 * equal once normalised (lib/titleMatch.ts normTitle) -- a series with a similar name is never taken for it. Kept a week
 * per series. Empty when MangaUpdates does not know it; empty and not kept when it did not answer, so the next look asks
 * again. Never throws.
 */
export async function mangaUpdatesGroups(seriesId: string, names: readonly string[]): Promise<string[]> {
  const kept = groupsSeen.get(seriesId);
  if (kept && Date.now() - kept.at < GROUPS_KEEP_MS) return kept.groups;
  const want = new Set(names.map(normTitle).filter((k) => k.length >= 3));
  if (!want.size) return [];
  let groups: string[] = [];
  try {
    const work = await searchMangaUpdates(names[0], (seen) => seen.some((n) => want.has(normTitle(n))));
    if (work) {
      const j = await muFetch(`/series/${encodeURIComponent(work.id)}/groups`);
      const list: any[] = Array.isArray(j?.group_list) ? j.group_list : [];
      groups = [...new Set(list.map((g) => g?.name).filter((n: unknown): n is string => typeof n === 'string' && !!n.trim()))];
    }
  } catch {
    return [];
  }
  groupsSeen.set(seriesId, { at: Date.now(), groups });
  return groups;
}
