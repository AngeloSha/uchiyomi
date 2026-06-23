'use client';
import { genreArt, genreGradient } from '@/lib/art';

export function GenreTile({ genre, active, onClick }: { genre: string; active?: boolean; onClick: () => void }) {
  const art = genreArt(genre);
  return (
    <button
      onClick={onClick}
      className={`group relative aspect-[3/2] overflow-hidden rounded-2xl border text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-glow ${active ? 'border-accent shadow-glow' : 'border-ink-700/60'}`}
      style={art ? undefined : { background: genreGradient(genre) }}
    >
      {art && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={art} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <span className="absolute inset-x-0 bottom-0 p-3 font-display text-sm font-semibold capitalize text-white drop-shadow">{genre}</span>
    </button>
  );
}
