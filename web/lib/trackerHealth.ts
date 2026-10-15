// Which of a person's tracker connections can be relied on, said once (#246, @Squeaks72). `GET /api/trackers` (bff
// lib/trackers.ts statusFor) lists every provider; a row is only worth building UI on while its connection is sound.
//
// "Needs reconnecting" is the SERVER's `needsReconnect`: the token was rejected (the row is switched off), has lapsed, or
// can no longer be read -- the cases only a new token mends. Not "any lastError": a rate limit, an outage or a Cloudflare
// 403 write one too (syncFailed), and so does the floor refusal, which tells the person to import their list again. Read
// as broken, they put "Reconnect" above every page until the next good sync, though reconnecting fixes none of them, and
// the import box hid the very connection the floor line sends the person to.
// Reintroduce by testing `lastError`: trackerHealth.test.ts "a rate limit is not a broken connection" fails.
//
// Per-account only. AniList's public numbers, art and related titles come from the server's own lookup and need no
// connection of anyone's, so the ratings tile and the Related rail are NOT gated on this. What is: anything that reads
// the person's own list (the import page's tracker intake, Recommended for you).
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { TrackerStatus } from './types';

/** Only a new token mends it: the server's verdict, or -- while a cached row ages -- an expiry that has passed since. */
export function trackerNeedsReconnect(t: TrackerStatus, now = Date.now()): boolean {
  if (t.needsReconnect) return true;
  return t.connected && !!t.expiresAt && new Date(t.expiresAt).getTime() <= now;
}

/** Connected and sound: safe to build something on. */
export const trackerUsable = (t: TrackerStatus, now = Date.now()): boolean => t.connected && !trackerNeedsReconnect(t, now);

export const usableTrackers = (all: TrackerStatus[] | undefined, now = Date.now()) => (all ?? []).filter((t) => trackerUsable(t, now));
export const brokenTrackers = (all: TrackerStatus[] | undefined, now = Date.now()) => (all ?? []).filter((t) => trackerNeedsReconnect(t, now));

/**
 * What a "Not now" on the reconnect line dismisses: these connections broken in these ways. A new problem (another
 * provider, another reason) is another value, so the line comes back for it; the same one stays dismissed.
 */
export const reconnectSignature = (broken: TrackerStatus[]): string =>
  broken.map((t) => `${t.provider}:${t.connected ? 'on' : 'off'}:${t.lastError ?? ''}:${t.expiresAt ?? ''}`).sort().join('|');

/** The one shared read of the person's trackers (the key Profile and the import page use, so they never disagree). */
export function useTrackers(opts: { staleTime?: number } = {}) {
  const { status } = useAuth();
  return useQuery({
    queryKey: ['trackers'],
    queryFn: () => api<{ content: TrackerStatus[] }>('/api/trackers'),
    select: (r) => r.content,
    enabled: status === 'authed',
    staleTime: opts.staleTime ?? 60_000,
  });
}
