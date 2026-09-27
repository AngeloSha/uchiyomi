// Shapes and rules for Connect sources (bff lib/linkBatch.ts): the library's bulk way to follow other
// sources for many series at once, with a review in between. Mirrors link_batches / link_items /
// link_candidates in bff/src/lib/migrate.ts; the rows come off `SELECT *`, so the column names are as-is.
import { t as tr } from './i18n';

export type LinkBatchState = 'searching' | 'review' | 'linking' | 'done';
export type LinkVerdict = 'ok' | 'numbering_differs' | 'too_few' | 'title_differs';

export interface LinkBatch {
  id: string;
  state: LinkBatchState;
  total: number;
  searched: number;
  linked: number;
  failed: number;
  created_at: string;
  updated_at: string;
  /** `searching` with nobody searching it (a restart): offer Resume. */
  stale?: boolean;
  /** How many sources a series may follow besides its primary. */
  maxFollowers?: number;
}

export interface LinkCandidate {
  id: string;
  item_id: string;
  source: string;
  /** The source's display name, added by the route. */
  name: string;
  source_series_id: string;
  their_title: string | null;
  cover: string | null;
  our_name: string | null;
  their_name: string | null;
  coverage_fwd: number | null;
  coverage_back: number | null;
  verdict: LinkVerdict;
  manual: boolean;
  status: string | null;
}

export interface LinkItem {
  id: string;
  ord: number;
  series_id: string;
  title: string;
  names: string[];
  state: 'pending' | 'done' | 'error';
  asked: number;
  unreachable: number;
  primary: { source: string; name: string } | null;
  following: { source: string; name: string }[];
  freeSlots: number;
  candidates: LinkCandidate[];
}

/** GET /api/admin/link/items/:id/chapters: what a candidate lists, beside what the series has. */
export interface LinkChapters {
  source: string;
  name: string;
  title: string | null;
  count: number;
  ourCount: number;
  shared: number;
  /** Numbers the series has that this source does not list. */
  missing: number[];
  chapters: { number: number; title: string | null; scanlator: string | null; publishedAt: string | null; ours: boolean }[];
}

/**
 * Chapter numbers as runs: [1,2,3,5,7,8] → "1–3, 5, 7–8". Whole numbers join a run; a decimal (12.5)
 * stands alone. At most `max` parts, then "+ n more", so a source missing 300 scattered numbers stays a line.
 */
export function ranges(nums: number[], max = 12): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && Number.isInteger(sorted[j]) && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.length > max ? `${parts.slice(0, max).join(', ')} ${tr('+ {n} more', { n: parts.length - max })}` : parts.join(', ');
}

/** A candidate that can still be ticked: not run yet. */
export const isOpen = (c: LinkCandidate): boolean => !c.status;

/**
 * Whether /run will actually run this candidate -- bff lib/linkBatch.ts `mayFollow`, word for word. The
 * server silently leaves the rest open, so a "has the run finished?" check that waited on them too would
 * wait for ever.
 */
export const mayRun = (c: Pick<LinkCandidate, 'verdict' | 'manual'>, override: boolean): boolean =>
  c.verdict === 'ok' || (override && (c.verdict !== 'title_differs' || c.manual));

/** Whether ticking this candidate needs the admin's "follow anyway" (the server's `override`). */
export const needsOverride = (c: Pick<LinkCandidate, 'verdict'>): boolean => c.verdict !== 'ok';

/**
 * What "Select exact matches" picks: per series, the `ok` candidates, best-covered first, as many as the
 * series has free slots. A warning is never picked for anyone -- ticking one is a decision, not a default.
 */
export function preselect(items: LinkItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) {
    const ok = it.candidates.filter((c) => isOpen(c) && c.verdict === 'ok')
      .sort((a, b) => Math.min(b.coverage_fwd ?? 0, b.coverage_back ?? 0) - Math.min(a.coverage_fwd ?? 0, a.coverage_back ?? 0));
    for (const c of ok.slice(0, it.freeSlots)) out.add(c.id);
  }
  return out;
}

/** How many of a series' candidates are ticked; the checkbox of an unticked one disables at freeSlots. */
export const pickedFor = (it: LinkItem, selected: Set<string>): number => it.candidates.filter((c) => selected.has(c.id)).length;

export function verdictLabel(v: LinkVerdict): string {
  switch (v) {
    case 'ok': return tr('same series');
    case 'numbering_differs': return tr('chapter numbers differ');
    case 'too_few': return tr('too few chapters to compare');
    case 'title_differs': return tr('no name matches');
  }
}
export const verdictColor = (v: LinkVerdict): string => (v === 'ok' ? 'text-emerald-400' : 'text-amber-400');

/** A coverage pair as the row prints it: "has 98 % of ours · we have 95 % of its". */
export function coverageLine(c: Pick<LinkCandidate, 'coverage_fwd' | 'coverage_back'>): string | null {
  if (c.coverage_fwd == null || c.coverage_back == null) return null;
  return tr('has {a}% of our chapters · we have {b}% of its', { a: Math.round(c.coverage_fwd * 100), b: Math.round(c.coverage_back * 100) });
}

/** The run's status for a candidate, as a sentence. Every branch a literal, so the locale files see each. */
export function linkStatusLabel(status: string): string {
  switch (status) {
    case 'linked': return tr('Connected');
    case 'cap': return tr('Not connected — this series already follows two other sources');
    case 'primary': return tr('Not connected — that is its main source');
    case 'gone': return tr('Not connected — the series is no longer in the library');
    case 'unavailable': return tr('Not connected — that source is not installed');
    case 'not_confirmed': return tr('Not connected — confirm the warning to connect it');
    default: return tr('Failed — {reason}', { reason: status });
  }
}
export const linkStatusColor = (status: string): string => (status === 'linked' ? 'text-emerald-400' : 'text-red-400');

export function linkBatchStateLabel(s: LinkBatchState): string {
  switch (s) {
    case 'searching': return tr('Searching…');
    case 'review': return tr('Ready to review');
    case 'linking': return tr('Connecting…');
    case 'done': return tr('Done');
  }
}
