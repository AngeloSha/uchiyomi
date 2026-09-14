// Which copy of a chapter to keep, when a source lists more than one.
//
// A chapter number on MangaDex, or on any site with more than one active group, comes back as several
// rows: group A's release, group B's a day later, an external link to the publisher. Mihon shows every row
// and lets the reader pick; Uchiyomi writes ONE file per number, so something has to pick for them. Until
// now that something was three adapters with three different rules -- MangaDex kept whichever copy it saw
// with pages, the engines kept the first the page listed, the extension bridge kept the first the engine
// returned -- and none of them knew what a group was, so "I want group A's release" had no place to go. The
// rule now lives here, once, as a pure function over the chapter list every adapter already returns: the
// adapters stop deduping and just say who released what.
//
// Blocking a group drops a copy only when EVERY group on it is blocked. A joint release by A and B is B's
// work as much as A's; dropping it because A is on the block list would lose B's chapter, which is the one
// the block was meant to protect. The same reading applies the other way: a copy is "from group A" when A
// is any of its groups, so a joint release counts as the ranked group's.
//
// Patience -- waiting a while for the preferred group before settling for another -- is stateless. It is
// judged from the copies' own release dates against the clock, so a sweep that runs every six hours needs
// no memory of when it first saw a number: once the oldest copy is older than the patience window the
// number is released, whatever happened in between. It never applies to a copy with no group information.
// A scraped site that names no groups cannot ever produce the preferred one, and a person who sets a
// priority list for MangaDex and then adds a series from an engine must not find that series stalled for
// two days on every chapter for a group that can never arrive. Undated copies are taken now for the same
// reason: with no date there is nothing to be patient against, and waiting on an unknown is waiting forever.
//
// The waiting number's best copy is still placed in `releases`. The counts and the date stamps the updater
// derives from the list have to describe the source as it is, not as the preference filters it, or "3
// chapters behind" would read as "up to date" while the reader waits; the caller simply does not download
// the numbers in `waiting`.
import type { SourceChapter } from './sources/types';

/** The comparison key for a group name: NFKC, lower case, letters and digits only. */
export const normGroup = (s: string): string =>
  (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The raw group names on a copy, deduped by normGroup. `groups` is authoritative when the source supplied
 * it (MangaDex hands over one relationship per group); otherwise the display string is split on the
 * separators sites use for a joint release. Empty when nothing is known.
 */
export function groupsOf(c: { scanlator?: string; groups?: string[] }): string[] {
  const raw = Array.isArray(c.groups) ? c.groups : c.scanlator ? c.scanlator.split(/ & | \/ |, /) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of raw) {
    const name = typeof g === 'string' ? g.trim() : '';
    const key = normGroup(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** What is stored: on server_settings for everyone, on lib_series for one title. NULL patience = inherit. */
export interface StoredPrefs {
  priority: string[];
  blocked: string[];
  patienceDays: number | null;
}

/** What chooseReleases consumes: the merge of global and per-series, with patience already in ms. */
export interface ReleasePrefs {
  priority: string[];
  blocked: string[];
  patienceMs: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_PATIENCE_DAYS = 2;

/** Union of names, deduped by normGroup, keeping the first spelling seen. */
function union(...lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const name of list) {
      const key = normGroup(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/**
 * Per-series preferences over the global ones. Blocks accumulate -- a group blocked for everyone stays
 * blocked on a series that adds its own -- while a series priority REPLACES the global list rather than
 * extending it, because the order is the whole point of a priority list and appending would leave the
 * global first choice in front of the one the series asked for.
 */
export function mergePrefs(global: StoredPrefs, series?: StoredPrefs | null): ReleasePrefs {
  const priority = series?.priority?.length ? series.priority : global.priority ?? [];
  const blocked = union(global.blocked ?? [], series?.blocked ?? []);
  const days = series?.patienceDays ?? global.patienceDays ?? DEFAULT_PATIENCE_DAYS;
  return { priority: [...priority], blocked, patienceMs: Math.max(0, days) * DAY_MS };
}

export interface ChooseOpts {
  /** The clock patience is judged against; defaults to Date.now(). */
  now?: number;
  /** Lower = preferred, for the updater's multi-source union (primary 0, followers after). Default 0. */
  sourceRank?: (source?: string) => number;
}

/** The priority list as comparison keys, minus the blocked groups, and the blocked set itself. */
function priorityKeys(prefs: ReleasePrefs): { blocked: Set<string>; priority: string[] } {
  const blocked = new Set(prefs.blocked.map(normGroup).filter(Boolean));
  // A blocked group cannot be a first choice: its copies are dropped before ranking, so waiting for it
  // would hold every number for the whole window and then settle anyway.
  const priority = prefs.priority.map(normGroup).filter((k) => k && !blocked.has(k));
  return { blocked, priority };
}

/**
 * The order the release rules rank two copies of the SAME number in: hosted before external (pages === 0
 * is MangaDex's external link; an unknown page count is not), then priority rank, then the caller's
 * source rank, then earliest release. Zero when nothing separates them, so a caller may add its own
 * tie-break (chooseReleases keeps the order the source listed them in).
 *
 * Exported because the persisted listing stores every copy of a number in this same order, chosen copy
 * first, and a second copy of the comparator would drift from this one the first time either changed.
 * An external copy cannot be downloaded at all, so it is never preferred over a hosted one, whatever
 * group it carries: a top-ranked group's external link would otherwise win the number and then fail on
 * every sweep while a readable copy sat unchosen. It is only taken when nothing hosted exists.
 */
export function releaseOrder(prefs: ReleasePrefs, opts: ChooseOpts = {}): (a: SourceChapter, b: SourceChapter) => number {
  const sourceRank = opts.sourceRank ?? (() => 0);
  const { priority } = priorityKeys(prefs);
  const rankOf = (c: SourceChapter): number => {
    let best = Infinity;
    for (const k of groupsOf(c).map(normGroup)) {
      const i = priority.indexOf(k);
      if (i >= 0 && i < best) best = i;
    }
    return best;
  };
  const dateOf = (c: SourceChapter): number => {
    const t = c.publishedAt ? Date.parse(c.publishedAt) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  const external = (c: SourceChapter) => (c.pages === 0 ? 1 : 0);
  // Memoised per object: a sort calls the comparator n log n times and groupsOf normalises every name
  // on every call, which for a thousand-copy MangaDex listing is measurable.
  const keys = new WeakMap<SourceChapter, { rank: number; date: number; ext: number }>();
  const keyOf = (c: SourceChapter) => {
    let k = keys.get(c);
    if (!k) { k = { rank: rankOf(c), date: dateOf(c), ext: external(c) }; keys.set(c, k); }
    return k;
  };
  return (a, b) => {
    const x = keyOf(a), y = keyOf(b);
    return x.ext - y.ext || x.rank - y.rank || sourceRank(a.source) - sourceRank(b.source) || x.date - y.date || 0;
  };
}

/**
 * One copy per chapter number, ascending, plus the numbers that are being held for the preferred group.
 *
 * Per number: copies whose known groups are all blocked are dropped first. If a copy from the effective
 * first choice (the priority list minus blocked groups) is present it wins outright. Otherwise the number
 * waits while a priority list exists, patience is on, at least one copy names a group, and the oldest
 * dated copy is still inside the window. Either way the best remaining copy is placed: by priority rank,
 * then hosted before external (pages === 0 is MangaDex's external link; an unknown page count is not),
 * then the caller's source rank, then earliest release, then the order the source listed them.
 */
export function chooseReleases<T extends SourceChapter>(
  chapters: T[],
  prefs: ReleasePrefs,
  opts: ChooseOpts = {},
): { releases: T[]; waiting: number[] } {
  const now = opts.now ?? Date.now();
  const { blocked, priority } = priorityKeys(prefs);
  const rankOf = (keys: string[]): number => {
    let best = Infinity;
    for (const k of keys) {
      const i = priority.indexOf(k);
      if (i >= 0 && i < best) best = i;
    }
    return best;
  };
  const dateOf = (c: SourceChapter): number => {
    const t = c.publishedAt ? Date.parse(c.publishedAt) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };

  interface Copy { c: T; idx: number; keys: string[]; rank: number; date: number }
  const byNumber = new Map<number, Copy[]>();
  chapters.forEach((c, idx) => {
    if (!Number.isFinite(c.number)) return;
    const keys = groupsOf(c).map(normGroup);
    if (keys.length && keys.every((k) => blocked.has(k))) return;
    const copy: Copy = { c, idx, keys, rank: rankOf(keys), date: dateOf(c) };
    const list = byNumber.get(c.number);
    if (list) list.push(copy);
    else byNumber.set(c.number, [copy]);
  });

  const external = (c: SourceChapter) => (c.pages === 0 ? 1 : 0);
  // The shared comparator (releaseOrder, above, which is where the hosted-before-external rule is
  // explained), with the listing order as the final tie-break so the primary wins between equals.
  const rules = releaseOrder(prefs, opts);
  const order = (a: Copy, b: Copy): number => rules(a.c, b.c) || a.idx - b.idx;

  const releases: T[] = [];
  const waiting: number[] = [];
  for (const number of [...byNumber.keys()].sort((a, b) => a - b)) {
    const copies = byNumber.get(number)!;
    copies.sort(order);
    const best = copies[0];
    releases.push(best.c);
    if (best.rank === 0) continue;
    if (!priority.length || prefs.patienceMs <= 0) continue;
    // Patience is judged from the hosted copies only: an external link is not a release anyone could read
    // here, and a publisher link dated months before any group's work would otherwise end the wait at once.
    const hosted = copies.filter((x) => !external(x.c));
    if (!hosted.some((x) => x.keys.length)) continue;
    const oldest = Math.min(...hosted.map((x) => x.date));
    if (Number.isFinite(oldest) && now - oldest < prefs.patienceMs) waiting.push(number);
  }
  return { releases, waiting };
}
