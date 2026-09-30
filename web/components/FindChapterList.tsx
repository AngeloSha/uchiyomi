'use client';
// What a candidate source lists, beside what the series has: the thing to look at before following it (bff GET
// /api/admin/sources/find/items/:id/chapters). Content only, so the review can put it in a Sheet and the search by
// hand can swap its body for it -- two Sheets stacked would share one Escape.
//
// A chapter the series does not have yet is marked "new": that is what the follow would bring. The numbers the series
// has and this source does not are listed on top, as ranges -- a source missing 1–40 of a 200-chapter series is
// another edition or a sequel, and that is exactly what the list is for spotting.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { chapterLabel, relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { findError } from '@/lib/useFindRun';
import { ranges, type FindChapters } from '@/lib/findSources';

export function FindChapterList({ itemId, source, sourceSeriesId }: { itemId: string; source: string; sourceSeriesId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['find-chapters', itemId, source, sourceSeriesId],
    queryFn: () => api<FindChapters>(
      `/api/admin/sources/find/items/${encodeURIComponent(itemId)}/chapters?source=${encodeURIComponent(source)}&sourceSeriesId=${encodeURIComponent(sourceSeriesId)}`),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  if (isLoading) {
    return <div className="space-y-1.5">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-7 rounded-lg" />)}</div>;
  }
  if (error || !data) return <p className="py-6 text-center text-sm text-fog-500">{findError(error, tr('Could not load the chapters'))}</p>;
  const fresh = data.count - data.shared;
  return (
    <div data-find-chapters>
      {data.title && <p dir="auto" className="mb-1 line-clamp-2 break-words text-sm text-fog-100">{data.title} <bdi className="text-fog-500">· {data.name}</bdi></p>}
      <p className="text-[11px] text-fog-400">
        {data.count === 1
          ? tr('1 chapter here · {shared} of this series’ {ours} · {fresh} new', { shared: data.shared, ours: data.ourCount, fresh })
          : tr('{n} chapters here · {shared} of this series’ {ours} · {fresh} new', { n: data.count, shared: data.shared, ours: data.ourCount, fresh })}
      </p>
      {data.missing.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-400" data-missing>{tr('Not on this source: {list}', { list: ranges(data.missing) })}</p>
      )}
      {data.count === 0 ? (
        <p className="py-6 text-center text-sm text-fog-500">{tr('This source lists no chapters for it.')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-ink-800/70">
          {data.chapters.map((c) => (
            <li key={c.number} className="flex items-center gap-2 py-1.5 text-xs">
              <span className={`w-16 shrink-0 tabular-nums ${c.ours ? 'text-fog-400' : 'text-fog-100'}`}>{chapterLabel({ number: c.number })}</span>
              <span dir="auto" className="min-w-0 flex-1 truncate text-fog-400">{[c.title, c.scanlator].filter(Boolean).join(' · ')}</span>
              {c.publishedAt && <span className="shrink-0 text-[10px] text-fog-600">{relativeTime(c.publishedAt)}</span>}
              {!c.ours && <span className="shrink-0 rounded-md bg-accent-soft px-1.5 text-[10px] font-semibold text-accent">{tr('new')}</span>}
            </li>
          ))}
        </ul>
      )}
      {data.chapters.length < data.count && (
        <p className="mt-2 text-center text-[11px] text-fog-600">{tr('Showing the first {n}.', { n: data.chapters.length })}</p>
      )}
    </div>
  );
}
