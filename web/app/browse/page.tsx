'use client';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { SeriesTile } from '@/components/cards';
import { GenreTile } from '@/components/GenreTile';
import { IcSparkle } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

function BrowseInner() {
  const params = useSearchParams();
  const router = useRouter();
  const genre = params.get('genre') || '';

  const { data: genres } = useQuery({ queryKey: ['genres'], queryFn: () => api<{ content: string[] }>('/api/genres') });

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['browse', genre],
    enabled: !!genre,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<Page<Series>>('/api/series/search', {
        json: { page: pageParam, size: 40, sort: 'metadata.titleSort,asc', condition: { genre: { operator: 'is', value: genre } } },
      }),
    getNextPageParam: (last) => (last.last ? undefined : last.number + 1),
  });

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = useMemo(() => data?.pages.flatMap((p) => p.content) ?? [], [data]);

  const surprise = async () => {
    const r = await api<{ seriesId: string | null }>('/api/random');
    if (r.seriesId) router.push(`/series/?id=${r.seriesId}`);
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-5 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Browse')}</h1>
          <button onClick={surprise} className="btn-accent px-4 py-2 text-sm"><IcSparkle width={16} height={16} />{tr('Surprise me')}</button>
        </div>
        {genre && (
          <button onClick={() => router.replace('/browse')} className="chip mt-3 text-xs">← All genres</button>
        )}
      </header>

      {!genre ? (
        <div className="grid grid-cols-2 gap-3 px-4 pt-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 lg:px-0 xl:grid-cols-5 2xl:grid-cols-6">
          {(genres?.content ?? []).map((g) => (
            <GenreTile key={g} genre={g} onClick={() => router.replace(`/browse?genre=${encodeURIComponent(g)}`)} />
          ))}
        </div>
      ) : (
        <>
          <h2 className="px-5 pt-3 font-display text-2xl font-bold capitalize lg:px-0">{genre}</h2>
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 px-4 pt-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 lg:gap-x-4 lg:px-0 xl:grid-cols-8 2xl:grid-cols-9 min-[1800px]:grid-cols-10">
            {isLoading
              ? Array.from({ length: 14 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)
              : items.map((s, i) => <SeriesTile key={s.id} series={s} eager={i < 12} />)}
          </div>
          <div ref={sentinel} className="h-16" />
        </>
      )}
    </div>
  );
}

export default function BrowsePage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <BrowseInner />
    </Suspense>
  );
}
