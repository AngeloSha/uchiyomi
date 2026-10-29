// The engine declares extension search fields as a typed filter list, indexed including headers/separators.
// Only explicit creator text fields count. A select, an "author notes" toggle or an unknown label is not one.
import type { CreatorField } from '../types';

export type CreatorPath = readonly number[];
export interface FilterChange { position: number; textState?: string; groupChange?: FilterChange }

function roles(name: unknown): CreatorField[] {
  if (typeof name !== 'string') return [];
  const label = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/\s*\(case[- ]sensitive\)$/, '');
  if (!/^(authors?|artists?)(?:\s*[/&]\s*(authors?|artists?))?$/.test(label)) return [];
  return [...new Set<CreatorField>(label.split(/\s*[/&]\s*/).map((word) => word.startsWith('author') ? 'author' : 'artist'))];
}

/** At most two nested groups, matching the bounded GraphQL selection; ambiguous fields claim no capability. */
export function creatorFilterPaths(filters: unknown): Map<CreatorField, CreatorPath> {
  const paths = new Map<CreatorField, CreatorPath[]>();
  const walk = (list: unknown, parent: number[]) => {
    if (!Array.isArray(list) || parent.length > 2) return;
    list.forEach((f: unknown, position) => {
      if (!f || typeof f !== 'object') return;
      const filter = f as { __typename?: unknown; name?: unknown; filters?: unknown };
      const path = [...parent, position];
      if (filter.__typename === 'TextFilter') {
        for (const role of roles(filter.name)) paths.set(role, [...(paths.get(role) ?? []), path]);
      } else if (filter.__typename === 'GroupFilter') walk(filter.filters, path);
    });
  };
  walk(filters, []);
  return new Map([...paths].filter(([, candidates]) => candidates.length === 1).map(([role, candidates]) => [role, candidates[0]]));
}

/** SourceMutation.updateFilterList applies these request-local changes to a fresh extension filter list. */
export function creatorFilterChange(path: CreatorPath, name: string): FilterChange {
  const [position, ...tail] = path;
  return tail.length ? { position, groupChange: creatorFilterChange(tail, name) } : { position, textState: name };
}
