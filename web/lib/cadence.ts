// The cadence line under a group's name -- "ships weekly · last release 3d ago" -- with no React in it.
//
// Shared by the group rows in the Sources & translations sheet and the compact list in the add dialog, so the
// two say the same thing about the same group. The server decides the cadence (`groupStats` in the bff);
// this only turns its verdict into words, and lives here so a test can check every branch without a browser.

import type { Cadence } from './types';
import { keys, t } from './i18n';
import { relativeTime } from './format';

// Declared through `keys()` because they reach `tr()` through cadenceLine's return value, which the string
// extractor cannot see (lib/i18n.ts says why that has shipped untranslated labels three times).
const CADENCE_LABELS = keys(
  'ships daily', 'ships weekly', 'ships monthly', 'releases irregularly',
  'quiet — no release in {n} days', 'last release today', 'last release {ago}',
);

export interface CadencePart { key: string; args: Record<string, string | number> }

const DAY = 86_400_000;

/**
 * The parts of the cadence line, each a string key and its arguments for `tr(key, args)`, in display order.
 *
 *   * `quiet` wins over everything: a group that shipped weekly for a year and then stopped is not "ships
 *     weekly", it is "quiet — no release in 60 days", and the reader deciding whether to wait for it needs
 *     the second sentence, not the first. The day count is the server's `daysSince`, or the age of
 *     `lastReleaseAt` when the server did not send one;
 *   * otherwise the kind's label (nothing for `unknown` -- one dated release says nothing about a rhythm)
 *     followed by the last-release part when there is a date: "today" under a day, else the relative time;
 *   * `unknown` with no date at all is an empty list, and the caller renders nothing.
 */
export function cadenceLine(c: Cadence, lastReleaseAt: string | null, now = Date.now()): CadencePart[] {
  if (c.quiet) {
    const since = c.daysSince ?? (lastReleaseAt ? (now - Date.parse(lastReleaseAt)) / DAY : null);
    return [{ key: CADENCE_LABELS[4], args: { n: Math.max(0, Math.round(since ?? 0)) } }];
  }
  const parts: CadencePart[] = [];
  switch (c.kind) {
    case 'daily': parts.push({ key: CADENCE_LABELS[0], args: {} }); break;
    case 'weekly': parts.push({ key: CADENCE_LABELS[1], args: {} }); break;
    case 'monthly': parts.push({ key: CADENCE_LABELS[2], args: {} }); break;
    case 'irregular': parts.push({ key: CADENCE_LABELS[3], args: {} }); break;
    default: break;
  }
  if (lastReleaseAt) {
    const since = c.daysSince ?? (now - Date.parse(lastReleaseAt)) / DAY;
    parts.push(since < 1
      ? { key: CADENCE_LABELS[5], args: {} }
      : { key: CADENCE_LABELS[6], args: { ago: relativeTime(lastReleaseAt) } });
  }
  return parts;
}

/** The cadence line as one translated string, parts joined with ` · `; `''` when there is nothing to say. */
export function cadenceText(c: Cadence, lastReleaseAt: string | null, now = Date.now()): string {
  return cadenceLine(c, lastReleaseAt, now).map((p) => t(p.key, p.args)).join(' · ');
}
