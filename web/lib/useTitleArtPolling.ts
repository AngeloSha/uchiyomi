'use client';
import { useEffect, useRef } from 'react';
import type { Series } from './types';
import { titleArtPending, titleArtPollAllowed, TITLE_ART_POLL_MS } from './titleArt';

/** A lookup never holds the first render. Poll only this visible hero query, for at most a minute per pending run. */
export function useTitleArtPolling(identity: string, series: readonly Pick<Series, 'titleArt'>[], refresh: () => Promise<unknown>, enabled = true): void {
  const pending = titleArtPending(series);
  const run = useRef<{ identity: string; started: number | null }>({ identity, started: null });
  useEffect(() => {
    if (run.current.identity !== identity || !pending || !enabled) run.current = { identity, started: null };
    if (!pending || !enabled) return;
    if (run.current.started == null) run.current.started = Date.now();
    const started = run.current.started;
    if (!titleArtPollAllowed(started, Date.now())) return;
    let fetching = false;
    const timer = setInterval(() => {
      if (!titleArtPollAllowed(started, Date.now())) { clearInterval(timer); return; }
      if (!fetching && document.visibilityState !== 'hidden') {
        fetching = true;
        void refresh().catch(() => {}).finally(() => { fetching = false; });
      }
    }, TITLE_ART_POLL_MS);
    return () => clearInterval(timer);
  }, [identity, pending, refresh, enabled]);
}
