'use client';
// The other names a series goes by (bff lib/altTitles.ts), for admins, inside Sources & translations.
//
// A series is stored under one title; another source may file it as "Only I Level Up" or "Na Honjaman
// Level Up". The names here are what Connect sources searches under and matches against -- exactly, never by
// containment. Names read from a source's description are used only while Admin → Settings → "Match
// sources by other names" is on, and say so; a name typed here is always used.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { t as tr } from '@/lib/i18n';

interface AltTitle { title: string; norm: string; origin: 'description' | 'admin' | 'confirmed' | 'merged'; sourceName: string | null }

function originLabel(a: AltTitle): string {
  switch (a.origin) {
    case 'description': return a.sourceName ? tr('from {name}', { name: a.sourceName }) : tr('from a description');
    case 'confirmed': return a.sourceName ? tr('confirmed on {name}', { name: a.sourceName }) : tr('confirmed');
    case 'merged': return tr('from a merge');
    case 'admin': return tr('added by hand');
  }
}

export function AltTitlesEditor({ seriesId }: { seriesId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['series-alt-titles', seriesId];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<{ matching: boolean; content: AltTitle[] }>(`/api/admin/series/${encodeURIComponent(seriesId)}/alt-titles`),
    staleTime: 30_000,
  });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const names = data?.content ?? [];

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setBusy(true);
    try {
      await api(`/api/admin/series/${encodeURIComponent(seriesId)}/alt-titles`, { json: { title } });
      setDraft('');
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toast(msgOf(e, tr('Could not add that name')), 'error'); }
    setBusy(false);
  };
  const remove = async (a: AltTitle) => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${encodeURIComponent(seriesId)}/alt-titles/${encodeURIComponent(a.norm)}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { toast(msgOf(e, tr('Could not remove that')), 'error'); }
    setBusy(false);
  };

  return (
    <div className="mt-3" data-alt-titles>
      <p className="mb-1.5 max-w-prose text-[11px] leading-relaxed text-fog-500">
        {tr('Other names: used to find this series on sources that call it something else. A name must match exactly.')}
      </p>
      {names.length > 0 && (
        <ul className="mb-2 space-y-1">
          {names.map((a) => {
            const unused = a.origin === 'description' && data?.matching === false;
            return (
              <li key={a.norm} className="flex items-center gap-2 text-xs">
                <span className={`min-w-0 flex-1 truncate ${unused ? 'text-fog-600' : 'text-fog-200'}`} title={a.title}>{a.title}</span>
                <span className="shrink-0 text-[10px] text-fog-600">{unused ? tr('not used while matching by other names is off') : originLabel(a)}</span>
                <button type="button" onClick={() => remove(a)} disabled={busy} aria-label={tr('Remove {name}', { name: a.title })}
                  className="shrink-0 px-1 text-fog-500 hover:text-rose-400 disabled:opacity-50">×</button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={tr('Add another name…')} maxLength={200}
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 text-xs text-fog-100 outline-hidden focus:border-accent/60" />
        <button type="submit" disabled={busy || !draft.trim()} className="chip text-xs disabled:opacity-50">{tr('Add')}</button>
      </form>
    </div>
  );
}
