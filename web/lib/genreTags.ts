/** The rules of the genre tag box (components/GenreTagInput.tsx), with no React in them so a test can drive them. */

/** How many known genres are offered under the field while typing. */
export const MAX_SUGGESTIONS = 6;

/** What a typed or pasted entry becomes: trimmed, a trailing comma dropped; empty when there is nothing to add. */
export function cleanGenre(raw: string): string {
  return raw.trim().replace(/,$/, '').trim();
}

/** `genres` with `raw` added at the end, or the same array when it is empty or already there (case ignored). */
export function withGenre(genres: string[], raw: string): string[] {
  const t = cleanGenre(raw);
  if (!t || genres.some((g) => g.toLowerCase() === t.toLowerCase())) return genres;
  return [...genres, t];
}

/** The known genres to offer for what is typed: those that start with it first, then those that contain it; never one already chosen. */
export function suggestGenres(draft: string, known: readonly unknown[], chosen: readonly string[]): string[] {
  const q = draft.trim().toLowerCase();
  if (!q) return [];
  const have = new Set(chosen.map((g) => g.toLowerCase()));
  const pool = known.filter((g): g is string => typeof g === 'string' && !!g.trim() && !have.has(g.toLowerCase()));
  const starts = pool.filter((g) => g.toLowerCase().startsWith(q));
  const within = pool.filter((g) => !g.toLowerCase().startsWith(q) && g.toLowerCase().includes(q));
  return [...starts, ...within].slice(0, MAX_SUGGESTIONS);
}
