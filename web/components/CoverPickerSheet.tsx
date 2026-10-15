'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { Sheet } from '@/components/ui';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t as tr } from '@/lib/i18n';
import { bustCover } from '@/lib/coverBust';
import { ART_MAX_BYTES, ART_MAX_MB, dataUrlOf } from '@/lib/artUpload';

interface Candidate { sourceId: string; name: string; primary: boolean; coverUrl: string }

/**
 * Change a series' cover to one a source it follows has for it. An admin's picker, opened from the cover on the
 * series page: the candidates are read from each followed source's own record of the series (the same lookup
 * the updater makes), shown through the cover proxy, and applied by naming only the source -- the server fetches
 * the picture itself and keeps its own copy, so the cover survives the source changing or going away. A picture of
 * the admin's own can be uploaded from the same sheet.
 */
export function CoverPickerSheet({ seriesId, artVersion, onClose }: { seriesId: string; artVersion?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['cover-candidates', seriesId], staleTime: 5 * 60_000,
    queryFn: () => api<{ content: Candidate[] }>(`/api/admin/series/${encodeURIComponent(seriesId)}/cover-candidates`).then((r) => r.content),
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    if (saving) return;
    if (!f.type.startsWith('image/')) { toast(tr('That file is not an image this server can read.'), 'error'); return; }
    if (f.size > ART_MAX_BYTES) { toast(tr('That image is over {n} MB. Pick a smaller one.', { n: ART_MAX_MB }), 'error'); return; }
    setSaving(true);
    try {
      const dataUrl = await dataUrlOf(f);
      await api(`/api/admin/series/${encodeURIComponent(seriesId)}/art`, { method: 'PUT', json: { kind: 'cover', mode: 'upload', dataUrl } });
      done();
    } catch (e) { toast(msgOf(e, tr('Could not change the cover')), 'error'); setSaving(false); }
  };
  const done = () => {
    bustCover(seriesId);
    for (const k of [['series', seriesId], ['library'], ['home']]) qc.invalidateQueries({ queryKey: k });
    toast(tr('Cover updated'), 'success');
    onClose();
  };
  const use = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      await api(`/api/admin/series/${encodeURIComponent(seriesId)}/art`, { method: 'PUT', json: { kind: 'cover', mode: 'source', source: picked } });
      done();
    } catch (e) { toast(msgOf(e, tr('Could not change the cover')), 'error'); setSaving(false); }
  };
  const tile = (key: string, src: string, label: string, current?: boolean) => {
    const on = picked === key;
    return (
      <button key={key} type="button" disabled={current || saving} onClick={() => setPicked(key)} aria-pressed={current ? undefined : on} data-cover-option={key}
        className={`group block text-start ${current ? 'cursor-default' : ''}`}>
        <span className={`block aspect-[2/3] overflow-hidden rounded-xl border-2 bg-ink-900 transition ${on ? 'border-accent' : 'border-ink-700'} ${current ? '' : 'group-hover:border-fog-500'}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
        </span>
        <span className={`mt-1.5 block truncate text-xs ${on ? 'text-accent' : 'text-fog-300'}`}>{label}</span>
      </button>
    );
  };
  return (
    <Sheet title={tr('Change cover')} onClose={onClose} overBottomNav
      footer={<button type="button" onClick={use} disabled={!picked || saving} data-cover-use className="btn-key btn-key-primary w-full disabled:opacity-50">{tr('Use this cover')}</button>}>
      {isLoading && <p className="py-6 text-center text-sm text-fog-400">{tr('Looking for covers…')}</p>}
      {!isLoading && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {tile('current', img.seriesThumb(seriesId, artVersion, 400), tr('Current cover'), true)}
          {(data ?? []).map((c) => tile(c.sourceId, `/img/sources/cover?u=${encodeURIComponent(c.coverUrl)}&source=${encodeURIComponent(c.sourceId)}&w=400`, c.name))}
        </div>
      )}
      {!isLoading && (
        <div className="mt-4">
          <input ref={fileRef} type="file" accept="image/*" hidden data-cover-file
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
          <button type="button" disabled={saving} onClick={() => fileRef.current?.click()} data-cover-upload className="btn-key">{tr('Upload your own…')}</button>
        </div>
      )}
      {!isLoading && !(data?.length) && <p className="mt-4 text-sm text-fog-400">{tr('None of the sources following this series has a cover to offer right now.')}</p>}
    </Sheet>
  );
}
