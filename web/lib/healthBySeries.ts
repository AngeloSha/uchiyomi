// Health, turned around: the checks' findings grouped by the series they are about (components/HealthBySeries.tsx).
// Only a finding about a single series is here (a library-wide one has no series), a greyed `info` row is not a
// problem, and the duplicates card is left out because its finding is about two series at once and has its own merge.
import type { HealthCheck, HealthItem } from './types';
import { keysFor } from './healthKeys';

export interface SeriesProblem { check: HealthCheck; item: HealthItem; key: string }
export interface SeriesRow { id: string; title: string; problems: SeriesProblem[]; checks: Set<string> }

/** One row per series, the series with the most problems first, then by title. */
export function groupBySeries(checks: readonly HealthCheck[]): SeriesRow[] {
  const by = new Map<string, SeriesRow>();
  for (const c of checks) {
    if (c.id === 'duplicates') continue;
    const keys = keysFor(c.id, c.items);
    c.items.forEach((it, i) => {
      if (!it.seriesId || it.info) return;
      const r = by.get(it.seriesId) ?? { id: it.seriesId, title: it.title, problems: [], checks: new Set<string>() };
      r.problems.push({ check: c, item: it, key: keys[i] });
      r.checks.add(c.id);
      by.set(it.seriesId, r);
    });
  }
  return [...by.values()].sort((a, b) => b.problems.length - a.problems.length || a.title.localeCompare(b.title));
}
