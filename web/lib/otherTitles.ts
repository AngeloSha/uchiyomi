// The English / romanised / Japanese titles of a series' AniList entry (GET /api/series/:id/other-titles), as the series
// page lists them: only those that say something the page's own title does not.
export interface OtherTitles { english: string | null; romaji: string | null; native: string | null }
export interface OtherTitleLine { kind: 'english' | 'romaji' | 'native'; name: string }

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The lines to show, in the order English, romanised, Japanese. A name is dropped when it is blank, when it is the
 * title already shown (spacing, case and punctuation aside), or when an earlier line already says it (AniList often
 * gives the same word for English and romaji).
 */
export function otherTitleLines(titles: OtherTitles | null | undefined, shown: string): OtherTitleLine[] {
  if (!titles) return [];
  const seen = new Set<string>([fold(shown)]);
  const out: OtherTitleLine[] = [];
  for (const kind of ['english', 'romaji', 'native'] as const) {
    const name = titles[kind]?.trim();
    if (!name) continue;
    const k = fold(name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ kind, name });
  }
  return out;
}
