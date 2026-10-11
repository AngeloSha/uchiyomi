'use client';
// The series page's ratings, said once (v0.60.0): AniList's tile and the reader's own, side by side.
//
// Before, AniList's "84% · 312K" and the reader's "★ 4/5" were each said up to three times on one page -- a chip over
// the banner, the meta line under the title, the line under the stars. The owner asked for once, and for it to look
// better. AniList's score is a big number over "/ 100" with a thin meter filled to it -- a bar, never a ring: a ring
// means work in progress everywhere else in this app -- and the whole tile opens the entry on AniList. The reader's
// stars are five real buttons; tapping the current one again takes the rating back.
//
// What decides (the tap, the request, the tile's numbers) is lib/ratings.ts, unit-tested in test/ratingsPanel.test.ts.
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { api } from '@/lib/api';
import { useReduceEffects } from '@/lib/effects';
import { t as tr } from '@/lib/i18n';
import { anilistTile, anilistTileName, nextRating, ratingRequest, readersText, type AniListTile } from '@/lib/ratings';
import type { AniListNumbers, Series } from '@/lib/types';
import { useToast } from './Toast';
import { IcStar, IcUsers } from './icons';
import { IcExternal } from './SeriesKeys';

/**
 * Rate the series, optimistically: the stars change at once, in the series' own cached payload (so a refetch shows the
 * same, and a visit back does not flash the old rating), then the request -- PUT with the stars, or DELETE when the tap
 * took the rating back. Taps go to the server one after the other, in the order they were made. A refusal puts back
 * what was there before that tap (unless a later tap has changed it since) and says so; until v0.60.0 a failed rating
 * was swallowed and the stars lied. The Library sorts by "My rating" and Home's cards can say it, so both refetch.
 */
export function useSeriesRating(seriesId: string): (tapped: number) => void {
  const qc = useQueryClient();
  const toast = useToast();
  const queue = useRef<Promise<void>>(Promise.resolve());
  const ticket = useRef(0);
  return useCallback((tapped: number) => {
    const key = ['series', seriesId];
    const before = qc.getQueryData<Series>(key)?.yomi?.rating ?? null;
    const next = nextRating(before, tapped);
    const put = (v: number | null) => qc.setQueryData<Series>(key, (s) => (s?.yomi ? { ...s, yomi: { ...s.yomi, rating: v } } : s));
    const mine = ++ticket.current;
    // A refetch already on its way would land the old rating over the new one.
    void qc.cancelQueries({ queryKey: key });
    put(next);
    const { path, init } = ratingRequest(seriesId, next);
    queue.current = queue.current.then(async () => {
      try {
        await api(path, init);
        for (const k of [['library'], ['home']]) qc.invalidateQueries({ queryKey: k });
      } catch {
        if (ticket.current === mine) put(before);
        toast(tr('Could not save your rating'), 'error');
      }
    });
  }, [qc, toast, seriesId]);
}

/** One tile's frame: glass, as the app's panels are, squared at 16 px. */
const TILE = 'glass flex min-w-0 rounded-2xl p-3';

/**
 * Both tiles, or the reader's alone when the series has no checked AniList link: then it takes the row, its words on one
 * side and the stars on the other, rather than half a grid beside an empty cell.
 */
export function RatingsPanel({ anilist, rating, onRate, className = '' }: {
  anilist: AniListNumbers | null | undefined;
  rating: number | null;
  onRate: (tapped: number) => void;
  className?: string;
}) {
  const tile = anilistTile(anilist);
  return (
    <div data-ratings-panel className={`grid gap-2 ${tile ? 'grid-cols-2' : 'grid-cols-1'} ${className}`}>
      {tile && <AniListTileView tile={tile} />}
      <RatingTile value={rating} onRate={onRate} alone={!tile} />
    </div>
  );
}

/**
 * AniList's word: the score large over "/ 100", the meter, and how many readers list it. A link to the entry when the
 * payload names it (v0.60.0's `id`), opened in a new tab. The score and "/ 100" are one left-to-right run, so in Arabic
 * they still read "84 / 100" and never "100 / 84"; the count is isolated as every AniList count is.
 */
function AniListTileView({ tile }: { tile: AniListTile }) {
  const name = anilistTileName(tile);
  const hint = tr('Average score on AniList, and how many people there have it on a list');
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium tracking-wide text-fog-400">AniList</span>
        {tile.url && <IcExternal size={14} className="shrink-0 text-fog-500 transition-colors group-hover:text-accent" />}
      </span>
      <span className="mt-1.5 block">
        <span dir="ltr" className="inline-flex items-baseline gap-1">
          <span className="font-display text-[1.75rem] font-bold leading-none tabular-nums text-fog-50">{tile.score ?? '–'}</span>
          <span className="text-xs font-medium text-fog-500">/ 100</span>
        </span>
      </span>
      <Meter value={tile.score} />
      {!!tile.popularity && (
        <span className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-fog-400">
          <IcUsers width={14} height={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">{readersText(tile.popularity)}</span>
        </span>
      )}
    </>
  );
  return tile.url ? (
    <a href={tile.url} target="_blank" rel="noopener noreferrer" aria-label={name} title={hint} data-anilist-tile
      className={`${TILE} group flex-col outline-none transition-shadow hover:ring-1 hover:ring-accent/40 focus-visible:ring-2 focus-visible:ring-accent/70`}>
      {body}
    </a>
  ) : (
    <div role="group" aria-label={name} title={hint} data-anilist-tile className={`${TILE} flex-col`}>{body}</div>
  );
}

/**
 * The meter: filled to the score from the start edge. It grows in once, unless Reduce effects or the system's reduced
 * motion asks for stillness; a transform, so the compositor runs it alone.
 */
function Meter({ value }: { value: number | null }) {
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  return (
    <span aria-hidden className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-ink-700/80">
      {value !== null && value > 0 && (
        <motion.span className="block h-full origin-left rounded-full bg-accent rtl:origin-right" style={{ width: `${value}%` }}
          initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }}
          transition={reduced ? { duration: 0 } : { duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }} />
      )}
    </span>
  );
}

/** The reader's own: "Your rating", the five stars, and what a tap does next. */
function RatingTile({ value, onRate, alone }: { value: number | null; onRate: (tapped: number) => void; alone: boolean }) {
  const id = useId();
  const caption = value ? tr('Tap again to clear') : tr('Rate this');
  return (
    <div data-your-rating={value ?? 0} className={`${TILE} ${alone ? 'flex-row items-center justify-between gap-3' : 'flex-col justify-between gap-1'}`}>
      <span className="min-w-0">
        <span id={id} className="block text-[11px] font-medium tracking-wide text-fog-400">{tr('Your rating')}</span>
        {alone && <span className="mt-1 block text-[11px] text-fog-500">{caption}</span>}
      </span>
      <StarRow value={value} onRate={onRate} size={alone ? 24 : 22} labelledBy={id} />
      {!alone && <span className="block text-[11px] text-fog-500">{caption}</span>}
    </div>
  );
}

const STARS = [1, 2, 3, 4, 5] as const;

/** Whether this focus came from the keyboard: a tap focuses a star too, and a tap is not a preview. */
const keyboardFocus = (el: HTMLElement): boolean => {
  try { return el.matches(':focus-visible'); } catch { return true; }
};

/**
 * Five buttons, each "Rate n of 5", pressed when it is the rating. Hovering with a mouse -- or moving through them with
 * the keyboard -- lights the stars up to that one, a little dimmer than the rating itself, so you see what a tap will
 * do before you make it. The arrow keys move between them in the reading direction, Home and End to the ends.
 */
function StarRow({ value, onRate, size, labelledBy }: { value: number | null; onRate: (tapped: number) => void; size: number; labelledBy: string }) {
  const [preview, setPreview] = useState<number | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const lit = preview ?? value ?? 0;
  const move = (e: KeyboardEvent<HTMLButtonElement>, n: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const by = e.key === 'ArrowRight' ? (rtl ? -1 : 1) : e.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    const to = e.key === 'Home' ? 1 : e.key === 'End' ? 5 : by ? Math.min(5, Math.max(1, n + by)) : 0;
    if (!to) return;
    e.preventDefault();
    refs.current[to - 1]?.focus();
  };
  return (
    <span role="group" aria-labelledby={labelledBy} className="-mx-1 flex shrink-0 items-center" onPointerLeave={() => setPreview(null)}>
      {STARS.map((n) => {
        const on = n <= lit;
        const tone = !on ? 'text-fog-600 hover:text-fog-400' : preview !== null && preview !== value ? 'text-accent/70' : 'text-accent';
        return (
          <button key={n} ref={(el) => { refs.current[n - 1] = el; }} type="button"
            aria-label={tr('Rate {n} of 5', { n })} aria-pressed={value === n}
            onClick={() => { setPreview(null); onRate(n); }}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setPreview(n); }}
            onFocus={(e) => { if (keyboardFocus(e.currentTarget)) setPreview(n); }}
            onBlur={() => setPreview(null)}
            onKeyDown={(e) => move(e, n)}
            className={`grid h-9 w-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${tone}`}>
            <IcStar width={size} height={size} fill={on ? 'currentColor' : 'none'} aria-hidden />
          </button>
        );
      })}
    </span>
  );
}
