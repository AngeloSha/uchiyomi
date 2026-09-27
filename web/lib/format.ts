import { t as tr } from './i18n';

export function bytes(n?: number | null): string {
  if (!n || n <= 0) return '0 MB';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function progressOf(b: { media: { pagesCount: number }; readProgress?: { page: number; completed: boolean } | null }): number {
  if (!b.readProgress) return 0;
  if (b.readProgress.completed) return 1;
  const total = b.media?.pagesCount || 0;
  return total ? Math.min(1, b.readProgress.page / total) : 0;
}

// Volume-style archives ("Tome 01.cbr", "Berserk T41", "v01") should read "Vol. N", not "Ch. N".
// Chapter markers win so release-version suffixes ("Ch. 5 v2") stay chapters.
const CHAPTER_MARK = /\b(?:ch(?:ap(?:ter|itre)?)?|episode|ep)\b\.?\s*\d/i;
const VOLUME_WORD = /\b(?:tome|volume|vol)\.?\s*\d/i;
const VOLUME_SHORT = /\b[tv]\.?\s?\d/i; // T05 / v01 / t.3 — boundary keeps "Titan 05" a chapter
export function isVolumeName(name?: string | null): boolean {
  return !!name && !CHAPTER_MARK.test(name) && (VOLUME_WORD.test(name) || VOLUME_SHORT.test(name));
}

export function chapterLabel(b: { metadata?: { number?: string; title?: string }; number?: number; name?: string }): string {
  const n = b.metadata?.number ?? (b.number != null ? String(b.number) : '');
  if (n) return isVolumeName(b.name || b.metadata?.title) ? `Vol. ${n}` : `Ch. ${n}`;
  return b.name || '';
}

/**
 * The chapter's own name, for `Ch. 12 · The Return`: the server's `chapterName`, and nothing else.
 *
 * The server has already taken the number (in any of the ways sources say it) off the front and kept only a
 * real name (lib/library.ts `chapterName`). There is deliberately NO fallback to `name` or `metadata.title`:
 * those are the filename's, and on a library built by hand that put `One Piece v02 c012 [Digital]` beside the
 * chapter number on most rows.
 */
export function chapterName(b: { chapterName?: string | null }): string {
  return (b.chapterName ?? '').trim();
}

// ---------------------------------------------------------------------------------------------------
// Time, said one way everywhere (v0.49.0).
//
// Health's live rows, the Downloads view, the slow archive and the engine setup all say how long something
// took, how long it may take, when it will happen and how long ago it did. Each of those workstreams first
// drafted its own formatter with its own keys, and the same two minutes would have read "2 min", "2:00" and
// "about 2 minutes" on three tabs of one app. So there is one of each here and every surface imports it:
//
//   formatClock   a live stopwatch, "2:14" -- a clock needs no translation
//   wallClock     a time of day, "14:05" / "02:05 PM", the way the app's language writes it
//   durationText  how long, in the reader's language: "4 min", "1 hr 5 min"
//   etaLine       how long an action usually takes: "Up to 10 minutes · Last time 2:14"
//   etaText       how long a slow job has left: "About 3 days"
//   untilText     when something happens next: "in 20 minutes"
//   relativeTime  how long ago: "5m ago" (English, unchanged) / "vor 5 Minuten"
//   relativeTimeShort  the same, where a column has room for the amount only: "5m" / "5 Min."

let locale = 'en';
/** Built Intl formatters, per locale and unit; cleared when the language changes. */
const formatters = new Map<string, Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>();

/**
 * The language the Intl formatters below speak. I18nProvider sets it beside the dictionary (lib/i18n.ts
 * `setActiveDict`), before the remount that re-renders every string, so no component has to pass it in.
 */
export function setActiveLocale(code: string): void {
  if (code === locale) return;
  locale = code || 'en';
  formatters.clear();
}

export function activeLocale(): string {
  return locale;
}

/**
 * The Intl tag, with Western digits pinned. Every other number on screen reaches a translated string as
 * `String(n)` through tr()'s vars, so an `ar` formatter left to choose Arabic-Indic digits would put "٣"
 * beside "Ch. 12" in the same line.
 */
const intlTag = (): string => `${locale}-u-nu-latn`;

function cached<T extends Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>(key: string, make: () => T): T {
  let f = formatters.get(key) as T | undefined;
  if (!f) { f = make(); formatters.set(key, f); }
  return f;
}

type Unit = 'second' | 'minute' | 'hour' | 'day';
const unitText = (unit: Unit, n: number): string =>
  cached(`u:${unit}`, () => new Intl.NumberFormat(intlTag(), { style: 'unit', unit, unitDisplay: 'short' })).format(n);
/** Two amounts as one duration, joined the reader's way ("1 hr 5 min", "1 Std., 5 Min."); one when the second is 0. */
const unitPair = (a: [Unit, number], b: [Unit, number]): string => {
  if (!b[1]) return unitText(...a);
  const parts = [unitText(...a), unitText(...b)];
  try { return cached('list', () => new Intl.ListFormat(intlTag(), { type: 'unit', style: 'narrow' })).format(parts); } catch { return parts.join(' '); }
};
/** The fallback where Intl has no unit style (an old WebView): the same amounts through our own keys. */
const unitKey = (unit: Unit, n: number): string =>
  unit === 'second' ? tr('{n} sec', { n }) : unit === 'minute' ? tr('{n} min', { n }) : unit === 'hour' ? tr('{n} h', { n }) : tr('{n} d', { n });

/**
 * A running clock, "0:07", "2:14", "1:02:09". Not translated: digits and colons read the same in every
 * language here, and a clock that changes shape as it ticks ("59 sec" -> "1 min") is harder to watch.
 * Anything that is not a positive number reads as "0:00" rather than "NaN:NaN".
 */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * A time of day, "14:05" or "02:05 PM", in the app's language -- not the browser's. `toLocaleTimeString([])`
 * follows the browser, so with the app in Arabic or Japanese and an English browser, EngineSetup's retry line read
 * "Tried 3 times since 02:05 PM" inside a translated sentence (the s11 review). '' for anything that is not a date.
 */
export function wallClock(at: string | number | Date): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  try { return d.toLocaleTimeString(intlTag(), { hour: '2-digit', minute: '2-digit' }); } catch { return d.toLocaleTimeString(); }
}

/**
 * How long, in the reader's language: "45 sec", "4 min", "1 hr 5 min", "2 days 3 hr". Rounded to what is
 * worth reading at each scale: seconds under a minute, minutes under an hour, hours and minutes under a day.
 */
export function durationText(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  const [a, b]: [[Unit, number], [Unit, number]] = s < 60 ? [['second', s], ['second', 0]]
    : m < 60 ? [['minute', m], ['minute', 0]]
    : h < 24 ? [['hour', h], ['minute', m % 60]]
    : [['day', Math.floor(h / 24)], ['hour', h % 24]];
  try {
    return unitPair(a, b);
  } catch {
    return b[1] ? `${unitKey(...a)} ${unitKey(...b)}` : unitKey(...a);
  }
}

/** What an action is expected to take: the most, optionally the least, and what it took last time. */
export interface Eta {
  minMs?: number;
  maxMs: number;
  lastMs?: number;
}

/**
 * How long an action usually takes, said before anyone presses it: "A few seconds", "Under a minute",
 * "Up to 10 minutes", "1–5 minutes", "Up to 3 hours", and " · Last time 2:14" when there was one.
 *
 * Rounded UP to the minute, because an estimate that says "up to 4 minutes" about a run that takes 4:20 has
 * told the person it is stuck. Past an hour and a half the unit is hours: "up to 240 minutes" is a number
 * nobody reads as four hours.
 */
export function etaLine(e: Eta): string {
  const max = Number.isFinite(e.maxMs) && e.maxMs > 0 ? e.maxMs : 0;
  const min = Number.isFinite(e.minMs) && (e.minMs ?? 0) > 0 ? Math.min(e.minMs!, max) : 0;
  let out: string;
  if (max < 10_000) out = tr('A few seconds');
  else if (max < 60_000) out = tr('Under a minute');
  else if (max > 90 * 60_000) {
    const b = Math.ceil(max / 3_600_000);
    const a = Math.round(min / 3_600_000);
    out = min >= 3_600_000 && a < b ? tr('{a}–{b} hours', { a, b }) : tr('Up to {n} hours', { n: b });
  } else {
    const b = Math.ceil(max / 60_000);
    const a = Math.round(min / 60_000);
    out = min >= 60_000 && a < b ? tr('{a}–{b} minutes', { a, b })
      : b === 1 ? tr('Up to 1 minute') : tr('Up to {n} minutes', { n: b });
  }
  if (e.lastMs != null && Number.isFinite(e.lastMs) && e.lastMs > 0) out += ` · ${tr('Last time {clock}', { clock: formatClock(e.lastMs) })}`;
  return out;
}

/**
 * How long a long job has left, for the slow archive (#117): "Under an hour", "About 5 hours", "About 3 days".
 * Coarse on purpose. The archive paces itself with random breaks, so "2 days 7 hr" would promise a precision
 * it does not have; hours are counted up to two days, because "about 1 day" for 47 hours is a day out.
 */
export function etaText(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (v < 3_600_000) return tr('Under an hour');
  const h = Math.round(v / 3_600_000);
  if (h < 48) return h === 1 ? tr('About 1 hour') : tr('About {n} hours', { n: h });
  const d = Math.round(v / 86_400_000);
  return d === 1 ? tr('About 1 day') : tr('About {n} days', { n: d });
}

/**
 * When something happens next, `ms` from now: "in 20 minutes", "in 3 hours", "tomorrow" -- a source's
 * cooldown, the next scheduled run, the archive's next chapter. Under a minute is "in under a minute" rather
 * than Intl's "now", which reads as a promise that it is happening as you look.
 */
export function untilText(ms: number): string {
  const m = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
  if (m < 1) return tr('in under a minute');
  const h = Math.round(m / 60);
  const d = Math.round(h / 24);
  try {
    const rtf = cached('rel:until', () => new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto', style: 'long' }));
    return m < 60 ? rtf.format(m, 'minute') : h < 24 ? rtf.format(h, 'hour') : rtf.format(d, 'day');
  } catch {
    return tr('in {d}', { d: durationText(ms) });
  }
}

/**
 * How long ago, in the reader's language.
 *
 * ⚠️ English is the hand-written "5m ago" it always was, byte for byte: task results, the supply line and
 * a dozen English tests quote it, and English readers have seen it since v0.1. Every other language gets
 * Intl's own sentence ("vor 5 Minuten", "5 分前") instead of the English one inside a translated line, and a
 * date in the future reads as one ("in 3 days", an expiry) rather than "just now". Where Intl cannot
 * format, the English line is the fallback, as it was.
 */
export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (locale !== 'en' && Number.isFinite(d)) {
    const r = intlAgo(diff, d);
    if (r !== null) return r;
  }
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * How long ago, as the amount alone: "3d", "5m", "now" -- the series page's desktop chapter grid, whose date
 * column has room for "3d" and not "3d ago" (app/series/page.tsx `RowDate`).
 *
 * ⚠️ Its own function, never relativeTime's sentence with " ago" cut off: that cut was the grid's code, and
 * once every other language spoke through Intl it matched nothing, so the grid showed "il y a 3 jours" and
 * "vor 3 Tagen" where "3d" was already too wide. English is that cut, byte for byte ("3d", "now"); every
 * other language is Intl's narrow unit ("3 T", "3j", "3天") and Intl's own word for now. A date in the future
 * reads "now" in every language, as it always has in English; older than a month is the date, as in both
 * forms before.
 */
export function relativeTimeShort(iso?: string | null): string {
  if (!iso) return '';
  if (locale === 'en') {
    const long = relativeTime(iso);
    return long === 'just now' ? 'now' : long.replace(/ ago$/, '');
  }
  const d = new Date(iso).getTime();
  try {
    if (!Number.isFinite(d)) throw new Error('not a date');
    const m = Math.round((Date.now() - d) / 60000);
    const narrow = (unit: Unit, n: number) =>
      cached(`n:${unit}`, () => new Intl.NumberFormat(intlTag(), { style: 'unit', unit, unitDisplay: 'narrow' })).format(n);
    if (m < 1) return cached('rel:now', () => new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto', style: 'narrow' })).format(0, 'second');
    if (m < 60) return narrow('minute', m);
    const h = Math.round(m / 60);
    if (h < 24) return narrow('hour', h);
    const days = Math.round(h / 24);
    if (days < 30) return narrow('day', days);
    return new Date(d).toLocaleDateString(intlTag());
  } catch {
    // An old WebView without unit styles, or a date that is not one: the sentence, which is wider but right.
    return relativeTime(iso);
  }
}

/** relativeTime for every language but English: the same steps, said by Intl, in either direction. */
function intlAgo(diff: number, at: number): string | null {
  try {
    const rtf = cached('rel:ago', () => new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto', style: 'long' }));
    const sign = diff >= 0 ? -1 : 1;
    const m = Math.round(Math.abs(diff) / 60000);
    if (m < 1) return rtf.format(0, 'second');
    if (m < 60) return rtf.format(sign * m, 'minute');
    const h = Math.round(m / 60);
    if (h < 24) return rtf.format(sign * h, 'hour');
    const days = Math.round(h / 24);
    if (days < 30) return rtf.format(sign * days, 'day');
    return new Date(at).toLocaleDateString(intlTag());
  } catch {
    return null;
  }
}
