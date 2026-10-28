'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { otherTitleLines, type OtherTitles as Titles } from '@/lib/otherTitles';

/**
 * The names of the series' AniList entry (English, romanised, Japanese) under the genres, above the summary. Renders
 * nothing while loading, when the series has no AniList link, or when every name is the title already shown.
 */
export function OtherTitles({ seriesId, shown }: { seriesId: string; shown: string }) {
  const q = useQuery({
    queryKey: ['other-titles', seriesId], enabled: !!seriesId, staleTime: 10 * 60_000, retry: false,
    queryFn: () => api<{ titles: Titles | null }>(`/api/series/${encodeURIComponent(seriesId)}/other-titles`),
  });
  const lines = otherTitleLines(q.data?.titles, shown);
  if (!lines.length) return null;
  const label = { english: tr('English'), romaji: tr('Romaji'), native: tr('Japanese') };
  return (
    <dl data-other-titles className="max-w-3xl space-y-0.5 text-sm text-fog-300">
      {lines.map((l) => (
        <div key={l.kind} className="flex gap-2">
          <dt className="w-16 shrink-0 text-fog-500">{label[l.kind]}</dt>
          <dd dir="auto" lang={l.kind === 'native' ? 'ja' : undefined} className="min-w-0 break-words">{l.name}</dd>
        </div>
      ))}
    </dl>
  );
}
