// The release radar (v0.61.0): when a series' next chapter is likely to come, said as an estimate.
//
// The owner reads a handful of series as they come out and wanted to know which of them should have something new
// this week, and which are late. The sources barely say: on this install published_at is NULL for about 38,000 of
// 41,000 chapters, and only 34 of 224 series have any dated chapter, so source dates alone would date about one
// series in seven. The second evidence is the server's own: when each chapter ARRIVED here. A sweep fetches a new
// chapter within hours of its release, so the arrivals carry the series' rhythm too -- once re-downloads, fills, the
// slow archive's back catalogue and completed partials are left out, none of which is a release (releaseArrivals).
//
// Both are clustered into releases exactly as the "who scanlates this" cadence clusters uploads (groupStats.ts
// releaseStarts, cadenceOf): ten chapters dropped in an hour are one release. Then an estimate only where the rhythm
// is clear -- four releases or more, mostly evenly spaced, a series still running -- because a guess presented as a
// date is worse than none. Everything here is shown as an estimate ("~Friday", "usually Fridays"): the owner's rule.
//
// The same module decides the smart update checks (checkEvery, isDue): with Admin -> Settings "Smart update checks"
// on (off by default), the SCHEDULED sweep asks a series that has been quiet for months less often -- never less than
// every three days -- and asks every series at the normal rate while its next chapter is due. Nothing a person starts
// (Run now, Check now, Fetch newest, a repair, Fix everything, the slow archive) consults it.
//
// The pure part (radarOf, releaseArrivals, checkEvery, isDue) takes its clock as a parameter and is unit-tested
// against fixed dates (test/releaseRadar.test.ts); refreshRadar and refreshMissingRadars are its database wrappers.
import { q, one } from './db';
import { CADENCE_WINDOW, cadenceOf, releaseStarts, type Cadence } from './groupStats';
import { komgaStatus } from './komgaDto';
import { noticeHidden, noticeListed } from './noticeChapters';
import { lastNumber } from './chapterRanges';
import { visibleToAll } from './visibility';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A source date further ahead of this server's clock than this is a scheduled post or a bad date, not a release. */
export const FUTURE_SLACK_MS = 36 * HOUR;
/** Source dates whose newest is older than the newest arrival by more than this have stopped dating new chapters. */
export const STALE_SOURCE_MS = 2 * DAY;
/** Fewer releases than this say nothing reliable about when the next one comes. */
export const MIN_RELEASES = 4;
/** A gap counts as on rhythm within this share of the median gap, and never less than a day. */
const TOLERANCE_SHARE = 0.4;
const TOLERANCE_MIN_DAYS = 1;
/** A weekday is the series' own when this many of its last STEADY_WINDOW releases fell on it, and this share. */
const STEADY_WINDOW = 8;
const STEADY_MIN = 3;
const STEADY_SHARE = 0.6;
/** Only a rhythm of five days or more has a weekday; a daily one is every day. */
const STEADY_MIN_DAYS = 5;
/** How far an estimate may be moved onto the series' weekday: any weekday is at most three days away. */
const SNAP_DAYS = 3;
/** Silence measured against the rhythm, as cadenceOf's `quiet`: three intervals, at least a fortnight, else 45 days. */
const QUIET_INTERVALS = 3;
const QUIET_FLOOR_MS = 14 * DAY;
const QUIET_UNKNOWN_MS = 45 * DAY;
/** The smart checks' ceiling: a series is asked at least this often, whatever its silence. */
export const SMART_CAP_MS = 72 * HOUR;

export type RadarBasis = 'source' | 'arrival';

export interface RadarInput {
  /** The series' status as stored or overridden (free text from ComicInfo or an admin); komgaStatus reads it. */
  status?: string | null;
  /**
   * Release dates the sources list, ms: the chosen copy of every available or held number that is not a hidden notice
   * (refreshRadar's query), so the blocklist and the preferred groups are already applied.
   */
  sourceDates: number[];
  /** When each chapter that moved the series forward arrived on this server, ms: releaseArrivals' answer. */
  arrivals: number[];
}

/** One series' radar, as series_radar stores it: times in ms. */
export interface Radar {
  basis: RadarBasis | null;
  kind: Cadence['kind'];
  intervalDays: number | null;
  /** When the newest release began. Never null in a radar: no date at all is no radar. */
  lastAt: number;
  /** The estimate and how long it stays "any day" -- both null when there is no estimate. */
  nextAt: number | null;
  dueUntil: number | null;
  /** From here on the series is quiet, not late. */
  quietAfter: number;
  /** It keeps one weekday: the estimate sits on it, and the web says "usually Fridays". */
  steady: boolean;
  /** Its status says it is finished (completed, cancelled). */
  ended: boolean;
}

/**
 * The arrivals that were releases, from every chapter row of a series: when it arrived (`at`, ms) and the last chapter
 * it holds (`top`, override-aware, a range's end). A row counts only if its top number is above every row that
 * arrived before it -- so a re-download, a filled gap, the slow archive's older chapters and a partial completed later
 * are never a release, however recently their files were written. Oldest first.
 *
 * Reintroduce by counting every row: "a re-downloaded old chapter is not a release" in releaseRadar.test.ts dates a
 * release on the day chapter 3 was fetched again.
 */
export function releaseArrivals(rows: Array<{ at: number; top: number }>): number[] {
  const sorted = rows.filter((r) => Number.isFinite(r.at) && Number.isFinite(r.top)).sort((a, b) => a.at - b.at || a.top - b.top);
  const out: number[] = [];
  let highest = -Infinity;
  for (const r of sorted) {
    if (r.top > highest) { out.push(r.at); highest = r.top; }
  }
  return out;
}

/** The median of a non-empty list. */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Whether the recent releases (`starts`, newest first) keep their rhythm: at least half the gaps between the last
 * CADENCE_WINDOW releases -- the window cadenceOf judges -- lie within 40 % of the median gap, and never less than a
 * day of it. A series that ships in bursts (three in a week, then nothing for a month, then two) has a median that
 * describes none of its weeks, and an estimate from it would be a date pulled from the air.
 */
function keepsRhythm(starts: number[]): boolean {
  const recent = starts.slice(0, CADENCE_WINDOW);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) gaps.push((recent[i - 1] - recent[i]) / DAY);
  if (!gaps.length) return false;
  const m = median(gaps);
  const tolerance = Math.max(TOLERANCE_SHARE * m, TOLERANCE_MIN_DAYS);
  const near = gaps.filter((g) => Math.abs(g - m) <= tolerance).length;
  return near * 2 >= gaps.length;
}

/**
 * The UTC weekday the series keeps (0 Sunday … 6 Saturday), or null: at least STEADY_MIN of its last STEADY_WINDOW
 * releases, and STEADY_SHARE of them, fell on one weekday. A tie goes to the weekday of the newer release.
 */
function steadyDay(starts: number[]): number | null {
  const last = starts.slice(0, STEADY_WINDOW);
  const count = new Map<number, number>();
  for (const t of last) { const d = new Date(t).getUTCDay(); count.set(d, (count.get(d) ?? 0) + 1); }
  let best: number | null = null;
  let most = 0;
  for (const t of last) {           // newest first, so a tie keeps the newer release's weekday
    const d = new Date(t).getUTCDay();
    if ((count.get(d) ?? 0) > most) { best = d; most = count.get(d)!; }
  }
  return best != null && most >= STEADY_MIN && most >= STEADY_SHARE * last.length ? best : null;
}

/** `at` moved by up to SNAP_DAYS days onto UTC weekday `day`, keeping its time of day. */
const ontoWeekday = (at: number, day: number): number => {
  let shift = (day - new Date(at).getUTCDay() + 7) % 7;
  if (shift > SNAP_DAYS) shift -= 7;
  return at + shift * DAY;
};

/**
 * One series' radar from its evidence, or null when nothing dates it at all.
 *
 * Which evidence: the source's dates when they show at least two releases and their newest is no more than two days
 * older than the newest arrival -- a source that stopped dating its new chapters, or dates only its old ones, loses to
 * what arrived; else the arrivals when they show two releases; else neither, and the radar knows only when the last
 * release was. A source date more than 36 hours ahead of this clock is dropped, a nearer one is taken as now.
 *
 * The rhythm is cadenceOf's, over that evidence. An estimate (`nextAt`, `dueUntil`) only for a series still running
 * (not ENDED, ABANDONED or HIATUS by komgaStatus), that ships daily, weekly or monthly, with MIN_RELEASES releases or
 * more that keep their rhythm (keepsRhythm). `nextAt` is the last release plus the interval, moved onto the series'
 * weekday when it keeps one (steady: an interval of five days or more); it stays "any day" until `dueUntil`, half an
 * interval later and at least a day. `quietAfter` is cadenceOf's quiet rule: three intervals, at least a fortnight, or
 * 45 days without a rhythm.
 */
export function radarOf(input: RadarInput, now = Date.now()): Radar | null {
  const source = input.sourceDates
    .filter((t) => Number.isFinite(t) && t <= now + FUTURE_SLACK_MS)
    .map((t) => Math.min(t, now));
  const arrivals = input.arrivals.filter((t) => Number.isFinite(t)).map((t) => Math.min(t, now));
  const sourceStarts = releaseStarts(source);
  const arrivalStarts = releaseStarts(arrivals);
  const newestSource = source.length ? Math.max(...source) : null;
  const newestArrival = arrivals.length ? Math.max(...arrivals) : null;

  let basis: RadarBasis | null = null;
  // Reintroduce by taking the source's dates whenever they show two releases: "stale source dates: the arrivals win"
  // in releaseRadar.test.ts reads basis 'source' and a next chapter dated a year ago.
  if (sourceStarts.length >= 2 && (newestArrival == null || newestArrival - newestSource! <= STALE_SOURCE_MS)) basis = 'source';
  else if (arrivalStarts.length >= 2) basis = 'arrival';

  const starts = basis === 'source' ? sourceStarts : basis === 'arrival' ? arrivalStarts : [];
  const lastAt = starts.length ? starts[0] : Math.max(sourceStarts[0] ?? -Infinity, arrivalStarts[0] ?? -Infinity);
  if (!Number.isFinite(lastAt)) return null;

  const cadence = basis ? cadenceOf(basis === 'source' ? source : arrivals, now) : null;
  const kind: Cadence['kind'] = cadence?.kind ?? 'unknown';
  const intervalDays = cadence?.intervalDays ?? null;
  const status = komgaStatus(input.status);
  const ended = status === 'ENDED' || status === 'ABANDONED';

  let nextAt: number | null = null;
  let dueUntil: number | null = null;
  let steady = false;
  // Reintroduce by estimating from any rhythm: "uneven gaps give no estimate" and "three releases give no estimate, but
  // say when the last one was" in releaseRadar.test.ts read a date; drop the status test and "an ended or paused series
  // has no estimate" does.
  if (intervalDays != null && !ended && status !== 'HIATUS'
      && (kind === 'daily' || kind === 'weekly' || kind === 'monthly')
      && starts.length >= MIN_RELEASES && keepsRhythm(starts)) {
    const day = intervalDays >= STEADY_MIN_DAYS ? steadyDay(starts) : null;
    steady = day != null;
    const base = lastAt + intervalDays * DAY;
    nextAt = day != null ? ontoWeekday(base, day) : base;
    dueUntil = nextAt + Math.max(DAY, (intervalDays * DAY) / 2);
  }
  const quietAfter = lastAt + (intervalDays != null ? Math.max(QUIET_INTERVALS * intervalDays * DAY, QUIET_FLOOR_MS) : QUIET_UNKNOWN_MS);
  return { basis, kind, intervalDays, lastAt, nextAt, dueUntil, quietAfter, steady, ended };
}

/* ------------------------------------------------------------------------------------------- the smart checks */

/** What the smart checks read of one series: its row's stamps and its radar's times, ms (null when unknown). */
export interface DueInput {
  /** lib_series.source_checked_at: when its sources were last asked. Null: never. */
  checkedAt: number | null;
  /** lib_series.source_missing: chapters its sources list that this server lacks, at the last check. */
  sourceMissing: number | null;
  nextAt: number | null;
  dueUntil: number | null;
  lastAt: number | null;
  /** lib_series.latest_mtime (its newest chapter file) and created_at (when it came into the library). */
  latestMtime: number | null;
  createdAt: number | null;
}

/**
 * How often the scheduled sweep asks a series while the smart checks are on, given the update interval `hoursMs` (H).
 *
 * At H -- every sweep, as with the switch off -- while its sources list chapters this server lacks (they are being
 * fetched), and while its next chapter is due: from a day before the radar's estimate until its `dueUntil`. Otherwise
 * a seventh of its silence (since its last release, its newest file or its arrival in the library, whichever is
 * latest), never less than H and never more than three days, or H when H is longer. So a series quiet for a week is
 * asked daily, one quiet for three weeks every three days, and one that has said nothing for ten years every three
 * days too. Reintroduce by dropping the cap: "a series quiet for ten years is still asked within three days" in
 * releaseRadar.test.ts waits for over a year.
 */
export function checkEvery(r: DueInput, now: number, hoursMs: number): number {
  const h = Number.isFinite(hoursMs) && hoursMs > 0 ? hoursMs : 6 * HOUR;
  const cap = Math.max(h, SMART_CAP_MS);
  if ((r.sourceMissing ?? 0) > 0) return h;
  if (r.nextAt != null && r.dueUntil != null && now >= r.nextAt - DAY && now < r.dueUntil) return h;
  const heard = Math.max(r.lastAt ?? 0, r.latestMtime ?? 0, r.createdAt ?? 0);
  const silence = Math.max(0, now - heard);
  return Math.min(cap, Math.max(h, silence / 7));
}

/**
 * Whether the scheduled sweep asks this series now: never asked, or asked at least checkEvery ago less half an
 * interval. The slack is the sweep's own length: a sweep that reached a series late in its run would otherwise make it
 * miss the next one by minutes and wait a whole interval more. Reintroduce without it: "half an interval of slack" in
 * releaseRadar.test.ts finds a series asked five and a half hours ago rested by a six-hourly sweep.
 */
export function isDue(r: DueInput, now: number, hoursMs: number): boolean {
  if (r.checkedAt == null) return true;
  const h = Number.isFinite(hoursMs) && hoursMs > 0 ? hoursMs : 6 * HOUR;
  return now - r.checkedAt >= checkEvery(r, now, h) - h / 2;
}

/* ------------------------------------------------------------------------------------------------- the database */

const ms = (v: unknown): number | null => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/**
 * Work out one series' radar from what is stored and keep it in series_radar: the row rewritten, or removed when the
 * series has no source to release anything through or nothing dates it. Database only -- no source is asked. Best
 * effort for its callers (the listing refresh, the sweep, Check now): a radar must never be what fails a check.
 *
 * The source dates are the listing's chosen copies of available and held numbers -- a held one is released, by a
 * group other than the preferred -- never a blocked number's and never a notice the series hides. The arrivals are
 * every chapter row's, tombstones included (a chapter deleted after reading still came when it came), hidden notices
 * not: when its file first came, LEAST(created_at, its file's mtime), since rows scanned before v0.55.2 all carry the
 * upgrade's time as created_at; and the last chapter it holds, override-aware (chapterRanges.ts lastNumber).
 */
export async function refreshRadar(seriesId: string, now = Date.now()): Promise<Radar | null> {
  const s = await one<{ status: string | null; routed: boolean }>(
    `SELECT COALESCE(o.status, s.status) AS status,
            (s.source_id IS NOT NULL OR EXISTS (SELECT 1 FROM series_sources ss WHERE ss.series_id = s.id)) AS routed
       FROM lib_series s LEFT JOIN series_overrides o ON o.series_id = s.id
      WHERE s.id = $1`, [seriesId]);
  if (!s) return null;
  let radar: Radar | null = null;
  if (s.routed) {
    const listed = await q<{ at: Date }>(
      `SELECT l.published_at AS at FROM series_listing l
        WHERE l.series_id = $1 AND l.status IN ('available', 'held') AND l.published_at IS NOT NULL
          AND NOT ${noticeListed('l')}`, [seriesId]);
    const books = await q<{ at: Date | null; top: number | null }>(
      `SELECT LEAST(b.created_at, CASE WHEN b.mtime > 0 THEN to_timestamp(b.mtime / 1000.0) END) AS at,
              ${lastNumber('b', 'ov')} AS top
         FROM lib_books b JOIN lib_series s ON s.id = b.series_id
         LEFT JOIN book_overrides ov ON ov.book_id = b.id
        WHERE b.series_id = $1 AND NOT ${noticeHidden('s', 'b', 'ov')}`, [seriesId]);
    radar = radarOf({
      status: s.status,
      sourceDates: listed.map((r) => ms(r.at)).filter((t): t is number => t != null),
      arrivals: releaseArrivals(books.map((b) => ({ at: ms(b.at) ?? NaN, top: Number(b.top) }))),
    }, now);
  }
  if (!radar) {
    await q('DELETE FROM series_radar WHERE series_id = $1', [seriesId]);
    return null;
  }
  const at = (t: number | null) => (t == null ? null : new Date(t).toISOString());
  // INSERT … SELECT so a series deleted in the meantime writes nothing rather than failing its foreign key; the casts
  // because a SELECT's parameters are text unless told otherwise.
  await q(
    `INSERT INTO series_radar (series_id, basis, kind, interval_days, last_at, next_at, due_until, quiet_after, steady, ended, computed_at)
     SELECT $1::text, $2::text, $3::text, $4::real, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz,
            $9::boolean, $10::boolean, now()
      WHERE EXISTS (SELECT 1 FROM lib_series WHERE id = $1::text)
     ON CONFLICT (series_id) DO UPDATE SET basis = EXCLUDED.basis, kind = EXCLUDED.kind, interval_days = EXCLUDED.interval_days,
       last_at = EXCLUDED.last_at, next_at = EXCLUDED.next_at, due_until = EXCLUDED.due_until, quiet_after = EXCLUDED.quiet_after,
       steady = EXCLUDED.steady, ended = EXCLUDED.ended, computed_at = now()`,
    [seriesId, radar.basis, radar.kind, radar.intervalDays, at(radar.lastAt), at(radar.nextAt), at(radar.dueUntil),
      at(radar.quietAfter), radar.steady, radar.ended],
  );
  return radar;
}

/**
 * Once at boot (server.ts): a radar for every series that has a source and none yet -- an upgrade from v0.60.1, a
 * series added while the server was down -- from what is already stored, so Releasing soon and Expected this week
 * are not empty until each series' next check. Database only, one series at a time. How many it dated.
 */
export async function refreshMissingRadars(): Promise<number> {
  const ids = await q<{ id: string }>(
    `SELECT s.id FROM lib_series s
      WHERE ${visibleToAll('s')}
        AND (s.source_id IS NOT NULL OR EXISTS (SELECT 1 FROM series_sources ss WHERE ss.series_id = s.id))
        AND NOT EXISTS (SELECT 1 FROM series_radar r WHERE r.series_id = s.id)
      ORDER BY s.id`);
  let dated = 0;
  for (const { id } of ids) {
    if (await refreshRadar(id).catch(() => null)) dated++;
  }
  return dated;
}

/** A radar row as the API sends it (yomi.radar): ISO times, `every` the interval in days. */
export interface RadarDto {
  nextAt: string | null;
  dueUntil: string | null;
  quietAfter: string | null;
  lastAt: string | null;
  every: number | null;
  kind: Cadence['kind'];
  steady: boolean;
  ended: boolean;
  basis: RadarBasis | null;
}

/** The radar of each of these series that has one, for enrichSeries: one query for the page. */
export async function radarsFor(seriesIds: string[]): Promise<Map<string, RadarDto>> {
  if (!seriesIds.length) return new Map();
  const rows = await q<{ series_id: string; basis: string | null; kind: string; interval_days: number | null; last_at: Date | null;
                         next_at: Date | null; due_until: Date | null; quiet_after: Date | null; steady: boolean; ended: boolean }>(
    `SELECT series_id, basis, kind, interval_days, last_at, next_at, due_until, quiet_after, steady, ended
       FROM series_radar WHERE series_id = ANY($1)`, [seriesIds],
  ).catch(() => []);
  const iso = (v: Date | null) => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
  return new Map(rows.map((r) => [r.series_id, {
    nextAt: iso(r.next_at), dueUntil: iso(r.due_until), quietAfter: iso(r.quiet_after), lastAt: iso(r.last_at),
    every: r.interval_days == null ? null : Math.round(Number(r.interval_days) * 10) / 10,
    kind: (['daily', 'weekly', 'monthly', 'irregular'].includes(r.kind) ? r.kind : 'unknown') as Cadence['kind'],
    steady: !!r.steady, ended: !!r.ended,
    basis: r.basis === 'source' || r.basis === 'arrival' ? r.basis : null,
  }]));
}
