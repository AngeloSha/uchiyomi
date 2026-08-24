'use client';
import Link from 'next/link';
import { img } from '@/lib/api';
import { GenreFacet } from '@/lib/genres';
import { Img, useWideViewport } from '@/components/ui';

/**
 * A genre, shown as a piece of the shelf it actually describes.
 *
 * The old tile painted each genre with one of SIX generated key-art files, mapped from a table of about
 * forty genre NAMES. A real library has ninety-nine genres, so the same night-market photograph appeared
 * under Comedy, Cooking, Historical, Music, School Life, Slice of Life and Sports; the same explosion under
 * Action, Adventure, Martial Arts and Superhero; and the fifty-six genres with no mapping at all -- Manhwa,
 * the second largest, among them -- fell through to a two-stop gradient at 16% and 7% lightness, which on a
 * true-black page is a rectangle you cannot see.
 *
 * Covers from your own library cannot repeat like that and cannot be wrong, because they ARE the thing
 * behind the label. `/api/genres/overview` returns them already ordered by size and recency, so the first
 * cell is the biggest, most recently updated series in the genre.
 *
 * Two sizes, and the difference between them is information: the six shelves you have most of are rendered
 * at roughly twice the area of the rest, which is the only thing on the page that tells you Fantasy holds
 * 175 and Cooking holds 4 before you click either.
 */
const MOSAIC: Record<number, string> = {
  0: 'hidden',
  1: '',                                  // one cover, full bleed
  2: 'grid grid-cols-2 gap-px',
  3: 'grid grid-cols-3 gap-px',
  4: 'grid grid-cols-2 grid-rows-2 gap-px',
};

export function GenreTile({ genre, size = 'md', eager }: {
  genre: GenreFacet;
  size?: 'lg' | 'md';
  eager?: boolean;
}) {
  // A phone cell is ~85px wide; four of them is mush, and it would be four thumbnail requests per tile
  // across a whole wall of them. The ids are already in the payload, so showing fewer costs nothing.
  const wide = useWideViewport();
  const ids = genre.covers.slice(0, wide ? 4 : 2);
  const n = Math.min(ids.length, 4);

  return (
    <Link
      href={`/browse/?genre=${encodeURIComponent(genre.label)}`}
      // Keeps the tiles below the fold off the paint path without giving up their box, so a wall of ninety
      // tiles neither janks on scroll nor reflows when the art lands.
      style={{ contentVisibility: 'auto', containIntrinsicSize: size === 'lg' ? '400px 225px' : '260px 173px' }}
      className={`group grad-border relative block overflow-hidden rounded-2xl border border-ink-700/60 text-start
                  transition-all duration-300 hover:-translate-y-1 hover:shadow-glow
                  ${size === 'lg' ? 'aspect-[4/3] lg:aspect-[16/9]' : 'aspect-[3/2]'}`}
    >
      {/* The ground. Derived from the live accent rather than from a hash of the genre name, so it
          re-themes with the rest of the app and can never be the invisible near-black rectangle again. */}
      <span aria-hidden className="absolute inset-0"
        style={{ background: 'linear-gradient(150deg, rgb(var(--accent) / 0.20), rgb(var(--accent) / 0.06) 55%, transparent)' }} />

      {/* One transform on the wrapper rather than four on the cells: a single composited layer per tile. */}
      {n > 0 && (
        <span aria-hidden className={`absolute inset-0 transition-transform duration-500 group-hover:scale-[1.06] ${MOSAIC[n]}`}>
          {ids.map((id, i) => (
            <Img key={id} src={img.seriesThumb(id)} alt="" eager={eager && i === 0}
              className="h-full w-full" imgClassName="object-top" />
          ))}
        </span>
      )}

      {/* The label has to stay readable over a cover we have never seen, so the plate under it is opaque
          black at the very bottom rather than a polite 45%. A cover is allowed to be bright; a label is not
          allowed to be illegible because of it. */}
      <span aria-hidden className="absolute inset-0"
        style={{ background: 'linear-gradient(to top, rgb(0 0 0 / 0.96) 0%, rgb(0 0 0 / 0.72) 22%, rgb(0 0 0 / 0.28) 52%, transparent 80%)' }} />
      {/* Accent light in the FAR corner from the label, anchored on --start so it swaps sides in Arabic.
          Putting it under the text, which is where it started, was adding light exactly where it hurt. */}
      <span aria-hidden className="absolute inset-0"
        style={{ background: 'radial-gradient(85% 110% at var(--start) 0%, rgb(var(--accent) / 0.26), transparent 60%)' }} />

      <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3 lg:p-4">
        <span className={`font-display font-semibold leading-tight text-white
                          [text-shadow:0_1px_10px_rgb(0_0_0/0.95)]
                          ${size === 'lg' ? 'text-base lg:text-2xl' : 'text-sm lg:text-base'}`}>
          {genre.label}
        </span>
        {/* Omitted rather than faked when the backend cannot count. */}
        {genre.series != null && (
          <span className={`shrink-0 tabular-nums ${size === 'lg'
            ? 'font-display text-lg font-bold text-white/85 lg:text-2xl'
            : 'rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-fog-100 backdrop-blur'}`}>
            {genre.series}
          </span>
        )}
      </span>
    </Link>
  );
}
