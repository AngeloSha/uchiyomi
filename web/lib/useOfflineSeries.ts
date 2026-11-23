'use client';
import { useEffect, useState } from 'react';
import { downloadedSeriesIds, peekDownloadedSeriesIds } from './downloads';

/**
 * Which series have something saved on this device, for the small badge on a cover.
 *
 * The set itself is cached in `downloads.ts`, beside the writes that invalidate it -- see the note there.
 * This hook is only the React wrapper: one read per mount, shared by every card on the page, rather than an
 * `isDownloaded()` round trip per tile.
 *
 * Deliberately not React Query: this is device state, not server state, and it must answer offline where
 * the query client has no persisted cache at all.
 */
export function useOfflineSeries(): Set<string> {
  // From the cache when it is already read, so a page of cards does not render twice on every visit.
  const [ids, setIds] = useState<Set<string>>(() => peekDownloadedSeriesIds() ?? new Set());

  useEffect(() => {
    let alive = true;
    downloadedSeriesIds()
      .then((s) => { if (alive) setIds(s); })
      .catch(() => { /* no store, or a blocked upgrade: no badges, which is the honest answer */ });
    return () => { alive = false; };
  }, []);

  return ids;
}
