// The pure half of lib/trackerRecs.ts: which of a person's titles seed recommendations and how the services'
// answers are combined and filtered. Kept apart from the stores and the calls so it runs without a database.
import { ADAPTERS, normTitle, type Provider, type LibraryEntry, type RecItem } from './trackerProviders';

export const MAX_RESULTS = 40;
/** No single seed fills the rail: past this many from one "because you read" the rest are left for later. */
const PER_SEED_CAP = 5;

/** Where a person's taste is read from: finished, in progress or paused, never dropped or merely planned. */
const SEEDING = new Set<string>(['reading', 'completed', 'on_hold']);
const LIKED = 7;
/** Three stars (6/10) is a good series; two or fewer (4/10 and under) is not, and never seeds. */
export const MIN_SCORE = 5;
/** Fewer chapters than this of an unfinished series is a sample, not taste. Twenty of a 1,200-chapter series is not. */
export const MIN_READ = 10;
const DAY = 86_400_000;
/** Reading fades: a seed's pull halves every year since the last chapter, down to a floor. Never read here: no fade. */
const HALF_LIFE_DAYS = 365;
const RECENCY_FLOOR = 0.35;

/** Barely started: only a few chapters of a series not finished. Says nothing about taste. */
export function barelyRead(e: LibraryEntry): boolean {
  return e.status !== 'completed' && e.progress < MIN_READ;
}

/** 1 for something read lately or with no reading date, fading with time since the last chapter. */
export function recency(e: LibraryEntry, now = Date.now()): number {
  if (!e.lastRead) return 1;
  const days = Math.max(0, (now - e.lastRead) / DAY);
  return Math.max(RECENCY_FLOOR, Math.pow(0.5, days / HALF_LIFE_DAYS));
}

/** How much a seed stands for: its score, or for an unrated one a lean towards 'liked' that grows with how much was read. */
export function seedStrength(e: LibraryEntry): number {
  return (e.score ?? LIKED - 0.5 + Math.min(1, e.progress / 200)) * recency(e);
}

/**
 * The titles to build recommendations from, best first: the ones rated 5/10 (three stars) or more, then the
 * ones read without rating. It has to be read in earnest (`barelyRead`), and reading fades with time (`recency`). Something rated lower is left out on purpose. Stable: the same list gives the same seeds, which
 * is what lets the per-title cache do its job (a seed that changed every visit would never be cached).
 */
export function pickSeeds(entries: LibraryEntry[], count: number): LibraryEntry[] {
  const eligible = entries.filter((e) =>
    SEEDING.has(e.status) && e.format !== 'novel' && !barelyRead(e) && (e.score == null ? e.status !== 'on_hold' : e.score >= MIN_SCORE));
  const rank = seedStrength;
  return eligible
    .sort((a, b) => rank(b) - rank(a) || b.progress - a.progress || a.externalId.localeCompare(b.externalId, 'en', { numeric: true }))
    .slice(0, Math.max(0, count));
}

/**
 * What the person's own ratings say about a title's genres, as a multiplier: a genre of series they rated well
 * lifts it, one of series they rated two stars or less pulls it down. 1 when nothing is known (no taste yet,
 * or an answer cached before genres were fetched). Bounded so taste reorders the rail and never empties it.
 */
export function tasteFactor(genres: string[] | undefined, taste: Map<string, number> | undefined): number {
  if (!taste?.size || !genres?.length) return 1;
  let sum = 0;
  for (const g of genres) sum += taste.get(g.toLowerCase()) ?? 0;
  return Math.min(1.6, Math.max(0.4, 1 + 0.25 * (sum / Math.sqrt(genres.length))));
}

export interface Rec {
  title: string;
  altTitles: string[];
  cover: string | null;
  /** 0-100 community score, when a service gave one. */
  score: number | null;
  /** Which service(s) suggested it, and the series of the person's that each suggestion came from. */
  sources: Array<{ provider: Provider; label: string; because: string; url: string | null }>;
}

export interface SeedRecs { provider: Provider; seed: LibraryEntry; items: RecItem[] }

export interface Exclusions {
  /** Every id on the person's list at each service, so a title is never recommended by the service holding it. */
  ids: Map<Provider, Set<string>>;
  /** Every normalised name on any of the person's lists, and in the library. */
  names: Set<string>;
}

interface Cand { rec: Rec; weight: number; best: Map<Provider, number>; lead: number; leadSeed: string }

/**
 * Combine what the seeds produced into one ranked list. A title several seeds point at ranks above one
 * seed's pick, weighted by how well the person rated the seed and how many readers made the pairing. The
 * same work arriving from both services (matched on any shared name) is one card naming both.
 *
 * `restrictAdult`: drop everything not KNOWN to be all-ages. MyAnimeList says nothing about age rating, so
 * its titles carry what AniList answered for them, and a title neither answered for is not shown to a viewer
 * who must not see adult work (the same fail-closed rule as the age cap).
 */
export function buildRecs(inputs: SeedRecs[], leave: Exclusions, opts: { restrictAdult: boolean; taste?: Map<string, number> }): Rec[] {
  const cands: Cand[] = [];
  const byName = new Map<string, Cand>();
  for (const { provider, seed, items } of inputs) {
    const held = leave.ids.get(provider);
    const seedWeight = seedStrength(seed) / 10;
    for (const it of items) {
      if (it.format === 'novel' || held?.has(it.id)) continue;
      if (opts.restrictAdult && it.adult !== false) continue;
      const names = [it.title, ...it.altTitles].map(normTitle).filter(Boolean);
      if (!names.length || names.some((n) => leave.names.has(n))) continue;
      const gain = seedWeight * (1 + Math.log1p(Math.max(0, it.votes))) * tasteFactor(it.genres, opts.taste);
      let c = names.map((n) => byName.get(n)).find(Boolean);
      if (!c) {
        c = {
          rec: { title: it.title, altTitles: it.altTitles, cover: it.cover, score: it.score, sources: [] },
          weight: 0, best: new Map(), lead: 0, leadSeed: '',
        };
        cands.push(c);
      } else {
        // Whichever service filled a field first keeps it, but a missing cover or score is taken from the other.
        c.rec.cover ??= it.cover;
        c.rec.score ??= it.score;
      }
      for (const n of names) byName.set(n, c);
      c.weight += gain;
      if (gain > (c.best.get(provider) ?? 0)) {
        c.best.set(provider, gain);
        const at = c.rec.sources.findIndex((s) => s.provider === provider);
        const src = { provider, label: ADAPTERS[provider].label, because: seed.title, url: it.url };
        if (at >= 0) c.rec.sources[at] = src; else c.rec.sources.push(src);
      }
      if (gain > c.lead) { c.lead = gain; c.leadSeed = seed.title; }
    }
  }
  cands.sort((a, b) => b.weight - a.weight || a.rec.title.localeCompare(b.rec.title));
  const perSeed = new Map<string, number>();
  const out: Rec[] = [];
  for (const c of cands) {
    const n = perSeed.get(c.leadSeed) ?? 0;
    if (n >= PER_SEED_CAP) continue;
    perSeed.set(c.leadSeed, n + 1);
    out.push(c.rec);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** The names on a set of lists, every spelling of every entry. */
export function exclusionsFrom(lists: Map<Provider, LibraryEntry[]>): Exclusions {
  const ids = new Map<Provider, Set<string>>();
  const names = new Set<string>();
  for (const [provider, entries] of lists) {
    ids.set(provider, new Set(entries.map((e) => e.externalId)));
    for (const e of entries) for (const n of [e.title, ...(e.altTitles ?? [])]) { const k = normTitle(n); if (k) names.add(k); }
  }
  return { ids, names };
}

