// Who scanlates a series, from the copies its sources list and the files on its disk.
//
// A reader deciding which group to prefer, or whether to wait for one, needs more than a name: how many
// chapters the group has released, which ones, when the last was, and whether it still ships or has gone
// quiet. Three places want that answer -- the series page's panel, the admin's preference editor and the
// add dialog on Discover -- and each used to count something slightly different (on-disk files, listed
// rows, nothing). One aggregator, pure over its two inputs, so the three read the same figures.
//
// Group identity is normGroup, the same equality the release rules use, so "Asura Scans" and "asurascans"
// are one row here as they are one group there. The display name is the first spelling seen ON DISK,
// because that is the spelling in the reader's own files (ComicInfo Translator, lib_books.scanlator) and
// the one the chapter list already shows beside each row; only a group with nothing on disk takes the
// listing's spelling. A joint release counts once for each of its groups: it is B's work as much as A's,
// the reading lib/releases.ts gives a block.
//
// No database and no clock of its own: `now` is a parameter so the cadence rules can be pinned by tests
// against fixed dates rather than against whatever day the suite happens to run on.
import { groupsOf, normGroup } from './releases';

export interface Cadence {
  /** From the median gap between the group's last ten release DAYS; `unknown` below two distinct days. */
  kind: 'daily' | 'weekly' | 'monthly' | 'irregular' | 'unknown';
  intervalDays: number | null;
  daysSince: number | null;
  /** The group has been silent for longer than its own rhythm explains. */
  quiet: boolean;
}

export interface GroupStat {
  name: string;
  /**
   * Chapters the group released: distinct numbers, across every source. A joint release counts for each
   * of its groups; a second copy of the same number (a follower listing it too, a re-upload) is not a
   * second release, exactly as the cadence below does not date it twice.
   */
  releases: number;
  first: number | null;
  last: number | null;
  lastReleaseAt: string | null;
  cadence: Cadence;
  /** Chapters on this server whose file is stamped with the group. */
  onDisk: number;
  /** The numbers the group released, ascending, each once. */
  chapters: number[];
  /** The languages its copies are in, sorted; empty when the source names none. */
  langs: string[];
  /**
   * One flag per week for the last twelve, OLDEST FIRST: index 11 is the seven days ending now, index 0
   * the week that began 84 days ago. True when the group released a chapter in that window. The series
   * page draws these as an activity strip, which is the whole reason they are flags and not dates: twelve
   * booleans per group is smaller than any date list and the strip needs nothing more.
   */
  weeks: boolean[];
}

/** One listed copy, as the listing stores it or as an adapter lists it live. */
export interface StatCopy {
  number: number;
  groups?: string[];
  scanlator?: string | null;
  publishedAt?: string | null;
  source?: string;
  lang?: string | null;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** How many weeks the activity strip covers. */
const WEEKS = 12;
/** How many of the newest release days the rhythm is judged from: enough to smooth one late week, few enough to notice a group that slowed down this year. */
/** Uploads closer together than this are one release (a batch), whatever the calendar says. */
const RELEASE_GAP_MS = 12 * 60 * 60 * 1000;
const CADENCE_WINDOW = 10;

/**
 * A group's rhythm from its release dates (ms, any order, one per chapter).
 *
 * The median gap between the newest ten RELEASE DAYS, not between the newest ten chapters: groups ship in
 * batches -- two chapters at a time every week is the common MangaDex pattern, ten in an hour once a month
 * is not rare -- and over raw timestamps most of those gaps are zero, so both read "ships daily" and the
 * monthly one is "quiet" a fortnight after every drop. A day with several chapters is one release day.
 * The median and not the mean: one three-month hiatus in a weekly group would otherwise read as "monthly"
 * for the next ten chapters, and a median ignores one outlier. The bands are generous on purpose -- a
 * "weekly" group that slips to nine days is still weekly to its readers.
 *
 * `quiet` is the useful bit: silence measured against the group's OWN interval, three of them, with a
 * two-week floor so a daily group is not "quiet" over a long weekend; a group with no rhythm to judge by
 * is quiet after forty-five days, which is longer than any regular schedule and shorter than "gone".
 * `daysSince` is from the newest timestamp itself, not its day, so it is whole days really elapsed.
 */
export function cadenceOf(dates: number[], now = Date.now()): Cadence {
  const valid = [...new Set(dates.filter((t) => Number.isFinite(t)))].sort((a, b) => b - a);
  const last = valid[0];
  const daysSince = last === undefined ? null : Math.max(0, Math.floor((now - last) / DAY_MS));
  // One RELEASE is a cluster of uploads: walking newest-first, a timestamp starts a new release only when
  // the gap to the previous one is longer than half a day. A batch of ten chapters dropped in an hour is
  // one release, and so is the same batch when it straddles midnight -- bucketing by calendar day made a
  // group that uploads at 23:50 and 00:10 every week read "daily", which is the headline this card exists
  // to get right. Then the last CADENCE_WINDOW releases, and the gaps between them in days.
  // Reintroduce by taking `valid.slice(0, CADENCE_WINDOW)` and dividing the raw gaps by DAY_MS: "two
  // chapters a week at a time still ships weekly" reads daily and "ten chapters dropped in one hour a
  // month apart ship monthly" reads daily and quiet; bucket by UTC day instead and "a batch that crosses
  // midnight is one release" reads daily.
  const starts: number[] = [];
  for (const t of valid) {
    if (!starts.length || starts[starts.length - 1] - t > RELEASE_GAP_MS) starts.push(t);
    else starts[starts.length - 1] = t; // the batch's earliest upload is when the release began
  }
  const recent = starts.slice(0, CADENCE_WINDOW);
  if (recent.length < 2) {
    return { kind: 'unknown', intervalDays: null, daysSince, quiet: daysSince != null && daysSince > 45 };
  }
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) gaps.push((recent[i - 1] - recent[i]) / DAY_MS);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  const intervalDays = Math.round(median * 10) / 10;
  const kind: Cadence['kind'] = intervalDays <= 1.5 ? 'daily' : intervalDays <= 9 ? 'weekly' : intervalDays <= 40 ? 'monthly' : 'irregular';
  // Three intervals, never less than a fortnight: a group that ships daily is not "quiet" on the third day,
  // and a monthly one is not quiet until it has missed three months.
  const quiet = daysSince != null && daysSince > Math.max(3 * intervalDays, 14);
  return { kind, intervalDays, daysSince, quiet };
}

/** A group with nothing counted: what the preference editor shows for a blocked name that has vanished. */
export function emptyGroupStat(name: string): GroupStat {
  return {
    name, releases: 0, first: null, last: null, lastReleaseAt: null,
    cadence: { kind: 'unknown', intervalDays: null, daysSince: null, quiet: false },
    onDisk: 0, chapters: [], langs: [], weeks: Array<boolean>(WEEKS).fill(false),
  };
}

/**
 * Which of the last WEEKS weeks had a release, from the same per-number dates the cadence is judged on.
 *
 * Newest LAST, so the strip reads left to right like a calendar and the rightmost dot is this week; the
 * flag is written at `WEEKS - 1 - w` where `w` is whole weeks ago. A scrape can carry a date a little
 * ahead of this server's clock (a site's timezone, a scheduled release stamped early), and `Math.max(0, …)`
 * folds that into this week rather than dropping the group's newest release from its own strip.
 * Reintroduce by writing `weeks[w]` instead: "weeks: twelve flags, newest last" reads the strip backwards
 * (index 1 and 3 set instead of 10 and 8).
 */
export function weeksOf(dates: number[], now = Date.now()): boolean[] {
  const weeks = Array<boolean>(WEEKS).fill(false);
  for (const t of dates) {
    if (!Number.isFinite(t)) continue;
    const w = Math.max(0, Math.floor((now - t) / WEEK_MS));
    if (w < WEEKS) weeks[WEEKS - 1 - w] = true;
  }
  return weeks;
}

interface Acc {
  name: string;
  onDisk: number;
  numbers: Set<number>;
  /** Per number, the EARLIEST valid date: a re-upload of chapter 12 is not a twelfth release. */
  dated: Map<number, number>;
  langs: Set<string>;
}

/**
 * Per-group figures from every listed copy and every stamped file, sorted by releases descending, then
 * by name. A copy that names no group belongs to nobody and is not counted anywhere.
 */
export function groupStats(copies: StatCopy[], onDisk: Array<{ number: number; scanlator: string | null }>, now = Date.now()): GroupStat[] {
  const acc = new Map<string, Acc>();
  const entry = (name: string): Acc | null => {
    const key = normGroup(name);
    if (!key) return null;
    let a = acc.get(key);
    if (!a) { a = { name, onDisk: 0, numbers: new Set(), dated: new Map(), langs: new Set() }; acc.set(key, a); }
    return a;
  };
  // Disk first, so its spelling is the one kept for a group that is in both.
  for (const b of onDisk) {
    if (!b.scanlator) continue;
    for (const name of groupsOf({ scanlator: b.scanlator })) { const a = entry(name); if (a) a.onDisk++; }
  }
  for (const c of copies) {
    if (!Number.isFinite(c.number)) continue;
    const t = c.publishedAt ? Date.parse(c.publishedAt) : NaN;
    for (const name of groupsOf({ groups: c.groups, scanlator: c.scanlator ?? undefined })) {
      const a = entry(name);
      if (!a) continue;
      a.numbers.add(c.number);
      if (Number.isFinite(t)) {
        const prev = a.dated.get(c.number);
        if (prev === undefined || t < prev) a.dated.set(c.number, t);
      }
      if (c.lang) a.langs.add(c.lang);
    }
  }
  const out: GroupStat[] = [];
  for (const a of acc.values()) {
    const chapters = [...a.numbers].sort((x, y) => x - y);
    const dates = [...a.dated.values()];
    const lastAt = dates.length ? Math.max(...dates) : null;
    out.push({
      name: a.name,
      // Distinct numbers, not copies: a series followed on two sources that both list Group A's hundred
      // chapters would otherwise say "200 releases · Ch. 1-100", and the docs promise chapters.
      // Reintroduce by counting one per copy in the loop above: "the follower's duplicate is not a
      // release" in groupStats.test.ts reads 4.
      releases: a.numbers.size,
      first: chapters.length ? chapters[0] : null,
      last: chapters.length ? chapters[chapters.length - 1] : null,
      lastReleaseAt: lastAt == null ? null : new Date(lastAt).toISOString(),
      cadence: cadenceOf(dates, now),
      onDisk: a.onDisk,
      chapters,
      langs: [...a.langs].sort(),
      weeks: weeksOf(dates, now),
    });
  }
  return out.sort((x, y) => y.releases - x.releases || x.name.localeCompare(y.name));
}
