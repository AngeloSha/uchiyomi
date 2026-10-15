/**
 * The part of the manual migrate sheet with no React in it (components/MigrateSourceSheet.tsx), so a test can hold it.
 */

/** The names worth offering as search terms: the title first, then its other names, each once (case and spacing aside). */
export function migrateTerms(title: string, alts: readonly string[], max = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [title, ...alts]) {
    const t = raw.trim().replace(/\s+/g, ' ');
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Which actions a pick offers. A series with a main source can take a pick as an extra source or move to it; one with
 * none (scanned from disk, or detached) can only take it as its main, which is also what the server does whichever is asked.
 */
export function attachButtons(mainId: string | null): { follower: boolean; main: boolean } {
  return mainId ? { follower: true, main: true } : { follower: false, main: true };
}

/**
 * The `sources=` value for a search over the picked sources, or null when the pick is every source (or nothing was
 * picked yet), which searches everything and keeps the URL short.
 */
export function sourcesParam(selected: readonly string[] | null, allIds: readonly string[]): string | null {
  if (!selected) return null;
  const known = new Set(allIds);
  const picked = selected.filter((id) => known.has(id));
  if (picked.length === 0 || picked.length === known.size) return null;
  return picked.join(',');
}
