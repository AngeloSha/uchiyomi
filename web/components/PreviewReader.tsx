'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { msgOf } from '@/components/ConfirmDialog';
import { IcX } from '@/components/icons';
import { chapterLabel } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { inOrder, neighbours, previewCountUrl, previewListUrl, previewPageUrl, type PreviewChapter } from '@/lib/preview';

/**
 * Read a chapter straight from a source, without adding the series to the library (#91).
 *
 * @Squeaks72's idea and much of this layout; rebuilt because the first version let any account make the server
 * fetch an address it named (bff routes/sources.ts previewChapters). Whether a title is worth keeping is usually
 * one chapter's worth of question, and answering it by adding, reading and removing leaves a folder, a listing
 * and a row behind. Nothing here is written: the list and the pages come from the source on demand, and the
 * server fetches every page itself, by chapter number and page index.
 *
 * Deliberately NOT the real reader, which is built on a book id and carries progress, bookmarks, offline copies
 * and the next-chapter chain -- none of which exist for something not in the library.
 *
 * ⚠️ PORTALLED TO <body>. It opens from the add dialog, whose panel has a `backdrop-filter`, and a filter makes
 * an element the containing block for its `fixed` descendants: rendered in place, the "full-screen" viewer was a
 * page squeezed into the dialog's width. And ⚠️ Escape is caught in the CAPTURE phase and stopped: the dialog
 * underneath closes on any Escape that reaches the document, so the first Escape here used to throw away the add
 * dialog as well. Here it goes back one step -- pages to the list, the list to the dialog.
 */
export function PreviewReader({ source, sourceName, sourceId, title, onClose, onAdd, canAdd }: {
  source: string;
  sourceName: string;
  /** The series' id ON THE SOURCE, as search returned it: nothing here has a library id. */
  sourceId: string;
  title: string;
  onClose: () => void;
  /** The add dialog's own Add, so a decision made here goes through the same checks. */
  onAdd?: () => void;
  /** Whether that Add may be pressed now (the dialog's own `disabled` rule). */
  canAdd?: boolean;
}) {
  const [number, setNumber] = useState<number | null>(null);
  const numberRef = useRef(number);
  numberRef.current = number;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (numberRef.current !== null) setNumber(null);
      else closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const list = useQuery({
    queryKey: ['preview', source, sourceId],
    queryFn: () => api<{ title: string; content: PreviewChapter[] }>(previewListUrl(source, sourceId)),
    staleTime: 5 * 60_000,
    // A refusal (an age limit, a switched-off source) is an answer, not a hiccup to try three more times.
    retry: false,
  });
  const chapters = useMemo(() => inOrder(list.data?.content ?? []), [list.data]);

  const body = number === null ? (
    <>
      <p className="mb-3 text-xs text-fog-500">
        {tr('Reading from {source}. Nothing is added to your library and no progress is kept.', { source: sourceName })}
      </p>
      {list.isPending && <p className="py-8 text-center text-sm text-fog-500">{tr('Loading…')}</p>}
      {list.isError && <p className="py-8 text-center text-sm text-rose-400">{msgOf(list.error, tr('That source would not answer.'))}</p>}
      {list.isSuccess && chapters.length === 0 && <p className="py-8 text-center text-sm text-fog-500">{tr('No chapters listed.')}</p>}
      <div className="space-y-1">
        {chapters.map((c) => (
          <button key={c.number} type="button" onClick={() => setNumber(c.number)}
            className="flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-start text-sm text-fog-200 hover:bg-ink-800">
            <span className="shrink-0 tabular-nums">{chapterLabel({ number: c.number })}</span>
            {c.title && <span className="truncate text-fog-500">{c.title}</span>}
            {c.scanlator && <span className="ms-auto shrink-0 text-[11px] text-fog-600">{c.scanlator}</span>}
          </button>
        ))}
      </div>
    </>
  ) : (
    <PreviewPages source={source} sourceId={sourceId} number={number} {...neighbours(chapters, number)} onPick={setNumber} />
  );

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={`${tr('Preview')}: ${title}`}>
      <div className="flex items-center gap-3 border-b border-ink-800 bg-black/85 px-4 py-2">
        {number !== null && (
          <button type="button" onClick={() => setNumber(null)} className="text-sm text-fog-400 hover:text-fog-100">{tr('Chapters')}</button>
        )}
        <span className="truncate text-sm text-fog-200">
          {title}{number !== null ? ` · ${chapterLabel({ number })}` : ''}
        </span>
        <span className="ms-auto shrink-0 text-[11px] text-fog-600">{tr('Preview')}</span>
        <button type="button" onClick={onClose} aria-label={tr('Close')} className="shrink-0 text-fog-400 hover:text-fog-100">
          <IcX width={18} height={18} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-3 lg:px-4">
        <div className="mx-auto max-w-3xl">{body}</div>
      </div>
      {onAdd && (
        <div className="border-t border-ink-800 bg-black/85 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={onAdd} disabled={canAdd === false}
            className="btn-accent mx-auto block w-full max-w-md py-2.5 text-sm disabled:opacity-50">{tr('Add to library')}</button>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The pages: one continuous scroll, the only layout right for both a webtoon and a paged chapter when there is
 * no per-series reader memory to consult. Each image reserves most of a screen until it has loaded, so the
 * scroll position does not jump as pages arrive, and a page that fails says which one it was.
 */
function PreviewPages({ source, sourceId, number, prev, next, onPick }: {
  source: string; sourceId: string; number: number; prev?: number; next?: number; onPick: (n: number) => void;
}) {
  const count = useQuery({
    queryKey: ['preview-count', source, sourceId, number],
    queryFn: () => api<{ count: number }>(previewCountUrl(source, sourceId, number)),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const top = useRef<HTMLDivElement>(null);
  // Back to the top on every chapter change: continuing a scroll into another chapter reads as a jump.
  useEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [number]);

  return (
    <div ref={top}>
      {count.isPending && <p className="py-16 text-center text-sm text-fog-500">{tr('Loading…')}</p>}
      {count.isError && <p className="py-16 text-center text-sm text-rose-400">{msgOf(count.error, tr('That chapter would not load.'))}</p>}
      {Array.from({ length: count.data?.count ?? 0 }, (_, i) => (
        <PreviewPage key={`${number}:${i}`} src={previewPageUrl(source, sourceId, number, i)} index={i} />
      ))}
      <div className="flex gap-2 px-2 py-6">
        <button type="button" disabled={prev === undefined} onClick={() => prev !== undefined && onPick(prev)}
          className="flex-1 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300 disabled:opacity-40">{tr('Previous chapter')}</button>
        <button type="button" disabled={next === undefined} onClick={() => next !== undefined && onPick(next)}
          className="flex-1 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300 disabled:opacity-40">{tr('Next chapter')}</button>
      </div>
    </div>
  );
}

function PreviewPage({ src, index }: { src: string; index: number }) {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  if (state === 'failed') {
    return <p className="py-10 text-center text-xs text-fog-500">{tr('Page {n} could not be loaded.', { n: index + 1 })}</p>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" decoding="async" onLoad={() => setState('ok')} onError={() => setState('failed')}
      className={`block w-full ${state === 'loading' ? 'min-h-[60vh] bg-ink-900/40' : ''}`} />
  );
}
