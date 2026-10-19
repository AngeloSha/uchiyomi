// The profile's badges, as the server knows them (v0.89.0, #267 part 3 by @CheetahDoesStuff): what each one takes, and
// the avatar frame it unlocks.
//
// The badges are drawn in the browser (web/lib/badges.ts BADGES, components/BadgeEmblem.tsx) from GET /api/stats'
// `chapters_completed` and `longestStreak`. A frame is worn where the whole household sees it -- the corner, the board,
// a chapter's comments -- so the server says who may wear one: the same goals, measured the same way, here. The two
// lists are held together by test/badges.test.ts, which reads the web's. Both measures grow as an account reads (a
// chapter finished counts once, #264; the longest streak is the longest there ever was), but they can shrink: forgetting
// a series takes its reading with it. So the frame already worn is never measured again (routes/personal.ts).
import { q, one } from './db';

/** A frame is cast in its badge's metal (web/components/BadgeEmblem.tsx METALS): its name is the metal's. */
export const FRAMES = ['bronze', 'silver', 'ember', 'gold', 'moon', 'aurora'] as const;
export type AvatarFrame = (typeof FRAMES)[number];

export interface BadgeRule { name: string; kind: 'chapters' | 'streak'; goal: number; frame: AvatarFrame }

/** In the web's order: the ladder a steady habit climbs. */
export const BADGE_RULES: readonly BadgeRule[] = [
  { name: 'Reader', kind: 'chapters', goal: 10, frame: 'bronze' },
  { name: 'Bookworm', kind: 'chapters', goal: 50, frame: 'silver' },
  { name: 'On a roll', kind: 'streak', goal: 7, frame: 'ember' },
  { name: 'Centurion', kind: 'chapters', goal: 100, frame: 'gold' },
  { name: 'Devoted', kind: 'streak', goal: 30, frame: 'moon' },
  { name: 'Legend', kind: 'chapters', goal: 500, frame: 'aurora' },
];

export const isFrame = (v: unknown): v is AvatarFrame => typeof v === 'string' && (FRAMES as readonly string[]).includes(v);

/**
 * The current and the longest run of days with a finished chapter, from those days ('YYYY-MM-DD', UTC). Today or
 * yesterday anchors the current run, so a streak is not lost before the day is over. GET /api/stats' streaks.
 */
export function computeStreaks(days: string[]): { current: number; longest: number } {
  if (!days.length) return { current: 0, longest: 0 };
  const set = new Set(days);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let current = 0;
  const cur = new Date();
  if (!set.has(fmt(cur))) cur.setDate(cur.getDate() - 1); // allow today or yesterday to anchor
  while (set.has(fmt(cur))) { current++; cur.setDate(cur.getDate() - 1); }
  let longest = 0, run = 0;
  let prev: Date | null = null;
  for (const ds of [...days].sort()) {
    const d = new Date(ds + 'T00:00:00Z');
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

/** The days, UTC, on which `uid` finished a chapter: what both streaks are counted over. */
export async function finishedDays(uid: string): Promise<string[]> {
  return (await q<{ d: string }>(
    `SELECT DISTINCT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d FROM reading_events WHERE user_id = $1 AND completed = true`,
    [uid],
  )).map((r) => r.d);
}

/** The frames `uid` may wear: those of the badges earned, measured as /api/stats measures them for the profile. */
export async function earnedFrames(uid: string): Promise<Set<AvatarFrame>> {
  const row = await one<{ n: number }>('SELECT chapters_completed::int AS n FROM reading_stats WHERE user_id = $1', [uid]);
  const chapters = Number(row?.n ?? 0);
  const longest = computeStreaks(await finishedDays(uid)).longest;
  return new Set(BADGE_RULES.filter((b) => (b.kind === 'chapters' ? chapters : longest) >= b.goal).map((b) => b.frame));
}

/** The badge a frame comes with. */
export const badgeOfFrame = (f: AvatarFrame): BadgeRule => BADGE_RULES.find((b) => b.frame === f)!;
