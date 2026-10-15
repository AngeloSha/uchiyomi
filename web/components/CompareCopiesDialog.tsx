'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Modal } from '@/components/ConfirmDialog';
import { chapterLabel } from '@/lib/format';
import { copySourceId } from '@/lib/groupFilter';
import { t as tr } from '@/lib/i18n';
import type { Book, VersionCopy } from '@/lib/types';

const who = (c: VersionCopy) => c.groups.join(' & ') || c.scanlator || '';

/**
 * Two copies of one chapter, page by page, side by side: the file on this server against another source's copy of
 * the same number. The pages move together, so the same page of each is always in view; the copy on the right is
 * whichever the admin picks from the chips above, and "Replace with this copy" goes to the page's own confirm.
 * Nothing here changes anything.
 */
export function CompareCopiesDialog({ seriesId, book, copies, sourceNames, onReplace, onClose }: {
  seriesId: string;
  book: Book;
  /** Every copy of this number the listing knows; the one on disk is the left side, the rest are offered. */
  copies: VersionCopy[];
  sourceNames: Record<string, string>;
  onReplace: (copy: VersionCopy) => void;
  onClose: () => void;
}) {
  const others = copies.filter((c) => !c.onDisk && c.key !== '');
  const [sel, setSel] = useState(0);
  const [page, setPage] = useState(0);
  const copy = others[Math.min(sel, others.length - 1)];
  const localCount = book.media.pagesCount;
  const counts = useQuery({
    queryKey: ['copy-pages', seriesId, copy?.source, copy ? copySourceId(copy) : ''], enabled: !!copy, staleTime: 10 * 60_000, retry: false,
    queryFn: () => api<{ count: number }>(`/api/admin/series/${encodeURIComponent(seriesId)}/copy-pages?source=${encodeURIComponent(copy!.source)}&chapter=${encodeURIComponent(copySourceId(copy!))}`).then((r) => r.count),
  });
  const remoteCount = counts.data ?? copy?.pages ?? null;
  const last = Math.max(localCount, remoteCount ?? 0) - 1;
  useEffect(() => { setPage(0); }, [sel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setPage((p) => Math.min(last, p + 1));
      else if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [last]);

  const localName = (book.sourceId && sourceNames[book.sourceId]) || tr('on server');
  const remoteSrc = copy ? `/img/series/${encodeURIComponent(seriesId)}/copy-page?source=${encodeURIComponent(copy.source)}&chapter=${encodeURIComponent(copySourceId(copy))}&i=${page}` : '';
  const side = (label: string, sub: string, count: number | null, src: string | null, missing: boolean, failed: boolean) => (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-fog-100">{label}</span>
        <span className="shrink-0 text-fog-500">{count == null ? '' : count === 1 ? tr('1 page') : tr('{n} pages', { n: count })}</span>
      </div>
      <p className="mb-1.5 truncate text-[11px] text-fog-500">{sub || ' '}</p>
      <div className="grid h-[58dvh] place-items-center overflow-hidden rounded-xl border border-ink-700 bg-black/40">
        {missing
          ? <span className="px-3 text-center text-xs text-fog-500">{tr('No page {n}', { n: page + 1 })}</span>
          : failed
            ? <span className="px-3 text-center text-xs text-fog-500">{tr('Could not load this page')}</span>
            // eslint-disable-next-line @next/next/no-img-element
            : <img key={src!} src={src!} alt="" className="max-h-full max-w-full object-contain" />}
      </div>
    </div>
  );

  return (
    <Modal title={tr('Compare copies')} onClose={onClose} wide>
      <p className="-mt-1 mb-3 text-sm text-fog-400">{chapterLabel(book)}</p>
      {!copy ? <p className="text-sm text-fog-400">{tr('No other source has a copy of this chapter.')}</p> : (
        <>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={tr('Copy to compare')}>
            {others.map((c, i) => (
              <button key={c.key} type="button" onClick={() => setSel(i)} aria-pressed={i === sel} data-compare-copy
                className={i === sel ? 'chip chip-active text-xs' : 'chip text-xs'}>
                {[c.sourceName || c.source, who(c)].filter(Boolean).join(' · ')}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {side(localName, tr('on server'), localCount, page < localCount ? img.page(book.id, page + 1, 1200) : null, page >= localCount, false)}
            {side(copy.sourceName || copy.source, who(copy), remoteCount, page < (remoteCount ?? Infinity) ? remoteSrc : null, remoteCount != null && page >= remoteCount, counts.isError)}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button type="button" className="btn-key" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label={tr('Previous page')}>‹</button>
              <span className="min-w-20 text-center text-xs text-fog-300" data-compare-page>{tr('Page {n} of {total}', { n: page + 1, total: Math.max(1, last + 1) })}</span>
              <button type="button" className="btn-key" disabled={page >= last} onClick={() => setPage((p) => Math.min(last, p + 1))} aria-label={tr('Next page')}>›</button>
            </div>
            <button type="button" className="btn-key btn-key-primary" data-compare-replace onClick={() => onReplace(copy)}>{tr('Replace with this copy')}</button>
          </div>
          {remoteCount != null && remoteCount !== localCount && (
            <p className="mt-2 text-[11px] text-amber-300/90">{tr('The two copies have different page counts, so later pages will not line up.')}</p>
          )}
        </>
      )}
    </Modal>
  );
}
