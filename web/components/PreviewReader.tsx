'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { t as tr } from '@/lib/i18n';

/**
 * Read a chapter straight from a source, without adding the series to the library.
 *
 * The point is the decision before the decision: whether a title is worth keeping is usually one chapter's
 * worth of question, and answering it by adding the series, reading it, then removing it again leaves a
 * folder, a listing, a floor and a row behind -- and, before the downloader learned to check what it
 * already holds, a few gigabytes as well.
 *
 * So nothing here is written. The chapter list and the page URLs come from the source on demand, and the
 * pages themselves are rendered through `/img/sources/cover`, the proxy that already fetches a remote
 * image named by a source with that source's referer and Cloudflare session, behind the SSRF guard and
 * the `/img/` authorization hook.
 *
 * Deliberately NOT the real reader. That one is built on a book id and carries progress, bookmarks,
 * offline copies and the next-chapter chain, none of which exist for something not in the library, and
 * teaching it to run without them would put a null check on every one of those paths. This is a viewer:
 * pick a chapter, scroll it, move to the next.
 */
type Chapter = { chapterId: string; number: number; title: string | null; scanlator: string | null };

/**
 * A page through the source-image proxy. `w=1600` because the proxy whitelists its widths (400/800/1600) and
 * treats anything else as 400 -- a page rendered at cover-tile size is unreadable. `withoutEnlargement`
 * there means a narrower original is served as it is.
 */
const pageSrc = (source: string, url: string) =>
  `/img/sources/cover?u=${encodeURIComponent(url)}&source=${encodeURIComponent(source)}&w=1600`;

export function PreviewReader({ source, sourceName, sourceId, title, onClose, onAdd }: {
  source: string;
  sourceName: string;
  /** The series' id ON THE SOURCE, not a library id -- nothing here has a library id. */
  sourceId: string;
  title: string;
  onClose: () => void;
  /** Offered from inside the viewer, because deciding to keep it is the expected end of a preview. */
  onAdd?: () => void;
}) {
  const [picked, setPicked] = useState<Chapter | null>(null);

  const list = useQuery({
    queryKey: ['preview-chapters', source, sourceId],
    queryFn: () => api<{ title: string; content: Chapter[] }>(
      `/api/sources/preview/chapters?source=${encodeURIComponent(source)}&sourceId=${encodeURIComponent(sourceId)}`),
    staleTime: 5 * 60_000,
  });

  const chapters = useMemo(
    () => [...(list.data?.content ?? [])].sort((a, b) => a.number - b.number),
    [list.data],
  );

  if (picked) {
    const i = chapters.findIndex((c) => c.chapterId === picked.chapterId);
    return (
      <PreviewPages
        source={source} title={title} chapter={picked}
        prev={i > 0 ? chapters[i - 1] : undefined}
        next={i >= 0 && i < chapters.length - 1 ? chapters[i + 1] : undefined}
        onPick={setPicked}
        onClose={() => setPicked(null)}
      />
    );
  }

  return (
    <Modal title={title || tr('Preview')} onClose={onClose}>
      <p className="mb-3 text-xs text-fog-500">
        {tr('Reading from {source}. Nothing is added to your library and no progress is kept.', { source: sourceName })}
      </p>
      {list.isPending && <p className="py-8 text-center text-sm text-fog-500">{tr('Loading…')}</p>}
      {list.isError && (
        <p className="py-8 text-center text-sm text-rose-400">{msgOf(list.error, tr('That source would not answer.'))}</p>
      )}
      {!list.isPending && !list.isError && chapters.length === 0 && (
        <p className="py-8 text-center text-sm text-fog-500">{tr('No chapters listed.')}</p>
      )}
      <div className="max-h-[60vh] space-y-1 overflow-y-auto">
        {chapters.map((c) => (
          <button key={c.chapterId} onClick={() => setPicked(c)}
            className="flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-start text-sm text-fog-200 hover:bg-ink-800">
            <span className="shrink-0 tabular-nums">{tr('Ch. {n}', { n: c.number })}</span>
            {c.title && <span className="truncate text-fog-500">{c.title}</span>}
            {c.scanlator && <span className="ms-auto shrink-0 text-[11px] text-fog-600">{c.scanlator}</span>}
          </button>
        ))}
      </div>
      {onAdd && (
        <button onClick={onAdd} className="btn-accent mt-4 w-full py-2.5 text-sm">
          {tr('Add to library')}
        </button>
      )}
    </Modal>
  );
}

/**
 * The pages themselves: one continuous scroll, which is the only layout that is right for both a webtoon
 * and a paged chapter when there is no per-series reader memory to consult.
 *
 * Images are loaded lazily and decoded asynchronously so a 200-page chapter does not stall the first
 * paint, and each carries its own index for the caption a failed page leaves behind.
 */
function PreviewPages({ source, title, chapter, prev, next, onPick, onClose }: {
  source: string;
  title: string;
  chapter: Chapter;
  prev?: Chapter;
  next?: Chapter;
  onPick: (c: Chapter) => void;
  onClose: () => void;
}) {
  const pages = useQuery({
    queryKey: ['preview-pages', source, chapter.chapterId],
    queryFn: () => api<{ pages: string[] }>(
      `/api/sources/preview/pages?source=${encodeURIComponent(source)}&chapterId=${encodeURIComponent(chapter.chapterId)}`),
    staleTime: 5 * 60_000,
  });

  // Back to the top on every chapter change: continuing a scroll into a different chapter reads as the
  // page having jumped.
  useEffect(() => { window.scrollTo?.({ top: 0 }); }, [chapter.chapterId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-ink-800 bg-black/85 px-4 py-2 backdrop-blur">
        <button onClick={onClose} className="text-sm text-fog-400 hover:text-fog-100">{tr('Chapters')}</button>
        <span className="truncate text-sm text-fog-200">
          {title} · {tr('Ch. {n}', { n: chapter.number })}
        </span>
        <span className="ms-auto shrink-0 text-[11px] text-fog-600">{tr('Preview')}</span>
      </div>

      {pages.isPending && <p className="py-16 text-center text-sm text-fog-500">{tr('Loading…')}</p>}
      {pages.isError && (
        <p className="py-16 text-center text-sm text-rose-400">{msgOf(pages.error, tr('That chapter would not load.'))}</p>
      )}

      <div className="mx-auto max-w-3xl">
        {(pages.data?.pages ?? []).map((u, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${i}:${u}`} src={pageSrc(source, u)} alt="" loading="lazy" decoding="async"
            className="block w-full" />
        ))}
      </div>

      <div className="mx-auto flex max-w-3xl gap-2 px-4 py-6">
        <button disabled={!prev} onClick={() => prev && onPick(prev)}
          className="flex-1 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300 disabled:opacity-40">
          {tr('Previous')}
        </button>
        <button disabled={!next} onClick={() => next && onPick(next)}
          className="flex-1 rounded-full border border-ink-700 py-2.5 text-sm text-fog-300 disabled:opacity-40">
          {tr('Next')}
        </button>
      </div>
    </div>
  );
}
