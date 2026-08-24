'use client';
import { useEffect, useRef, useState } from 'react';
import { Img, useWideViewport } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { IcPlus, IcSparkle } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

export interface Trending {
  title: string;
  cover: string | null;
  /** Wide AniList key art. Returned by /api/discover/trending since it shipped, and never once rendered. */
  banner?: string | null;
  description: string;
  genres: string[];
  score: number | null;
  chapters: number | null;
  status: string | null;
}

/**
 * The one cinematic surface on Discover, and it costs nothing to build.
 *
 * `/api/discover/trending` has always returned `banner`, `genres`, `score`, `chapters` and `status` for
 * twenty-four globally trending titles it has already filtered against this library. The page declared an
 * interface without `banner` and rendered the rest as a 144px thumbnail with a percentage badge. So the art
 * for a proper hero was sitting in the payload of a page whose complaint was that it is not cinematic.
 *
 * On a phone the banner is the wrong picture: a 4.75:1 strip inside a 1.1:1 box shows about a quarter of it,
 * reliably the quarter with no face. So narrow viewports take the 2:3 cover, cropped from the top.
 */
export function DiscoverHero({ slides, onPick }: { slides: Trending[]; onPick: (t: Trending) => void }) {
  const wide = useWideViewport();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const startX = useRef(0);

  useEffect(() => {
    if (paused || slides.length < 2) return;
    const t = setTimeout(() => setI((v) => (v + 1) % slides.length), 7000);
    return () => clearTimeout(t);
  }, [i, paused, slides.length]);

  if (!slides.length) return null;
  const cur = slides[Math.min(i, slides.length - 1)];
  // The banner if we have one and the room for it; otherwise the cover, which every item has.
  const art = wide && cur.banner ? cur.banner : cur.cover;
  const letterboxed = wide && !cur.banner;

  return (
    <div
      className="bleed relative isolate h-[44vh] min-h-[300px] overflow-hidden lg:h-[54vh] lg:min-h-[400px] lg:max-h-[600px] lg:rounded-b-3xl"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => { startX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - startX.current;
        if (Math.abs(dx) > 50) setI((v) => (v + (dx < 0 ? 1 : slides.length - 1)) % slides.length);
      }}
    >
      <div key={cur.title} className="absolute inset-0 animate-fade-up">
        {/* A 2:3 cover in a 16:6 box would be pillarboxed against flat black, so its own blur fills the sides. */}
        {letterboxed && (
          <Img src={sourceCover(undefined, art, 800)} alt="" fallbackSrc={art || undefined}
            className="absolute inset-0 h-full w-full scale-125 opacity-50 blur-2xl" />
        )}
        <Img
          src={sourceCover(undefined, art, 1600)} alt={cur.title} fallbackSrc={art || undefined} eager
          className={`absolute inset-0 h-full w-full ${letterboxed ? 'mx-auto max-w-2xl' : ''}`}
          imgClassName={wide && cur.banner ? 'object-center' : 'object-top'}
        />
      </div>

      {/* Light, matching the home hero: the art is the point, and the type carries its own shadow. The first
          version stacked a full-height black gradient, an 85% inline scrim and a radial, which between them
          left a hero that looked like it had failed to load. */}
      <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/30 to-transparent" />
      <span aria-hidden className="scrim-soft absolute inset-0" />
      <span aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(60% 70% at var(--start) 70%, rgb(var(--accent) / 0.14), transparent 70%)' }} />

      <div className="relative z-10 flex h-full flex-col justify-end px-4 pb-5 lg:px-8 lg:pb-10">
        <span className="mb-2.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-black/45 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent backdrop-blur">
          <IcSparkle width={12} height={12} />{tr('Trending now')}
        </span>
        <h2 className="max-w-3xl font-display text-2xl font-bold leading-[1.06] text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.65)] lg:text-5xl xl:text-6xl">
          {cur.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-300 lg:text-sm">
          {cur.score != null && <span className="font-semibold text-accent">{cur.score}%</span>}
          {cur.chapters != null && <span>· {tr('{n} ch', { n: cur.chapters })}</span>}
          {(cur.genres ?? []).slice(0, 3).map((g) => <span key={g}>· {g}</span>)}
        </div>
        {cur.description && (
          <p className="mt-2.5 hidden max-w-xl text-sm leading-relaxed text-fog-300 lg:line-clamp-2">{cur.description}</p>
        )}
        <div className="mt-4 flex items-center gap-2.5">
          <button onClick={() => onPick(cur)} className="btn-accent px-6 py-3 text-sm lg:px-7 lg:py-3.5 lg:text-base">
            <IcPlus width={17} height={17} />{tr('Find and add')}
          </button>
          {slides.length > 1 && (
            <div className="flex gap-1.5 ps-1">
              {slides.map((s, k) => (
                <button key={s.title} onClick={() => setI(k)} aria-label={s.title} className="grid place-items-center py-2">
                  <span className={`h-1.5 rounded-full transition-all ${k === i ? 'w-6 bg-accent' : 'w-1.5 bg-white/35'}`} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The trending items the hero did not take, as a rail. Same art, one size down. */
export function TrendingCard({ t, onPick }: { t: Trending; onPick: (t: Trending) => void }) {
  return (
    <button onClick={() => onPick(t)} className="group w-36 shrink-0 snap-start text-start lg:w-40">
      <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-glow">
        <Img src={sourceCover(undefined, t.cover)} alt={t.title} fallbackSrc={t.cover || undefined}
          className="h-full w-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.06]" />
        {t.score != null && (
          <span className="absolute end-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur">{t.score}%</span>
        )}
        <span aria-hidden className="absolute bottom-1.5 end-1.5 grid size-7 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110">
          <IcPlus width={15} height={15} />
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100">{t.title}</p>
    </button>
  );
}
