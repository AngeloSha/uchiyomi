/**
 * How many OTHER sources a series may follow besides its main one: 1 to 10, 3 by default.
 *
 * Two until v0.80.0, when the scout (lib/sourceScout.ts) began following sources on its own: a series stuck on a site
 * that rate-limits it needs room for a source on another image server, and a broken follower no longer counts against
 * the automatic follows (sourceStanding.ts notCarrying). An operator's knob in the env (`MAX_FOLLOWED_SOURCES`, 1 to 6)
 * until v0.89.0 (#305, TIGamingTV: "more sources per series, more to search from"), when it became the admin's choice:
 * Admin -> Settings -> Getting chapters -> Other sources per series (`server_settings.max_followed_sources`). The env's
 * number is still read, as the starting value while no choice is saved. Ten at most: every follower is one more chapter
 * list asked for on every library update, for every series, which the menu's help says.
 */
import { one } from './db';

export const FOLLOW_LIMIT_MAX = 10;
export const FOLLOW_LIMIT_DEFAULT = 3;

/** A number taken whole and held between 1 and 10; anything that is not a number (or 0) is nothing set: three. */
const clamp = (n: number): number => Math.min(FOLLOW_LIMIT_MAX, Math.max(1, Math.floor(n || FOLLOW_LIMIT_DEFAULT)));

/** The env's number (`MAX_FOLLOWED_SOURCES`): the limit while the admin has not picked one. */
export const followLimit = (raw: string | undefined = process.env.MAX_FOLLOWED_SOURCES): number => clamp(Number(raw));

/**
 * How long the limit read from the database is kept before it is read again. Every follow, find and scout asks for it,
 * and a sweep asks hundreds of times; saving the menu forgets it at once (forgetFollowerLimit), so the wait is only ever
 * seen by a second process.
 */
const CACHE_MS = 30_000;
let cached: { n: number; at: number } | null = null;

/**
 * The limit in force: the admin's choice, else the env's number, else three. A database that cannot be read answers the
 * env's number rather than failing a follow over a setting. Reintroduce by reading the env alone: "the admin's choice is
 * the limit" in followLimit.int.test.ts follows only three.
 */
export async function followerLimit(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.n;
  const row = await one<{ n: number | null }>('SELECT max_followed_sources AS n FROM server_settings WHERE id = 1').catch(() => null);
  const n = row?.n != null ? clamp(Number(row.n)) : followLimit();
  cached = { n, at: Date.now() };
  return n;
}

/** Saving the admin's choice: the next follow reads it afresh. */
export function forgetFollowerLimit(): void {
  cached = null;
}
