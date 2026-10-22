// Related works and recommendations, from AniList (v0.61.0).
//
// The owner approved "Related works + Because you read X": a series' sequels, prequels, main story, side stories,
// spin-offs and other versions on its page, the sequel at the end of the reader, and Discover's "Because you read X"
// from what AniList's readers recommend after it. All of it is AniList's answer for the entry a series is linked to (a
// link a person made, or one the online-match check confirmed: an unchecked automatic link may be another work), kept
// in anilist_related by AniList id.
//
// Asked in the background only, as the scores are (lib/anilistScores.ts), in the same six-hour tick right after them:
// entries with no row first, then the ones read most recently by anyone, ten a request (lib/anilist.ts
// fetchAniListRelated), a row asked again after a week. A library whose AniList lookups are off (libraries.anilist_lookup)
// sends nothing: its series are left out when the ids are chosen, and the ids are read again right before each request,
// so a library switched off while a round runs is not asked about from then on (lib/matchCheck.ts's rule). No page ever
// asks AniList: the routes read the table, and an entry with no row has nothing to show yet.
//
// Who sees what is decided per viewer when the table is read, never in the shared copy:
//  - a related work the server holds (heldEntry) is the library's series, shown as itself when this viewer may list it
//    (browsable), and dropped -- never named -- when they may not;
//  - one it does not hold is AniList's, shown with its AniList cover, unless it is 18+ for this viewer (adultOk).
import { q, one } from './db';
import { ADULT_RATING, browsable, browsableIds, Params, visibleToAll, type ViewCtx } from './visibility';
import { libraryIndex, MIN_OTHER_NAME_KEY, type Held, type LibraryIndex } from './discoverIdentity';
import { nameKey } from './onlineMatch';
import { runtime } from './runtime';
import { fetchAniListRelated, RELATIONS, type Relation, type RelatedItem } from './anilist';

/** A row older than this is asked again: what AniList relates and recommends moves slowly. */
export const RELATED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The most entries one round asks about: twenty requests, a little under a minute with the pacing. */
const MAX_PER_ROUND = 200;
/** Entries per request (lib/anilist.ts asks AniList ten at a time whatever this says). */
const CHUNK = 10;
/** Between two requests, as every AniList job here paces itself (~30 a minute). */
const GAP_MS = 2200;

// ---- asking AniList, in the background ---------------------------------------------------------------------------

export interface RelatedOutcome {
  /** Entries AniList was asked about. */
  asked: number;
  /** Of those, the ones it answered (the rest are kept empty, until the row is stale). */
  stored: number;
  missing: number;
  /** Chosen, then not asked about: their library's lookups were switched off while the round ran. */
  skipped: number;
}

/** Of these AniList ids, the ones a library that may look things up still links: read right before each request. */
async function allowedIds(ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await q<{ id: string }>(
    `SELECT DISTINCT t.external_id AS id
       FROM series_trackers t
       JOIN lib_series s ON s.id = t.series_id AND ${visibleToAll('s')}
       JOIN libraries l ON l.id = s.library_id AND l.anilist_lookup
      WHERE t.provider = 'anilist' AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
        AND t.external_id = ANY($1::text[])`,
    [[...ids]],
  );
  return new Set(rows.map((r) => r.id));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One round: the AniList ids of visible, checked-linked series in libraries with lookups on whose row is missing or
 * stale -- missing first, then the most recently read by anyone -- asked `chunk` at a time, each id read again right
 * before its request. Every answer is stored; an id AniList did not answer is stored empty, so it waits for the row to go
 * stale rather than being asked every six hours. Throws when AniList fails (what earlier requests stored stays): the
 * next round tries again.
 */
export async function refreshAniListRelated(
  o: { maxAgeMs?: number; max?: number; chunk?: number; gapMs?: number } = {},
): Promise<RelatedOutcome> {
  const maxAge = o.maxAgeMs ?? RELATED_MAX_AGE_MS;
  const chunk = Math.max(1, Math.min(50, Math.floor(o.chunk ?? CHUNK)));
  const gap = o.gapMs ?? GAP_MS;
  const rows = await q<{ id: string }>(
    `SELECT t.external_id AS id
       FROM series_trackers t
       JOIN lib_series s ON s.id = t.series_id AND ${visibleToAll('s')}
       JOIN libraries l ON l.id = s.library_id AND l.anilist_lookup
       LEFT JOIN anilist_related r ON r.anilist_id = t.external_id
       LEFT JOIN (SELECT series_id, max(updated_at) AS at FROM read_progress GROUP BY series_id) rp ON rp.series_id = s.id
      WHERE t.provider = 'anilist' AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
        AND t.external_id ~ '^[0-9]{1,10}$'
        AND (r.anilist_id IS NULL OR r.fetched_at < now() - ($1::bigint * interval '1 millisecond'))
      GROUP BY t.external_id
      ORDER BY bool_or(r.anilist_id IS NULL) DESC, max(rp.at) DESC NULLS LAST, t.external_id
      LIMIT $2`,
    [maxAge, o.max ?? MAX_PER_ROUND],
  );
  const ids = rows.map((r) => r.id).filter((id) => {
    const n = Number(id);
    return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647;
  });
  const out: RelatedOutcome = { asked: 0, stored: 0, missing: 0, skipped: 0 };
  let requested = false;
  for (let i = 0; i < ids.length && !runtime.stopping; i += chunk) {
    const part = ids.slice(i, i + chunk);
    // The candidates read above are not a grant: a library can be switched off while the round runs. Read again right
    // before the request. Reintroduce by asking `part` as chosen: "a library switched off between two requests is not
    // asked about" in anilistRelated.int.test.ts finds its entry asked.
    const allowed = await allowedIds(part);
    const ask = part.filter((id) => allowed.has(id));
    out.skipped += part.length - ask.length;
    if (!ask.length) continue;
    if (requested && gap > 0) await sleep(gap);
    requested = true;
    const got = await fetchAniListRelated(ask.map(Number));
    out.asked += ask.length;
    for (const id of ask) {
      const r = got.get(Number(id));
      if (r) out.stored++;
      else out.missing++;
      await q(
        `INSERT INTO anilist_related (anilist_id, relations, recs, fetched_at) VALUES ($1, $2::jsonb, $3::jsonb, now())
         ON CONFLICT (anilist_id) DO UPDATE SET relations = EXCLUDED.relations, recs = EXCLUDED.recs, fetched_at = now()`,
        [id, JSON.stringify(r?.relations ?? []), JSON.stringify(r?.recs ?? [])],
      );
    }
  }
  return out;
}

// ---- reading it, per viewer --------------------------------------------------------------------------------------

/** What the 18+ rules read of a viewer: their age cap, whether they hide 18+, and the genres the admin calls adult. */
export type AdultCtx = Pick<ViewCtx, 'maxAgeRating' | 'hideAdultLibraries' | 'adultGenres'>;

/**
 * May this viewer be shown this AniList entry? Not an 18+ one to an account capped below 18, whatever it asks; and while
 * the viewer hides 18+, neither an 18+ one nor one carrying a genre the admin named as adult -- compared as browsable()
 * compares them, trimmed and case-blind. The display rule every listing applies to the library's own series, applied to
 * what is not in it. Reintroduce by keeping adult entries: "an 18+ recommendation is not shown to a viewer hiding 18+" in
 * anilistRelated.int.test.ts finds it on Because you read.
 */
export function adultOk(item: { adult?: boolean; genres?: readonly string[] }, ctx: AdultCtx): boolean {
  const adult = item.adult === true;
  if (adult && ctx.maxAgeRating !== null && ctx.maxAgeRating < ADULT_RATING) return false;
  if (!ctx.hideAdultLibraries) return true;
  if (adult) return false;
  const named = new Set((ctx.adultGenres ?? []).map((g) => String(g).trim().toLowerCase()).filter(Boolean));
  if (!named.size) return true;
  return !(item.genres ?? []).some((g) => named.has(String(g).trim().toLowerCase()));
}

/**
 * The library series an AniList entry is, by the strongest evidence first: its very entry (a series linked to it, or
 * whose name is known to be it -- lib/discoverIdentity.ts byWork), then a name the library knows a series by, exactly
 * (nameKey) -- its three titles, and a synonym only when long enough to say which work it is (MIN_OTHER_NAME_KEY, the
 * index's own rule for other names: "Return" is many works' name). Empty when the server does not hold it. Server-wide,
 * like Discover's "already held": the caller decides what this viewer may be shown.
 */
export function heldEntry(idx: LibraryIndex, item: { id: number; titles?: readonly string[]; synonyms?: readonly string[] }): Held[] {
  const byWork = idx.byWork.get(`al:${item.id}`);
  if (byWork?.length) return byWork;
  for (const t of item.titles ?? []) {
    const k = nameKey(t);
    const held = k ? idx.byName.get(k) : undefined;
    if (held?.length) return held;
  }
  for (const s of item.synonyms ?? []) {
    const k = nameKey(s);
    if (k.length < MIN_OTHER_NAME_KEY) continue;
    const held = idx.byName.get(k);
    if (held?.length) return held;
  }
  return [];
}

/** A stored list, as items: anything that is not one is left out (a row written by a later version, a hand edit). */
function itemsOf(v: unknown): RelatedItem[] {
  const list = Array.isArray(v) ? v : [];
  return list.filter((x): x is RelatedItem => !!x && Number.isSafeInteger(x.id) && typeof x.title === 'string' && !!x.title)
    .map((x) => ({ ...x, titles: Array.isArray(x.titles) ? x.titles : [], synonyms: Array.isArray(x.synonyms) ? x.synonyms : [],
      genres: Array.isArray(x.genres) ? x.genres : [] }));
}

interface Entry { work: string; row: { relations: RelatedItem[]; recs: RelatedItem[] } | null }

/**
 * A series' AniList entry as these reads may use it: null when its library's lookups are off or it has no checked link
 * (nothing is shown for it, whatever the table holds); `row` null while the entry has not been asked about yet. `work`
 * is the series' own `lib:` work, so neither it nor one of its language editions is listed as related to itself.
 */
async function entryOf(seriesId: string): Promise<Entry | null> {
  const r = await one<{ work: string; on: boolean; al: string | null; relations: unknown; recs: unknown; has: boolean }>(
    `SELECT COALESCE(s.work_id::text, s.id) AS work, l.anilist_lookup AS "on", t.external_id AS al,
            a.relations, a.recs, (a.anilist_id IS NOT NULL) AS has
       FROM lib_series s
       JOIN libraries l ON l.id = s.library_id
       LEFT JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
                                  AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
       LEFT JOIN anilist_related a ON a.anilist_id = t.external_id
      WHERE s.id = $1`,
    [seriesId],
  );
  if (!r || !r.on || !r.al) return null;
  return { work: `lib:${r.work}`, row: r.has ? { relations: itemsOf(r.relations), recs: itemsOf(r.recs) } : null };
}

/**
 * The library series an entry is, as this viewer may be shown it: the first of the held ones they may list, other than
 * the series asked about and its own editions. `undefined` when the server holds none; `null` when it holds one this
 * viewer may not see -- dropped by the caller, never named.
 */
function shownHeld(held: Held[], seriesId: string, work: string, shown: Set<string>): Held | null | undefined {
  if (!held.length) return undefined;
  const others = held.filter((h) => h.id !== seriesId && h.work !== work);
  if (!others.length) return null; // it is this series (or another edition of it)
  // Reintroduce by taking `others[0]` whatever the viewer may list: "a held work the viewer may not see is not named" in
  // anilistRelated.int.test.ts finds it on the capped account's Related.
  return others.find((h) => shown.has(h.id)) ?? null;
}

/** A related work the server does not hold, as the series page shows it: AniList's cover and words. */
export interface OutsideWork { anilistId: number; title: string; cover: string | null; format: string | null; status: string | null; score: number | null }
export type RelatedRow = { relation: Relation; seriesId: string } | { relation: Relation; outside: OutsideWork };

/**
 * What a series is related to, for this viewer (GET /api/series/:id/related): sequels, prequels, the main story, side
 * stories, spin-offs and alternative versions, in that order. A held one is its library series when the viewer may list
 * it, and left out -- never named -- when they may not; one the server does not hold is AniList's, unless it is 18+ for
 * the viewer. `lookups: false`, and nothing else, for a series whose library does not look things up on AniList or that
 * has no checked link. Reads the table only. The caller has already checked the viewer may open the series.
 */
export async function relatedFor(seriesId: string, ctx: ViewCtx): Promise<{ lookups: boolean; content: RelatedRow[] }> {
  const e = await entryOf(seriesId);
  if (!e) return { lookups: false, content: [] };
  const items = (e.row?.relations ?? []).filter((it) => it.rel && (RELATIONS as readonly string[]).includes(it.rel));
  if (!items.length) return { lookups: true, content: [] };
  items.sort((a, b) => RELATIONS.indexOf(a.rel!) - RELATIONS.indexOf(b.rel!));
  const idx = await libraryIndex();
  const heldOf = items.map((it) => heldEntry(idx, it));
  const shown = await browsableIds(heldOf.flat().map((h) => h.id), ctx);
  const content: RelatedRow[] = [];
  const listed = new Set<string>();
  items.forEach((it, i) => {
    const h = shownHeld(heldOf[i], seriesId, e.work, shown);
    if (h === null) return;
    if (h) {
      if (!listed.has(h.id)) { listed.add(h.id); content.push({ relation: it.rel!, seriesId: h.id }); }
      return;
    }
    if (!adultOk(it, ctx)) return;
    content.push({
      relation: it.rel!,
      outside: { anilistId: it.id, title: it.title, cover: it.cover, format: it.format, status: it.status, score: it.score },
    });
  });
  return { lookups: true, content };
}

/**
 * The library series AniList's readers recommend after this one, that this viewer may list, most voted first: what More
 * like this leads with (GET /api/series/:id/similar). Empty under the same conditions as relatedFor. Table only.
 */
export async function heldRecs(seriesId: string, ctx: ViewCtx): Promise<string[]> {
  const e = await entryOf(seriesId);
  const recs = e?.row?.recs ?? [];
  if (!e || !recs.length) return [];
  const idx = await libraryIndex();
  const heldOf = recs.map((it) => heldEntry(idx, it));
  const shown = await browsableIds(heldOf.flat().map((h) => h.id), ctx);
  const out: string[] = [];
  for (const held of heldOf) {
    const h = shownHeld(held, seriesId, e.work, shown);
    if (h && !out.includes(h.id)) out.push(h.id);
  }
  return out;
}

/** Discover's trending shape (web components/DiscoverHero.tsx Trending), so its cards draw a recommendation as they are. */
export interface TrendingShape {
  id: number; title: string; cover: string | null; banner: null; description: string; genres: string[];
  score: number | null; chapters: null; status: string | null;
}
const asTrending = (it: RelatedItem): TrendingShape => ({
  id: it.id, title: it.title, cover: it.cover, banner: null, description: '', genres: it.genres, score: it.score, chapters: null,
  status: it.status,
});

/** The series the row may be about: the viewer's last five with a finished chapter. */
const SEEDS = 5;
/** The most picks it hands Discover, taken from every seed in turn (v0.98.0; one seed's ten at most before). */
const BECAUSE_MAX = 30;

/** A pick and the read series it came from (v0.98.0): its card says "Because you read {title}" beside that cover. */
export interface BecausePick extends TrendingShape { because: { id: string; title: string } }

/**
 * Discover's "Because you read" picks (GET /api/discover/because): what AniList's readers recommend after the series this
 * viewer read lately, less what the server already holds (by its entry or by any name, heldEntry) and what is 18+ for
 * them. The seeds are the five most recently read series with a finished chapter that the viewer may list, in a library
 * that looks things up, with a checked link and a row. Table only.
 *
 * v0.98.0: every seed adds its picks, one from each in turn, most recent first, and each pick names its own seed. It was
 * the first seed that left four, alone: AniList keeps ten picks a title and the library holds many of them, so the owner's
 * row was four cards on a screen that holds fourteen, while the other four seeds' picks were loaded here and thrown away.
 * `seed` is the first seed the picks name, for a page from before v0.98.0 that heads its rail with one title.
 */
export async function becauseYouRead(userId: string, ctx: ViewCtx): Promise<{
  seed: { id: string; title: string } | null; seeds: { id: string; title: string }[]; content: BecausePick[];
}> {
  const p = new Params();
  const uid = p.add(userId);
  const seeds = await q<{ id: string; title: string; recs: unknown }>(
    `SELECT s.id, COALESCE(NULLIF(btrim(o.title), ''), s.title) AS title, a.recs
       FROM (SELECT series_id, max(updated_at) AS at FROM read_progress
              WHERE user_id = ${uid} GROUP BY series_id HAVING bool_or(completed)) rp
       JOIN lib_series s ON s.id = rp.series_id
       JOIN libraries l ON l.id = s.library_id AND l.anilist_lookup
       JOIN series_trackers t ON t.series_id = s.id AND t.provider = 'anilist'
                             AND (t.linked_by IS NOT NULL OR t.checked_at IS NOT NULL)
       JOIN anilist_related a ON a.anilist_id = t.external_id AND jsonb_array_length(a.recs) > 0
       LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE ${browsable('s', ctx, p)}
      ORDER BY rp.at DESC, s.id
      LIMIT ${p.add(SEEDS)}`,
    p.values as any[],
  );
  if (!seeds.length) return { seed: null, seeds: [], content: [] };
  const idx = await libraryIndex();
  // Reintroduce by keeping what is held: "Because you read leaves out what the server holds" in
  // anilistRelated.int.test.ts finds a held work on the row.
  const lists = seeds
    .map((s) => ({ seed: { id: s.id, title: s.title }, recs: itemsOf(s.recs).filter((it) => !heldEntry(idx, it).length && adultOk(it, ctx)) }))
    .filter((l) => l.recs.length > 0);
  // One from each seed in turn, so the first cards on screen are not all one series' picks; one card per AniList entry, the
  // first seed to name it keeping it. Reintroduce the one-seed row: "Because you read draws from every recent read" fails.
  const content: BecausePick[] = [];
  const seen = new Set<number>();
  for (let i = 0; content.length < BECAUSE_MAX && lists.some((l) => i < l.recs.length); i++) {
    for (const l of lists) {
      const it = l.recs[i];
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      content.push({ ...asTrending(it), because: l.seed });
      if (content.length >= BECAUSE_MAX) break;
    }
  }
  const named = lists.map((l) => l.seed).filter((sd) => content.some((c) => c.because.id === sd.id));
  return { seed: named[0] ?? null, seeds: named, content };
}
