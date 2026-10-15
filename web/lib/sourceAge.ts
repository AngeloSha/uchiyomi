/**
 * The age rating an admin can put on a whole source (Sources sheet -> Age rating), with no React in it so a test can hold it.
 *
 * `null` is "no rating of mine": the source is held to what its extension says (Adult only when it declares itself adult, else
 * unrated). 0 is Mixed: its titles are judged one by one, which also cancels an extension's adult flag. 18 is Adult only: the
 * whole source is hidden while Show 18+ is off. The library, not the source, rates a series.
 */
export const MIXED = 0;
export const ADULT_ONLY = 18;
export const SOURCE_AGES: readonly number[] = [MIXED, ADULT_ONLY];

export interface AgeFacts { ageRating?: number | null; defaultAgeRating?: number | null }

/** The rating the source is held to now, or null when it is unrated. */
export function effectiveAge(s: AgeFacts): number | null {
  if (s.ageRating !== undefined && s.ageRating !== null) return s.ageRating >= ADULT_ONLY ? ADULT_ONLY : null;
  return s.defaultAgeRating ?? null;
}

/** Which chip is lit: 'default' when nothing is set, else Mixed (0) or Adult only (18). */
export function ageChoice(s: AgeFacts): number | 'default' {
  return s.ageRating === undefined || s.ageRating === null ? 'default' : s.ageRating >= ADULT_ONLY ? ADULT_ONLY : MIXED;
}

/** The body of the PUT that picks a chip. */
export function ageRequest(choice: number | 'default'): { ageRating: number | null } {
  return { ageRating: choice === 'default' ? null : choice };
}
