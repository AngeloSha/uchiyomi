// The release radar in words (v0.61.0): "Next chapter ~Friday · usually Fridays", with no React in it.
//
// The server decides when a series' next chapter is likely (bff lib/releaseRadar.ts, `yomi.radar`) and stores the times;
// this turns them into what the series page, the reader's end card, the Library's Releasing soon cards and Updates'
// Expected this week say. The owner's rule: an estimate is always said as one -- "~Friday", "usually Fridays", "due any
// day" -- never a date the reader could hold anyone to.
//
// The state is read from the stored times against the clock, so a radar written on Monday says "due any day" on Friday
// and "running late" the next week without anyone rewriting it. Days are the reader's own: their timezone (the
// browser's), their language (the app's, through Intl, "today" and "tomorrow" by RelativeTimeFormat, weekdays and short
// dates by DateTimeFormat). Pure apart from those, so test/radar.test.ts holds every line.
import { keys, t as tr } from './i18n';
import { activeLocale, cached, relativeTime } from './format';
import { cadenceLine } from './cadence';
import type { CadenceKind, SeriesRadar } from './types';

/**
 * Declared through keys(): every one reaches tr() through a variable. `~{day}` is the estimate's own mark, translated
 * because not every language says "about Friday" with a tilde (Japanese puts 頃 after the day).
 */
const LABELS = keys('~{day}', 'Next chapter {when}', 'Next chapter due any day', 'Running late', 'Due');
/** "usually Fridays", by local weekday, Sunday first (Date.getDay). Seven keys: Russian declines the day. */
const USUALLY = keys('usually Sundays', 'usually Mondays', 'usually Tuesdays', 'usually Wednesdays', 'usually Thursdays',
  'usually Fridays', 'usually Saturdays');

const DAY = 86_400_000;

/**
 * Where a series stands against its radar, `now` being the clock:
 *   expected  before its estimate         "Next chapter ~Friday"
 *   due       from the estimate until it stops being "any day"   "Next chapter due any day"
 *   late      after that, not yet quiet   "Running late · last release 12d ago"
 *   quiet     silent past its rhythm      nothing: it is no longer late, it has stopped
 *   ended     finished                    nothing
 *   none      no estimate, or no radar    nothing
 */
export type RadarState = 'expected' | 'due' | 'late' | 'quiet' | 'ended' | 'none';

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function radarState(r: SeriesRadar | null | undefined, now = Date.now()): RadarState {
  if (!r) return 'none';
  if (r.ended) return 'ended';
  const quiet = ms(r.quietAfter);
  if (quiet != null && now >= quiet) return 'quiet';
  const next = ms(r.nextAt);
  if (next == null) return 'none';
  if (now < next) return 'expected';
  const due = ms(r.dueUntil);
  return due == null || now < due ? 'due' : 'late';
}

/** The app's language for Intl, Western digits kept (lib/format.ts says why). */
const tag = (): string => `${activeLocale()}-u-nu-latn`;

/** A local calendar day's number, so "tomorrow" is the reader's tomorrow, not UTC's. */
const dayNumber = (t: number): number => {
  const d = new Date(t);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};

/**
 * The day `at` falls on, said from `now`: "today", "tomorrow", a weekday within the week ("Friday" / "Fri"), else a
 * short date ("Oct 24"). In the app's language; the browser's own words where Intl cannot.
 */
export function dayText(at: number, now: number, style: 'long' | 'short' = 'long'): string {
  const days = dayNumber(at) - dayNumber(now);
  try {
    if (days === 0 || days === 1) {
      return cached(`radar:rel:${style}`, () => new Intl.RelativeTimeFormat(tag(), { numeric: 'auto', style })).format(days, 'day');
    }
    if (days > 1 && days < 7) return cached(`radar:wd:${style}`, () => new Intl.DateTimeFormat(tag(), { weekday: style })).format(at);
    return cached('radar:date', () => new Intl.DateTimeFormat(tag(), { month: 'short', day: 'numeric' })).format(at);
  } catch {
    return new Date(at).toLocaleDateString();
  }
}

/** "~Friday": the day, marked as an estimate. */
export const approxDay = (at: number, now: number, style: 'long' | 'short' = 'long'): string => tr(LABELS[0], { day: dayText(at, now, style) });

/** "ships weekly": the cadence words the group panel already says (lib/cadence.ts), for a rhythm with no weekday. */
const rhythmText = (kind: CadenceKind): string => {
  const first = cadenceLine({ kind, intervalDays: null, daysSince: null, quiet: false }, null)[0];
  return first ? tr(first.key, first.args) : '';
};

/**
 * The radar's line, as its parts in display order -- each already in the reader's language -- for the series page and
 * the reader's end card: "Next chapter ~Friday", "usually Fridays" (a steady weekday, the estimate's own) or "ships
 * weekly"; "Next chapter due any day"; "Running late", "last release 12d ago". Nothing when the series is quiet, ended,
 * on hiatus (no estimate), has no radar, or is not monitored (`autoUpdate` false: nothing will fetch it).
 */
export function radarParts(r: SeriesRadar | null | undefined, o: { autoUpdate?: boolean; now?: number } = {}): string[] {
  const now = o.now ?? Date.now();
  if (!r || o.autoUpdate === false) return [];
  switch (radarState(r, now)) {
    case 'expected': {
      const next = ms(r.nextAt)!;
      const parts = [tr(LABELS[1], { when: approxDay(next, now) })];
      // The weekday the estimate sits on IS the series' own (the server moved it there), said in the reader's zone.
      const rhythm = r.steady ? tr(USUALLY[new Date(next).getDay()]) : rhythmText(r.kind);
      if (rhythm) parts.push(rhythm);
      return parts;
    }
    case 'due':
      return [tr(LABELS[2])];
    case 'late':
      return r.lastAt ? [tr(LABELS[3]), tr('last release {ago}', { ago: relativeTime(r.lastAt) })] : [tr(LABELS[3])];
    default:
      return [];
  }
}

/** The line as one string, parts joined with ` · `; '' when there is nothing to say. */
export const radarText = (r: SeriesRadar | null | undefined, o: { autoUpdate?: boolean; now?: number } = {}): string =>
  radarParts(r, o).join(' · ');

/**
 * What a card under Releasing soon says: "~Fri", "Due", "Running late" -- or null, for a series without an estimate in
 * force, which sorts after the rest anyway.
 */
export function radarNote(r: SeriesRadar | null | undefined, o: { autoUpdate?: boolean; now?: number } = {}): string | null {
  const now = o.now ?? Date.now();
  if (!r || o.autoUpdate === false) return null;
  switch (radarState(r, now)) {
    case 'expected': return approxDay(ms(r.nextAt)!, now, 'short');
    case 'due': return tr(LABELS[4]);
    case 'late': return tr(LABELS[3]);
    default: return null;
  }
}

/** Soonest estimate first, a series without one last: Expected this week's order, kept if a list arrives out of it. */
export const byExpected = <T extends { yomi?: { radar?: SeriesRadar | null } }>(a: T, b: T): number => {
  const x = ms(a.yomi?.radar?.nextAt);
  const y = ms(b.yomi?.radar?.nextAt);
  return x == null ? (y == null ? 0 : 1) : y == null ? -1 : x - y;
};
