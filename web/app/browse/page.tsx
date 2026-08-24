'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { ART } from '@/lib/art';
import { FORMAT_KEYS, GenreFacet } from '@/lib/genres';
import { SeriesTile } from '@/components/cards';
import { GenreTile } from '@/components/GenreTile';
import { EmptyState } from '@/components/EmptyState';
import { Img, Reveal } from '@/components/ui';
import { IcChevronLeft, IcSparkle } from '@/components/icons';
import { useAuth, canDownload } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';

/**
 * Browse, rebuilt out of the library you actually have.
 *
 * What was here: a flat alphabetical grid of genre names painted from six generated key-art files shared
 * across forty name mappings, so on a real library the same picture appeared under seven genres at once and
 * the fifty-six unmapped ones rendered as near-black rectangles. No counts, no ranking, no way to find one
 * genre among ninety-nine, and not one pixel of it came from this server's own collection.
 *
 * What it is now: four bands, ordered by how much of your library is in each.
 *
 *   0. FORMATS, quarantined. "Manhwa" carries 159 of 213 series on a real library; ranked by count it would
 *      be the biggest tile on the page, above every actual mood. It still filters, it just stops competing.
 *   1. THE LEAD SIX, at roughly twice the area. The size ladder IS the information.
 *   2. THE BODY, everything with three or more series.
 *   3. THE TAIL, chips behind one disclosure, because forty one-series genres is a list.
 */
function BrowseInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const genre = params.get('genre') || '';
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading: loadingGenres } = useQuery({
    queryKey: ['genres-overview'],
    // Four is what the widest mosaic renders; asking for more downloads thumbnails nothing shows.
    queryFn: () => api<{ content: GenreFacet[] }>('/api/genres/overview?covers=4'),
    staleTime: 10 * 60 * 1000,
  });

  const all = useMemo(() => data?.content ?? [], [data]);
  const bands = useMemo(() => {
    // Komga owns its own catalogue and exposes no per-genre aggregate, so every row comes back uncounted.
    // With no counts there is no ladder and no tail to hide: alphabetical, one size, no numbers.
    const komga = all.length > 0 && all.every((g) => g.series == null);
    const needle = q.trim().toLowerCase();
    const shown = needle ? all.filter((g) => g.label.toLowerCase().includes(needle)) : all;
    const formats = shown.filter((g) => FORMAT_KEYS.has(g.key));
    const real = shown.filter((g) => !FORMAT_KEYS.has(g.key));
    if (komga) return { komga, formats, lead: [], body: [...real].sort((a, b) => a.label.localeCompare(b.label)), tail: [] };
    // The API already returns count-descending, so "biggest first" needs no client sort.
    const lead = real.slice(0, 6);
    const rest = real.slice(6);
    const body = rest.filter((g) => (g.series ?? 0) >= 3).slice(0, 24);
    const inBody = new Set(body.map((g) => g.key));
    return { komga, formats, lead, body, tail: rest.filter((g) => !inBody.has(g.key)) };
  }, [all, q]);

  const facet = all.find((g) => g.key === genre.trim().toLowerCase());

  const { data: results, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
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

  const items = useMemo(() => results?.pages.flatMap((p) => p.content) ?? [], [results]);
  const total = results?.pages[0]?.totalElements ?? facet?.series ?? null;

  const surprise = async () => {
    const r = await api<{ seriesId: string | null }>('/api/random');
    if (r.seriesId) router.push(`/series/?id=${r.seriesId}`);
  };

  // ------------------------------------------------------------------ one genre
  if (genre) {
    return (
      <div className="min-h-screen-d px-4 lg:px-0">
        {/* The banner is that genre's own covers, already in the cached overview payload. Nothing extra
            is fetched to draw it, and it cannot be a picture of the wrong thing. */}
        <div className="bleed relative isolate mb-4 h-32 overflow-hidden lg:h-44 lg:rounded-b-3xl">
          <div aria-hidden className="absolute inset-0 grid scale-110 grid-cols-2 opacity-45 blur-xl sm:grid-cols-4">
            {(facet?.covers ?? []).slice(0, 4).map((id) => (
              <Img key={id} src={img.seriesThumb(id)} alt="" className="h-full w-full" imgClassName="object-top" />
            ))}
          </div>
          <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/70 to-ink-950/40" />
          <div aria-hidden className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(80% 120% at var(--start) 100%, rgb(var(--accent) / 0.24), transparent 62%)' }} />
          <div className="absolute inset-x-0 bottom-0 px-4 pb-4 lg:px-8 lg:pb-6">
            <button onClick={() => router.push('/browse/')} className="chip mb-2 text-xs">
              <IcChevronLeft width={14} height={14} />{tr('Browse')}
            </button>
            <h2 className="font-display text-2xl font-bold leading-tight lg:text-4xl">{facet?.label ?? genre}</h2>
            {total != null && (
              <p className="text-xs tabular-nums text-fog-300">
                {total === 1 ? tr('1 series') : tr('{n} series', { n: total })}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 lg:gap-x-4 xl:grid-cols-8 2xl:grid-cols-9 min-[1800px]:grid-cols-10">
          {isLoading
            ? Array.from({ length: 14 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)
            : items.map((s, i) => <SeriesTile key={s.id} series={s} eager={i < 12} />)}
        </div>
        <div ref={sentinel} className="h-16" />
        {!isLoading && !items.length && (
          <p className="px-1 pb-10 text-center text-sm text-fog-500">{tr('Nothing here yet')}</p>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------------ the wall
  return (
    <div className="min-h-screen-d px-4 lg:px-0">
      <header className="safe-top sticky top-0 z-30 -mx-4 bg-ink-950/85 px-4 pb-3 backdrop-blur-xl lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight lg:text-3xl">{tr('Browse')}</h1>
            {all.length > 0 && (
              <p className="mt-0.5 text-xs text-fog-500">{tr('{n} genres in your library', { n: all.length })}</p>
            )}
          </div>
          <button onClick={surprise} className="btn-accent shrink-0 px-4 py-2 text-sm">
            <IcSparkle width={16} height={16} />{tr('Surprise me')}
          </button>
        </div>
        {/* Only once the wall is long enough that scrolling it is worse than typing. */}
        {all.length > 24 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search…')}
            aria-label={tr('Search…')} className="field mt-3 max-w-sm" />
        )}
      </header>

      {loadingGenres ? (
        <>
          <div className="grid grid-cols-2 gap-3 pt-5 sm:grid-cols-3 lg:gap-4">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton aspect-[4/3] rounded-2xl lg:aspect-[16/9]" />)}
          </div>
          <div className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 lg:gap-4 2xl:grid-cols-6 min-[1700px]:grid-cols-7">
            {Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton aspect-[3/2] rounded-2xl" />)}
          </div>
        </>
      ) : !all.length ? (
        <EmptyState art={ART.emptyLibrary} title={tr('Nothing here yet')}
          sub={tr('Once your series carry genres, this is where they gather.')}
          cta={canDownload(user) ? { href: '/discover/', label: tr('Add new series') } : undefined} />
      ) : (
        <>
          {bands.formats.length > 0 && (
            <section className="pt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Format')}</p>
              <div className="flex flex-wrap gap-2">
                {bands.formats.map((g) => (
                  <Link key={g.key} href={`/browse/?genre=${encodeURIComponent(g.label)}`} className="chip text-xs">
                    <span>{g.label}</span>
                    {g.series != null && <span className="ms-1 tabular-nums text-fog-500">{g.series}</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {bands.lead.length > 0 && (
            <section className="grid grid-cols-2 gap-3 pt-5 sm:grid-cols-3 lg:gap-4">
              {bands.lead.map((g, i) => (
                <Reveal key={g.key} delay={i * 28}><GenreTile genre={g} size="lg" eager={i < 3} /></Reveal>
              ))}
            </section>
          )}

          {bands.body.length > 0 && (
            <section className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 lg:gap-4 2xl:grid-cols-6 min-[1700px]:grid-cols-7">
              {bands.body.map((g, i) => (
                <Reveal key={g.key} delay={Math.min(i, 12) * 28}><GenreTile genre={g} /></Reveal>
              ))}
            </section>
          )}

          {bands.tail.length > 0 && (
            <section className="pt-6">
              <button onClick={() => setShowAll((v) => !v)} className="chip text-xs">
                {tr('Show all')}<span className="ms-1 tabular-nums text-fog-500">{bands.tail.length}</span>
              </button>
              {showAll && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {bands.tail.map((g) => (
                    <Link key={g.key} href={`/browse/?genre=${encodeURIComponent(g.label)}`} className="chip text-xs">
                      <span>{g.label}</span>
                      {g.series != null && <span className="ms-1 tabular-nums text-fog-500">{g.series}</span>}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}

          {!bands.formats.length && !bands.lead.length && !bands.body.length && !bands.tail.length && (
            <p className="px-1 py-12 text-center text-sm text-fog-500">{tr('No genre matches that.')}</p>
          )}
          <div className="h-10" />
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
