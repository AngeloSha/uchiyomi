// A tracker that asked us to wait (v0.73.0): the one rule for reading a stored `user_trackers.last_error` as a pace, not a
// fault. A push whose 429 outlasted every retry writes RATE_LIMITED (lib/trackers.ts syncFailed); before v0.73.0 it wrote
// the service's own line ("anilist 429"), and those rows read the same until the next push that lands clears them.
// Profile → Connections says it as "Syncing slowly" (lib/trackers.ts statusFor), and Health's Tracker sync card does not
// count it as a finding (lib/healthTrackers.ts). No imports: Health may read it without pulling the tracker code in.

/** The `last_error` a rate limit leaves. */
export const RATE_LIMITED = 'rate_limited';

/** Whether a stored `last_error` is a rate limit -- ours, or a 429 line from before v0.73.0. */
export const isRateLimitedError = (lastError: string | null | undefined): boolean =>
  lastError === RATE_LIMITED || (!!lastError && /^(anilist|myanimelist|kitsu|mangaupdates) 429\b/i.test(lastError));
