// Recommendations from the trackers a person has connected.
//
// AniList and MyAnimeList both know which titles readers pair with which ("people who liked X also liked Y").
// This module turns the person's own list into a handful of seeds -- the series they rated highest -- asks
// the service what readers recommend after each, and hands the result to Discover with the service named and
// the seed it came from ("because you read Y"). Anything on the person's lists, under any status, and
// anything the library already holds, is left out.
//
// ⚠️ The one design rule is to be a polite client. Nothing here is called per page view:
//  * the person's list is read at most twice a day (`LIST_TTL`) and survives a restart (tracker_list_cache);
//  * what readers recommend after a title is asked once per title for the WHOLE SERVER for two weeks
//    (`REC_TTL`, tracker_rec_cache), however many people hold it;
//  * AniList is asked for a whole batch of seeds in one request, and MyAnimeList (one call per title) is
//    paced and capped, with an hourly budget per service;
//  * a failure puts that service in a cooldown instead of being retried by the next visit, and the old
//    answer keeps being served meanwhile -- stale beats empty, and beats hammering a service that said no;
//  * concurrent visits to a refresh already running join it instead of starting another.
import { q, one } from './db';
import { visibleToAll } from './visibility';
import { open as unseal } from './secretbox';
import { withGate } from './gate';
import {
  ADAPTERS, LIST_STATUSES, normTitle, anilistRecommendations, malRecommendations, anilistByMalIds,
  type Provider, type LibraryEntry, type RecItem,
} from './trackerProviders';
import { pickSeeds, buildRecs, exclusionsFrom, recency, MIN_READ, type Rec, type SeedRecs } from './trackerRecsCore';
export { pickSeeds, buildRecs, exclusionsFrom, type Rec, type SeedRecs, type Exclusions } from './trackerRecsCore';

/** The services that can seed a recommendation. Kitsu's list is still read for what to leave out. */
export const REC_PROVIDERS: Provider[] = ['anilist', 'myanimelist'];

export const LIST_TTL_MS = 12 * 3600_000;
export const REC_TTL_MS = 14 * 86_400_000;
/** The whole list is read, not a page of it: the exclusion is only right if every entry is known. */
const LIST_MAX = 5000;
/** How many titles a person's recommendations are built from, per service. */
export const SEED_COUNT: Record<string, number> = { anilist: 8, myanimelist: 5 };
/** AniList seeds per request: its query-complexity limit is the reason this is not "all of them". */
const ANILIST_BATCH = 8;
/** Per service, per hour: list pages + seed calls. A ceiling far above normal use that still bounds a bug. */
const HOURLY_BUDGET: Record<string, number> = { anilist: 24, myanimelist: 40 };
const COOLDOWN_MS = 10 * 60_000;
const COOLDOWN_LIMITED_MS = 45 * 60_000;
const MAL_GAP_MS = 1500;
/** The most a visit waits for a refresh before answering with what it has (the refresh carries on). */
const WAIT_MS = 8000;

// ---------------------------------------------------------------------------- politeness

const spent = new Map<string, number[]>();
const HOUR = 3600_000;
function used(provider: string): number {
  const now = Date.now();
  const arr = (spent.get(provider) ?? []).filter((t) => now - t < HOUR);
  spent.set(provider, arr);
  return arr.length;
}
const budgetLeft = (provider: string): number => (HOURLY_BUDGET[provider] ?? 20) - used(provider);
function spend(provider: string, calls: number): void {
  const arr = spent.get(provider) ?? [];
  for (let i = 0; i < calls; i++) arr.push(Date.now());
  spent.set(provider, arr);
}
const cooling = new Map<string, number>();
const coolingDown = (provider: string): boolean => (cooling.get(provider) ?? 0) > Date.now();
function cool(provider: string, e: unknown): void {
  const limited = /\b(429|403|1015)\b|rate|too many/i.test((e as Error)?.message ?? '');
  cooling.set(provider, Date.now() + (limited ? COOLDOWN_LIMITED_MS : COOLDOWN_MS));
}
const mayCall = (provider: string, calls: number): boolean => !coolingDown(provider) && budgetLeft(provider) >= calls;

/** Test hook: the budget, cooldown and in-flight maps are process-global. */
export function resetRecsState(): void { spent.clear(); cooling.clear(); inflight.clear(); }

const inflight = new Map<string, Promise<void>>();
function once(key: string, run: () => Promise<void>): Promise<void> {
  const have = inflight.get(key);
  if (have) return have;
  const p = run().catch(() => {}).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------- stores

interface ListRow { entries: LibraryEntry[]; fetchedAt: number }

async function readList(userId: string, provider: Provider): Promise<ListRow | null> {
  const r = await one<{ entries: LibraryEntry[]; fetched_at: string }>(
    'SELECT entries, fetched_at FROM tracker_list_cache WHERE user_id = $1 AND provider = $2', [userId, provider]).catch(() => null);
  return r && Array.isArray(r.entries) ? { entries: r.entries, fetchedAt: new Date(r.fetched_at).getTime() } : null;
}

async function writeList(userId: string, provider: Provider, entries: LibraryEntry[]): Promise<void> {
  await q(
    `INSERT INTO tracker_list_cache (user_id, provider, entries, fetched_at) VALUES ($1,$2,$3::jsonb, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET entries = EXCLUDED.entries, fetched_at = now()`,
    [userId, provider, JSON.stringify(entries)],
  );
}

interface RecRow { items: RecItem[]; fetchedAt: number }

async function readRecs(provider: Provider, ids: string[]): Promise<Map<string, RecRow>> {
  if (!ids.length) return new Map();
  const rows = await q<{ seed_id: string; recs: RecItem[]; fetched_at: string }>(
    'SELECT seed_id, recs, fetched_at FROM tracker_rec_cache WHERE provider = $1 AND seed_id = ANY($2)', [provider, ids]).catch(() => []);
  return new Map(rows.map((r) => [r.seed_id, { items: Array.isArray(r.recs) ? r.recs : [], fetchedAt: new Date(r.fetched_at).getTime() }]));
}

async function writeRecs(provider: Provider, seedId: string, items: RecItem[]): Promise<void> {
  await q(
    `INSERT INTO tracker_rec_cache (provider, seed_id, recs, fetched_at) VALUES ($1,$2,$3::jsonb, now())
     ON CONFLICT (provider, seed_id) DO UPDATE SET recs = EXCLUDED.recs, fetched_at = now()`,
    [provider, seedId, JSON.stringify(items)],
  );
}

/** Forget a person's cached list: their connection changed, so the list may belong to another account. */
export async function dropListCache(userId: string, provider: Provider): Promise<void> {
  await q('DELETE FROM tracker_list_cache WHERE user_id = $1 AND provider = $2', [userId, provider]).catch(() => {});
}

// ---------------------------------------------------------------------------- refresh

const TOKEN_REJECTED = 'the tracker rejected the saved token -- reconnect to resume syncing';

interface Conn { provider: Provider; token: string }

async function refreshList(userId: string, c: Conn, have: ListRow | null): Promise<ListRow | null> {
  if (have && Date.now() - have.fetchedAt < LIST_TTL_MS) return have;
  if (!mayCall(c.provider, 2)) return have;
  try {
    const entries = await ADAPTERS[c.provider].listLibrary(c.token, { statuses: [...LIST_STATUSES], max: LIST_MAX });
    spend(c.provider, 1 + Math.ceil(entries.length / (c.provider === 'anilist' ? 500 : 1000)));
    await writeList(userId, c.provider, entries);
    return { entries, fetchedAt: Date.now() };
  } catch (e) {
    spend(c.provider, 1);
    if ((e as { authFailed?: boolean }).authFailed) {
      // Same verdict as a rejected push: the connection is switched off and Profile says why.
      await q('UPDATE user_trackers SET enabled = false, last_error = $3 WHERE user_id = $1 AND provider = $2',
        [userId, c.provider, TOKEN_REJECTED]).catch(() => {});
    } else cool(c.provider, e);
    return have;
  }
}

/**
 * What the person did inside Uchiyomi, laid over their tracker list for series linked to that tracker: the stars
 * they gave (x2 onto the 0-10 scale; it wins over the tracker's number, being the newer word), the chapters they
 * finished here, and how many the library holds. A series rated here but absent from the list comes in as a
 * title they are reading, so rating something in the app is enough to count.
 */
async function withLocalSignals(userId: string, provider: Provider, entries: LibraryEntry[]): Promise<LibraryEntry[]> {
  const rows = await q<{ external_id: string; title: string | null; stars: number | null; read: number; total: number; last: string | null }>(
    `SELECT st.external_id, st.title, r.stars,
            (SELECT max(rp.updated_at) FROM read_progress rp WHERE rp.user_id = $1 AND rp.series_id = st.series_id) AS last,
            (SELECT count(*)::int FROM read_progress rp WHERE rp.user_id = $1 AND rp.series_id = st.series_id AND rp.completed) AS read,
            (SELECT count(*)::int FROM lib_books b WHERE b.series_id = st.series_id AND b.pruned_at IS NULL) AS total
       FROM series_trackers st
       LEFT JOIN ratings r ON r.user_id = $1 AND r.series_id = st.series_id
      WHERE st.provider = $2
        AND (r.stars IS NOT NULL OR EXISTS (SELECT 1 FROM read_progress rp WHERE rp.user_id = $1 AND rp.series_id = st.series_id AND rp.completed))`,
    [userId, provider]).catch(() => []);
  if (!rows.length) return entries;
  const byId = new Map(rows.map((r) => [r.external_id, r]));
  const out = entries.map((e) => {
    const l = byId.get(e.externalId);
    if (!l) return e;
    byId.delete(e.externalId);
    return { ...e, progress: Math.max(e.progress, l.read), total: l.total || undefined, ...(l.last ? { lastRead: new Date(l.last).getTime() } : {}), ...(l.stars ? { score: l.stars * 2 } : {}) };
  });
  for (const l of byId.values()) {
    if (!l.stars || !l.title) continue;
    out.push({ externalId: l.external_id, title: l.title, altTitles: [], status: 'reading', progress: l.read, format: 'manga', score: l.stars * 2, total: l.total || undefined, ...(l.last ? { lastRead: new Date(l.last).getTime() } : {}) });
  }
  return out;
}

const STAR_TASTE: Record<number, number> = { 1: -1, 2: -0.6, 3: 0.2, 4: 0.6, 5: 1 };
/** What a read-but-unrated series says for its genres: a mild yes, fading as it ages. */
const READ_TASTE = 0.3;

/**
 * The person's taste by genre, from the series in THIS library: stars they gave (5 and 4 lift a genre, 2 and 1
 * pull it down) and, for series they read in earnest without rating, a mild lift that fades with time since
 * they last read. Averaged with a little shrinkage so one rating cannot swing a genre. Keys are lower-case.
 */
export async function tasteFor(userId: string): Promise<Map<string, number>> {
  const rows = await q<{ genres: string[]; stars: number | null; read: number; last: string | null }>(
    `SELECT COALESCE(NULLIF(o.genres, '{}'::text[]), s.genres, '{}') AS genres, r.stars,
            (SELECT count(*)::int FROM read_progress rp WHERE rp.user_id = $1 AND rp.series_id = s.id AND rp.completed) AS read,
            (SELECT max(rp.updated_at) FROM read_progress rp WHERE rp.user_id = $1 AND rp.series_id = s.id) AS last
       FROM lib_series s
       LEFT JOIN series_overrides o ON o.series_id = s.id
       LEFT JOIN ratings r ON r.user_id = $1 AND r.series_id = s.id
      WHERE ${visibleToAll('s')}
        AND (r.stars IS NOT NULL OR EXISTS (SELECT 1 FROM read_progress rp WHERE rp.user_id = $1 AND rp.series_id = s.id AND rp.completed))`,
    [userId]).catch(() => []);
  const sum = new Map<string, number>();
  const n = new Map<string, number>();
  for (const r of rows) {
    let v: number;
    if (r.stars) v = STAR_TASTE[r.stars] ?? 0;
    else if (r.read >= MIN_READ) v = READ_TASTE * recency({ lastRead: r.last ? new Date(r.last).getTime() : undefined } as LibraryEntry);
    else continue;
    for (const g of r.genres ?? []) {
      const k = g.trim().toLowerCase();
      if (!k) continue;
      sum.set(k, (sum.get(k) ?? 0) + v);
      n.set(k, (n.get(k) ?? 0) + 1);
    }
  }
  const out = new Map<string, number>();
  for (const [k, v] of sum) out.set(k, v / ((n.get(k) ?? 0) + 2));
  return out;
}

/** The seeds of a person's list that have no answer younger than `REC_TTL_MS` on file. */
async function staleSeeds(provider: Provider, seeds: LibraryEntry[]): Promise<{ missing: LibraryEntry[]; rows: Map<string, RecRow> }> {
  const rows = await readRecs(provider, seeds.map((s) => s.externalId));
  const missing = seeds.filter((s) => { const r = rows.get(s.externalId); return !r || Date.now() - r.fetchedAt >= REC_TTL_MS; });
  return { missing, rows };
}

async function fetchAnilistSeeds(missing: LibraryEntry[]): Promise<void> {
  for (let i = 0; i < missing.length; i += ANILIST_BATCH) {
    if (!mayCall('anilist', 1)) return;
    const batch = missing.slice(i, i + ANILIST_BATCH);
    try {
      const got = await anilistRecommendations(batch.map((s) => s.externalId));
      spend('anilist', 1);
      for (const s of batch) await writeRecs('anilist', s.externalId, got.get(s.externalId) ?? []);
    } catch (e) { spend('anilist', 1); cool('anilist', e); return; }
  }
}

async function fetchMalSeeds(token: string, missing: LibraryEntry[]): Promise<void> {
  const got = new Map<string, RecItem[]>();
  for (const s of missing) {
    if (!mayCall('myanimelist', 1)) break;
    try {
      // One lane, spaced, for every person at once: two visits at the same moment are still one call at a time.
      const items = await withGate('recs:myanimelist', () => malRecommendations(token, s.externalId), { concurrency: 1, minGapMs: MAL_GAP_MS });
      spend('myanimelist', 1);
      got.set(s.externalId, items);
    } catch (e) { spend('myanimelist', 1); cool('myanimelist', e); break; }
  }
  if (!got.size) return;
  // MyAnimeList says nothing about age rating, format or the English title. ONE AniList call (up to 50 ids)
  // fills that in for everything just fetched, and what it fills in is cached with the recommendation.
  const all = new Map<string, RecItem>();
  for (const items of got.values()) for (const it of items) all.set(it.id, it);
  if (mayCall('anilist', 1)) {
    try {
      const known = await anilistByMalIds([...all.keys()]);
      spend('anilist', 1);
      for (const [malId, it] of all) {
        const k = known.get(malId);
        if (!k) continue;
        it.title = k.title; it.altTitles = [...new Set([...k.altTitles, ...it.altTitles])].slice(0, 3);
        it.cover = it.cover ?? k.cover; it.score = k.score; it.adult = k.adult; it.format = k.format; it.genres = k.genres;
      }
    } catch (e) { spend('anilist', 1); cool('anilist', e); }
  }
  for (const [seedId, items] of got) await writeRecs('myanimelist', seedId, items);
}

async function refresh(userId: string, c: Conn): Promise<void> {
  const list = await refreshList(userId, c, await readList(userId, c.provider));
  if (!list || !REC_PROVIDERS.includes(c.provider)) return;
  const seeds = pickSeeds(await withLocalSignals(userId, c.provider, list.entries), SEED_COUNT[c.provider] ?? 5);
  const { missing } = await staleSeeds(c.provider, seeds);
  if (!missing.length) return;
  if (c.provider === 'anilist') await fetchAnilistSeeds(missing);
  else await fetchMalSeeds(c.token, missing);
}

// ---------------------------------------------------------------------------- the answer

export interface RecSource {
  provider: Provider;
  label: string;
  /** How many titles are on the person's list there, and how many of them the suggestions are built from. */
  listed: number;
  seeds: number;
}
export interface RecAnswer {
  content: Rec[];
  sources: RecSource[];
  /** A refresh is still running; asking again in a few seconds will show more. */
  pending: boolean;
}

/**
 * Recommendations for one person. Reads only what is cached, starts (or joins) a refresh for whatever is
 * stale and waits a few seconds for it, so a first visit usually has its answer and a slow service never
 * holds the page. `inLibrary` answers which of these normalised titles the library already holds.
 */
export async function recommendationsFor(
  userId: string,
  opts: { restrictAdult: boolean; inLibrary: (titles: string[]) => Promise<Set<string>>; waitMs?: number },
): Promise<RecAnswer> {
  const rows = await q<{ provider: Provider; access_token: string; expires_at: string | null }>(
    'SELECT provider, access_token, expires_at FROM user_trackers WHERE user_id = $1 AND enabled ORDER BY provider', [userId]);
  const conns: Conn[] = [];
  for (const r of rows) {
    if (!(r.provider in ADAPTERS)) continue;
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) continue;
    const token = unseal(r.access_token);
    if (token) conns.push({ provider: r.provider, token });
  }

  const running: Promise<void>[] = [];
  for (const c of conns) {
    const list = await readList(userId, c.provider);
    let stale = !list || Date.now() - list.fetchedAt >= LIST_TTL_MS;
    if (!stale && REC_PROVIDERS.includes(c.provider)) {
      const seeds = pickSeeds(await withLocalSignals(userId, c.provider, list!.entries), SEED_COUNT[c.provider] ?? 5);
      stale = (await staleSeeds(c.provider, seeds)).missing.length > 0;
    }
    if (stale && !coolingDown(c.provider)) running.push(once(`${userId}:${c.provider}`, () => refresh(userId, c)));
  }
  if (running.length) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running),
      new Promise<void>((r) => { timer = setTimeout(r, opts.waitMs ?? WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }

  const lists = new Map<Provider, LibraryEntry[]>();
  const inputs: SeedRecs[] = [];
  const sources: RecSource[] = [];
  for (const c of conns) {
    const list = await readList(userId, c.provider);
    if (!list) continue;
    lists.set(c.provider, list.entries);
    let seedCount = 0;
    if (REC_PROVIDERS.includes(c.provider)) {
      const seeds = pickSeeds(await withLocalSignals(userId, c.provider, list.entries), SEED_COUNT[c.provider] ?? 5);
      const cached = await readRecs(c.provider, seeds.map((s) => s.externalId));
      for (const seed of seeds) {
        const r = cached.get(seed.externalId);
        if (!r) continue;
        seedCount++;
        inputs.push({ provider: c.provider, seed, items: r.items });
      }
    }
    sources.push({ provider: c.provider, label: ADAPTERS[c.provider].label, listed: list.entries.length, seeds: seedCount });
  }

  const leave = exclusionsFrom(lists);
  let content = buildRecs(inputs, leave, { restrictAdult: opts.restrictAdult, taste: await tasteFor(userId) });
  if (content.length) {
    const have = await opts.inLibrary(content.flatMap((r) => [r.title, ...r.altTitles]));
    content = content.filter((r) => ![r.title, ...r.altTitles].some((t) => have.has(normTitle(t))));
  }
  return { content, sources, pending: running.length > 0 && inflightFor(userId) };
}

const inflightFor = (userId: string): boolean => [...inflight.keys()].some((k) => k.startsWith(`${userId}:`));
