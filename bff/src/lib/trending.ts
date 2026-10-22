// Discover's trending titles (v0.61.0's rails, kept across restarts since v0.98.0): AniList's trending manga by country of
// origin, for the hero and the trending rows.
//
// Until v0.98.0 the pull lived in memory for six hours, so every restart and every deploy started cold: the first visit
// waited on two AniList requests queued behind everything else asking AniList, and when AniList held the queue (a 429) the
// pull failed inside the fifteen seconds a visit may wait, the route answered an empty list, and a phone showed no hero at
// all -- with nothing asking again. Now each country's answer is stored (anilist_trending) and served from that copy at
// once, at any age; a copy over six hours old is refreshed in the background, waiting its turn like any background AniList
// work. Only a server that has never stored one makes a visit wait, briefly, and then it says `pending` and the page asks
// again. The answer is filtered per viewer by the route, never here: this copy is shared.
import { q, one } from './db';
import { fetchTrending, type TrendCountry, type TrendingItem } from './anilist';
import { normTitle } from './titleMatch';

/** How old a copy may get before a visit starts a fresh pull. It is still served while that runs. */
export const TREND_TTL_MS = 6 * 3600_000;
/**
 * How long a visit waits for a pull when nothing has ever been stored for its country: past that it answers `pending`, and
 * the page asks again while the pull carries on.
 */
export const TREND_FIRST_WAIT_MS = 4000;
/** After a pull failed, how long before a visit may start another: AniList said no, and asking per visit is hammering it. */
export const TREND_RETRY_MS = 10 * 60_000;

const memory = new Map<TrendCountry, { at: number; items: TrendingItem[] }>();
const pulling = new Map<TrendCountry, Promise<TrendingItem[]>>();
const failedAt = new Map<TrendCountry, number>();

/** Tests: forget what this process holds, as a restart does. The stored copies stay. */
export function resetTrending(): void {
  memory.clear();
  pulling.clear();
  failedAt.clear();
}

async function storedCopy(country: TrendCountry): Promise<{ at: number; items: TrendingItem[] } | null> {
  const row = await one<{ items: unknown; fetched_at: Date }>(
    'SELECT items, fetched_at FROM anilist_trending WHERE country = $1', [country]).catch(() => null);
  if (!row || !Array.isArray(row.items) || !row.items.length) return null;
  return { at: new Date(row.fetched_at).getTime(), items: row.items as TrendingItem[] };
}

/** One pull per country at a time: both pages, the copy in memory, then the stored row. */
function pull(country: TrendCountry): Promise<TrendingItem[]> {
  const running = pulling.get(country);
  if (running) return running;
  const p = (async () => {
    // Both pages, always. On a large library most of page 1 is already owned -- measured on a 215-series install, 40
    // fetched became 28 after the library filter, and only 7 of those carried the wide art the hero prefers -- and since
    // the pull runs behind the stored copy, the second request costs no one a wait.
    const first = await fetchTrending(country, 1, true);
    const more = await fetchTrending(country, 2, true).catch(() => [] as TrendingItem[]);
    const seen = new Set(first.map((t) => normTitle(t.title)));
    const items = first.concat(more.filter((t) => !seen.has(normTitle(t.title))));
    // An empty answer is not a copy: what was stored stays, and the next visit past the retry wait asks again.
    if (!items.length) throw new Error('anilist answered no trending titles');
    memory.set(country, { at: Date.now(), items });
    failedAt.delete(country);
    await q(
      `INSERT INTO anilist_trending (country, items, fetched_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (country) DO UPDATE SET items = EXCLUDED.items, fetched_at = EXCLUDED.fetched_at`,
      [country, JSON.stringify(items)],
    ).catch((e) => console.warn(`[trending] ${country}: the pull landed but could not be stored (${(e as Error).message})`));
    return items;
  })();
  pulling.set(country, p);
  p.catch((e) => {
    failedAt.set(country, Date.now());
    console.warn(`[trending] ${country}: ${(e as Error).message}`);
  }).finally(() => pulling.delete(country));
  return p;
}

/**
 * One country's trending titles. `items` is null when there is nothing to show yet; `pending` says a pull is under way for
 * a country that has never had a copy, so the page should ask again in a few seconds.
 */
export async function trendingFor(
  country: TrendCountry, opts: { waitMs?: number } = {},
): Promise<{ items: TrendingItem[] | null; pending: boolean }> {
  let have = memory.get(country) ?? null;
  if (!have) {
    have = await storedCopy(country);
    if (have) memory.set(country, have);
  }
  const mayPull = (!have || Date.now() - have.at > TREND_TTL_MS)
    && Date.now() - (failedAt.get(country) ?? 0) >= TREND_RETRY_MS;
  // Stale beats empty: an old copy is still what was trending, where nothing reads as "nothing is". Reintroduce the
  // memory-only cache: "a stored copy answers after a restart without asking AniList" in trending.int.test.ts asks it.
  if (have) {
    if (mayPull) void pull(country).catch(() => {});
    return { items: have.items, pending: false };
  }
  if (!mayPull && !pulling.has(country)) return { items: null, pending: false };
  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([
    pull(country).then((items) => items, () => null),
    new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), opts.waitMs ?? TREND_FIRST_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (waited === undefined) return { items: null, pending: true };
  return { items: waited, pending: false };
}
