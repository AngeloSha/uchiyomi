// The group filter's arithmetic, with no React in it.
//
// The series page filters its chapter list by scanlation group: a chapter on disk carries the group as one
// display string (`scanlator`, "Asura & Reaper" for a joint release), a ghost carries the list the sources
// gave (`groups`). Which rows a chosen group keeps is a rule a person will argue with -- "I picked Reaper,
// where did the joint chapter go?" -- so it lives here where a test can reach it.

import { normGroup } from './scanlators';
import type { VersionCopy } from './types';

/**
 * The <select>'s "every group" value. ⚠️ A sentinel, not a group name: a group literally called "all" would
 * be indistinguishable from it, so the select only ever uses this for its FIRST option and every real
 * option carries the group's own name. Nobody has named a group "all" yet; if one does, the filter for it
 * shows everything, which is the harmless direction.
 */
export const ALL_GROUPS = 'all';

/**
 * The raw group names of a row, deduped by the server's equality. Mirrors `groupsOf` in
 * bff/src/lib/releases.ts: `groups` is authoritative when the source supplied one (MangaDex hands over one
 * relationship per group), otherwise the display string is split on the separators sites use for a joint
 * release -- so a book from "Asura & Reaper" counts for both groups, the way the server counts it.
 */
export function groupsOfRow(row: { scanlator?: string | null; groups?: string[] }): string[] {
  const raw = Array.isArray(row.groups) && row.groups.length ? row.groups : row.scanlator ? row.scanlator.split(/ & | \/ |, /) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of raw) {
    const name = typeof g === 'string' ? g.trim() : '';
    const key = normGroup(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Whether a chapter row (book or ghost) is kept under the chosen group. `ALL_GROUPS` keeps everything,
 * including rows with no group at all; a name keeps the rows any of whose groups is that name by the
 * server's equality, so "asura-scans" in the select matches "Asura Scans" on the row.
 */
export function matchesGroup(row: { scanlator?: string | null; groups?: string[] }, group: string): boolean {
  if (group === ALL_GROUPS) return true;
  const k = normGroup(group);
  return groupsOfRow(row).some((g) => normGroup(g) === k);
}

/**
 * The source's own id for a copy, for the `picks` body of a fetch. ⚠️ `key` is `${source}:${sourceId}` and
 * a source id can contain `:` (`ext:fake`, or a URL), so the id is everything after the KNOWN source prefix
 * -- never `key.split(':')[1]`, which hands the server half an id and gets `not_listed` back for a copy
 * that is plainly listed. A key that does not start with its own source is returned whole rather than
 * guessed at.
 */
export function copySourceId(copy: Pick<VersionCopy, 'key' | 'source'>): string {
  const prefix = `${copy.source}:`;
  return copy.key.startsWith(prefix) ? copy.key.slice(prefix.length) : copy.key;
}
