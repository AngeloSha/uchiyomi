'use client';
// "Properties…" on a series card's menu: the settings an admin reaches for most, in one place, without opening
// the series page first -- age rating, library, reading direction, series type, the sources it follows (and
// detaching one) and a check for new chapters. Anything bigger is the series page, one link away.
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import type { Series, SeriesSource } from '@/lib/types';
import { SERIES_TYPES, seriesTypeKey } from '@/lib/seriesTypes';
import { metaSaver, seedMeta, type SeriesMeta } from '@/lib/seriesMeta';
import { Sheet, Img } from '@/components/ui';
import { Row, SaveScope, SaveState, useSaveScope } from '@/components/settings';
import { ChoiceRow, DIRECTIONS, LibraryRow, ages, autoDirectionChoice } from '@/components/SeriesEditor';
import { useCheckNow } from '@/components/SourcesSheet';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';

export function SeriesPropertiesSheet({ series: listed, onClose }: {
  /** The card's copy: enough for the header while the full series loads. */
  series: Series;
  onClose: () => void;
}) {
  const id = listed.id;
  const { isAdmin } = useAuth();
  const { data } = useQuery({ queryKey: ['series', id], queryFn: () => api<Series>(`/api/series/${id}`) });
  const series = data ?? listed;
  const title = series.metadata?.title || series.name;
  return (
    <Sheet title={tr('Properties')} onClose={onClose} overBottomNav wrapTitle
      lead={<Img src={img.seriesThumb(id)} alt="" className="h-14 w-10 rounded-md object-cover" />}
      subtitle={title}>
      <div data-lenis-prevent data-series-properties className="space-y-1">
        <Summary series={series} />
        {isAdmin && data && <AdminFields key={id} series={data} />}
        <Link href={`/series/?id=${encodeURIComponent(id)}`} onClick={onClose} className="btn-key mt-2 block w-full text-center">{tr('Open series')}</Link>
      </div>
    </Sheet>
  );
}

function Summary({ series }: { series: Series }) {
  const n = series.booksCount;
  const bits = [
    n === 1 ? tr('1 chapter') : tr('{n} chapters', { n }),
    series.metadata?.status ? series.metadata.status : '',
  ].filter(Boolean);
  return <p className="pb-2 text-xs text-fog-400">{bits.join(' · ')}</p>;
}

function AdminFields({ series }: { series: Series }) {
  const id = series.id;
  const qc = useQueryClient();
  const scope = useSaveScope();
  const [meta, setMeta] = useState<SeriesMeta>(() => seedMeta(series));
  const [saver] = useState(() => metaSaver(seedMeta(series), (body) => api(`/api/admin/series/${id}/meta`, { method: 'PUT', json: body }), setMeta));
  const settle = () => { for (const k of [['series', id], ['library'], ['home'], ['series-books', id]]) qc.invalidateQueries({ queryKey: k }); };
  const save = (patch: Partial<SeriesMeta>) => saver.save(patch).then(settle);
  const { checking, checkNow } = useCheckNow(id, settle);
  const sources = series.sources ?? [];

  return (
    <SaveScope report={scope.report}>
      <div className="flex items-center justify-between pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fog-500">{tr('Settings')}</h3>
        <div data-properties-save={scope.status.kind}><SaveState status={scope.status} /></div>
      </div>
      <ChoiceRow narrow label={tr('Age rating')} value={meta.ageRating}
        help={tr('Members with an age limit below this will not see the series anywhere: not in the library, search, the reader, or an external OPDS app.')}
        options={[{ value: '', label: tr('Not rated') }, ...ages(meta.ageRating).map((a) => ({ value: String(a), label: `${a}+` }))]}
        onPick={(ageRating) => save({ ageRating })} />
      <LibraryRow id={id} series={series} onSaved={settle} />
      <ChoiceRow narrow label={tr('Reading direction')} value={meta.readingDirection}
        options={[{ value: '', label: autoDirectionChoice(series.detectedDirection) }, ...DIRECTIONS.map(([v, label]) => ({ value: v as string, label: tr(label) }))]}
        onPick={(readingDirection) => save({ readingDirection })} />
      <ChoiceRow narrow label={tr('Series type')} value={meta.seriesType}
        options={[{ value: '', label: tr('Automatic') }, ...SERIES_TYPES.filter((v) => v !== 'unknown').map((v) => ({ value: v as string, label: tr(seriesTypeKey(v)) }))]}
        onPick={(seriesType) => save({ seriesType })} />

      <SourcesBlock id={id} sources={sources} onChanged={settle} />

      <div className="flex flex-wrap gap-2 py-3">
        <button type="button" onClick={() => void checkNow()} disabled={checking} className="btn-key" data-properties-check>
          {checking ? tr('Checking…') : tr('Check for new chapters')}
        </button>
      </div>
    </SaveScope>
  );
}

function SourcesBlock({ id, sources, onChanged }: { id: string; sources: SeriesSource[]; onChanged: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const detach = async (s: SeriesSource) => {
    setBusy(s.sourceId);
    try {
      await api(`/api/admin/series/${id}/sources/${encodeURIComponent(s.sourceId)}`, { method: 'DELETE' });
      toast(tr('No longer following {s}', { s: s.name }), 'success');
      onChanged();
      for (const k of ['series-listing', 'series-scanlators', 'series-groups']) qc.invalidateQueries({ queryKey: [k, id] });
    } catch (e) { toast(msgOf(e, tr('Could not remove that')), 'error'); }
    setBusy(null);
  };
  return (
    <Row label={tr('Sources')} stacked
      help={sources.length ? undefined : tr('This series has no source to fetch new chapters from.')}>
      <ul data-properties-sources className="divide-y divide-ink-700/60">
        {sources.map((s) => (
          <li key={s.sourceId} className="flex items-center gap-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate text-fog-100">{s.name}</span>
            <span className="shrink-0 text-xs text-fog-500">
              {s.primary ? tr('main') : ''}{s.primary && s.chapters != null ? ' · ' : ''}{s.chapters != null ? tr('{n} chapters', { n: s.chapters }) : ''}
            </span>
            {!s.primary && (
              <button type="button" disabled={busy === s.sourceId} onClick={() => void detach(s)} aria-label={`${tr('Detach')} ${s.name}`} className="btn-key shrink-0 text-xs" data-properties-detach={s.sourceId}>
                {tr('Detach')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Row>
  );
}
