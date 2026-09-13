// Where the release preferences are kept, and how they are read back.
//
// Two rows hold them: server_settings.scanlator_prefs for everyone, lib_series.scanlator_prefs for one
// title (NULL = nothing of its own). Both are jsonb written by an admin route through `prefsSchema`, and
// both are read tolerantly, modelled on readHidden in sources/suwayomi/langs.ts: a hand-edited or
// half-written value degrades to the defaults rather than taking the updater down with a parse error, since
// the sweep reads this for every series it visits.
import { z } from 'zod';
import { one } from './db';
import { mergePrefs, ReleasePrefs, StoredPrefs } from './releases';

const groupName = z.string().trim().min(1).max(80);

/** The shape an admin may store, for the global and the per-series routes alike. */
export const prefsSchema = z.object({
  priority: z.array(groupName).max(50).default([]),
  blocked: z.array(groupName).max(200).default([]),
  // NULL on a series means "inherit the global value"; on the global row it means the built-in default.
  patienceDays: z.number().int().min(0).max(30).nullable().default(null),
});

const GLOBAL_DEFAULTS: StoredPrefs = { priority: [], blocked: [], patienceDays: 2 };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

/** Whatever is in the column, read as prefs; missing or malformed fields take `fallback`'s. */
function parseStored(v: unknown, fallback: StoredPrefs): StoredPrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...fallback };
  const o = v as Record<string, unknown>;
  const days = o.patienceDays;
  return {
    priority: strings(o.priority),
    blocked: strings(o.blocked),
    // The same ceiling the write path enforces: a hand-edited row must not make a series wait a season.
    patienceDays: days === null ? null : typeof days === 'number' && Number.isInteger(days) && days >= 0 ? Math.min(days, 30) : fallback.patienceDays,
  };
}

/** The server-wide preferences; the defaults when the row is missing or unreadable. */
export async function readGlobalPrefs(): Promise<StoredPrefs> {
  const row = await one<{ scanlator_prefs: unknown }>('SELECT scanlator_prefs FROM server_settings WHERE id = 1');
  return parseStored(row?.scanlator_prefs, GLOBAL_DEFAULTS);
}

/** One series' own preferences, or null when it has none (or does not exist). */
export async function readSeriesPrefs(seriesId: string): Promise<StoredPrefs | null> {
  const row = await one<{ scanlator_prefs: unknown }>('SELECT scanlator_prefs FROM lib_series WHERE id = $1', [seriesId]);
  if (!row || row.scanlator_prefs == null) return null;
  return parseStored(row.scanlator_prefs, { priority: [], blocked: [], patienceDays: null });
}

/**
 * The preferences chooseReleases should run with for a series: its own over the global ones.
 *
 * `patienceOverrideMs` replaces the computed patience outright. The person-driven paths pass 0: someone
 * who presses "download" on a chapter list has already decided, and holding their download for the
 * preferred group would look like the button did nothing.
 */
export async function effectivePrefsFor(seriesPrefs: StoredPrefs | null | undefined, patienceOverrideMs?: number): Promise<ReleasePrefs> {
  const merged = mergePrefs(await readGlobalPrefs(), seriesPrefs);
  return patienceOverrideMs === undefined ? merged : { ...merged, patienceMs: patienceOverrideMs };
}
