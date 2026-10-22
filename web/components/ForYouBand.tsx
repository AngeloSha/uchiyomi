'use client';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Img, Reveal } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { ScrollRail } from '@/components/ScrollRail';
import { Eyebrow, TrendingCard, type CardWhy } from '@/components/DiscoverHero';
import { IcPlus } from '@/components/icons';
import { img } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { useReduceEffects } from '@/lib/effects';
import { EASE } from '@/lib/motion';
import { seedsOf, type Pick } from '@/lib/forYou';

/** How long a pointer rests on a card before the glow takes its art: a sweep across the row lights nothing on the way. */
const LIGHT_MS = 120;
/** A pick's key in the band: its AniList entry, else its title (one card a title, lib/forYou.ts). */
const keyOf = (p: Pick): string => (p.id != null ? `al:${p.id}` : `t:${p.title}`);

/**
 * Discover's picks for you, in their own band (v0.99.0). The owner, of v0.98.0's row of covers inside the wall: the picks
 * "are hiding inside, barely noticeable". So the band breaks the wall's rhythm: edge to edge, the top pick's art glowing
 * behind it (on a computer, the art of whichever card the pointer rests on), the hero's tag, the covers of the series the
 * picks came from, the top pick as a big card that says why it is there, and the rest in a row to swipe.
 *
 * The glow is still -- a big blurred layer that moved would be re-blurred every frame on a phone -- and only its crossfade
 * steps aside under Reduce effects or reduced motion; the look stays.
 */
export function ForYouBand({ picks, whyOf, onPick }: { picks: Pick[]; whyOf: (pk: Pick) => CardWhy; onPick: (pk: Pick) => void }) {
  // Both hooks on every render and in this order (effects.test.ts).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const [litKey, setLitKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!picks.length) return null;

  const [top, ...rest] = picks;
  const shown = (litKey && picks.find((p) => keyOf(p) === litKey)) || top;
  const glow = sourceCover(undefined, shown.cover);
  const seeds = seedsOf(picks);
  // null: back to the top pick.
  const light = (key: string | null) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLitKey(key), LIGHT_MS);
  };

  return (
    <section data-anilist-rail="foryou" data-foryou-band
      className="bleed relative isolate my-4 overflow-hidden pb-8 pt-10 lg:my-6 lg:pb-10 lg:pt-14"
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') light(null); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) light(null); }}>
      {/* The glow: the lit pick's cover -- the very address its card shows, so nothing new is fetched -- blurred across the
          band at full strength through its middle and faded into the page at both edges (a mask: a dark gradient over
          the whole band left it a black band with a tint), under a light dim for the type and the hero's accent bloom. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,transparent,#000_22%,#000_78%,transparent)]">
        {/* A plain img, not Img: Img's loading shimmer and its broken-image tile would be blurred across the whole band
            (a big animated layer on a phone, a grey wash for a pick with no cover). A pick with no cover lights nothing,
            and a cover that fails to load simply is not there. */}
        <AnimatePresence initial={false}>
          {glow ? (
            <motion.div key={glow} className="absolute inset-0" data-foryou-glow
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.6, ease: EASE }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={glow} alt="" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                className="absolute inset-0 h-full w-full scale-125 object-cover opacity-75 blur-3xl saturate-150" />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <span className="absolute inset-0 bg-ink-950/35" />
        <span className="absolute inset-0"
          style={{ background: 'radial-gradient(60% 80% at var(--start) 35%, rgb(var(--accent) / 0.18), transparent 70%)' }} />
      </div>

      <div className="bleed-pad">
        <Eyebrow>{tr('For you')}</Eyebrow>
        <h2 className="font-display text-2xl font-bold tracking-tight text-white [text-shadow:0_2px_16px_rgba(0,0,0,0.65)] lg:text-4xl">
          {tr('Recommended for you')}
        </h2>
        {seeds.length > 0 && (
          <p className="mt-2.5 flex items-center gap-2.5 text-sm text-fog-300" data-foryou-seeds>
            <span className="flex -space-x-2">
              {seeds.map((s) => (
                <span key={s.seriesId} title={s.title} className="block size-7 rounded-full ring-2 ring-ink-950">
                  <Img src={img.seriesThumb(s.seriesId)} alt="" className="size-7 rounded-full" />
                </span>
              ))}
            </span>
            {tr('Because you read…')}
          </p>
        )}
      </div>

      {/* A phone: the top pick across the width, the row under it edge to edge. A computer: the top pick on the content
          edge, the row beside it running to the window's. */}
      <div className="bleed-pad mt-5 lg:mt-7 lg:flex lg:items-start lg:gap-6 lg:pe-0">
        <PickSpotlight pk={top} why={whyOf(top)} onPick={onPick} />
        {rest.length > 0 && (
          <div className="-mx-4 mt-4 lg:mx-0 lg:mt-0 lg:min-w-0 lg:flex-1">
            <ScrollRail label={tr('Recommended for you')}
              className="flex gap-3 px-4 pb-3 pt-2 scroll-px-4 [scroll-snap-type:x_mandatory] lg:ps-0 lg:pe-8 lg:scroll-ps-0 lg:scroll-pe-8">
              {rest.map((pk, i) => (
                <div key={keyOf(pk)} onPointerEnter={(e) => { if (e.pointerType === 'mouse') light(keyOf(pk)); }}
                  onFocus={() => light(keyOf(pk))}>
                  <Reveal delay={Math.min(i, 12) * 28}>
                    <TrendingCard t={pk} onPick={onPick} why={whyOf(pk)} />
                  </Reveal>
                </div>
              ))}
            </ScrollRail>
          </div>
        )}
      </div>
    </section>
  );
}

/** The top pick, big: its cover, its name, why it is here, and the key that finds it on your sources. */
function PickSpotlight({ pk, why, onPick }: { pk: Pick; why: CardWhy; onPick: (pk: Pick) => void }) {
  return (
    <button type="button" onClick={() => onPick(pk)} title={why.tip} data-foryou-spotlight
      className="group flex w-full items-center gap-4 rounded-3xl border border-white/10 bg-ink-950/45 p-3 text-start backdrop-blur-md transition hover:border-white/20 sm:max-w-[34rem] lg:w-[28rem] lg:shrink-0 lg:gap-5 lg:p-4">
      {/* 128 px on a 360-px phone, whose text column then still holds "Find and add" on one line, growing to 144 px from
          384: one fluid width, not a min-[…] step, which the named breakpoints would override (library.test.ts). */}
      <span className="grad-border relative aspect-[2/3] w-[clamp(8rem,calc(100vw_-_15rem),9rem)] shrink-0 overflow-hidden rounded-2xl border border-ink-700/60 shadow-glow sm:w-40 lg:w-44">
        <Img src={sourceCover(undefined, pk.cover)} alt={pk.title} fallbackSrc={pk.cover || undefined}
          className="h-full w-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.05]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-3 font-display text-xl font-bold leading-tight text-white lg:text-2xl" dir="auto">{pk.title}</span>
        {(pk.score != null || why.badge) && (
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-300">
            {pk.score != null && <span className="font-semibold text-accent">{pk.score}%</span>}
            {why.badge && <span className="rounded-md bg-ink-950/70 px-1.5 py-0.5 text-[10px] font-semibold text-fog-100">{why.badge}</span>}
          </span>
        )}
        {why.reason && (
          <span className="mt-2.5 flex items-start gap-2 text-xs leading-snug text-fog-300 lg:text-sm" data-pick-why>
            {why.art && <Img src={why.art} alt="" className="size-5 shrink-0 rounded-full ring-1 ring-ink-700" />}
            <span className="line-clamp-2" dir="auto">{why.reason}</span>
          </span>
        )}
        <span className="btn-accent mt-4 w-fit px-4 py-2.5 text-sm">
          <IcPlus width={16} height={16} />{tr('Find and add')}
        </span>
      </span>
    </button>
  );
}
