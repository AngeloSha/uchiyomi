// The values the settings' menus offer (v0.86.0, components/settings.tsx SelectRow), named in the reader's language by
// Intl, so a menu of hours or times adds no string to translate: "6 hours", "6 ساعات", "2 days", "1 week"; "03:00" or
// "3:00 AM" as the language writes a time. Western digits are pinned, as everywhere else (lib/format.ts intlTag).
import { activeLocale } from './format';

const tag = (): string => `${activeLocale()}-u-nu-latn`;

/** A number of hours, in the largest whole unit: hours, days or weeks. */
export function hoursText(h: number): string {
  const [n, unit] = h > 0 && h % 168 === 0 ? [h / 168, 'week'] : h > 0 && h % 24 === 0 ? [h / 24, 'day'] : [h, 'hour'];
  try {
    return new Intl.NumberFormat(tag(), { style: 'unit', unit, unitDisplay: 'long' }).format(n);
  } catch {
    return `${h} h`;
  }
}

/** An hour of the day as the language writes a time on the hour. */
export function clockText(h: number): string {
  try {
    return new Intl.DateTimeFormat(tag(), { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h));
  } catch {
    return `${String(h).padStart(2, '0')}:00`;
  }
}

/** How often a schedule may run: the usual steps from an hour to a week. */
export const INTERVAL_HOURS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];

/**
 * The steps, and the value stored now among them when it is not one -- an interval typed into the number box before
 * v0.86.0 (5 hours) stays what it is, and is shown, until someone picks another.
 */
export function intervalChoices(current: number): number[] {
  return [...new Set([...INTERVAL_HOURS, current])].filter((h) => Number.isInteger(h) && h >= 1 && h <= 168).sort((a, b) => a - b);
}
