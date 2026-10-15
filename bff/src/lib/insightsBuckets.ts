// Pure helpers for the You page's insights (lib/youInsights.ts): no database, so they unit-test without one.
import { validTz } from './readingTime';

/** The hour and weekday (Sunday 0) of an instant in `tz`, worked out once per quarter hour like readingTime.hourIn. */
export function localParts(tz: string): (t: number) => { hour: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: validTz(tz), hour: 'numeric', weekday: 'short', hourCycle: 'h23' });
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const memo = new Map<number, { hour: number; dow: number }>();
  return (t) => {
    const k = Math.floor(t / (15 * 60_000));
    let v = memo.get(k);
    if (!v) {
      const parts = fmt.formatToParts(new Date(k * 15 * 60_000));
      v = {
        hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24,
        dow: WD[parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'] ?? 0,
      };
      memo.set(k, v);
    }
    return v;
  };
}

/** Chapters finished per hour of the day and per weekday in `tz`, from the instants of the finishes. */
export function bucketTimes(times: number[], tz: string): { byHour: number[]; byWeekday: number[] } {
  const at = localParts(tz);
  const byHour = Array(24).fill(0);
  const byWeekday = Array(7).fill(0);
  for (const t of times) {
    const p = at(t);
    byHour[p.hour]++;
    byWeekday[p.dow]++;
  }
  return { byHour, byWeekday };
}
