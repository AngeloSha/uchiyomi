'use client';
import Link from 'next/link';
import { img } from '@/lib/api';
import { Book, Series } from '@/lib/types';
import { chapterLabel, progressOf } from '@/lib/format';
import { Img, ProgressBar } from './ui';
import { IcHeart, IcPlay } from './icons';

/** Portrait series cover -> series detail. */
export function SeriesCard({ series, w = 'w-32' }: { series: Series; w?: string }) {
  const unread = series.booksUnreadCount ?? 0;
  return (
    <Link href={`/series/?id=${series.id}`} className={`group shrink-0 ${w} [scroll-snap-align:start]`}>
      <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 shadow-lift transition-all duration-300 group-hover:-translate-y-1.5 group-hover:shadow-glow group-active:scale-[0.97]">
        <Img src={img.seriesThumb(series.id)} alt={series.metadata?.title || series.name} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.07]" />
        {series.yomi?.favorite && (
          <span className="absolute left-2 top-2 z-10 rounded-full bg-black/55 p-1.5 text-accent backdrop-blur">
            <IcHeart width={14} height={14} fill="currentColor" stroke="none" />
          </span>
        )}
        {unread > 0 && (
          <span className="absolute right-2 top-2 z-10 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-black shadow-glow">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className="absolute bottom-2 left-2 z-10 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold tracking-wide text-black shadow-glow">NEW</span>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/85 to-transparent" />
      </div>
      <p className="mt-2 line-clamp-2 px-0.5 text-[13px] font-medium leading-tight text-fog-200 transition group-hover:text-fog-50">
        {series.metadata?.title || series.name}
      </p>
    </Link>
  );
}

/** Wide "continue reading" card for an on-deck book. */
export function ContinueCard({ book }: { book: Book }) {
  const pct = progressOf(book);
  return (
    <Link
      href={`/reader/?book=${book.id}`}
      className="group relative h-44 w-72 shrink-0 overflow-hidden rounded-3xl border border-ink-700/60 shadow-lift transition-all duration-300 hover:-translate-y-1 hover:shadow-glow [scroll-snap-align:start]"
    >
      <Img src={img.bookThumb(book.id)} alt={book.seriesTitle} className="absolute inset-0 h-full w-full transition-transform duration-500 group-hover:scale-105" />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/45 to-black/10" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="line-clamp-1 font-display text-base font-semibold text-white">{book.seriesTitle}</p>
        <p className="mb-2 text-xs text-fog-300">{chapterLabel(book)}</p>
        <ProgressBar value={pct || 0.02} />
      </div>
      <span className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-accent text-black shadow-glow transition group-hover:scale-110 group-active:scale-90">
        <IcPlay width={18} height={18} />
      </span>
    </Link>
  );
}

/** Grid tile (library / search). */
export function SeriesTile({ series }: { series: Series }) {
  const unread = series.booksUnreadCount ?? 0;
  return (
    <Link href={`/series/?id=${series.id}`} className="group">
      <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-glow group-active:scale-[0.97]">
        <Img src={img.seriesThumb(series.id)} alt={series.metadata?.title || series.name} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.07]" />
        {series.yomi?.favorite && (
          <span className="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/55 p-1 text-accent backdrop-blur">
            <IcHeart width={12} height={12} fill="currentColor" stroke="none" />
          </span>
        )}
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-black">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {(series.yomi?.newCount ?? 0) > 0 && (
          <span className="absolute bottom-1.5 left-1.5 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold text-black">NEW</span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-300 transition group-hover:text-fog-100">
        {series.metadata?.title || series.name}
      </p>
    </Link>
  );
}
