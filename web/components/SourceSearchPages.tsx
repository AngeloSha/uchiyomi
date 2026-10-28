'use client';
import type { ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { withAdult } from '@/lib/adult';
import { t as tr } from '@/lib/i18n';

interface Result { sourceId: string; title: string; coverUrl?: string }

/** Additional pages are requested only when the reader asks, independently for each source. */
export function SourceSearchPages<T extends Result>({ source, query, initial, pageable, children }: {
  source: string; query: string; initial: T[]; pageable: boolean; children: (results: T[]) => ReactNode;
}) {
  const url = withAdult(`/api/sources/search?source=${encodeURIComponent(source)}&q=${encodeURIComponent(query)}`);
  const pages = useInfiniteQuery({
    queryKey: ['manual-source-pages', url], enabled: false, initialPageParam: 2,
    queryFn: ({ pageParam, signal }) => api<{ content: T[] }>(`${url}&page=${pageParam}`, { signal }),
    getNextPageParam: (last, _all, page) => last.content.length && page < 30 ? page + 1 : undefined,
    staleTime: 30_000,
  });
  const seen = new Set<string>();
  const results = [...initial, ...(pages.data?.pages.flatMap((p) => p.content) ?? [])]
    .filter((r) => !seen.has(r.sourceId) && (seen.add(r.sourceId), true));
  const more = pageable && (!pages.data || pages.hasNextPage);
  return <>
    {children(results)}
    {more && <button type="button" disabled={pages.isFetching} onClick={() => void pages.fetchNextPage()}
      className="btn-key mt-1 text-xs" data-source-search-more={source}>
      {pages.isFetching ? tr('Loading…') : pages.isError ? tr('Try again') : tr('More')}
    </button>}
    {pages.isError && <p role="alert" className="mt-1 text-xs text-amber-300">{tr('Search failed — try again.')}</p>}
  </>;
}
