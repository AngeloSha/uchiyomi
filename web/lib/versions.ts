// The versions sheet's reading of a number's copies (#116, components/ChapterVersionsSheet.tsx).
//
// Since v0.49.0 every copy carries its own title. Three groups' "Chapter 5" are versions of one chapter; Webtoons'
// "E7 - 315-317" and "Ee7 - 318-320", both numbered 7 by the extension, are two different posts. The titles are
// what tell the two apart, so the sheet shows them -- and says so -- only when they differ.
import type { VersionCopy } from './types';

/** A title as compared: without the extension's " (ch. N)" and the ♫ some sources append, case and spacing folded. */
export function normCopyTitle(t: string | null | undefined): string {
  return (t ?? '')
    .normalize('NFKC')
    .replace(/♫/g, '')
    .replace(/\s*\(ch\.\s*[\d.]+\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Do two or more copies carry different, non-empty titles? Then each copy's title is worth a line of its own. */
export function copyTitlesDiffer(copies: ReadonlyArray<Pick<VersionCopy, 'title'>>): boolean {
  return new Set(copies.map((c) => normCopyTitle(c.title)).filter(Boolean)).size >= 2;
}

/**
 * Do copies from ONE source and ONE group carry different titles? A group does not release one chapter twice
 * under two names: those are different posts that the source numbered the same (Webtoons' episode numbers), not
 * versions -- the sheet says so, and points an admin at the numbering.
 */
export function postsShareNumber(copies: ReadonlyArray<Pick<VersionCopy, 'title' | 'source' | 'groups' | 'scanlator'>>): boolean {
  const seen = new Map<string, string>();
  for (const c of copies) {
    const t = normCopyTitle(c.title);
    if (!t) continue;
    const who = `${c.source}\u0000${(c.groups.length ? c.groups : [c.scanlator ?? '']).map((g) => g.trim().toLowerCase()).sort().join('&')}`;
    const had = seen.get(who);
    if (had !== undefined && had !== t) return true;
    if (had === undefined) seen.set(who, t);
  }
  return false;
}
