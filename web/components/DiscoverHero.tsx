'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CARD_W, Img, useWideViewport } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { IcChevronLeft, IcChevronRight, IcPlay, IcPlus, IcSparkle } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { useArtUnderChrome } from '@/lib/overArt';
import { useReduceEffects } from '@/lib/effects';
import { EASE } from '@/lib/motion';

export interface Trending {
  /** The AniList entry (sent since v0.56.0): what Discover's AniList rails key a card by (v0.61.0). */
  id?: number | null;
  title: string;
  cover: string | null;
  /** The same cover at its largest (v0.98.0): a phone's hero fills its width with it. Absent from an older server. */
  coverXL?: string | null;
  /** Wide AniList key art. Returned by /api/discover/trending since it shipped, and never once rendered. */
  banner?: string | null;
  description: string;
  genres: string[];
  score: number | null;
  chapters: number | null;
  status: string | null;
}

/** How long a slide shows before the next, while nothing holds it. */
const SLIDE_MS = 5000;

/**
 * Asking again while the server is still pulling a country it has never stored (v0.98.0, bff lib/trending.ts): `pending`
 * in the answer. Every five seconds, a dozen times at most -- AniList slow today must not turn an open tab into a poll.
 */
export const HERO_POLL_MS = 5000;
export const HERO_POLL_MAX = 12;
export function heroPoll(data: { pending?: boolean } | undefined, updates: number): number | false {
  return data?.pending && updates < HERO_POLL_MAX ? HERO_POLL_MS : false;
}

/**
 * A slide's art, as the hero shows it AND as it warms the next slide: one address for both (v0.98.0). The preload asked for
 * the 800-px copy while a phone showed the 1600-px one, so every slide was fetched twice and the warm copy never helped.
 *
 * On a phone the banner is the wrong picture: a 4.75:1 strip inside a 1.1:1 box shows about a quarter of it, reliably the
 * quarter with no face. So a narrow viewport takes the cover at its largest, cropped from the top; so does a wide one
 * without a banner, letterboxed against its own blur. AniList's covers are under 800 px wide, so 800 is every pixel.
 */
export function heroArt(t: Trending, wide: boolean): { src: string; fallback: string | undefined; letterboxed: boolean } {
  if (wide && t.banner) return { src: sourceCover(undefined, t.banner, 1600), fallback: t.banner, letterboxed: false };
  const cover = t.coverXL || t.cover;
  return { src: sourceCover(undefined, cover, 800), fallback: cover || undefined, letterboxed: wide };
}

/** The hero's box, shared with the stand-in that holds its place while trending loads: the page never jumps. */
const HERO_BOX = 'bleed under-topbar relative isolate h-[44vh] min-h-[300px] overflow-hidden lg:h-[60vh] lg:max-h-[665px] lg:min-h-[465px]';

/** The hero's round-cornered keys over art: glass, so they read on any picture (Home's). */
const HERO_KEY = 'h-10 w-10 place-items-center rounded-xl border border-white/15 bg-black/40 text-white backdrop-blur transition hover:bg-black/60 active:scale-95';

/**
 * The small tag over Discover's art: the hero's "Trending now", and since v0.99.0 the For you band's "For you"
 * (components/ForYouBand.tsx) -- one look for both.
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="mb-2.5 inline-flex w-fit items-center gap-1.5 rounded-md bg-black/45 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-accent backdrop-blur rtl:tracking-normal">
      <IcSparkle width={12} height={12} />{children}
    </span>
  );
}

/** The scrims over the art: light, matching Home's -- the art is the point, and the type carries its own shadow. */
function Scrims() {
  return (
    <>
      <span aria-hidden className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/30 to-transparent" />
      <span aria-hidden className="scrim-soft absolute inset-0" />
      <span aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(60% 70% at var(--start) 70%, rgb(var(--accent) / 0.14), transparent 70%)' }} />
      {/* Under the see-through top bar (UI refresh), as on Home: a short scrim keeps its search and keys legible. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 hidden h-32 bg-linear-to-b from-ink-950/70 to-transparent lg:block" />
    </>
  );
}

/**
 * The one cinematic surface on Discover, and it costs nothing to build.
 *
 * `/api/discover/trending` has always returned `banner`, `genres`, `score`, `chapters` and `status` for the globally
 * trending titles it has already filtered against this library. The page declared an interface without `banner` and
 * rendered the rest as a 144px thumbnail with a percentage badge. So the art for a proper hero was sitting in the payload
 * of a page whose complaint was that it is not cinematic.
 *
 * v0.98.0, the owner: it "takes a while to load on phone or does not load at all". While the answer is on its way
 * (`waiting`) the hero's own box stands in, so nothing below it jumps when it lands; the server answers from its stored
 * copy now, so that is a moment. And it moves as Home's does: the slides crossfade, a phone's cover drifts slowly closer,
 * and segments say where the slides are, with a Pause key (WCAG 2.2.2) -- still under Reduce effects or reduced motion.
 */
export function DiscoverHero({ slides, onPick, waiting = false }: { slides: Trending[]; onPick: (t: Trending) => void; waiting?: boolean }) {
  const wide = useWideViewport();
  const [i, setI] = useState(0);
  // Held while the pointer is over the hero; `held` is the Pause key's.
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const stopped = paused || held;
  // Both hooks on every render and in this order (effects.test.ts).
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const startX = useRef(0);
  const n = slides.length;
  // Its art starts at the top of the window: the desktop top bar is see-through over it (lib/overArt.ts) -- over the
  // stand-in too, which is the same box.
  useArtUnderChrome(n > 0 || waiting);

  useEffect(() => { if (i >= n && n > 0) setI(0); }, [n, i]);
  // 5s, not 7s. With ten slides a seven-second beat is a seventy-second loop, so the back half was seen by essentially
  // nobody; fifty seconds gives every slide a realistic chance while still leaving time to read a title and decide.
  useEffect(() => {
    if (stopped || n < 2) return;
    const t = setTimeout(() => setI((v) => (v + 1) % n), SLIDE_MS);
    return () => clearTimeout(t);
  }, [i, stopped, n]);

  // Warm the next slide's art -- the very address the hero will show (heroArt), so the crossfade never waits on the
  // network. One Image per change, discarded immediately.
  useEffect(() => {
    if (n < 2) return;
    const next = slides[(i + 1) % n];
    const { src } = heroArt(next, wide);
    if (!src) return;
    const im = new Image();
    im.src = src;
  }, [i, slides, n, wide]);

  if (!n) {
    if (!waiting) return null;
    // The stand-in: the hero's box, its scrims and bloom, the eyebrow, and where the title and key will be.
    return (
      <div className={HERO_BOX} data-hero-waiting aria-hidden>
        <div className="skeleton absolute inset-0" />
        <Scrims />
        <div className="bleed-pad relative z-10 flex h-full flex-col justify-end pb-5 lg:pb-10">
          <Eyebrow>{tr('Trending now')}</Eyebrow>
          <span className="block h-7 w-3/4 max-w-md rounded-md bg-white/10 lg:h-12" />
          <span className="mt-2.5 block h-3 w-40 rounded bg-white/10" />
          <span className="mt-4 block h-11 w-40 rounded-xl bg-white/10 lg:h-12" />
        </div>
      </div>
    );
  }
  const cur = slides[Math.min(i, n - 1)];
  const art = heroArt(cur, wide);
  const go = (d: number) => setI((v) => (v + d + n) % n);

  return (
    <div
      className={HERO_BOX}
      data-discover-hero
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => { startX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - startX.current;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
    >
      {/* The slides crossfade, the new one settling from a touch closer (Home's hero); only fading under Reduce effects or
          reduced motion. A phone's cover drifts slowly closer and back (.hero-drift, CSS: framer keyframes never ran on a
          page loaded directly, see PhoneHeroCover), and is simply there under either setting. */}
      <AnimatePresence>
        <motion.div key={cur.title} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }} transition={{ duration: 0.9, ease: EASE }} className="absolute inset-0">
          {/* A 2:3 cover in a 16:6 box would be pillarboxed against flat black, so its own blur fills the sides. */}
          {art.letterboxed && (
            <Img src={art.src} alt="" fallbackSrc={art.fallback}
              className="absolute inset-0 h-full w-full scale-125 opacity-50 blur-2xl" />
          )}
          <div className={`absolute inset-0 ${!wide && !reduced ? 'hero-drift' : ''}`} data-hero-art>
            <Img
              src={art.src} alt={cur.title} fallbackSrc={art.fallback} eager
              className={`absolute inset-0 h-full w-full ${art.letterboxed ? 'mx-auto max-w-2xl' : ''}`}
              imgClassName={wide && cur.banner ? 'object-center' : 'object-top'}
            />
          </div>
        </motion.div>
      </AnimatePresence>

      <Scrims />

      <div className="bleed-pad relative z-10 flex h-full flex-col justify-end pb-5 lg:pb-10">
        <Eyebrow>{tr('Trending now')}</Eyebrow>
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
        <div className="mt-4">
          <button onClick={() => onPick(cur)} className="btn-accent px-6 py-3 text-sm lg:px-7 lg:py-3.5 lg:text-base">
            <IcPlus width={17} height={17} />{tr('Find and add')}
          </button>
        </div>
        {/* Where the slides are: one segment each, the current one filling while it shows -- still under Reduce effects or
            reduced motion, and while held (Home's). Each is its slide's button, named by its title. */}
        {n > 1 && (
          <div className="mt-4 flex items-center gap-1.5 lg:mt-5" data-hero-slides>
            {slides.map((s, k) => (
              <button key={s.title} type="button" aria-label={s.title} aria-current={k === i || undefined} onClick={() => setI(k)}
                className="group grid h-5 place-items-center">
                <span className={`relative h-1 overflow-hidden rounded-[2px] transition-[width,background-color] duration-300 ${k === i ? 'w-10 bg-white/25' : 'w-5 bg-white/25 group-hover:bg-white/45'}`}>
                  {k === i && (
                    <span key={`${i}:${stopped}`} aria-hidden className="absolute inset-0 origin-left bg-accent rtl:origin-right"
                      style={reduced || stopped ? undefined : { animation: `hero-progress ${SLIDE_MS}ms linear forwards` }} />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hold, and step: the Pause key on every screen (a phone swipes between slides); the arrows from lg up, together at
          the bottom end, clear of the text. */}
      {n > 1 && (
        <div className="absolute bottom-5 end-4 z-10 flex items-center gap-2 lg:bottom-10 lg:end-8">
          <button type="button" onClick={() => go(-1)} aria-label={tr('Previous')} className={`hidden lg:grid ${HERO_KEY}`}><IcChevronLeft width={18} height={18} className="rtl:-scale-x-100" /></button>
          <button type="button" onClick={() => setHeld((v) => !v)} aria-label={held ? tr('Resume') : tr('Pause')} aria-pressed={held} className={`grid ${HERO_KEY}`}>
            {held ? <IcPlay width={15} height={15} /> : <span aria-hidden className="flex gap-[3px]"><span className="h-3.5 w-[3px] rounded-[1px] bg-current" /><span className="h-3.5 w-[3px] rounded-[1px] bg-current" /></span>}
          </button>
          <button type="button" onClick={() => go(1)} aria-label={tr('Next')} className={`hidden lg:grid ${HERO_KEY}`}><IcChevronRight width={18} height={18} className="rtl:-scale-x-100" /></button>
        </div>
      )}
    </div>
  );
}

/** A card's own reason to be in its row (v0.98.0): the service that suggested it, and the read it came from. */
export interface CardWhy {
  /** The corner badge: the service that suggested it ("AniList · MAL"). */
  badge?: string;
  /** "Because you read {title}", already worded. */
  reason?: string;
  /** The read series' own cover, beside the reason: which of your series this came from, at a glance. */
  art?: string;
  /** The tooltip: every service and seed behind it. */
  tip?: string;
}
/** What a card draws: a trending title, or a pick for you. */
export interface CardItem { id?: number | null; title: string; cover: string | null; score: number | null }

/**
 * A title to add, in any of Discover's rows: its cover, score and + key, and -- in the picks row -- why it is there; in a
 * trending row its first ten wear their rank as Home's Top 10 does (v0.98.0). Widths as Home's cards: they grow with the
 * screen.
 */
export function TrendingCard<T extends CardItem>({ t, onPick, rank, why }: { t: T; onPick: (t: T) => void; rank?: number; why?: CardWhy }) {
  const card = (
    <span className={`block ${CARD_W}`}>
      <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-glow">
        <Img src={sourceCover(undefined, t.cover)} alt={t.title} fallbackSrc={t.cover || undefined}
          className="h-full w-full" imgClassName="transition-transform duration-500 group-hover:scale-[1.06]" />
        {why?.badge && (
          <span className="absolute start-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-fog-100 backdrop-blur">{why.badge}</span>
        )}
        {t.score != null && (
          <span className="absolute end-1.5 top-1.5 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-accent backdrop-blur">{t.score}%</span>
        )}
        <span aria-hidden className="absolute bottom-1.5 end-1.5 grid size-7 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110">
          <IcPlus width={15} height={15} />
        </span>
      </div>
      {/* Two lines' room under a ranked cover, always: the numeral beside it sits on the cover's foot, not the title's. */}
      <p className={`mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100 ${rank ? 'min-h-[2lh]' : ''}`} dir="auto">{t.title}</p>
      {why?.reason && (
        // Two lines: on a phone's card one line held "Because you read…" and none of the title it was about.
        <span className="mt-1 flex items-start gap-1.5 text-[11px] leading-tight text-fog-500" data-pick-why>
          {why.art && <Img src={why.art} alt="" className="size-4 shrink-0 rounded-full ring-1 ring-ink-700" />}
          <span className="line-clamp-2" dir="auto">{why.reason}</span>
        </span>
      )}
    </span>
  );
  return (
    <button type="button" onClick={() => onPick(t)} title={why?.tip} className="group shrink-0 snap-start text-start">
      {rank ? (
        <span className="flex items-end">
          <span aria-hidden className="rank-numeral -me-5 mb-9 select-none font-display text-[88px] font-black leading-[0.78]">{rank}</span>
          {card}
        </span>
      ) : card}
    </button>
  );
}
