'use client';
import { ScrollRail, CARD_RAIL } from '@/components/ScrollRail';
import Link from 'next/link';
import { Fragment, ReactNode, useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { HomePayload, Series } from '@/lib/types';
import { chapterLabel, progressOf } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { triggerRefresh } from '@/lib/refresh';
import { applyCover, clearCover } from '@/lib/theme';
import { ART } from '@/lib/art';
import { Img, ProgressBar, RailSkeleton, SectionTitle, Reveal } from '@/components/ui';
import { SeriesCard, ContinueCard } from '@/components/cards';
import { KeepReadingHidden } from '@/components/KeepReadingHidden';
import { HeroCarousel } from '@/components/HeroCarousel';
import { useTitleArtPolling } from '@/lib/useTitleArtPolling';
import { useArtUnderChrome } from '@/lib/overArt';
import { AdultToggle, useAdultFilterConfigured } from '@/components/AdultToggle';
import { IcPlay, IcSparkle, IcRefresh, IcBell } from '@/components/icons';
import { PullToRefresh } from '@/components/PullToRefresh';
import { Avatar } from '@/components/Avatar';
import { QuickSettingsSheet } from '@/components/ProfileMenu';
import { Lockup } from '@/components/Brand';
import { LibraryStart } from '@/components/LibraryStart';
import { t as tr } from '@/lib/i18n';
import { sortValue } from '@/lib/sortValue';
import { relativeTime } from '@/lib/format';
import { homeIdsOf, type ListRow } from '@/lib/lists';
import { useListsAll } from '@/components/SaveListDialog';
import { HOME_RAIL_KEYS, shownRails, type HomeRailKey } from '@/lib/homeRails';
import { HomeCustomize } from '@/components/HomeCustomize';
import { FavoritesManage } from '@/components/FavoritesSheet';
import { safeColor } from '@/lib/safeColor';

type CollectionRow = ListRow;

/**
 * One home rail per chosen list, capped at 3 — links through to the list's page. v0.61.0: any list this reader may read
 * (lib/lists.ts), a smart one or one someone shares included, from ['lists-all'].
 */
function CollectionRails() {
  const { user, status: authStatus } = useAuth();
  const { data } = useListsAll(true, 300_000);
  const all = data?.content ?? [];
  const saved = user?.settings?.homeCollections;
  // No setting means the pre-v0.55.8 behaviour.  Once a reader makes an explicit choice, including choosing
  // none, that exact order wins.  Empty selected lists remain in the setting but their rail stays quiet until
  // something is added; a stale or unreadable id is not in this reader's answer and is ignored (lib/lists.ts homeIdsOf).
  const cols = homeIdsOf(saved, all).map((id) => all.find((c) => c.id === id)).filter((c): c is CollectionRow => !!c);
  if (!cols.length) return null;
  return (
    <>
      {cols.map((c) => <CollectionRail key={c.id} col={c} />)}
    </>
  );
}

function CollectionRail({ col }: { col: CollectionRow }) {
  // Twelve, not the whole list (v0.61.0: a smart list may match the library), under a key of its own so the list's page
  // never takes this short answer for the list.
  const { data } = useQuery({
    queryKey: ['collection', col.id, 'rail'],
    queryFn: () => api<{ items: Series[] }>(`/api/collections/${col.id}?limit=12`),
    staleTime: 300000,
  });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="pt-8">
      <SectionTitle action={<Link href={`/collection/?id=${col.id}`} className="text-xs text-accent">{tr('See all')}</Link>}>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-4 w-1.5 rounded-full" style={{ background: safeColor(col.accent, 'rgb(var(--accent))') }} />
          {col.name}
        </span>
      </SectionTitle>
      <ScrollRail label={col.name} className={CARD_RAIL}>{items.slice(0, 12).map((s) => <SeriesCard key={s.id} series={s} />)}</ScrollRail>
    </section>
  );
}

/**
 * The line above Home's rails, as one sentence per time of day, with the reader's name and without: the greeting
 * was English in every language, and its ", {name}." glued on after it would be English punctuation in Japanese,
 * Chinese and Arabic too. The name is isolated: a Latin name inside an Arabic sentence takes its order.
 */
function greeting(name?: string) {
  const h = new Date().getHours();
  const who = name ? { name: `\u2068${name}\u2069` } : null;
  if (h < 5) return who ? tr('Late night reading, {name}.', who) : tr('Late night reading.');
  if (h < 12) return who ? tr('Good morning, {name}.', who) : tr('Good morning.');
  if (h < 18) return who ? tr('Good afternoon, {name}.', who) : tr('Good afternoon.');
  return who ? tr('Good evening, {name}.', who) : tr('Good evening.');
}

export default function HomePage() {
  const { user, status: authStatus } = useAuth();
  const [quickOpen, setQuickOpen] = useState(false);
  const qc = useQueryClient();
  // A second reason for the 18+ reveal to render: a genre or source on the admin's 18+ filter.
  const adultFilter = useAdultFilterConfigured();
  // The reader's rails, in their order (lib/homeRails.ts; Customize below the hero). A hidden rail is not drawn, and the
  // three that have a request of their own do not ask it.
  const shown = shownRails(user?.settings?.homeRails, HOME_RAIL_KEYS);
  const on = (k: HomeRailKey) => shown.includes(k);
  const { data, isLoading } = useQuery({ queryKey: ['home'], queryFn: () => api<HomePayload>('/api/home') });
  const { data: foryou } = useQuery({ queryKey: ['foryou'], queryFn: () => api<{ genres: string[]; content: Series[] }>('/api/foryou'), staleTime: 600000, enabled: on('forYou') });
  const { data: trending } = useQuery({ queryKey: ['trending'], queryFn: () => api<{ content: Series[] }>('/api/trending'), staleTime: 300000, enabled: on('top10') });
  const { data: featured, isPending: featuredPending } = useQuery({ queryKey: ['featured'], queryFn: () => api<{ content: Series[] }>('/api/featured'), staleTime: 600000 });
  const refetchTitleArt = useCallback(() => qc.refetchQueries({ queryKey: ['featured'], exact: true }), [qc]);
  useTitleArtPolling('featured', featured?.content ?? [], refetchTitleArt, authStatus !== 'offline');

  // "Because you read X" — seed a named recommendation rail from what you're currently reading (else a top favorite)
  const seed = data?.onDeck?.[0]
    ? { id: data.onDeck[0].seriesId, name: data.onDeck[0].seriesTitle }
    : data?.favorites?.[0]
      ? { id: data.favorites[0].id, name: data.favorites[0].metadata?.title || data.favorites[0].name }
      : null;
  const { data: because } = useQuery({
    queryKey: ['because', seed?.id ?? 'none'],
    queryFn: () => api<{ content: Series[] }>(`/api/series/${seed!.id}/similar`),
    enabled: !!seed?.id && on('because'),
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
  // Home's art starts at the top of the window: the desktop top bar is see-through over it (lib/overArt.ts).
  useArtUnderChrome();

  // Home's rails by key (lib/homeRails.ts), each drawn only when it has something to show. The reader's arrangement puts
  // them in order below; HOME_RAILS holds the owner's order, which is the default.
  const rail = (key: HomeRailKey): ReactNode => {
    switch (key) {
      case 'continue':
        // Keep reading. Every rail says pt-8; the list below gives the first one shown pt-4, whichever it is.
        // Everything removed from it still draws the title and its Hidden key, which is the way to put one back.
        return ((data?.onDeck?.length ?? 0) > 0 || (data?.keepReadingHidden ?? 0) > 0) && (
          <section className="pt-8">
            <SectionTitle action={<KeepReadingHidden count={data?.keepReadingHidden ?? 0} />}>{tr('Keep reading')}</SectionTitle>
            {(data?.onDeck?.length ?? 0) > 0 && (
              <ScrollRail label={tr('Keep reading')} className={CARD_RAIL}>
                {data!.onDeck.map((b, i) => <ContinueCard key={b.id} book={b} eager={i < 4} keepReading />)}
              </ScrollRail>
            )}
          </section>
        );
      case 'forYou':
        // For you
        return (foryou?.content?.length ?? 0) > 0 && (
          <section className="pt-8">
            <SectionTitle action={<Link href="/library" className="text-xs text-accent">{tr('Library')}</Link>}>{tr('For you')}</SectionTitle>
            <ScrollRail label={tr('For you')} className={CARD_RAIL}>
              {foryou!.content.map((s) => <SeriesCard key={s.id} series={s} />)}
            </ScrollRail>
          </section>
        );
      case 'because':
        // Because you read X (the series being read, else a favourite)
        return seed && (because?.content?.length ?? 0) > 0 && (
          <section className="pt-8">
            <SectionTitle>{tr('Because you read {title}', { title: `⁨${seed.name}⁩` })}</SectionTitle>
            <ScrollRail label={tr('Because you read {title}', { title: `⁨${seed.name}⁩` })} className={CARD_RAIL}>
              {because!.content.map((s) => <SeriesCard key={s.id} series={s} />)}
            </ScrollRail>
          </section>
        );
      case 'newEpisodes':
        // New episodes
        return (
          <section className="pt-8">
            <SectionTitle action={<Link href="/library?sort=updated" className="text-xs text-accent">{tr('See all')}</Link>}>{tr('New episodes')}</SectionTitle>
            {isLoading ? <RailSkeleton /> : (
              <ScrollRail label={tr('New episodes')} className={CARD_RAIL}>
                {(data?.updated ?? []).map((s, i) => <SeriesCard key={s.id} series={s} eager={i < 8} />)}
              </ScrollRail>
            )}
          </section>
        );
      case 'favorites':
        // Favorites
        return (data?.favorites?.length ?? 0) > 0 && (
          <section className="pt-8">
            {/* Manage opens the order and the list (v0.97.0, components/FavoritesSheet.tsx); it went to Profile, which had nothing for them. */}
            <SectionTitle action={<FavoritesManage />}>{tr('Your favorites')}</SectionTitle>
            <ScrollRail label={tr('Your favorites')} className={CARD_RAIL}>
              {data!.favorites.map((s) => <SeriesCard key={s.id} series={s} />)}
            </ScrollRail>
          </section>
        );
      case 'lists':
        // Your lists: one rail per list the Lists page puts on Home, in its order there.
        return <CollectionRails />;
      case 'pickUp':
        // Pick back up (v0.61.0): series put down three months to two years ago, each at its next chapter and saying
        // when. Only with something in it, like every rail an older server does not send.
        return (data?.pickUp?.length ?? 0) > 0 && (
          <section className="pt-8" data-home-pickup>
            <SectionTitle>{tr('Pick back up')}</SectionTitle>
            <ScrollRail label={tr('Pick back up')} className={CARD_RAIL}>
              {data!.pickUp!.map((b) => (
                <ContinueCard key={b.id} book={b} note={b.stoppedAt ? tr('Read {when}', { when: relativeTime(b.stoppedAt) }) : undefined} />
              ))}
            </ScrollRail>
          </section>
        );
      case 'recentlyAdded':
        // Recently added
        return (
          <section className="pt-8">
            <SectionTitle action={<Link href="/library?sort=new" className="text-xs text-accent">{tr('See all')}</Link>}>{tr('Recently added')}</SectionTitle>
            {isLoading ? <RailSkeleton /> : (
              <ScrollRail label={tr('Recently added')} className={CARD_RAIL}>
                {(data?.new ?? []).map((s) => <SeriesCard key={s.id} series={s} />)}
              </ScrollRail>
            )}
          </section>
        );
      case 'popular':
        // Most popular in your library (v0.58.0): the viewer's series by AniList popularity, each saying AniList's
        // score. Only with something in it -- a server older than v0.58.0 sends no `popular`, and a library with no
        // AniList numbers yet has nothing to rank -- so it never shows an empty rail or a skeleton that turns into
        // nothing.
        return (data?.popular?.length ?? 0) > 0 && (
          <section className="pt-8">
            <SectionTitle action={<Link href="/library?sort=popular" className="text-xs text-accent">{tr('See all')}</Link>}>{tr('Most popular in your library')}</SectionTitle>
            <ScrollRail label={tr('Most popular in your library')} className={CARD_RAIL}>
              {data!.popular!.map((s) => <SeriesCard key={s.id} series={s} note={sortValue(s, 'score')} />)}
            </ScrollRail>
          </section>
        );
      case 'gems':
        // Hidden gems (v0.61.0): well-rated series nobody here has opened, each saying AniList's score. Only with
        // something in it. See all is the Library's own answer to the same question, best first and not started.
        return (data?.gems?.length ?? 0) > 0 && (
          <section className="pt-8" data-home-gems>
            <SectionTitle action={<Link href="/library?sort=score&read=UNREAD" className="text-xs text-accent">{tr('See all')}</Link>}>{tr('Hidden gems')}</SectionTitle>
            <ScrollRail label={tr('Hidden gems')} className={CARD_RAIL}>
              {data!.gems!.map((s) => <SeriesCard key={s.id} series={s} note={sortValue(s, 'score')} />)}
            </ScrollRail>
          </section>
        );
      case 'top10':
        // Trending across accounts — Netflix-style Top 10 with big rank numerals
        return (trending?.content?.length ?? 0) > 0 && (
          <section className="pt-8">
            <SectionTitle>{tr('Top 10 in your library')}</SectionTitle>
            <ScrollRail label={tr('Top 10 in your library')} className={CARD_RAIL}>
              {trending!.content.slice(0, 10).map((s, i) => (
                <div key={s.id} className="flex shrink-0 items-end [scroll-snap-align:start]">
                  <span aria-hidden className="rank-numeral -me-5 mb-6 select-none font-display text-[88px] font-black leading-[0.78]">
                    {i + 1}
                  </span>
                  <SeriesCard series={s} />
                </div>
              ))}
            </ScrollRail>
          </section>
        );
    }
  };

  return (
    <PullToRefresh onRefresh={onRefresh}>
    <div className="min-h-screen-d">
      {/* top bar (mobile only — desktop uses the global TopNav) */}
      <header className="safe-top sticky top-0 z-30 flex items-center justify-between px-5 pb-3 lg:hidden">
        <Lockup className="text-2xl" markSize={36} />
        <div className="flex items-center gap-2">
          <Link href="/updates" className="relative grid h-10 w-10 place-items-center rounded-full border border-ink-700 bg-ink-850/70 text-fog-300 backdrop-blur">
            <IcBell width={19} height={19} />
            {/* Squared, as the desktop bar's: a round tag grows into a capsule at "9+". */}
            {(data?.updatesCount ?? 0) > 0 && <span className="absolute -end-1.5 -top-1 grid h-4 min-w-4 place-items-center rounded-[4px] bg-accent px-[3px] text-[10px] font-bold leading-none tabular-nums text-black">{(data!.updatesCount ?? 0) > 9 ? '9+' : data!.updatesCount}</span>}
          </Link>
          <button type="button" aria-label={tr('You')} aria-haspopup="dialog" onClick={() => setQuickOpen(true)} className="grid h-10 w-10 place-items-center rounded-full transition active:opacity-80">
            <Avatar avatar={user?.avatar} size={40} />
          </button>
        </div>
      </header>
      {quickOpen && <QuickSettingsSheet onClose={() => setQuickOpen(false)} />}

      {/* HERO — daily recommendation carousel */}
      {/* The welcome is for a library with nothing in it for this viewer -- `/api/featured` is the latest series they
          can see, so it is empty only then -- and never a flash while that answer is on its way: it now offers the
          import (v0.55.4), which a full library must not show for the second before its carousel arrives. */}
      {(featured?.content?.length ?? 0) > 0 ? (
        <HeroCarousel slides={featured!.content} />
      ) : isLoading || featuredPending ? (
        <div className="skeleton bleed-lg under-topbar under-phone-header h-[min(150vw,82svh)] lg:h-[62vh] lg:min-h-[440px]" />
      ) : (
        <div className="bleed-lg under-topbar under-phone-header relative h-[58vh] min-h-[420px] overflow-hidden lg:h-[70vh]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ART.hero} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/55 to-ink-950/15" />
          <div className="absolute inset-x-0 bottom-0 px-5 pb-12 lg:pe-14 lg:ps-[calc(var(--rail-w)+3.5rem)]">
            <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-accent backdrop-blur"><IcSparkle width={13} height={13} />{tr('Welcome')}</span>
            <h1 className="font-brand text-4xl font-bold leading-tight text-white drop-shadow lg:text-6xl">{tr('Welcome to Uchiyomi')}</h1>
            <p className="mb-4 mt-1 text-sm text-fog-300">{tr('Your cinematic library awaits.')}</p>
            {/* v0.55.4 (#158): the empty Library's keys, in its order -- import one (admins), find series in Discover
                (whoever may add them). "Browse library" led to that same empty page. */}
            <LibraryStart align="start" />
          </div>
        </div>
      )}

      {/* The greeting shares its line with the 18+ reveal, which renders nothing unless this account has
          such a library or the 18+ filter names a genre or source. Home is where a missing rail is noticed,
          so it is where the way back has to be. */}
      {/* px-4 at every width (UI refresh): the section titles and their rails sit 1rem in, and the greeting sat 4 px
          to the right of them on a phone and 16 px to the left on a desktop. */}
      {/* Look settings (UI refresh): Customize, the reader's own order and choice of rails, at the end of the same line. */}
      <div className="flex items-center justify-between gap-3 px-4 pt-6">
        <p className="min-w-0 text-sm text-fog-400 lg:text-base">
          {greeting(user?.displayName && user.displayName !== 'me' ? user.displayName : undefined)}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <AdultToggle className="shrink-0" alsoWhen={adultFilter} />
          <HomeCustomize />
        </div>
      </div>

      {/* The rails, in the reader's order (Customize, above). Whichever comes first sits closer to the greeting. */}
      <div className="[&>section:first-child]:pt-4">
        {shown.map((k) => <Fragment key={k}>{rail(k)}</Fragment>)}
      </div>
    </div>
    </PullToRefresh>
  );
}
