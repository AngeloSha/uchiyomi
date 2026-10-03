// Which follower takes over a series' main source (v0.54.0), and the facts it is judged on.
//
// The Replace run (lib/findSources.ts, mode `replace`) promotes each series' best working follower to its main source
// and searches only for the series that have none; its preview (the numbers the Replace dialog says before Start) and
// the sources overview's "already have a working backup" (lib/sourcesOverview.ts) count the same series the same
// way. All three read them here, so the dialog's "184 already follow a working source" is the run's own 184.
//
// A follower may take over when it still carries the series (lib/sourceStanding.ts: usable or cooling), it is in the
// series' language (the same-language guard every automatic follow passes, lib/seriesLang.ts followGuard), the admin
// who acts may reach it (their age cap, as Find's own rule), and its row names the series on it. No identity gate
// beyond that: a follower was judged to be this series when it was followed, and the sweep already merges it --
// promoting it changes which source wins a tie and the label, not which chapters arrive.
//
// Among those, best first (rankFollowers):
//   1. the health tier: usable and answered with chapters in the last week (series_sources.checked_at is stamped only
//      on an answer), then usable but not heard from since, then cooling -- promotable, but last: a cooldown lasts
//      minutes, and the follower is already merged, so leaving the series on its dead main (or sending it to a search
//      that would hit the follower cap) would be worse;
//   2. how much of the series' chapter numbers it lists (the series' listing, held numbers included), in tenths, the
//      stored follow-time coverage when the listing has nothing of it;
//   3. the admin's source order (lib/sourcePrefs.ts), the series' own over the server's;
//   4. how many chapters it lists past what the library holds;
//   5. the follow order.
import { q } from './db';
import { getSource } from './sources';
import { sourceAllowedFor } from './visibility';
import { followGuards } from './seriesLang';
import { carries, standingOf, standingRows, type Standing } from './sourceStanding';
import { effectiveSourcePriority } from './sourcePrefs';
import { assess } from './fill';
import { haveNumbers } from './libraryNumbers';

/** Why a follower was passed over (the run's `skipped`): its standing, its language, or the admin's age reach. */
export type SkipWhy = 'off' | 'failing' | 'cooling' | 'not_loaded' | 'language' | 'age';

/** What a follower is ranked on. */
export interface FollowerFacts {
  sourceId: string;
  name: string;
  /** Its id for the series on that source: what becomes the main pair. */
  sourceSeriesId: string;
  /** The source's own title for the series (series_sources.title), when the follow kept one. */
  title: string | null;
  standing: Standing;
  /** In the series' language (followGuard). */
  langFits: boolean;
  /** Within the acting admin's age reach. */
  allowed: boolean;
  /** When it last answered with its list for the series, and how many numbers it listed then. */
  checkedAt: string | null;
  chapters: number | null;
  /** The share of the series' numbers it listed when it was followed (series_sources.coverage). */
  coverage: number | null;
  /** The numbers it lists for the series in the stored listing (series_listing copies), when the facts were read with them. */
  listed: number[] | null;
  /** Its place in the admin's source order: lower first, the order's length for a source the order does not name. */
  orderRank: number;
  /** Its place in the follow order. */
  followIndex: number;
}

export interface RankedFollower extends FollowerFacts {
  /** 0: answered within the week; 1: usable, not heard from since; 2: cooling down. */
  tier: 0 | 1 | 2;
  /** Coverage of the series' numbers, 0..1: from its listing, or its stored coverage. */
  cover: number;
  /** Numbers it lists past everything the library holds. */
  newer: number;
}

export interface Skipped { sourceId: string; name: string; why: SkipWhy }

/** A follower heard from within this long is the first tier. */
export const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The followers that may take over, best first, and the ones passed over with why. Pure: the facts are read by
 * replaceFacts. `numbers` is everything the series lists or holds, `held` what it holds.
 */
export function rankFollowers(
  followers: readonly FollowerFacts[], o: { numbers: readonly number[]; held: readonly number[]; now?: number },
): { ranked: RankedFollower[]; skipped: Skipped[] } {
  const now = o.now ?? Date.now();
  const skipped: Skipped[] = [];
  const ranked: RankedFollower[] = [];
  for (const f of followers) {
    // A row with no id on its source cannot become the main pair.
    if (!f.sourceSeriesId) continue;
    const why: SkipWhy | null = f.standing === 'off' ? 'off' : f.standing === 'not_loaded' ? 'not_loaded'
      : f.standing === 'failing' ? 'failing' : !f.langFits ? 'language' : !f.allowed ? 'age' : null;
    if (why) { skipped.push({ sourceId: f.sourceId, name: f.name, why }); continue; }
    const at = f.checkedAt ? Date.parse(f.checkedAt) : NaN;
    const fresh = Number.isFinite(at) && now - at < FRESH_MS && (f.chapters ?? 0) > 0;
    const listed = f.listed?.length ? f.listed : null;
    ranked.push({
      ...f,
      tier: f.standing === 'cooling' ? 2 : fresh ? 0 : 1,
      cover: listed ? assess([...o.numbers], listed).coverage : Number(f.coverage ?? 0),
      newer: listed ? assess([...o.held], listed).newer.length : 0,
    });
  }
  // Reintroduce by dropping any key (the tier, the tenths of coverage, the source order): "Replace promotes each
  // series' best working follower" in findSources.int.test.ts promotes another follower for its series.
  ranked.sort((a, b) => a.tier - b.tier
    || Math.floor(b.cover * 10 + 1e-9) - Math.floor(a.cover * 10 + 1e-9)
    || a.orderRank - b.orderRank
    || b.newer - a.newer
    || a.followIndex - b.followIndex);
  return { ranked, skipped };
}

/** What a series is judged on: its own state, and its followers' facts. */
export interface SeriesFacts {
  id: string;
  /** Its main source now. */
  sourceId: string | null;
  posting: boolean;
  /** A renumber waits for a review, or its journal for its finish. */
  renumbering: boolean;
  followers: FollowerFacts[];
  /** With `numbers`: everything it lists or holds, and what it holds. */
  numbers: number[];
  held: number[];
}

/**
 * The facts of these series, in a few reads whatever their number. `numbers: true` (the run, one series at a time)
 * reads what each follower lists and what the series holds too, for the ranking's coverage; without it (a preview
 * over 195 series, the overview) only what decides whether a follower may take over at all.
 */
export async function replaceFacts(
  seriesIds: readonly string[], o: { maxAgeRating: number | null; numbers?: boolean },
): Promise<Map<string, SeriesFacts>> {
  const ids = [...new Set(seriesIds)];
  if (!ids.length) return new Map();
  const rows = await q<{ id: string; source_id: string | null; numbering: string | null; renumbering: boolean; source_prefs: unknown }>(
    `SELECT id, source_id, numbering, (numbering_pending IS NOT NULL OR renumber_plan IS NOT NULL) AS renumbering, source_prefs
       FROM lib_series WHERE id = ANY($1::text[])`, [ids]);
  const fols = await q<{ series_id: string; source_id: string; source_series_id: string; title: string | null; coverage: number | null;
                        checked_at: string | Date | null; chapters: number | null }>(
    `SELECT series_id, source_id, source_series_id, title, coverage, checked_at, chapters
       FROM series_sources WHERE series_id = ANY($1::text[]) ORDER BY series_id, created_at, source_id`, [ids]);
  const standing = await standingRows(fols.map((f) => f.source_id));
  const guards = await followGuards(ids);
  // Every number each source lists for the series: the copies of each listing row, or the row's own source for a row
  // older than the copies.
  const listed = new Map<string, number[]>();
  if (o.numbers) {
    const lrows = await q<{ series_id: string; source: string; nums: number[] }>(
      `SELECT l.series_id, c.source, array_agg(DISTINCT l.number::float8) AS nums
         FROM series_listing l
         CROSS JOIN LATERAL (SELECT e ->> 'source' AS source FROM jsonb_array_elements(l.copies) e
                             UNION SELECT l.source_id) c
        WHERE l.series_id = ANY($1::text[]) AND c.source IS NOT NULL
        GROUP BY l.series_id, c.source`, [ids]);
    for (const r of lrows) listed.set(`${r.series_id}\u0000${r.source}`, r.nums.map(Number).filter(Number.isFinite));
  }
  const now = Date.now();
  const bySeries = new Map<string, typeof fols>();
  for (const f of fols) bySeries.set(f.series_id, [...(bySeries.get(f.series_id) ?? []), f]);
  const out = new Map<string, SeriesFacts>();
  for (const r of rows) {
    const priority = await effectiveSourcePriority(r.source_prefs).catch(() => null);
    const guard = guards.get(r.id);
    // A row naming the main source itself (older than the follow route's rule) is no follower.
    const followers = (bySeries.get(r.id) ?? []).filter((f) => f.source_id !== r.source_id).map((f, i): FollowerFacts => ({
      sourceId: f.source_id,
      name: getSource(f.source_id)?.name ?? f.source_id,
      sourceSeriesId: f.source_series_id,
      title: f.title,
      standing: standingOf(f.source_id, standing.get(f.source_id), now),
      langFits: guard ? guard(f.source_id) : true,
      allowed: sourceAllowedFor(getSource(f.source_id), o.maxAgeRating),
      checkedAt: f.checked_at == null ? null : new Date(f.checked_at).toISOString(),
      chapters: f.chapters,
      coverage: f.coverage == null ? null : Number(f.coverage),
      listed: o.numbers ? (listed.get(`${r.id}\u0000${f.source_id}`) ?? null) : null,
      orderRank: priority ? priority.rank(f.source_id) : 0,
      followIndex: i,
    }));
    const held = o.numbers ? await haveNumbers(r.id) : [];
    const all = o.numbers
      ? [...new Set([...held, ...[...listed.entries()].filter(([k]) => k.startsWith(`${r.id}\u0000`)).flatMap(([, v]) => v)])]
      : [];
    out.set(r.id, {
      id: r.id, sourceId: r.source_id, posting: r.numbering === 'posting_order', renumbering: !!r.renumbering,
      followers, numbers: all, held,
    });
  }
  return out;
}

/** The followers that are dead weight under the follower cap: switched off, failing or not loaded, worst first. */
export function deadFollowers(f: SeriesFacts): FollowerFacts[] {
  const rank = (s: Standing) => (s === 'failing' ? 0 : s === 'not_loaded' ? 1 : 2);
  return f.followers.filter((x) => !carries(x.standing)).sort((a, b) => rank(a.standing) - rank(b.standing));
}

export interface ReplaceCounts { withBackup: number; toSearch: number; postingOrder: number }

/**
 * Of the series whose main source is being replaced, how many a Replace run would move at once (a follower takes
 * over), search for (no follower can), and leave alone (numbered by posting order). For the preview.
 */
export async function replaceCounts(seriesIds: readonly string[], maxAgeRating: number | null): Promise<ReplaceCounts> {
  return (await countsByMain(await replaceFacts(seriesIds, { maxAgeRating }))).get(null) ?? { withBackup: 0, toSearch: 0, postingOrder: 0 };
}

/**
 * The same counts for every series whose main source is one of `sourceIds`, by that source, in one pass: the sources
 * overview's "already have a working backup" beside each source.
 */
export async function replaceCountsByMain(seriesIds: readonly string[], maxAgeRating: number | null): Promise<Map<string | null, ReplaceCounts>> {
  return countsByMain(await replaceFacts(seriesIds, { maxAgeRating }), true);
}

async function countsByMain(facts: Map<string, SeriesFacts>, byMain = false): Promise<Map<string | null, ReplaceCounts>> {
  const out = new Map<string | null, ReplaceCounts>();
  for (const f of facts.values()) {
    const key = byMain ? f.sourceId : null;
    const c = out.get(key) ?? { withBackup: 0, toSearch: 0, postingOrder: 0 };
    if (f.posting) c.postingOrder++;
    else if (rankFollowers(f.followers, { numbers: [], held: [] }).ranked.length) c.withBackup++;
    else c.toSearch++;
    out.set(key, c);
  }
  return out;
}
