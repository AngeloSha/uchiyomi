'use client';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import { canDownload, useAuth } from './auth';
import { jobsPollInterval, navRing, type NavRing, type SourceJobs } from './serverDownloads';

/**
 * What the server is fetching (`GET /api/sources/jobs`), read by everything that shows it: the Library ring
 * (BottomNav on a phone, TopNav beside the Updates bell on a desktop), Library -> Downloads, the band on a
 * series page and Discover's strip.
 *
 * ⚠️ ONE POLLER. In TanStack Query v5 every observer runs its own refetchInterval timer, so two observers that
 * poll roughly double the requests -- and BottomNav and TopNav are both always mounted, one only hidden by CSS.
 * So AppShell alone passes `poll: true` (the pill's rule, now `jobsPollInterval`, with the slow archive left
 * out), and everything else reads the same cache: an action that starts or stops work calls `kickDownloads`,
 * and the answer that comes back decides the next interval (the function is re-read on every update of the
 * query, whoever caused it). The add and Find missing dialogs keep their own 2 s reads while they are open:
 * they are bounded, and each judges its own card. downloadsSurfaces.test.ts holds this to one poller.
 *
 * Only for a signed-in viewer who may download: the route refuses anyone else, and offline (`status` is
 * `offline`) there is no server to ask -- the harness counts every failed request as a console error.
 */
export function useServerDownloads({ poll = false, fresh = false, enabled = true }: { poll?: boolean; fresh?: boolean; enabled?: boolean } = {}) {
  const { user, status } = useAuth();
  return useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<SourceJobs>('/api/sources/jobs'),
    enabled: enabled && status === 'authed' && canDownload(user),
    refetchInterval: poll ? (qy) => jobsPollInterval(qy.state.data) : undefined,
    // The Downloads view asks again when it opens; a reader of the cache does not add a request of its own
    // for an answer the poller fetched a moment ago.
    staleTime: fresh ? 0 : 5_000,
  });
}

/** The Library ring, for a viewer who may see it: nothing at all for anyone else. */
export function useDownloadsRing(): NavRing {
  const { user, status } = useAuth();
  const { data } = useServerDownloads();
  const ring = navRing(data);
  return status === 'authed' && canDownload(user) ? ring : { ...ring, show: false, attention: false, count: 0 };
}

/**
 * Ask again now: after a Cancel, a Dismiss, a Try again or a Fetch, so the answer -- and with it the poll's
 * 2.5 s pace -- arrives at once rather than at the end of a 30 s wait.
 */
export function kickDownloads(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['source-jobs'] });
}
