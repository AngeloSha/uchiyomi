'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Book, Page, Series } from '@/lib/types';
import { chapterLabel } from '@/lib/format';
import { listDownloads, downloadChapter, deleteDownload } from '@/lib/downloads';
import { applyCover, clearCover } from '@/lib/theme';
import { Img, Backdrop, Rail, SectionTitle } from '@/components/ui';
import { SeriesCard } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { IcChevronLeft, IcHeart, IcStar, IcPlay, IcDownload, IcCheck, IcTrash, IcSliders } from '@/components/icons';

function StarRating({ value, onSet }: { value: number | null; onSet: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={() => onSet(n)} className={n <= (value || 0) ? 'text-accent' : 'text-ink-600'}>
          <IcStar width={22} height={22} fill={n <= (value || 0) ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

function ChapterRow({ book, downloaded, onReader, onToggleDownload }: {
  book: Book;
  downloaded: boolean;
  onReader: () => void;
  onToggleDownload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const rp = book.readProgress;
  const state = rp?.completed ? 'read' : rp ? 'reading' : 'unread';

  return (
    <div className="flex items-center gap-3 border-b border-ink-800/70 py-3">
      <button onClick={onReader} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className={`h-2 w-2 shrink-0 rounded-full ${state === 'read' ? 'bg-ink-600' : state === 'reading' ? 'bg-accent' : 'bg-accent/40'}`} />
        <div className="min-w-0">
          <p className={`truncate text-sm ${state === 'read' ? 'text-fog-500' : 'text-fog-100'}`}>{chapterLabel(book)}</p>
          {state === 'reading' && rp && (
            <p className="text-[11px] text-accent">page {rp.page}/{book.media.pagesCount}</p>
          )}
        </div>
      </button>
      <button
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try { await onToggleDownload(); } catch {}
          setBusy(false);
        }}
        className={`grid h-9 w-9 place-items-center rounded-full border ${downloaded ? 'border-accent/40 text-accent' : 'border-ink-700 text-fog-500'}`}
        aria-label={downloaded ? 'Remove download' : 'Download'}
      >
        {busy ? <span className="text-[10px] font-semibold text-accent">…</span> : downloaded ? <IcCheck width={16} height={16} /> : <IcDownload width={16} height={16} />}
      </button>
    </div>
  );
}

function SeriesInner() {
  const id = useSearchParams().get('id') || '';
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [asc, setAsc] = useState(true);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [showSummary, setShowSummary] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const { data: series } = useQuery({ queryKey: ['series', id], queryFn: () => api<Series>(`/api/series/${id}`), enabled: !!id });
  const { data: books } = useQuery({
    queryKey: ['series-books', id],
    queryFn: () => api<Page<Book>>(`/api/series/${id}/books?size=1000&sort=metadata.numberSort,asc`),
    enabled: !!id,
  });
  const { data: similar } = useQuery({ queryKey: ['similar', id], queryFn: () => api<{ content: Series[] }>(`/api/series/${id}/similar`), enabled: !!id });

  const [fav, setFav] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  useEffect(() => {
    if (series?.yomi) { setFav(series.yomi.favorite); setRating(series.yomi.rating); }
  }, [series]);

  useEffect(() => {
    listDownloads().then((d) => setDownloaded(new Set(d.filter((c) => c.seriesId === id).map((c) => c.bookId))));
  }, [id]);

  // ambient cover-art theming
  useEffect(() => {
    applyCover(series?.color);
    return () => clearCover();
  }, [series?.color]);

  const chapters = useMemo(() => {
    const c = books?.content ?? [];
    return asc ? c : [...c].reverse();
  }, [books, asc]);

  const resumeBook = useMemo(() => {
    const c = books?.content ?? [];
    return c.find((b) => !b.readProgress?.completed) || c[0];
  }, [books]);

  const inProgress = books?.content.some((b) => b.readProgress && !b.readProgress.completed);

  const back = () => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push('/'));

  const toggleFav = async () => {
    const next = !fav;
    setFav(next);
    try {
      if (next) await api('/api/favorites', { json: { seriesId: id } });
      else await api(`/api/favorites/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['home'] });
    } catch { setFav(!next); }
  };

  const setStars = async (n: number) => {
    setRating(n);
    try { await api(`/api/ratings/${id}`, { method: 'PUT', json: { stars: n } }); } catch {}
  };

  const toggleDownload = async (bookId: string) => {
    if (downloaded.has(bookId)) {
      await deleteDownload(bookId);
      setDownloaded((s) => { const n = new Set(s); n.delete(bookId); return n; });
    } else {
      await downloadChapter(bookId);
      setDownloaded((s) => new Set(s).add(bookId));
    }
  };

  const downloadAll = async () => {
    if (downloadingAll || !books) return;
    const todo = books.content.filter((b) => !downloaded.has(b.id));
    if (!todo.length) { toast('Everything is already downloaded', 'success'); return; }
    setDownloadingAll(true);
    toast(`Downloading ${todo.length} chapters…`);
    let done = 0;
    for (const b of todo) {
      try {
        await downloadChapter(b.id);
        setDownloaded((s) => new Set(s).add(b.id));
        done++;
      } catch {
        toast('Stopped — device storage may be full', 'error');
        break;
      }
    }
    setDownloadingAll(false);
    if (done) toast(`Saved ${done} chapters offline`, 'success');
  };

  const meta = series?.metadata;
  const summary = meta?.summary || series?.booksMetadata?.summary;
  const title = meta?.title || series?.name || '…';

  // shared blocks (rendered once)
  const Actions = (
    <div className="mt-4 flex flex-col gap-2">
      <button onClick={() => resumeBook && router.push(`/reader/?book=${resumeBook.id}`)} className="btn-accent w-full">
        <IcPlay width={18} height={18} /> {inProgress ? 'Continue' : 'Start reading'}
      </button>
      <div className="flex gap-2">
        <button onClick={toggleFav} className={`flex flex-1 items-center justify-center gap-2 rounded-full border py-3 text-sm ${fav ? 'border-accent/50 bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>
          <IcHeart width={18} height={18} fill={fav ? 'currentColor' : 'none'} stroke={fav ? 'none' : 'currentColor'} /> {fav ? 'Saved' : 'Favorite'}
        </button>
        <button onClick={downloadAll} disabled={downloadingAll} className="flex flex-1 items-center justify-center gap-2 rounded-full border border-ink-700 py-3 text-sm text-fog-300 disabled:opacity-50">
          <IcDownload width={18} height={18} /> {downloadingAll ? 'Saving…' : 'Download all'}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <StarRating value={rating} onSet={setStars} />
        <span className="text-xs text-fog-500">{rating ? `${rating}/5` : 'Rate this'}</span>
      </div>
    </div>
  );

  const Meta = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-400 lg:text-sm">
      {meta?.status && <span className="capitalize">{meta.status.toLowerCase()}</span>}
      {series && <span>· {series.booksCount} chapters</span>}
      {(series?.booksUnreadCount ?? 0) > 0 && <span className="text-accent">· {series!.booksUnreadCount} unread</span>}
    </div>
  );

  const Genres = !!meta?.genres?.length && (
    <div className="flex flex-wrap gap-2">
      {meta.genres.slice(0, 8).map((g) => <span key={g} className="chip text-xs">{g}</span>)}
    </div>
  );

  const Summary = summary && (
    <p className={`max-w-3xl text-sm leading-relaxed text-fog-300 ${showSummary ? '' : 'line-clamp-3 lg:line-clamp-4'}`} onClick={() => setShowSummary((s) => !s)}>
      {summary}
    </p>
  );

  const Chapters = (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Chapters</h2>
        <button onClick={() => setAsc((a) => !a)} className="chip text-xs">
          <IcSliders width={14} height={14} /> {asc ? 'Oldest' : 'Newest'}
        </button>
      </div>
      <div className="lg:grid lg:gap-x-8 lg:[grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
        {chapters.map((b) => (
          <ChapterRow key={b.id} book={b} downloaded={downloaded.has(b.id)}
            onReader={() => router.push(`/reader/?book=${b.id}`)} onToggleDownload={() => toggleDownload(b.id)} />
        ))}
        {!books && Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton my-3 h-6 rounded" />)}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen-d">
      {/* sticky back bar */}
      <div className="safe-top sticky top-0 z-30 flex items-center gap-2 bg-gradient-to-b from-ink-950 to-transparent px-4 pb-3 lg:static lg:bg-none lg:px-0 lg:py-4">
        <button onClick={back} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-800/70 text-fog-100 backdrop-blur lg:bg-ink-850">
          <IcChevronLeft width={22} height={22} />
        </button>
        <span className="truncate text-sm text-fog-300 lg:text-base">{title}</span>
      </div>

      {/* banner — real art pulled from the internet (AniList), genre-banner fallback */}
      <div className="relative -mt-[58px] h-64 overflow-hidden lg:mt-0 lg:h-[22rem] lg:rounded-3xl">
        {series && <Backdrop seriesId={id} genres={series.metadata?.genres} className="absolute inset-0" />}
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/65 to-ink-950/30" />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(85% 95% at 22% 0%, rgb(var(--cover, 124 92 255) / 0.32), transparent 62%)' }} />
      </div>

      {/* content */}
      <div className="px-4 lg:grid lg:grid-cols-[260px_1fr] lg:gap-8 lg:px-0">
        {/* cover + actions */}
        <div className="-mt-20 lg:-mt-32 lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-end gap-4 lg:block">
            <div className="h-44 w-32 shrink-0 overflow-hidden rounded-2xl border border-ink-600 shadow-lift lg:h-auto lg:w-full">
              {series && <Img src={img.seriesThumb(id)} alt={series.name} className="aspect-[2/3] h-full w-full" />}
            </div>
            {/* title beside cover on mobile */}
            <div className="min-w-0 pb-1 lg:hidden">
              <h1 className="font-display text-2xl font-bold leading-tight text-white">{title}</h1>
              {Meta}
            </div>
          </div>
          {Actions}
        </div>

        {/* info + chapters */}
        <div className="mt-7 flex flex-col gap-4 lg:mt-2">
          <div className="hidden lg:block">
            <h1 className="font-display text-3xl font-bold leading-tight text-white">{title}</h1>
            <div className="mt-1">{Meta}</div>
          </div>
          {Genres}
          {Summary}
          {Chapters}
        </div>
      </div>

      {(similar?.content?.length ?? 0) > 0 && (
        <section className="mt-10">
          <SectionTitle>More like this</SectionTitle>
          <Rail>{similar!.content.map((s) => <SeriesCard key={s.id} series={s} />)}</Rail>
        </section>
      )}
    </div>
  );
}

export default function SeriesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <SeriesInner />
    </Suspense>
  );
}
