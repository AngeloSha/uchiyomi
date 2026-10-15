/**
 * How many OTHER sources a series may follow besides its main one (env `MAX_FOLLOWED_SOURCES`, 1 to 6, default 2).
 * Two is what the server shipped with and stays the default; a library that holds series on many sources can raise it. Not a
 * setting in the app: it bounds work done per series (a Find run, a failed chapter's fallbacks), which is an operator's knob.
 * Six at most: every follower is one more chapter list asked for on every sweep, for every series.
 */
export const FOLLOW_LIMIT_MAX = 6;
export const followLimit = (raw: string | undefined = process.env.MAX_FOLLOWED_SOURCES): number =>
  Math.min(FOLLOW_LIMIT_MAX, Math.max(1, Math.floor(Number(raw) || 2)));
