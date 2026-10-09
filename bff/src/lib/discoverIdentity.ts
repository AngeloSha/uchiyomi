// Which work a Discover item is, and whether the library already holds it (v0.56.0).
//
// The owner, on Discover: the same series shows several times, because every source names it differently, and series the
// library already holds show at all. Two questions, one module:
//
//  - libraryIndex(): what the library holds, by every way an item can point at it. The source series it came from or
//    follows (exact); every name it goes by (lib/altTitles.ts namesOfMany, plus each followed source's own name for it);
//    and the work it is (its checked AniList link, and the works its names resolve to below).
//  - title_works: which work a NAME is. Asked once per name, in the background, of AniList, then MangaDex, then
//    MangaUpdates, and kept. Each answer's whole list of names is kept with it, so one lookup places every name the work
//    goes by: asking for "Solo Leveling" places "Only I Level Up" too.
//
// An item's work key (workOf) is what Discover folds its cards by: `lib:` for a work the library holds, `al:` / `md:` /
// `mu:` for one an online service named, else `n:` and the item's nameKey (lib/onlineMatch.ts) -- exact equality only,
// never containment, so "Tokyo Ghoul:re" stays its own card beside "Tokyo Ghoul".

import { q, one } from './db';
import { visibleToAll } from './visibility';
import { nameKey, namesMatch } from './onlineMatch';
import { namesOfMany } from './altTitles';
import { effectiveLang } from './seriesLang';
import { runtime } from './runtime';
import { searchAniListWorks } from './anilist';
import { searchMangaDexWorks } from './sources/mangadex';
import { searchMangaUpdates } from './mangaupdates';

type Log = { info: (m: string) => void; warn: (m: string) => void };

/** A library series an item points at: the entry a card opens, its language, and the work it is part of (`lib:` key). */
export interface Held { id: string; lang: string; work: string }
/** An item as this module reads it: which source, which series on it, and the name it goes by there. */
export interface ItemRef { source: string; sourceId: string; title: string }

export interface LibraryIndex {
  byPair: Map<string, Held[]>;
  byName: Map<string, Held[]>;
  byWork: Map<string, Held[]>;
}

/**
 * A source series as the index keys it: the source, and the series' id there -- by path when the id is a link, so a site
 * that moved to another domain (lib/sources/slug.ts rebase points requests at the new one, the stored id keeps the old)
 * still finds the series it always was. Reintroduce the whole link: "a series still matches after its site moved" in
 * discoverIdentity.test.ts reads two keys.
 */
export function pairKey(source: string, id: string): string {
  let v = String(id).trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      v = (u.pathname.replace(/\/+$/, '') || '/') + u.search;
    } catch { /* not a link after all: kept as given */ }
  }
  return `${source}\u0001${v}`;
}

// ---- which work a name is (title_works) ----------------------------------------------------------------------------

/** What is known about a name key: the work (null when every service was asked and none knew it), and since when. */
interface Known { work: string | null; at: number }
const known = new Map<string, Known>();
let loaded: Promise<void> | null = null;

/** The table read once into memory: a few thousand short rows, and every Discover response reads it per item. */
function worksReady(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      const rows = await q<{ key: string; work: string | null; at: string }>('SELECT key, work, checked_at AS at FROM title_works');
      for (const r of rows) known.set(r.key, { work: r.work, at: new Date(r.at).getTime() });
    })();
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}

/**
 * The work a name key is known to be, or null. A name a source page listed points at that page's title (`n:`), and is
 * followed to whatever that title turned out to be -- at most three steps, which no real chain needs, so a loop cannot
 * hang a response.
 */
export function workForKey(k: string): string | null {
  let w = known.get(k)?.work ?? null;
  for (let i = 0; i < 3 && w?.startsWith('n:'); i++) {
    const next = known.get(w.slice(2))?.work;
    if (!next || next === w) break;
    w = next;
  }
  return w;
}

// ---- what the library holds ----------------------------------------------------------------------------------------

const INDEX_TTL_MS = 60_000;
/** An other name (not the series' own title) counts as the series' only when its key is at least this long. */
const MIN_OTHER_NAME_KEY = 8;
let indexVersion = 0;
let indexCache: { at: number; version: number; built: Promise<LibraryIndex> } | null = null;

/** Something the index is built from changed (an add, a merge): the next read builds it again. */
export function libraryChanged(): void { indexVersion++; }

/**
 * The library, as Discover asks about it: built at most once a minute (or right after libraryChanged), shared by every
 * response meanwhile. Visible-to-all rows, as the add route's duplicate check reads them: "is this here" is a question
 * about the server, not about who asks.
 */
export function libraryIndex(): Promise<LibraryIndex> {
  const c = indexCache;
  if (c && c.version === indexVersion && Date.now() - c.at < INDEX_TTL_MS) return c.built;
  const built = buildIndex();
  const entry = { at: Date.now(), version: indexVersion, built };
  indexCache = entry;
  built.catch(() => { if (indexCache === entry) indexCache = null; });
  return built;
}

async function buildIndex(): Promise<LibraryIndex> {
  await worksReady();
  const series = await q<{ id: string; lang: string | null; source_id: string | null; source_series_id: string | null; work_id: string | null; title: string }>(
    `SELECT s.id, s.lang, s.source_id, s.source_series_id, s.work_id::text AS work_id, s.title
       FROM lib_series s WHERE ${visibleToAll('s')} ORDER BY s.id`,
  );
  const held = new Map<string, Held>();
  // A work's language editions share one `lib:` key (work_id, v0.52.0), so their cards fold as one.
  for (const s of series) held.set(s.id, { id: s.id, lang: effectiveLang(s.lang, s.source_id), work: `lib:${s.work_id ?? s.id}` });
  const byPair = new Map<string, Held[]>();
  const byName = new Map<string, Held[]>();
  const byWork = new Map<string, Held[]>();
  const add = (m: Map<string, Held[]>, k: string, h: Held | undefined) => {
    if (!k || !h) return;
    const list = m.get(k);
    if (!list) m.set(k, [h]);
    else if (!list.some((x) => x.id === h.id)) list.push(h);
  };
  for (const s of series) {
    if (s.source_id && s.source_series_id) add(byPair, pairKey(s.source_id, s.source_series_id), held.get(s.id));
    add(byName, nameKey(s.title), held.get(s.id));
  }
  // Each followed source: the series it follows there, and the name it goes by there -- often not the main source's.
  const followers = await q<{ series_id: string; source_id: string; source_series_id: string | null; title: string | null }>(
    `SELECT ss.series_id, ss.source_id, ss.source_series_id, ss.title
       FROM series_sources ss JOIN lib_series s ON s.id = ss.series_id AND ${visibleToAll('s')}`,
  );
  for (const f of followers) {
    if (f.source_series_id) add(byPair, pairKey(f.source_id, f.source_series_id), held.get(f.series_id));
    if (f.title) add(byName, nameKey(f.title), held.get(f.series_id));
  }
  // The admin's display title, whatever its length: a person chose it.
  const shown = await q<{ series_id: string; title: string }>(
    `SELECT o.series_id, o.title FROM series_overrides o JOIN lib_series s ON s.id = o.series_id AND ${visibleToAll('s')}
      WHERE o.title IS NOT NULL AND btrim(o.title) <> ''`,
  );
  for (const o of shown) add(byName, nameKey(o.title), held.get(o.series_id));
  // Every other name (lib/altTitles.ts namesOfMany: the other names and the language editions' titles), when it is long
  // enough to say which work it is. Most other names are read out of a source's description, and the reading splits on
  // punctuation: run over the owner's library, "…Through All Realms - Makes Sense, Right?" left "Right?" as a name of its
  // own -- which an unrelated anthology is called, so Discover would have read it as held. Reintroduce by keeping every
  // name: "a short other name holds nothing" in discoverIdentity.int.test.ts reads the anthology as held.
  for (const [id, names] of await namesOfMany(series.map((s) => s.id))) {
    for (const n of names) {
      const k = nameKey(n);
      if (k.length >= MIN_OTHER_NAME_KEY) add(byName, k, held.get(id));
    }
  }
  // Its AniList entry, when a person linked it or the title check confirmed the link (lib/matchCheck.ts) -- the rule
  // Health's Duplicate series reads by (lib/health.ts duplicateSeries): an unchecked automatic link may be another work.
  const links = await q<{ series_id: string; external_id: string }>(
    `SELECT t.series_id, t.external_id
       FROM series_trackers t JOIN lib_series s ON s.id = t.series_id AND ${visibleToAll('s')}
      WHERE t.provider = 'anilist' AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)`,
  );
  for (const l of links) if (/^\d+$/.test(l.external_id)) add(byWork, `al:${l.external_id}`, held.get(l.series_id));
  // And the work each of its names is known to be: one placed by an online answer, so an item under a name the library
  // never heard of is still found when its name is that work's.
  for (const [k, hs] of byName) {
    const w = workForKey(k);
    if (w && !w.startsWith('n:')) for (const h of hs) add(byWork, w, h);
  }
  return { byPair, byName, byWork };
}

/**
 * The library series an item is, by the strongest evidence first: its very source series, then a name the series goes
 * by, then the work its name is known to be. Empty when the library does not hold it. Several when more than one series
 * answers (a work's language editions): the caller picks by language (routes/sources.ts owned).
 */
export function heldFor(idx: LibraryIndex, it: ItemRef): Held[] {
  const byPair = it.source && it.sourceId ? idx.byPair.get(pairKey(it.source, it.sourceId)) : undefined;
  if (byPair?.length) return byPair;
  const k = nameKey(it.title);
  if (!k) return [];
  const byName = idx.byName.get(k);
  if (byName?.length) return byName;
  const w = workForKey(k);
  return (w && idx.byWork.get(w)) || [];
}

/**
 * The key an item's card folds by: the work the library holds, else the work its name is known to be, else its own name.
 * Never empty -- an item whose name folds to nothing is its own card (`s:`), never every such item on one card.
 */
export function workOf(idx: LibraryIndex, it: ItemRef, held: Held[] = heldFor(idx, it)): string {
  if (held.length) return held[0].work;
  const k = nameKey(it.title);
  if (!k) return `s:${it.source}:${it.sourceId}`;
  return workForKey(k) ?? `n:${k}`;
}

/** An index of nothing: what a response falls back to when the library cannot be read -- nothing reads as held. */
export function noIndex(): LibraryIndex {
  return { byPair: new Map(), byName: new Map(), byWork: new Map() };
}

/**
 * A work key as it stands now, for a page that asks again while names are being looked up (GET /api/discover/works): an
 * `n:` key the library turned out to hold, or whose name has since been placed with a work; a service's key the library
 * holds. `lib:` and `s:` keys are what they were. `owned`: the library holds the work, in any language.
 */
export function currentWork(idx: LibraryIndex, key: string): { work: string; owned: boolean } {
  if (key.startsWith('lib:')) return { work: key, owned: true };
  let w: string | null = key;
  if (key.startsWith('n:')) {
    const k = key.slice(2);
    const byName = idx.byName.get(k);
    if (byName?.length) return { work: byName[0].work, owned: true };
    w = workForKey(k);
    if (!w) return { work: key, owned: false };
  }
  const held = idx.byWork.get(w);
  return held?.length ? { work: held[0].work, owned: true } : { work: w, owned: false };
}

// ---- asking the online services ------------------------------------------------------------------------------------

/** A name no service knew is asked again after this long: a new series gets its entry a few weeks in. */
const RETRY_NONE_MS = 30 * 24 * 60 * 60_000;
/** The most names waiting at once: a wall is a few hundred; more than this is browsing faster than the services answer. */
const QUEUE_MAX = 2000;
/** Names shorter than this (as keys) are never placed by another name's answer: too generic to be one work's. */
const MIN_FAN_KEY = 5;
/** The most names one answer places. */
const MAX_FAN = 60;
/** AniList is asked at most once in this long, which leaves room for its other jobs under its ~30 a minute. */
const ANILIST_GAP_MS = 4000;
/** A transient failure is retried this many times before the name is stored as unknown. */
const MAX_TRIES = 3;

const queue = new Map<string, string>(); // name key -> the name to ask with, oldest first
const asking = new Set<string>();
const failures = new Map<string, number>();
let draining = false;
let anilistNext = 0;
let anilistGapMs = ANILIST_GAP_MS;
let logger: Log | null = null;

let setting: { at: number; on: boolean } | null = null;
/** Admin → Settings "Match Discover titles online" (server_settings.discover_lookups), read at most once a minute. */
export async function lookupsOn(): Promise<boolean> {
  if (setting && Date.now() - setting.at < 60_000) return setting.on;
  const r = await one<{ on: boolean | null }>('SELECT discover_lookups AS "on" FROM server_settings WHERE id = 1').catch(() => null);
  setting = { at: Date.now(), on: r?.on !== false };
  return setting.on;
}
/** The settings route changed the switch: read it again before the next name. */
export function lookupsChanged(): void { setting = null; }

/**
 * Discover's names: those nobody has asked about yet (or no service knew, a month ago) wait to be asked, oldest first,
 * and the asking wakes. Never blocks: a response answers with what is known now, and the page asks again later
 * (GET /api/discover/works).
 */
export function noteTitles(titles: Iterable<string | null | undefined>): void {
  if (setting && !setting.on) return;
  const now = Date.now();
  for (const t of titles) {
    const k = nameKey(t);
    if (!k || queue.has(k) || asking.has(k)) continue;
    const kn = known.get(k);
    if (kn && (kn.work !== null || now - kn.at < RETRY_NONE_MS)) continue;
    if (queue.size >= QUEUE_MAX) break;
    queue.set(k, String(t).trim());
  }
  if (queue.size) void drain();
}

/** How many of these work keys are still waiting to be asked about (an `n:` key whose name is queued or being asked). */
export function pendingOf(keys: readonly string[]): number {
  let n = 0;
  for (const key of keys) {
    if (!key.startsWith('n:')) continue;
    const k = key.slice(2);
    if (queue.has(k) || asking.has(k)) n++;
  }
  return n;
}

/** Start the asking with a logger (server.ts). It also starts by itself on the first noted name. */
export function startTitleWorks(log: Log): void {
  logger = log;
  void worksReady().catch((e) => log.warn(`discover: the known names did not load: ${(e as Error)?.message || e}`));
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    await worksReady();
    while (queue.size && !runtime.stopping) {
      if (!(await lookupsOn())) { queue.clear(); return; }
      const [k, title] = queue.entries().next().value as [string, string];
      queue.delete(k);
      // Placed while it waited -- another name's answer listed it ("Solo Leveling" answered places "Only I Level Up") --
      // so it is never asked about. Reintroduce by asking every queued name: "a name placed while it waited is not asked
      // about" in discoverIdentity.int.test.ts finds AniList asked twice.
      if (known.get(k)?.work) continue;
      asking.add(k);
      try {
        await resolveName(k, title);
        failures.delete(k);
      } catch (e) {
        // A service failed (down, 5xx, rate-limited) and none of the others knew the name: asked again later, at the back,
        // after a breather -- stored as unknown only after MAX_TRIES, so an outage never writes a month of misses.
        const tries = (failures.get(k) ?? 0) + 1;
        if (tries < MAX_TRIES) { failures.set(k, tries); queue.set(k, title); }
        else { failures.delete(k); await store(k, null, 'failed', []).catch(() => {}); }
        logger?.warn(`discover: asking about "${title}" failed (${(e as Error)?.message || e}); try ${tries} of ${MAX_TRIES}`);
        await sleep(30_000);
      } finally {
        asking.delete(k);
      }
    }
  } catch (e) {
    logger?.warn(`discover: the name lookups stopped: ${(e as Error)?.message || e}`);
  } finally {
    draining = false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/**
 * One name, asked of each service in turn, and the first answer that IS the name kept: one of the entry's names must be
 * the name, by nameKey (namesMatch), never a search's best guess. AniList first (the id progress sync and Health's
 * duplicates already use), then MangaDex, whose entries link their AniList id when they have one, then MangaUpdates,
 * which knows the most scanlation names. Throws when a service failed and no other knew the name.
 */
export async function resolveName(k: string, title: string): Promise<void> {
  const isIt = (names: readonly string[]) => namesMatch(title, names);
  let failed: unknown = null;
  try {
    const wait = anilistNext - Date.now();
    anilistNext = Math.max(Date.now(), anilistNext) + anilistGapMs;
    if (wait > 0) await sleep(wait);
    const hit = (await searchAniListWorks(title)).find((w) => isIt(w.titles));
    if (hit) return await store(k, `al:${hit.id}`, 'anilist', hit.titles);
  } catch (e) { failed = e; }
  try {
    const hit = (await searchMangaDexWorks(title)).find((w) => isIt(w.names));
    if (hit) return await store(k, hit.al ? `al:${hit.al}` : `md:${hit.id}`, 'mangadex', hit.names);
  } catch (e) { failed ??= e; }
  try {
    const hit = await searchMangaUpdates(title, isIt);
    if (hit) return await store(k, `mu:${hit.id}`, 'mangaupdates', hit.names);
  } catch (e) { failed ??= e; }
  if (failed) throw failed;
  await store(k, null, 'none', []);
}

/** Which id a work keeps when two services named it: AniList's, then MangaDex's, then MangaUpdates'. */
const RANK: Record<string, number> = { 'al:': 0, 'md:': 1, 'mu:': 2 };
const rank = (w: string) => RANK[w.slice(0, 3)] ?? 9;
/** Names at least this long (as keys) may join two services' ids into one work: long enough to say which work it is. */
const MIN_JOIN_KEY = 8;

/**
 * The id an answer's work goes by, once what is already known is weighed: when the answer's names are already placed
 * with another service's id for the work, the two are one work, kept under the better-ranked id, and every name placed
 * under the other is moved to it. Run over the owner's library before release: "Regressing As The Bastard Of The Sword
 * Clan" was AniList's, "Regressed life of the Sword Clan's Ignoble Reincarnator" only MangaUpdates' (whose ids name no
 * AniList entry) -- two cards for one series until MangaUpdates' answer, which lists both names, joined them. Never
 * when the names point at two ids of one service (two AniList entries): that is two works sharing a name, and nothing is
 * joined. Reintroduce by keeping each answer's own id: "two services' answers for one work become one" in
 * discoverIdentity.int.test.ts reads two works.
 */
async function joined(work: string, k: string, names: readonly string[]): Promise<string> {
  const others = new Set<string>();
  for (const key of [k, ...names.map(nameKey)]) {
    if (key.length < MIN_JOIN_KEY) continue;
    const w = workForKey(key);
    if (w && w !== work && !w.startsWith('n:')) others.add(w);
  }
  if (!others.size) return work;
  const all = [work, ...others];
  const perService = new Map<string, Set<string>>();
  for (const w of all) perService.set(w.slice(0, 3), new Set([...(perService.get(w.slice(0, 3)) ?? []), w]));
  if ([...perService.values()].some((ids) => ids.size > 1)) return work;
  const keep = all.slice().sort((a, b) => rank(a) - rank(b))[0];
  const moved = all.filter((w) => w !== keep);
  if (moved.length) {
    await q('UPDATE title_works SET work = $1 WHERE work = ANY($2::text[])', [keep, moved]);
    for (const kn of known.values()) if (kn.work && moved.includes(kn.work)) kn.work = keep;
  }
  return keep;
}

/** A name's answer, kept; then every other name the answer gave, placed with the same work. */
async function store(k: string, answer: string | null, via: string, names: readonly string[]): Promise<void> {
  const work = answer ? await joined(answer, k, names) : null;
  await q(
    `INSERT INTO title_works (key, work, via, checked_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET work = EXCLUDED.work, via = EXCLUDED.via, checked_at = now()`,
    [k, work, via],
  );
  known.set(k, { work, at: Date.now() });
  if (work) await place(work, names.filter((n) => nameKey(n) !== k), `${via}:names`);
}

/**
 * Names placed with a work because an answer (or a source page) listed them. Never over a name already placed -- the
 * first answer stands, and a name asked about directly is never overwritten by another's list -- only over one no
 * service knew. Short names are left out: "Return" is many works' name.
 */
async function place(work: string, names: readonly string[], via: string): Promise<void> {
  const keys = [...new Set(names.map(nameKey).filter((x) => x.length >= MIN_FAN_KEY))].slice(0, MAX_FAN);
  if (!keys.length) return;
  const rows = await q<{ key: string }>(
    `INSERT INTO title_works (key, work, via, checked_at)
       SELECT k, $2, $3, now() FROM unnest($1::text[]) AS k
     ON CONFLICT (key) DO UPDATE SET work = EXCLUDED.work, via = EXCLUDED.via, checked_at = now()
       WHERE title_works.work IS NULL
     RETURNING key`,
    [keys, work, via],
  );
  const now = Date.now();
  for (const r of rows) known.set(r.key, { work, at: now });
}

/**
 * The other names a source's own page lists for a series (its "Alternative names", lib/altTitles.ts parseAltTitles),
 * read when the app opened the page anyway (routes/sources.ts seriesAndChapters): each is placed with the work the
 * page's title is known to be, else with the title itself (`n:`), so a card under any of those names folds with the
 * card under the title -- and with whatever that title later turns out to be (workForKey follows it).
 */
export async function learnPageNames(title: string, names: readonly string[]): Promise<void> {
  const k = nameKey(title);
  if (!k || !names.length) return;
  await worksReady();
  await place(workForKey(k) ?? `n:${k}`, names.filter((n) => nameKey(n) !== k), 'page');
}

/** Tests only: the spacing between AniList questions; `null` puts back the real one. */
export function _setDiscoverPacing(ms: number | null): void { anilistGapMs = ms ?? ANILIST_GAP_MS; }

/** Tests only: forget what this process learned, so each case starts from the table. */
export function resetDiscoverIdentity(): void {
  known.clear();
  loaded = null;
  queue.clear();
  asking.clear();
  failures.clear();
  indexCache = null;
  setting = null;
  anilistNext = 0;
}
