// MangaUpdates, for the one question Discover asks it (v0.56.0, lib/discoverIdentity.ts): which work is this name? It
// keeps the most complete list of the names a series goes by -- every scanlation title a manhwa was ever posted under --
// which is exactly what tells two sites naming one series differently apart. Free, no key. Asked only after AniList and
// MangaDex found nothing, and paced well under its limits: one request a second, from this module alone.

/**
 * Where MangaUpdates is: MANGAUPDATES_API_URL moves it (a test points it at a fake), as ANILIST_API_URL moves AniList.
 * Read once at module load; unset, it is MangaUpdates' own API (docs/CONFIGURATION.md).
 */
const MU = (process.env.MANGAUPDATES_API_URL || 'https://api.mangaupdates.com/v1').replace(/\/+$/, '');
const GAP_MS = 1000;
let nextAt = 0;

/** Wait for this request's turn: one a second, whoever asks. */
async function turn(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, nextAt);
  nextAt = start + GAP_MS;
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
}

/** One MangaUpdates call as JSON. Throws on anything but an answer: a network error, a 429 or a 5xx is not a miss. */
async function muFetch(path: string, init?: RequestInit): Promise<any> {
  await turn();
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
