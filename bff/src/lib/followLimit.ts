/**
 * How many OTHER sources a series may follow besides its main one (env `MAX_FOLLOWED_SOURCES`, 1 to 6, default 3).
 * Two until v0.80.0, when the scout (lib/sourceScout.ts) began following sources on its own: a series stuck on a site
 * that rate-limits it needs room for a source on another image server, and a broken follower no longer counts against
 * the automatic follows (sourceStanding.ts notCarrying). Not a setting in the app: it bounds work done per series (a
 * Find run, a failed chapter's fallbacks), which is an operator's knob. Six at most: every follower is one more chapter
 * list asked for on every sweep, for every series.
 */
export const FOLLOW_LIMIT_MAX = 6;
export const FOLLOW_LIMIT_DEFAULT = 3;
export const followLimit = (raw: string | undefined = process.env.MAX_FOLLOWED_SOURCES): number =>
  Math.min(FOLLOW_LIMIT_MAX, Math.max(1, Math.floor(Number(raw) || FOLLOW_LIMIT_DEFAULT)));
