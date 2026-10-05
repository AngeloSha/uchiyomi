'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { SeriesTile } from '@/components/cards';
import { IcSearch, IcX } from '@/components/icons';
import { PlaceRow } from '@/components/CommandPalette';
import { t as tr } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { isDesktop } from '@/lib/desktop';
import { findDestinations } from '@/lib/destinations';

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SearchInner() {
  const initial = useSearchParams().get('q') || '';
  const [q, setQ] = useState(initial);
  const debounced = useDebounced(q.trim(), 280);
  const inputRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    if (!initial) inputRef.current?.focus();
    try {
      setRecent(JSON.parse(localStorage.getItem('yomi_recent') || '[]'));
    } catch {}
  }, [initial]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    enabled: debounced.length >= 2,
    queryFn: () => api<Page<Series>>('/api/series/search', { json: { query: debounced, size: 60 } }),
  });
  // v0.55.4: the pages and settings the query names, as the palette lists them (a phone has no palette): under the
  // series, admins' only for admins, none of Desktop's missing ones there (lib/destinations.ts).
  const { isAdmin } = useAuth();
  const places = useMemo(() => findDestinations(debounced, { admin: isAdmin, desktop: isDesktop(), limit: 8 }), [debounced, isAdmin]);

  const remember = (term: string) => {
    if (!term) return;
    const next = [term, ...recent.filter((r) => r !== term)].slice(0, 8);
    setRecent(next);
    localStorage.setItem('yomi_recent', JSON.stringify(next));
  };

  return (
    <div className="min-h-screen-d">
      <header className="safe-top sticky top-0 z-30 bg-ink-950/85 px-4 pb-3 backdrop-blur-xl lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:backdrop-blur-none">
        <div className="flex items-center gap-2 rounded-2xl border border-ink-600 bg-ink-850 px-3.5 py-3 focus-within:border-accent lg:max-w-xl">
          <IcSearch width={20} height={20} className="text-fog-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => remember(debounced)}
            placeholder={tr('Search your library…')}
            className="w-full bg-transparent text-base text-fog-50 outline-hidden placeholder:text-fog-500"
          />
          {q && (
            <button onClick={() => setQ('')} className="text-fog-500">
              <IcX width={18} height={18} />
            </button>
          )}
        </div>
      </header>

      {debounced.length < 2 && recent.length > 0 && (
        <div className="px-5 pt-5 lg:px-0">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-fog-500">{tr('Recent')}</p>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <button key={r} onClick={() => setQ(r)} className="chip">
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {debounced.length >= 2 && (
        <div className="px-4 pt-4 lg:px-0">
          {isFetching && !data ? (
            <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-9 3xl:grid-cols-10">
              {Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
            </div>
          ) : (data?.content.length ?? 0) === 0 ? (
            <p className={`${places.length ? 'py-6' : 'py-20'} text-center text-sm text-fog-500`}>
              {tr('No series match “{query}”.', { query: `\u2068${debounced}\u2069` })}
            </p>
          ) : (
            <>
              <p className="mb-3 text-xs text-fog-500">{data?.totalElements} results</p>
              <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 lg:gap-x-4 xl:grid-cols-8 2xl:grid-cols-9 3xl:grid-cols-10">
                {data?.content.map((s, i) => <SeriesTile key={s.id} series={s} eager={i < 12} />)}
              </div>
            </>
          )}
          {places.length > 0 && (
            <section data-search-places aria-label={tr('Pages and settings')} className="mt-6 pb-6">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-fog-500">{tr('Pages and settings')}</p>
              <div className="card divide-y divide-ink-800/70 overflow-hidden rounded-2xl">
                {places.map((p) => <PlaceRow key={p.key} place={p} href={p.href} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <SearchInner />
    </Suspense>
  );
}
