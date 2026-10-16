// The profile's badges (components/ProfileYou.tsx BadgesCard), as data and plain functions.
//
// A badge is a goal on one measure (#267, CheetahDoesStuff): finished chapters, each counted once since v0.70.0 (#264),
// or the longest run of days with a finished chapter. The goal is what its caption says it takes and the measure is how
// far along the reader is, so neither can drift from what earns it -- the badge used to carry a bare `test()` and say
// nowhere what it wanted.
import { keys, t as tr } from './i18n';

/** What a badge is measured on: GET /api/stats' `chapters_completed` and `longestStreak`. */
export interface BadgeStats { chapters_completed: number; longestStreak: number }

// Rendered as `tr(b.label)`, so the labels are declared. See lib/i18n.ts.
const LABELS = keys('Reader', 'Bookworm', 'On a roll', 'Centurion', 'Devoted', 'Legend');

/** What a badge's emblem is cast in (components/BadgeEmblem.tsx): chapter badges climb through metals, streaks burn. */
export type BadgeMetal = 'bronze' | 'silver' | 'gold' | 'ember' | 'moon' | 'aurora';
/** What is drawn on its plate. */
export type BadgeGlyph = 'book' | 'worm' | 'flame' | 'laurel' | 'moon' | 'crown';

export interface Badge { label: (typeof LABELS)[number]; kind: 'chapters' | 'streak'; goal: number; metal: BadgeMetal; glyph: BadgeGlyph }

/** In the order they are earned on a steady habit: the ladder, and the tie-break for "nearest". */
export const BADGES: readonly Badge[] = [
  { label: LABELS[0], kind: 'chapters', goal: 10, metal: 'bronze', glyph: 'book' },
  { label: LABELS[1], kind: 'chapters', goal: 50, metal: 'silver', glyph: 'worm' },
  { label: LABELS[2], kind: 'streak', goal: 7, metal: 'ember', glyph: 'flame' },
  { label: LABELS[3], kind: 'chapters', goal: 100, metal: 'gold', glyph: 'laurel' },
  { label: LABELS[4], kind: 'streak', goal: 30, metal: 'moon', glyph: 'moon' },
  { label: LABELS[5], kind: 'chapters', goal: 500, metal: 'aurora', glyph: 'crown' },
];

/** Where the reader stands on a badge's measure. */
export const badgeHave = (b: Badge, s: BadgeStats): number => (b.kind === 'chapters' ? s.chapters_completed : s.longestStreak);
export const badgeEarned = (b: Badge, s: BadgeStats): boolean => badgeHave(b, s) >= b.goal;

/**
 * The badges still to earn, nearest first: by the share of the goal already done, so a chapter badge and a streak badge
 * compare -- 18 of 25 chapters comes before 3 of 7 days. A tie keeps the ladder's order.
 */
export function lockedBadges(s: BadgeStats): Badge[] {
  const done = (b: Badge) => badgeHave(b, s) / b.goal;
  return BADGES.filter((b) => !badgeEarned(b, s)).sort((a, b) => done(b) - done(a) || BADGES.indexOf(a) - BADGES.indexOf(b));
}

/** What a badge takes: "Read 50 chapters", or a streak in the words the profile's hero says one in ("7 day streak"). */
export function badgeGoalText(b: Badge): string {
  if (b.kind === 'streak') return tr('{n} day streak', { n: b.goal });
  return b.goal === 1 ? tr('Read 1 chapter') : tr('Read {n} chapters', { n: b.goal });
}

/** What it takes and where the reader stands: "Read 50 chapters · you have 40", "7 day streak · your best is 3". */
export function badgeCaption(b: Badge, s: BadgeStats): string {
  const have = badgeHave(b, s);
  const standing = badgeEarned(b, s) ? tr('Earned') : b.kind === 'chapters' ? tr('you have {n}', { n: have }) : tr('your best is {n}', { n: have });
  return `${badgeGoalText(b)} · ${standing}`;
}
