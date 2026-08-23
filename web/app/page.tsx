'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { HomePayload, Series } from '@/lib/types';
import { chapterLabel, progressOf } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { triggerRefresh } from '@/lib/refresh';
import { applyCover, clearCover } from '@/lib/theme';
import { ART } from '@/lib/art';
import { Img, ProgressBar, Rail, RailSkeleton, SectionTitle, Reveal } from '@/components/ui';
import { SeriesCard, ContinueCard } from '@/components/cards';
import { HeroCarousel } from '@/components/HeroCarousel';
import { IcPlay, IcSparkle, IcRefresh, IcBell } from '@/components/icons';
import { PullToRefresh } from '@/components/PullToRefresh';
import { Avatar } from '@/components/Avatar';
import { Lockup } from '@/components/Brand';
import { t as tr } from '@/lib/i18n';

interface CollectionRow { id: string; name: string; accent: string | null; item_count: number }

/** One home rail per (non-empty) collection, capped at 3 — links through to the collection page. */
function CollectionRails() {
  const { data } = useQuery({ queryKey: ['collections'], queryFn: () => api<{ content: CollectionRow[] }>('/api/collections'), staleTime: 300000 });
  const cols = (data?.content ?? []).filter((c) => c.item_count > 0).slice(0, 3);
  if (!cols.length) return null;
  return (
    <>
      {cols.map((c) => <CollectionRail key={c.id} col={c} />)}
    </>
  );
}

function CollectionRail({ col }: { col: CollectionRow }) {
  const { data } = useQuery({
    queryKey: ['collection', col.id],
    queryFn: () => api<{ items: Series[] }>(`/api/collections/${col.id}`),
    staleTime: 300000,
  });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="pt-8">
      <SectionTitle action={<Link href={`/collection/?id=${col.id}`} className="text-xs text-accent">{tr('See all')}</Link>}>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-4 w-1.5 rounded-full" style={{ background: col.accent || 'rgb(var(--accent))' }} />
          {col.name}
        </span>
      </SectionTitle>
      <Rail>{items.slice(0, 12).map((s) => <SeriesCard key={s.id} series={s} />)}</Rail>
    </section>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Late night reading';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function HomePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['home'], queryFn: () => api<HomePayload>('/api/home') });
  const { data: foryou } = useQuery({ queryKey: ['foryou'], queryFn: () => api<{ genres: string[]; content: Series[] }>('/api/foryou'), staleTime: 600000 });
  const { data: trending } = useQuery({ queryKey: ['trending'], queryFn: () => api<{ content: Series[] }>('/api/trending'), staleTime: 300000 });
  const { data: featured } = useQuery({ queryKey: ['featured'], queryFn: () => api<{ content: Series[] }>('/api/featured'), staleTime: 600000 });

  // "Because you read X" — seed a named recommendation rail from what you're currently reading (else a top favorite)
  const seed = data?.onDeck?.[0]
    ? { id: data.onDeck[0].seriesId, name: data.onDeck[0].seriesTitle }
    : data?.favorites?.[0]
      ? { id: data.favorites[0].id, name: data.favorites[0].metadata?.title || data.favorites[0].name }
      : null;
  const { data: because } = useQuery({
    queryKey: ['because', seed?.id ?? 'none'],
    queryFn: () => api<{ content: Series[] }>(`/api/series/${seed!.id}/similar`),
    enabled: !!seed?.id,
    staleTime: 600000,
  });

  // Auto-scan Komga on open so new Suwayomi chapters surface, then refetch.
  useEffect(() => {
    triggerRefresh().then(() => setTimeout(() => qc.invalidateQueries({ queryKey: ['home'] }), 1800));
  }, [qc]);

  const onRefresh = async () => {
    await triggerRefresh();
    await new Promise((r) => setTimeout(r, 1500));
    qc.invalidateQueries({ queryKey: ['home'] });
  };

  // the hero carousel drives ambient --cover; clear it when leaving home
  useEffect(() => () => clearCover(), []);

  return (
    <PullToRefresh onRefresh={onRefresh}>
    <div className="min-h-screen-d">
      {/* top bar (mobile only — desktop uses the global TopNav) */}
      <header className="safe-top sticky top-0 z-30 flex items-center justify-between px-5 pb-3 lg:hidden">
        <Lockup className="text-2xl" markSize={36} />
        <div className="flex items-center gap-2">
          <Link href="/updates" className="relative grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 backdrop-blur">
            <IcBell width={19} height={19} />
            {(data?.updatesCount ?? 0) > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-black">{(data!.updatesCount ?? 0) > 9 ? '9+' : data!.updatesCount}</span>}
          </Link>
          <Link href="/profile" className="transition active:opacity-80">
            <Avatar avatar={user?.avatar} size={40} />
          </Link>
        </div>
      </header>

      {/* HERO — daily recommendation carousel */}
      {(featured?.content?.length ?? 0) > 0 ? (
        <HeroCarousel slides={featured!.content} />
      ) : isLoading ? (
        <div className="skeleton h-[62vh] min-h-[440px] w-full lg:-mx-6 lg:w-[calc(100%+3rem)]" />
      ) : (
        <div className="relative h-[58vh] min-h-[420px] overflow-hidden lg:-mx-6 lg:h-[70vh] lg:w-[calc(100%+3rem)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ART.hero} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/55 to-ink-950/15" />
          <div className="absolute inset-x-0 bottom-0 px-5 pb-12 lg:px-14">
            <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-accent backdrop-blur"><IcSparkle width={13} height={13} />{tr('Welcome')}</span>
            <h1 className="font-brand text-4xl font-bold leading-tight text-white drop-shadow lg:text-6xl">{tr('Welcome to Uchiyomi')}</h1>
            <p className="mb-4 mt-1 text-sm text-fog-300">{tr('Your cinematic library awaits.')}</p>
            <Link href="/library" className="btn-accent">{tr('Browse library')}</Link>
          </div>
        </div>
      )}

      <p className="px-5 pt-6 text-sm text-fog-400 lg:px-0 lg:text-base">
        {greeting()}{user?.displayName && user.displayName !== 'me' ? `, ${user.displayName}` : ''}.
      </p>

      {/* Keep reading */}
      {(data?.onDeck?.length ?? 0) > 0 && (
        <section className="pt-4">
          <SectionTitle>{tr('Keep reading')}</SectionTitle>
          <Rail>
            {data!.onDeck.map((b, i) => <ContinueCard key={b.id} book={b} eager={i < 4} />)}
          </Rail>
        </section>
      )}

      {/* For you */}
      {(foryou?.content?.length ?? 0) > 0 && (
        <section className="pt-8">
          <SectionTitle action={<Link href="/browse" className="text-xs text-accent">{tr('Browse')}</Link>}>{tr('For you')}</SectionTitle>
          <Rail>
            {foryou!.content.map((s) => <SeriesCard key={s.id} series={s} />)}
          </Rail>
        </section>
      )}

      {/* Because you read X */}
      {seed && (because?.content?.length ?? 0) > 0 && (
        <section className="pt-8">
          <SectionTitle>Because you read {seed.name}</SectionTitle>
          <Rail>
            {because!.content.map((s) => <SeriesCard key={s.id} series={s} />)}
          </Rail>
        </section>
      )}

      {/* New episodes */}
      <section className="pt-8">
        <SectionTitle action={<Link href="/library?sort=updated" className="text-xs text-accent">{tr('See all')}</Link>}>{tr('New episodes')}</SectionTitle>
        {isLoading ? <RailSkeleton /> : (
          <Rail>
            {(data?.updated ?? []).map((s, i) => <SeriesCard key={s.id} series={s} eager={i < 8} />)}
          </Rail>
        )}
      </section>

      {/* Favorites */}
      {(data?.favorites?.length ?? 0) > 0 && (
        <section className="pt-8">
          <SectionTitle action={<Link href="/profile" className="text-xs text-accent">{tr('Manage')}</Link>}>{tr('Your favorites')}</SectionTitle>
          <Rail>
            {data!.favorites.map((s) => <SeriesCard key={s.id} series={s} />)}
          </Rail>
        </section>
      )}

      {/* Your collections */}
      <CollectionRails />

      {/* Recently added */}
      <section className="pt-8">
        <SectionTitle action={<Link href="/library?sort=new" className="text-xs text-accent">{tr('See all')}</Link>}>{tr('Recently added')}</SectionTitle>
        {isLoading ? <RailSkeleton /> : (
          <Rail>
            {(data?.new ?? []).map((s) => <SeriesCard key={s.id} series={s} />)}
          </Rail>
        )}
      </section>

      {/* Trending across accounts — Netflix-style Top 10 with big rank numerals */}
      {(trending?.content?.length ?? 0) > 0 && (
        <section className="pt-8">
          <SectionTitle>{tr('Top 10 in your library')}</SectionTitle>
          <Rail>
            {trending!.content.slice(0, 10).map((s, i) => (
              <div key={s.id} className="flex shrink-0 items-end [scroll-snap-align:start]">
                <span aria-hidden className="rank-numeral -me-5 mb-6 select-none font-display text-[88px] font-black leading-[0.78]">
                  {i + 1}
                </span>
                <SeriesCard series={s} />
              </div>
            ))}
          </Rail>
        </section>
      )}
    </div>
    </PullToRefresh>
  );
}
