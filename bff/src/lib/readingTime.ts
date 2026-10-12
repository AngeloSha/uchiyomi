// Reading time (v0.61.0): how long this reader has spent reading, from the page turns the reader already sends.
//
// Nothing new is recorded. Every page turn is a reading_events row (lib/progress.ts), dated when it happened -- the
// offline outbox's too, since v0.61.0 -- and the time between one turn and the next is the time spent on the page
// before it. Four things make that honest rather than a stopwatch left running:
//
//   * ONE timeline per reader, every device merged by time (ties by id), so a phone and a PC open at once never count
//     an hour twice; a duplicate replay of the same turn at the same instant adds nothing.
//   * A gap counts in full only up to an allowance: five minutes for a page, stretched for a tall strip by its height
//     -- a 1:20 webtoon strip is read for minutes where a page is read in seconds -- to at most thirty. A longer gap is a
//     break: it counts nothing, and the next turn starts a new sitting. Nothing is clipped to the allowance: a phone
//     put down on page 12 for an hour is not "five minutes of reading".
//   * The reader never sends an event for the page it opens on (it seeds its last sent page on open; web
//     app/reader/page.tsx), so each sitting adds one typical page for it: the median counted gap of the window, never
//     under 5 s or over 90 s, 20 s when the window has none.
//   * Time is the earlier event's: its chapter, its series, its device and its hour. A sitting's opening page is its
//     first event's.
//
// Per chapter, the median over the chapters finished in the window that have time -- null under three, which is too
// few to be anyone's pace. Hours are in the reader's own timezone (validated by Intl; UTC otherwise), the windows are
// rolling 7 and 30 days, and the year is the UTC calendar year /api/wrapped counts chapters in.
//
// The pure part (readingTimeline, summarize, allowanceFor, …) is tested against fixed events (test/readingTime.test.ts);
// loadTimeline and deviceNames are its database wrappers. Counts-only surfaces stay counts-only: the household
// leaderboard and the admin's member stats never see anyone's time.
import { q } from './db';

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 86_400_000;

/** A page is read within this; a longer gap is a break. Stretched for tall strips (allowanceFor). */
export const PAGE_ALLOWANCE_MS = 5 * MIN;
/** The most a tall strip stretches it. */
export const MAX_ALLOWANCE_MS = 30 * MIN;
/** A page as tall as four times its width is still a page; past that the allowance grows with the height. */
const TALL_RATIO = 4;
/** The typical page a sitting adds for the page it opened on, and its bounds. */
export const TYPICAL_DEFAULT_MS = 20 * SEC;
const TYPICAL_MIN_MS = 5 * SEC;
const TYPICAL_MAX_MS = 90 * SEC;
/** Fewer finished chapters with time than this give no per-chapter pace. */
export const PACE_MIN_CHAPTERS = 3;

/** One page turn, as reading_events stores it. */
export interface TimeEvent {
  id: number;
  /** When it happened, ms. */
  at: number;
  bookId: string;
  seriesId: string;
  deviceId: string | null;
  completed: boolean;
}

/** Time spent on one event's page, or a sitting's opening page (`opening`, whose length is the window's typical page). */
export interface Piece {
  at: number;
  ms: number;
  bookId: string;
  seriesId: string;
  deviceId: string | null;
  opening?: true;
}

export interface Timeline {
  /** Counted gaps and sitting openings (ms 0 until summarize prices them), in time order. */
  pieces: Piece[];
  /** The finished chapters: every completed event, by time. */
  finished: Array<{ at: number; bookId: string; seriesId: string }>;
}

/**
 * How long a page of this chapter may take before a gap is a break: five minutes, times the chapter's tallest page's
 * height-to-width ratio over four once it is taller than that, at most thirty. Unknown (never opened on this server,
 * no counted dimensions): five minutes.
 */
export function allowanceFor(ratio: number | null | undefined): number {
  const r = typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  return Math.min(MAX_ALLOWANCE_MS, PAGE_ALLOWANCE_MS * Math.max(1, r / TALL_RATIO));
}

/**
 * The merged timeline: every event by time (ties by id), each gap to the next that is within its page's allowance
 * counted to the earlier event, every event after a break (or the first) opening a sitting.
 *
 * Reintroduce per-device timelines (group by deviceId first): "two devices at once count once" in readingTime.test.ts
 * doubles the time. Reintroduce clipping (count min(gap, allowance)): "a long gap is a break, and counts nothing" reads
 * five minutes.
 */
export function readingTimeline(events: TimeEvent[], allowance: (bookId: string) => number): Timeline {
  const sorted = events.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at || a.id - b.id);
  const pieces: Piece[] = [];
  const finished: Timeline['finished'] = [];
  let prev: TimeEvent | null = null;
  for (const e of sorted) {
    if (e.completed) finished.push({ at: e.at, bookId: e.bookId, seriesId: e.seriesId });
    if (prev && e.at - prev.at <= allowance(prev.bookId)) {
      // A replay of the same turn at the same instant is a gap of nothing: it adds nothing, and opens nothing.
      if (e.at > prev.at) pieces.push({ at: prev.at, ms: e.at - prev.at, bookId: prev.bookId, seriesId: prev.seriesId, deviceId: prev.deviceId });
    } else {
      pieces.push({ at: e.at, ms: 0, bookId: e.bookId, seriesId: e.seriesId, deviceId: e.deviceId, opening: true });
    }
    prev = e;
  }
  return { pieces, finished };
}

/** The median of a non-empty list. */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export interface WindowTime {
  ms: number;
  /** Chapters finished in the window: completed events, as /api/stats and /api/wrapped count them. */
  chapters: number;
  /** The median time of a chapter finished in the window, null under PACE_MIN_CHAPTERS. */
  perChapterMs: number | null;
  /** Time by the hour of the day it was read, 0-23 in the timezone `hourOf` speaks. */
  byHour: number[];
  /** Time by device id (null: an event no device named). */
  byDevice: Map<string | null, number>;
  /** Time by series. */
  bySeries: Map<string, number>;
  /** The per-chapter times the median was taken over, by book. */
  perBook: Map<string, number>;
}

/**
 * What the timeline says about the window [from, to): its time (the counted gaps and, for each sitting opened in it, the
 * window's typical page), its chapters, and where the time went. `onlySeries` narrows the per-chapter pace to one
 * series' chapters (the series page's "Catch up in"), everything else stays the window's.
 */
export function summarize(tl: Timeline, from: number, to: number, hourOf: (t: number) => number, onlySeries?: string): WindowTime {
  const inside = (t: number) => t >= from && t < to;
  const counted = tl.pieces.filter((p) => !p.opening && inside(p.at));
  const gaps = counted.map((p) => p.ms).filter((ms) => ms > 0);
  const typical = gaps.length ? Math.min(TYPICAL_MAX_MS, Math.max(TYPICAL_MIN_MS, median(gaps))) : TYPICAL_DEFAULT_MS;
  const byHour = Array<number>(24).fill(0);
  const byDevice = new Map<string | null, number>();
  const bySeries = new Map<string, number>();
  const byBook = new Map<string, number>();
  let ms = 0;
  for (const p of tl.pieces) {
    if (!inside(p.at)) continue;
    const t = p.opening ? typical : p.ms;
    ms += t;
    const h = hourOf(p.at);
    if (h >= 0 && h < 24) byHour[h] += t;
    byDevice.set(p.deviceId, (byDevice.get(p.deviceId) ?? 0) + t);
    bySeries.set(p.seriesId, (bySeries.get(p.seriesId) ?? 0) + t);
    byBook.set(p.bookId, (byBook.get(p.bookId) ?? 0) + t);
  }
  const finished = tl.finished.filter((f) => inside(f.at));
  const perBook = new Map<string, number>();
  for (const f of finished) {
    if (onlySeries && f.seriesId !== onlySeries) continue;
    const t = byBook.get(f.bookId) ?? 0;
    if (t > 0) perBook.set(f.bookId, t);
  }
  const times = [...perBook.values()];
  return {
    ms: Math.round(ms),
    chapters: finished.length,
    perChapterMs: times.length >= PACE_MIN_CHAPTERS ? Math.round(median(times)) : null,
    byHour: byHour.map((x) => Math.round(x)),
    byDevice, bySeries, perBook,
  };
}

/** A timezone this server's Intl knows, else UTC. Names only (`Asia/Kolkata`), never an offset someone typed. */
export function validTz(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return 'UTC';
  try {
    // The name as the reader's browser gave it: ICU may answer an older alias (Asia/Calcutta for Asia/Kolkata).
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * The hour of the day in `tz` for an instant. Offsets and their changes fall on quarter hours, so the answer is the same
 * across each quarter hour of UTC and is worked out once per quarter: a year of a heavy reader's page turns is tens of
 * thousands of instants and a few thousand quarters.
 */
export function hourIn(tz: string): (t: number) => number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: validTz(tz), hour: 'numeric', hourCycle: 'h23' });
  const memo = new Map<number, number>();
  return (t: number) => {
    const quarter = Math.floor(t / (15 * MIN));
    let h = memo.get(quarter);
    if (h === undefined) {
      const part = fmt.formatToParts(new Date(quarter * 15 * MIN)).find((p) => p.type === 'hour');
      h = part ? Number(part.value) % 24 : 0;
      memo.set(quarter, h);
    }
    return h;
  };
}

/* ------------------------------------------------------------------------------------------------- the database */

/** Lets a window's sittings and gaps at its edges be judged as they would be from inside: the longest allowance. */
const EDGE_MS = MAX_ALLOWANCE_MS;

/**
 * One reader's timeline over [from, to), from their own reading_events only -- with half an hour either side, so a
 * gap or a sitting at a window's edge is judged as it would be from inside it. Each chapter's allowance comes from its
 * tallest counted page, read in one aggregate over lib_books.page_dims for the chapters in the timeline; a dimension
 * that is not a number is ignored, not cast.
 */
export async function loadTimeline(userId: string, from: number, to: number): Promise<Timeline> {
  // Nothing is read in the future (progressRules.ts eventTime dates no turn past now): a window that ends later -- this
  // year's, or Wrapped asked about the year 9999 -- is read up to tomorrow, and one that starts later is empty. The year
  // 10000 is also a date Postgres will not take.
  const end = Math.min(to + EDGE_MS, Date.now() + DAY);
  if (!(from - EDGE_MS < end)) return { pieces: [], finished: [] };
  const rows = await q<{ id: number; at: Date; book_id: string; series_id: string; device_id: string | null; completed: boolean }>(
    `SELECT id, created_at AS at, book_id, series_id, device_id, completed FROM reading_events
      WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at, id`,
    [userId, new Date(from - EDGE_MS).toISOString(), new Date(end).toISOString()],
  );
  const books = [...new Set(rows.map((r) => r.book_id))];
  const tall = new Map<string, number>();
  if (books.length) {
    const dims = await q<{ id: string; ratio: number | null }>(
      `SELECT b.id, max((d->>'height')::numeric / NULLIF((d->>'width')::numeric, 0))::float8 AS ratio
         FROM lib_books b
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(b.page_dims) = 'array' THEN b.page_dims ELSE '[]'::jsonb END) d
        WHERE b.id = ANY($1) AND jsonb_typeof(d) = 'object'
          AND d->>'height' ~ '^[0-9]+(\\.[0-9]+)?$' AND d->>'width' ~ '^[0-9]+(\\.[0-9]+)?$'
        GROUP BY b.id`,
      [books],
    ).catch(() => []);
    for (const d of dims) if (d.ratio != null) tall.set(d.id, Number(d.ratio));
  }
  return readingTimeline(
    rows.map((r) => ({ id: Number(r.id), at: new Date(r.at).getTime(), bookId: r.book_id, seriesId: r.series_id, deviceId: r.device_id, completed: r.completed })),
    (bookId) => allowanceFor(tall.get(bookId)),
  );
}

/**
 * The name of each of this reader's devices: the newest name any of their sessions on it gave (refresh_tokens), so a
 * phone renamed by a later sign-in reads its new name. Only their own sessions are read.
 */
export async function deviceNames(userId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await q<{ device_id: string; device_name: string }>(
    `SELECT DISTINCT ON (device_id) device_id, device_name FROM refresh_tokens
      WHERE user_id = $1 AND device_id = ANY($2) AND device_name IS NOT NULL
      ORDER BY device_id, created_at DESC`,
    [userId, ids],
  ).catch(() => []);
  return new Map(rows.map((r) => [r.device_id, r.device_name]));
}

/**
 * Time by device as the Studio lists it: one row per NAME, most time first -- two sessions of one phone, or two phones
 * both called "iPhone", are one row -- and a device nobody named under null.
 */
export async function devicesOf(userId: string, byDevice: Map<string | null, number>): Promise<Array<{ name: string | null; ms: number }>> {
  const names = await deviceNames(userId, [...byDevice.keys()].filter((k): k is string => !!k));
  const byName = new Map<string | null, number>();
  for (const [id, ms] of byDevice) {
    const name = (id && names.get(id)) || null;
    byName.set(name, (byName.get(name) ?? 0) + ms);
  }
  return [...byName].map(([name, ms]) => ({ name, ms: Math.round(ms) })).filter((d) => d.ms > 0).sort((a, b) => b.ms - a.ms);
}

/** The UTC calendar year `year`, as /api/wrapped counts it: [1 January, 1 January after). */
export const yearRange = (year: number): [number, number] => [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)];

/** Rolling windows ending now. */
export const lastDays = (days: number, now = Date.now()): [number, number] => [now - days * DAY, now + 1];
