// How hard the downloader may hit a source right now, remembered PER RATE KEY across chapters.
//
// A 429 used to slow down exactly one chapter: the resume loop in downloader.ts doubled the page gap and
// narrowed the pool to one worker, both of them locals of fetchChapter, and the very next chapter started
// again at full speed against a site that had just said no. Live, that read as a source being rate-limited
// five times in 74 seconds, each strike widening the cooldown, until the person's own manual retry was
// refused too. The owner's ask was the obvious one: "if we get rate limited, continue from the same source
// with slower pulling" -- which needs the slow-down to outlive the chapter that earned it.
//
// So the pace is a small in-memory table: a level per source, raised by every 429. Level 1 doubles every gap, level 4
// is sixteen times slower between chapters and the page-gap ceiling inside one. A successful download does NOT reset
// it -- the site let one chapter through at the slower pace, which is evidence the slower pace works, not that the
// fast one does. Nothing persists: a restart starts fast, and the first 429 teaches it again.
//
// v0.55.3: and it forgets slowly. Ten quiet minutes used to take a level off, so a site that kept refusing was asked
// at full speed again within the hour: Natomanga's image server, the main source of 116 of the owner's series,
// answered 429 night after night, and every Fix everything ended with its chapters under "clears by itself" and the
// next day the same. Now a level is held at least PACE_HOLD_MS after it changed, and comes off one step at a time only
// after PACE_STEADY_RUN chapters in a row came down whole with no 429 at it (noteDownloaded): an hour and a run for
// each step. A key nothing downloads from loses a level per PACE_IDLE_MS, so a source that refused once and was never
// asked again is not slow for good. While a level is raised the key downloads one chapter at a time (downloader.ts
// underGate), and a 429 is a rest every chapter on the key waits out (restLeft), not only the one refused.
//
// One caller also asks to be slower than any of that on purpose: the slow archive (#117), through
// withSlowPace below.
//
// A level belongs to a source's RATE KEY (rateKeyOf below): its rate group (v0.52.0: every MangaDex language is an
// adapter of its own, and all of them are one API that limits one address -- a 429 earned in Spanish slows Portuguese
// as well), joined (v0.55.3) with every source whose pages come from the same image server (notePageHosts). Natomanga
// and Mangakakalot are two sites with one image CDN: each was asked at full speed while the other was being refused.
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSource, listSources } from './sources/loader';

/** The slowest we ever go: sixteen times the declared gap between chapters, and MAX_PAGE_GAP_MS inside one. */
export const PACE_MAX_LEVEL = 4;
/**
 * The least time a level is held after it changed: a 429 raised it, or a step took it down (v0.55.3). A level comes
 * off no sooner, however many chapters land: an image server that has refused keeps refusing for hours, and a fast
 * hour after a slow one is how Natomanga's was asked again at full speed every night.
 */
export const PACE_HOLD_MS = 60 * 60_000;
/** Chapters in a row that came down whole, with no 429 at the level, before it steps down once held (v0.55.3). */
export const PACE_STEADY_RUN = 10;
/**
 * A level that has not changed for this long loses one step, downloads or none (v0.55.3; was ten quiet minutes): a
 * source refused once and never asked again is not slow for good, and the slow archive, which waits on a fresh 429
 * (refusedLately), is not held up by a level nothing else is downloading through.
 */
export const PACE_IDLE_MS = 3 * 24 * 3600_000;
/**
 * Ceiling for the page gap inside a chapter, at any level. Four seconds a page is 8 minutes for a 120-page
 * chapter, which is slow enough that no site mistakes it for a burst and fast enough to finish tonight.
 * Was 2000 when it only lasted one chapter; a pace that persists has to be allowed to go slower.
 */
export const MAX_PAGE_GAP_MS = 4000;

interface Pace {
  level: number;
  /** When the level last changed: a 429, a step down, an idle step. The hold and the idle decay count from here. */
  since: number;
  /** When the last 429 was noted. */
  hitAt: number;
  /** Chapters in a row that came down whole with no 429 since the level last changed. */
  run: number;
  /** Until when every page request on the key waits: the rest the last 429 asked for. */
  restUntil: number;
}
const paces = new Map<string, Pace>();

/** A source's own key before any image server joins it to another: its rate group when it declares one, else its id. */
const groupOf = (sourceId: string): string => getSource(sourceId)?.rateGroup ?? sourceId;

/**
 * The key a source's pace level and its download gate are kept under: its rate group when it declares one (every
 * MangaDex language says 'mangadex', types.ts `rateGroup`), else its own id -- and since v0.55.3 the one key of every
 * group whose pages have come from the same image server as its own (notePageHosts), the smallest of their keys. An id
 * that is not registered is its own key. The downloader's gate (downloader.ts underGate) and the slow archive's reads
 * of the gate use it too.
 */
export const rateKeyOf = (sourceId: string): string => {
  const g = groupOf(sourceId);
  return joined().get(g) ?? g;
};

let clock: () => number = () => Date.now();
/** Tests only: replace the clock so holds and decay can be exercised without waiting hours. `null` restores it. */
export function setPaceClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); }

/** A key's pace after the lazy idle decay: one step off per PACE_IDLE_MS since the level last changed. */
function current(key: string): Pace | null {
  const p = paces.get(key);
  if (!p) return null;
  const steps = Math.floor((clock() - p.since) / PACE_IDLE_MS);
  if (steps <= 0) return p;
  if (p.level - steps <= 0) { paces.delete(key); return null; }
  // Applied by advancing the stamp, not by resetting it: four idle days leave a level-4 key at level 3 with one day
  // already served towards level 2, not at level 3 from scratch.
  p.level -= steps;
  p.since += steps * PACE_IDLE_MS;
  p.run = 0;
  return p;
}

/**
 * The source answered 429: one level slower, up to PACE_MAX_LEVEL, for its whole rate key. The hold restarts and the
 * run of good chapters with it, and every page request on the key rests `restMs` -- the wait the refused chapter is
 * about to sit out, which its neighbours on the key sit out too rather than asking the same server meanwhile.
 */
export function noteRateLimited(sourceId: string, restMs = 0): void {
  const key = rateKeyOf(sourceId);
  const p = current(key);
  const now = clock();
  paces.set(key, {
    level: Math.min(PACE_MAX_LEVEL, (p?.level ?? 0) + 1), since: now, hitAt: now, run: 0,
    restUntil: Math.max(p?.restUntil ?? 0, now + Math.max(0, restMs)),
  });
}

/**
 * A chapter on the source came down whole, and no page of it was answered 429 (downloader.ts fetchChapter): one more
 * in the run that takes a raised level down, a step at a time -- PACE_STEADY_RUN of them, and the level held
 * PACE_HOLD_MS. Nothing at level 0. ⚠️ One chapter is never enough: it got through at the slower pace, which says the
 * slower pace works, not that the faster one would.
 */
export function noteDownloaded(sourceId: string): void {
  const key = rateKeyOf(sourceId);
  const p = current(key);
  if (!p) return;
  p.run++;
  const now = clock();
  if (p.run < PACE_STEADY_RUN || now - p.since < PACE_HOLD_MS) return;
  if (p.level <= 1) { paces.delete(key); return; }
  p.level--;
  p.since = now;
  p.run = 0;
}

/** 0 = full speed: the level of the source's rate key. Read by the download gate and fetchPages, and by Health's rows. */
export function paceLevel(sourceId: string): number {
  return current(rateKeyOf(sourceId))?.level ?? 0;
}

/**
 * The loaded sources downloading at a raised pace now, by id. Health reads them twice (lib/health.ts): Source health's
 * `slowed` rows, and the failed chapters filed under a main source from one its series left (status `moved`), which
 * wait on a slowed main as on one that rests. The levels live here, in memory, so a query is handed the ids.
 */
export function slowedSources(): string[] {
  return listSources().map((a) => a.id).filter((id) => paceLevel(id) > 0);
}

/** How long a page request on the source's key must still wait, in ms: the rest of its last 429. 0 = none. */
export function restLeft(sourceId: string): number {
  const p = current(rateKeyOf(sourceId));
  return p ? Math.max(0, p.restUntil - clock()) : 0;
}

/**
 * Whether the source's key was answered 429 less than PACE_HOLD_MS ago. The slow archive waits while it was
 * (lib/archivePlan.ts sourceWait): it waited for the level to reach 0, which since v0.55.3 can take a day.
 */
export function refusedLately(sourceId: string): boolean {
  const p = current(rateKeyOf(sourceId));
  return !!p && clock() - p.hitAt < PACE_HOLD_MS;
}

// ---- one image server, one key (v0.55.3) -------------------------------------------------------------------------

/**
 * Hosts many unrelated sites serve images from, by registrable domain: one of these in two sources' pages says nothing
 * about whose limit a page counts against (an image proxy, a CDN or a host that keeps a tenant per path or per
 * subdomain), so it never joins them.
 */
const SHARED_HOSTS = new Set([
  'wp.com', 'googleusercontent.com', 'blogspot.com', 'blogger.com', 'discordapp.com', 'discordapp.net', 'imgur.com',
  'ibb.co', 'postimg.cc', 'catbox.moe', 'cloudfront.net', 'amazonaws.com', 'r2.dev', 'b-cdn.net', 'workers.dev',
  'pages.dev', 'github.io', 'githubusercontent.com', 'jsdelivr.net', 'statically.io', 'cloudinary.com', 'imagekit.io',
  'akamaized.net', 'fastly.net', 'azureedge.net', 'windows.net',
]);
/** Second-level labels under a two-letter country domain that are public suffixes themselves: example.co.uk. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'sch']);
/** Names that are never on the public internet (RFC 2606, RFC 6762, home networks): a lab's, a proxy's or a test's. */
const PRIVATE_TLDS = new Set(['invalid', 'test', 'example', 'localhost', 'local', 'lan', 'internal', 'intranet', 'home', 'corp', 'private', 'arpa']);
/** More servers than any real source uses; the cap only stops a runaway one growing the table. */
const MAX_SERVERS = 16;

/**
 * The image server a page URL is on, as far as a rate limit goes: its registrable domain. imgs-2.2xstorage.com and
 * img-r1.2xstorage.com are one CDN, which refuses an account, not a host name. Null -- joins nothing -- for anything
 * that is not a public name on the internet (an address, a one-label name, a home or test domain: a container, a
 * proxy, a lab), for a host many unrelated sites share (SHARED_HOSTS), and for anything not http(s).
 */
export function serverOf(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (labels.length < 2 || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || PRIVATE_TLDS.has(labels[labels.length - 1])) return null;
  const cc = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]);
  const domain = labels.slice(cc ? -3 : -2).join('.');
  return SHARED_HOSTS.has(domain) ? null : domain;
}

/** Rate group -> the image servers its pages have come from. In memory, like the levels: a restart learns them again. */
const servers = new Map<string, Set<string>>();
/** Bumped whenever a group shows a server it had not before, so the joins are worked out again only then. */
let serversSeen = 0;
let joinedAt = -1;
let joins = new Map<string, string>();

/**
 * Learn which image servers a source's pages are on: downloader.ts fetchPages, before the first request, on every
 * chapter and every completion pass. Two rate groups that have both served pages from one server share a key from
 * then on (rateKeyOf). Not for a source whose page URLs are a proxy's (`pagesProxied`: the extension engine serves
 * every extension's pages, and that says nothing about the sites behind it).
 *
 * ⚠️ Learned, not declared: a restart forgets which sources share a server until each has asked for a chapter's pages
 * again. The first chapter after that queues on its own key; its pages already follow the joint one.
 */
export function notePageHosts(src: { id: string; pagesProxied?: boolean }, urls: readonly string[]): void {
  if (src.pagesProxied) return;
  const g = groupOf(src.id);
  let set = servers.get(g);
  for (const u of urls) {
    const s = serverOf(u);
    if (!s || set?.has(s)) continue;
    if (!set) servers.set(g, (set = new Set()));
    if (set.size >= MAX_SERVERS) return;
    set.add(s);
    serversSeen++;
  }
}

/**
 * Group -> the key it shares, for every group joined to another through a server: the smallest key of the groups so
 * joined, worked out again only when a server was learned. A level kept under a key that has just joined another
 * moves to the shared key, the slower of the two and the latest of their holds and rests: either was refused.
 */
function joined(): Map<string, string> {
  if (joinedAt === serversSeen) return joins;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    for (let up = parent.get(r); up !== undefined; up = parent.get(r)) r = up;
    return r;
  };
  const first = new Map<string, string>(); // server -> the first group seen on it
  for (const [g, set] of servers) {
    for (const s of set) {
      const o = first.get(s);
      if (o === undefined) { first.set(s, g); continue; }
      const a = find(o), b = find(g);
      if (a !== b) { if (a < b) parent.set(b, a); else parent.set(a, b); } // the smaller key is the shared one
    }
  }
  const next = new Map<string, string>();
  for (const g of servers.keys()) { const r = find(g); if (r !== g) next.set(g, r); }
  for (const [g, key] of next) {
    const p = paces.get(g);
    if (!p) continue;
    paces.delete(g);
    const q = paces.get(key);
    paces.set(key, !q ? p : {
      level: Math.max(p.level, q.level), since: Math.max(p.since, q.since), hitAt: Math.max(p.hitAt, q.hitAt),
      run: Math.min(p.run, q.run), restUntil: Math.max(p.restUntil, q.restUntil),
    });
  }
  joins = next;
  joinedAt = serversSeen;
  return joins;
}

/** Pool width as the adapter declared it, clamped and NaN-proof (see the comment in downloader.ts). */
function declaredWorkers(pageConcurrency: number | undefined): number {
  const declared = Number(pageConcurrency);
  return Number.isFinite(declared) ? Math.min(8, Math.max(1, Math.floor(declared))) : 1;
}

/**
 * The page gap and pool width fetchChapter starts a chapter with.
 *
 * At level 0 this is exactly what the adapter declared, or the server default for one that declares
 * nothing. Slowed, the pool is one wide (the burst is what was refused) and the gap doubles per level up to
 * the ceiling. ⚠️ A declared gap of 0 (the Suwayomi adapter: the engine paces the site) is `||`-ed back to
 * the server default before doubling, because 0 × 16 is still 0 and a slowed source with no gap at all is
 * not slowed.
 */
export function paceFor(
  src: { id: string; pageGapMs?: number; pageConcurrency?: number },
  defaults: { gapMs: number },
): { gap: number; workers: number; level: number } {
  const level = paceLevel(src.id);
  if (!level) return { gap: src.pageGapMs ?? defaults.gapMs, workers: declaredWorkers(src.pageConcurrency), level };
  const base = src.pageGapMs || defaults.gapMs;
  return { gap: Math.min(MAX_PAGE_GAP_MS, base * 2 ** level), workers: 1, level };
}

/**
 * A caller's own slower pace, for every page it downloads however deep: the slow archive (#117,
 * lib/archive.ts) runs each of its chapters inside one.
 *
 * It travels in an AsyncLocalStorage, the way withOrigin carries who started a download
 * (lib/downloadActivity.ts), so nothing between the archive and fetchPages grows a parameter -- and so it is
 * scoped: a person's own download from the same source a minute later runs at exactly paceFor, as before.
 * The archive is the one caller that WANTS to be slower than its adapter asks. A fixed gap sustained for
 * days reads as a script, and Suwayomi's declared gap 0 and wider pool (issue #37) are tuned for someone
 * waiting on one chapter, not for a thousand-chapter back catalogue fetched over ten days.
 */
export interface SlowPace {
  /** Each page waits a fresh uniform draw from [min, max] ms after the previous one came back. */
  pageGapMs: [number, number];
  /** One page at a time, whatever the adapter declares. */
  workers: 1;
  /** Tests only: where the draws come from. Default Math.random. */
  rand?: () => number;
}
const slow = new AsyncLocalStorage<SlowPace>();

/** Run `fn` with every page it downloads, however deep, at the slow pace. */
export function withSlowPace<T>(p: { pageGapMs: [number, number]; rand?: () => number }, fn: () => T): T {
  return slow.run({ pageGapMs: p.pageGapMs, workers: 1, rand: p.rand }, fn);
}
/** The slow pace in force here, or undefined for every ordinary download. */
export const slowPace = (): SlowPace | undefined => slow.getStore();

/**
 * What fetchPages starts a chapter with. Outside withSlowPace this IS paceFor, unchanged. Inside it the
 * pool is one wide and each page draws its gap from the slow range, whose ends never go below the gap
 * paceFor would have used: an adapter's own gap, or the doubled gap of a pace level a 429 earned, stays a
 * floor. What it does override is a declared gap of 0 and a declared pool -- the Suwayomi adapter's, which
 * would otherwise fetch the archive's pages four at a time with no pause at all.
 */
export function pagePace(
  src: { id: string; pageGapMs?: number; pageConcurrency?: number },
  defaults: { gapMs: number },
): { gap: number; workers: number; level: number; jitter?: [number, number]; rand?: () => number } {
  const pace = paceFor(src, defaults);
  const s = slowPace();
  if (!s) return pace;
  const lo = Math.max(s.pageGapMs[0], pace.gap);
  const jitter: [number, number] = [lo, Math.max(s.pageGapMs[1], lo)];
  return { gap: lo, workers: s.workers, level: pace.level, jitter, ...(s.rand ? { rand: s.rand } : {}) };
}

/**
 * The pace a chapter resumes at after a 429 inside it (fetchPages' resume loop): each gap doubled, up to
 * MAX_PAGE_GAP_MS, and never below where it was. A gap that already sat above the ceiling -- an adapter's own
 * 6 s, an ARCHIVE_PAGE_GAP_MS of 5-8 s -- stays where it was: `min(g x 2, ceiling)` alone would cut it to 4 s,
 * and the resume after a refusal may not be the fast part. A declared gap of 0 stays 0 inside this chapter (the
 * engine paces the site); the NEXT chapter gets the server default doubled (paceFor).
 *
 * A slow pace's range (withSlowPace) backs off at both ends the same way, and keeps a spread: doubling alone
 * takes the default [1500, 4000] to [3000, 4000] and then to [4000, 4000], every page exactly 4 s apart for the
 * rest of the chapter. The low end stays at least a quarter of the top below it (or the range's own width, when
 * that is narrower), so [3000, 4000] is where it settles. A range that was one value to begin with stays one.
 *
 * ⚠️ With a range, `gap` is the low end, never doubled on its own. Every page is drawGap(jitter, gap): the gap is
 * a floor under the draw, so a gap doubled to 4000 beside a range kept at [3000, 4000] drew exactly 4000 for
 * every page, the metronome the spread was kept to avoid. It still never drops below where it was.
 */
export function resumePace(
  p: { gap: number; jitter?: [number, number] },
  ceiling: number = MAX_PAGE_GAP_MS,
): { gap: number; jitter?: [number, number] } {
  const up = (g: number): number => Math.max(g, Math.min(g * 2, ceiling));
  if (!p.jitter) return { gap: p.gap ? up(p.gap) : 0 };
  const [lo, hi] = p.jitter;
  const top = up(hi);
  const low = Math.min(up(lo), top - Math.min(hi - lo, top / 4));
  return { gap: Math.max(p.gap, low), jitter: [low, top] };
}

/** Tests only: forget every key's level and every server learned, so one file's 429 does not slow the next file's chapters. */
export function clearPace(): void {
  paces.clear();
  servers.clear();
  serversSeen = 0;
  joinedAt = -1;
  joins = new Map();
}
