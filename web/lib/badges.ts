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

/**
 * Each metal's light, mid, dark, edge and glow: the emblems' palette (the owner's approved design, v0.75.0), and since
 * v0.89.0 the avatar frames' (components/AvatarFrame.tsx), so a frame is cast in its badge's metal.
 */
export const BADGE_METALS: Record<BadgeMetal, [string, string, string, string, string]> = {
  bronze: ['#ffd9b0', '#cf8a52', '#7a4322', '#3a1d0e', 'rgba(207,138,82,.35)'],
  silver: ['#ffffff', '#c6ccda', '#6d7489', '#2c3040', 'rgba(198,204,218,.30)'],
  gold: ['#fff5c4', '#f2c14e', '#a06a12', '#4a2f05', 'rgba(242,193,78,.38)'],
  ember: ['#ffe3a8', '#ff8a3d', '#c6361b', '#4a1206', 'rgba(255,138,61,.38)'],
  moon: ['#eef1ff', '#9aa8ff', '#5361d6', '#1b2160', 'rgba(154,168,255,.35)'],
  aurora: ['#f1ecff', '#9b7dff', '#5b3fd9', '#1d1257', 'rgba(155,125,255,.45)'],
};
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

/**
 * v0.89.0 (#267 part 3, CheetahDoesStuff): each badge unlocks a frame for the avatar, cast in its metal and named after
 * it. The server holds the same rules (bff lib/badges.ts, held together by bff test/badges.test.ts) and refuses a frame
 * whose badge is not earned.
 */
export type AvatarFrame = BadgeMetal;
export const FRAMES: readonly AvatarFrame[] = BADGES.map((b) => b.metal);
export const isFrame = (v: unknown): v is AvatarFrame => typeof v === 'string' && (FRAMES as readonly string[]).includes(v);
/** The frames' names, in the badges' order: rendered as `tr(name)`, so declared. */
const FRAME_NAMES = keys('Bronze', 'Silver', 'Ember', 'Gold', 'Moonlight', 'Aurora');
export const frameName = (f: AvatarFrame): string => tr(FRAME_NAMES[FRAMES.indexOf(f)]);
export const badgeOfFrame = (f: AvatarFrame): Badge => BADGES.find((b) => b.metal === f)!;

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
