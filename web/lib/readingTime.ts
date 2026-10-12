// Reading time in words (v0.61.0): "4.5 hr", "~6 min per chapter", "Catch up in ~2 hr". No React.
//
// The server works the time out from page turns (bff lib/readingTime.ts, GET /api/stats/time, /api/series/:id/
// reading-pace, /api/wrapped); this says it the way a person reads an amount of time at a glance. Rounded on purpose,
// because the figure is an estimate built on page turns: minutes to the nearest five under an hour, hours to one decimal
// under ten, whole hours above -- never days, since "1 day" of reading reads as a calendar day. In the app's language
// through Intl's units ("4,5 Std.", "4.5 時間"), with the app's own `{n} min` / `{n} h` where Intl has no unit style.
import { t as tr } from './i18n';
import { activeLocale, cached } from './format';

type Unit = 'second' | 'minute' | 'hour';

/** A number and its unit in the app's language, short ("6 min", "4.5 hr"), Western digits kept. */
function unitText(unit: Unit, n: number): string {
  try {
    return cached(`rt:${unit}`, () => new Intl.NumberFormat(`${activeLocale()}-u-nu-latn`, {
      style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1,
    })).format(n);
  } catch {
    return unit === 'second' ? tr('{n} sec', { n }) : unit === 'minute' ? tr('{n} min', { n }) : tr('{n} h', { n });
  }
}

/**
 * An amount of reading: "0 min", "25 min", "4.5 hr", "312 hr". Under an hour, minutes to the nearest five, and at least
 * five once anything was read; then hours, one decimal under ten; whole hours from ten up, however many.
 */
export function hoursText(ms: number): string {
  const min = Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
  const five = Math.round(min / 5) * 5;
  if (min === 0) return unitText('minute', 0);
  if (five < 60) return unitText('minute', Math.max(5, five));
  const h = min / 60;
  return h < 9.95 ? unitText('hour', Math.round(h * 10) / 10) : unitText('hour', Math.round(h));
}

/** How long one chapter takes: "45 sec" (to five seconds), "6 min" (whole minutes), or hoursText past an hour. */
function chapterText(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  if (s < 57.5) return unitText('second', Math.max(5, Math.round(s / 5) * 5));
  const m = Math.round(s / 60);
  return m < 60 ? unitText('minute', m) : hoursText(ms);
}

/** "~6 min per chapter", or '' when there is no pace (fewer than three finished chapters with time). */
export const perChapterText = (ms: number | null | undefined): string =>
  ms != null && Number.isFinite(ms) && ms > 0 ? tr('~{time} per chapter', { time: chapterText(ms) }) : '';

/**
 * "Catch up in ~2 hr": the unread chapters at the reader's own pace -- '' unless they have read some, have some left
 * and have a pace at all.
 */
export function catchUpText(o: { read: number; unread: number; perChapterMs: number | null | undefined }): string {
  if (!(o.read > 0) || !(o.unread > 0) || o.perChapterMs == null || !(o.perChapterMs > 0)) return '';
  return tr('Catch up in ~{time}', { time: hoursText(o.unread * o.perChapterMs) });
}

/** The reader's own timezone, for the hours of the day (the server checks it); UTC where the browser will not say. */
export function readerTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
