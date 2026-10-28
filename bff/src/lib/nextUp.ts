// "Only tell me about a new chapter when it is the one I'd read next": one account's setting, and whether a chapter that
// just landed is the one the series page's reading button would open for that account (the rule: lib/nextUpRule.ts).
import { q, one } from './db';
import { nextUpIn } from './nextUpRule';
import { numKey } from './postingOrder';

/** Whether this account asked for the filter: app_settings.data.notifyOnlyNext, per account, off unless a real `true`. */
export async function notifyOnlyNextOn(userId: string): Promise<boolean> {
  const r = await one<{ on: boolean | null }>(`SELECT (data -> 'notifyOnlyNext') = 'true'::jsonb AS on FROM app_settings WHERE user_id = $1`, [userId]).catch(() => null);
  return r?.on === true;
}

/**
 * Whether one of `numbers` (the chapters that just landed) is the chapter this account would read next. Fails OPEN: a
 * lookup that throws says yes, because a missed notification is worse than an extra one. No numbers: yes (an
 * announcement that names no chapter is always wanted).
 */
export async function isNextUp(userId: string, seriesId: string, numbers: readonly number[]): Promise<boolean> {
  if (!numbers.length) return true;
  try {
    const rows = await q<{ number: number; done: boolean; page: number; pruned: boolean }>(
      `SELECT b.number::float8 AS number, COALESCE(rp.completed, false) AS done, COALESCE(rp.page, 0) AS page, (b.pruned_at IS NOT NULL) AS pruned
         FROM lib_books b LEFT JOIN read_progress rp ON rp.book_id = b.id AND rp.user_id = $1
        WHERE b.series_id = $2`, [userId, seriesId]);
    // The updater announces a landed file before persistScan has indexed it. Include those chapters in the
    // choice now, including by-number read marks, or a caught-up reader never hears about the new chapter.
    const indexed = new Set(rows.map((r) => numKey(r.number)));
    const missing = [...new Set(numbers.filter(Number.isFinite))].filter((n) => !indexed.has(numKey(n)));
    if (missing.length) {
      const marks = await q<{ number: number }>(
        'SELECT number::float8 AS number FROM listing_progress WHERE user_id = $1 AND series_id = $2 AND number = ANY($3::real[])',
        [userId, seriesId, missing]);
      const done = new Set(marks.map((r) => numKey(r.number)));
      for (const number of missing) rows.push({ number, done: done.has(numKey(number)), page: 0, pruned: false });
    }
    return nextUpIn(rows, numbers);
  } catch { return true; }
}

/** Whether to tell this account about chapters that just landed in a series: the setting is off, or one of them is next. */
export async function wantsNews(userId: string, seriesId: string, numbers: readonly number[] | undefined): Promise<boolean> {
  if (!numbers?.length) return true;
  if (!(await notifyOnlyNextOn(userId))) return true;
  return isNextUp(userId, seriesId, numbers);
}

export { nextUpIn };
