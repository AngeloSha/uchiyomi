'use client';
// A series page's first two answers, asked for at the click that opens it ("make it faster", 2026-10-15).
//
// A page changes behind a 260 ms fade (components/PageTransition.tsx, AnimatePresence mode="wait"), and the next page --
// and with it its queries -- only mounts once the last one has faded. So every series opened on its placeholders and only
// then asked the server for the series and its chapters, a whole fade after the click. Asked at the click, they are
// usually in hand by the time the page mounts, and it opens on them. Only a click: a press can be the start of a scroll
// across the covers, and a phone would ask for every series a thumb went past.
//
// The series page builds its two queries from these same definitions, so the cache can never hold a prefetched answer
// the page would not have asked for itself. Pinned in web/test/seriesPrefetch.test.ts.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { fetchAllBooks } from './seriesBooks';
import type { Series } from './types';

export const seriesQuery = (id: string) => ({ queryKey: ['series', id], queryFn: () => api<Series>(`/api/series/${id}`) });
export const seriesBooksQuery = (id: string) => ({ queryKey: ['series-books', id], queryFn: () => fetchAllBooks(id) });

type ClickLike = {
  button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
  target: EventTarget | null;
};

/**
 * The series a click opens in this tab, or null. A plain left click on a link to `/series/?id=…` on this origin; a
 * modified one opens a new tab or window, which asks for itself.
 */
export function seriesClicked(e: ClickLike, origin: string): string | null {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined;
  if (!a) return null;
  let u: URL;
  try { u = new URL(a.getAttribute('href') || '', origin); } catch { return null; }
  if (u.origin !== origin || !/^\/series\/?$/.test(u.pathname)) return null;
  return u.searchParams.get('id') || null;
}

/** Ask for a series and its chapters at the click on any link that opens it. */
export function usePrefetchSeriesOnClick(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const on = (e: MouseEvent) => {
      const id = seriesClicked(e, location.origin);
      if (!id) return;
      // Fresh answers are kept as they are (the client's 30 s staleTime), so a series opened twice asks once.
      void qc.prefetchQuery(seriesQuery(id));
      void qc.prefetchQuery(seriesBooksQuery(id));
    };
    // Capture: before the link's own handler starts the navigation.
    document.addEventListener('click', on, true);
    return () => document.removeEventListener('click', on, true);
  }, [enabled, qc]);
}
