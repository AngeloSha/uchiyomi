// Which of a person's tracker connections can be relied on, said once. `GET /api/trackers` (bff lib/trackers.ts
// statusFor) lists every provider; a row is only worth building UI on while its connection is sound. Three ways it is
// not: never connected, a rejected token (the server switches the row off and keeps the reason in `lastError`), and a
// token that is lapsed or failing (`lastError`, or `expiresAt` in the past) -- the last two still say `connected`.
//
// Per-account only. AniList's public numbers, art and related titles come from the server's own lookup and need no
// connection of anyone's, so the ratings tile and the Related rail are NOT gated on this. What is: anything that
// reads or writes the person's own list (Recommended for you, the import page's tracker intake).
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import type { TrackerStatus } from './types';

/** The connection has a token that should be replaced: rejected, failing, or past its expiry. */
export function trackerNeedsReconnect(t: TrackerStatus, now = Date.now()): boolean {
  if (!t.connected && !t.lastError) return false; // never connected (or disconnected): nothing to repair
  if (t.lastError) return true;
  return !!t.expiresAt && new Date(t.expiresAt).getTime() <= now;
}

/** Connected and sound: safe to build something on. */
export const trackerUsable = (t: TrackerStatus, now = Date.now()): boolean => t.connected && !trackerNeedsReconnect(t, now);

export const usableTrackers = (all: TrackerStatus[] | undefined, now = Date.now()) => (all ?? []).filter((t) => trackerUsable(t, now));
export const brokenTrackers = (all: TrackerStatus[] | undefined, now = Date.now()) => (all ?? []).filter((t) => trackerNeedsReconnect(t, now));

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
