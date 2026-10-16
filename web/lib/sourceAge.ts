/**
 * The age rating an admin can put on a whole source (the Sources sheet's Age rating, v0.73.0, #256 from @Squeaks72), with
 * no React in it so a test can hold it.
 *
 * Two choices. **Automatic** (`default`) leaves it to the source: adult when its extension declares itself adult, else
 * open to every account. **Adult only** makes it adult whatever its extension says: accounts limited below 18 are refused it, and with
 * Show 18+ off it leaves Discover and search. Nothing rates a source BELOW its extension's flag -- the contributor's
 * "Mixed" would have opened a whole site to accounts limited below 18 -- so a flagged source is adult either way, and the
 * sheet says so. A series keeps its own rating, from its library: this is about the source.
 */
export const ADULT_ONLY = 18;
export type AgeChoice = 'default' | 'adult';
export const AGE_CHOICES: readonly AgeChoice[] = ['default', 'adult'];

/** What the sources overview says of one source (bff lib/sourcesOverview.ts): the admin's rating, and what it is held to without one. */
export interface AgeFacts { ageRating?: number | null; defaultAgeRating?: number | null }

/** Which choice is lit. */
export const ageChoice = (s: AgeFacts): AgeChoice => ((s.ageRating ?? 0) >= ADULT_ONLY ? 'adult' : 'default');

/** Why the source is what it is, for the sentence under the choices: rated by the admin, flagged by its extension, or neither. */
export function ageWhy(s: AgeFacts): 'rated' | 'flagged' | 'open' {
  if (ageChoice(s) === 'adult') return 'rated';
  return (s.defaultAgeRating ?? 0) >= ADULT_ONLY ? 'flagged' : 'open';
}

/** The body of the PUT that picks a choice. */
export const ageRequest = (c: AgeChoice): { ageRating: number | null } => ({ ageRating: c === 'adult' ? ADULT_ONLY : null });
