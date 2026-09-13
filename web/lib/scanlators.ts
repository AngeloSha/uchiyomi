// Scanlator preferences and extra sources, the part with no React in it.
//
// Split out of the series page and FindMissingDialog so the two rules a person is most likely to argue with
// -- which candidate may be followed, and how a ranked list moves -- can be tested without a browser. Both
// components pull in react-query and JSX; this is arithmetic on a candidate row and on a list of names.

/** The overlap a candidate needs before it may be followed as a second source. See `followable`. */
export const FOLLOW_COVERAGE = 0.9;

/**
 * Whether a Find-missing candidate can be followed as an extra source for the series.
 *
 * Coverage is the share of the chapters on disk that this source also lists under the same numbers, so
 * 0.9 means its numbering agrees with ours for nearly everything we hold. A source below that would have the
 * updater fetching its "chapter 47" into the slot where our 47 belongs, and the file would look identical in
 * every listing. `ok` and `nothing_to_fill` are the two verdicts where the source answered and matched --
 * having nothing we are missing today says nothing about tomorrow, which is the whole reason to follow it.
 * Every other `why` means it did not answer, listed nothing, numbered differently, or was not asked. The
 * series' own source is `pinned` and is followed by definition.
 */
export function followable(c: { pinned: boolean; coverage: number; why: string }): boolean {
  return !c.pinned && c.coverage >= FOLLOW_COVERAGE && (c.why === 'ok' || c.why === 'nothing_to_fill');
}

/**
 * A copy of `list` with item `i` moved one step up (-1) or down (+1). A step that would leave the list --
 * the first item up, the last one down, an index that is not there -- returns an unchanged copy rather than
 * throwing or wrapping, so an arrow button at the end of a list is simply a button that does nothing.
 */
export function reorder<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const out = list.slice();
  const j = i + dir;
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/**
 * The server's idea of "the same group": NFKC, lowercase, letters and digits only. Mirrors `normGroup` in
 * bff/src/lib/releases.ts, and must keep doing so -- the server dedupes the stored lists this way, so a
 * client that thought "Asura Scans" and "asura-scans" were two groups would show two rows for one entry.
 */
export const normGroup = (s: string): string =>
  (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Whether `name` is in `list` by the server's equality. */
export function hasGroup(list: string[], name: string): boolean {
  const k = normGroup(name);
  return list.some((g) => normGroup(g) === k);
}

/** `list` without `name`, by the server's equality. */
export function withoutGroup(list: string[], name: string): string[] {
  const k = normGroup(name);
  return list.filter((g) => normGroup(g) !== k);
}
