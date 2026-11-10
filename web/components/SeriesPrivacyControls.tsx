'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { contentPrivacyOf } from '@/lib/contentScope';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { PrivateLibraryManager } from '@/components/PrivateLibraryManager';

interface PrivacyState { isPrivate: boolean; owner: boolean; canChange: boolean }
interface Destination { id: string; name: string }

/** Owner action: refile this copy deliberately; never claim another person's shared copy. */
export function SeriesPrivacyControls({ id, isPrivate }: { id: string; isPrivate: boolean }) {
  const { user, status } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const preferences = useQuery({
    queryKey: ['content-privacy', user?.id ?? null],
    queryFn: async () => contentPrivacyOf(await api('/api/personal/privacy')),
    enabled: !!user && status !== 'offline', staleTime: 15_000, retry: false,
  });
  const privacy = useQuery({
    queryKey: ['series-privacy', user?.id, id],
    queryFn: () => api<PrivacyState>(`/api/series/${encodeURIComponent(id)}/privacy`),
    enabled: !!user && !!preferences.data?.supported && status !== 'offline', staleTime: 0, retry: false,
  });
  const sharing = privacy.data?.isPrivate === true;
  const libraries = useQuery({
    queryKey: ['privacy-destinations', user?.id],
    queryFn: async () => {
      const value = await api<Destination[] | { content: Destination[] }>('/api/libraries');
      const rows = Array.isArray(value) ? value : value.content;
      return rows.filter((row) => row.id !== preferences.data?.privateLibraryId);
    },
    enabled: open && sharing, staleTime: 0, retry: false,
  });
  const destination = chosen ?? libraries.data?.[0]?.id ?? null;
  const ready = !!privacy.data?.canChange && (!sharing || (!!destination && !libraries.isFetching && !libraries.isError));
  const change = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await api(`/api/series/${encodeURIComponent(id)}/privacy`, {
        method: 'PUT', json: { isPrivate: !sharing, ...(sharing ? { libraryId: destination } : {}) },
      });
      for (const key of [['series', id], ['series-privacy'], ['library'], ['home'], ['collection'], ['src-detail'], ['content-privacy']]) {
        await qc.invalidateQueries({ queryKey: key });
      }
      setOpen(false);
    } catch (e) { setError(msgOf(e, tr('Could not change visibility. Try again.'))); }
    finally { setBusy(false); }
  };
  if (!isPrivate && !privacy.data?.owner) return null;
  return <>
    <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs" data-series-privacy>
      <span className="rounded-full border border-ink-700 px-2.5 py-1 text-fog-300">
        {privacy.data?.isPrivate ?? isPrivate ? tr('Private library') : tr('Shared library')}
      </span>
      {privacy.data?.canChange && <button type="button" className="text-accent underline underline-offset-2"
        onClick={() => { setChosen(null); setError(''); setOpen(true); }}>{tr('Change visibility')}</button>}
      {(privacy.data?.isPrivate ?? isPrivate) && <PrivateLibraryManager seriesId={id} />}
    </div>
    {open && <Modal title={sharing ? tr('Share this copy?') : tr('Make this copy private?')} onClose={busy ? () => {} : () => setOpen(false)}>
      <p className="text-sm leading-relaxed text-fog-300">{sharing
        ? tr('People with access to the selected library will be able to browse and read this copy. Your earlier private reading history stays private.')
        : tr('Only your account will be able to browse and read this server copy. Copies already downloaded by other people cannot be recalled.')}</p>
      {sharing && <div className="mt-4">
        <label htmlFor="privacy-destination" className="mb-1 block text-xs font-semibold text-fog-300">{tr('Shared library')}</label>
        {libraries.isLoading ? <p role="status" className="text-xs text-fog-500">{tr('Loading…')}</p>
          : libraries.isError ? <p role="alert" className="text-xs text-amber-300">{tr('Could not load libraries.')}</p>
          : !libraries.data?.length ? <p className="text-xs text-amber-300">{tr('You do not have a shared library to publish into.')}</p>
          : <select id="privacy-destination" className="field w-full" value={destination ?? ''} disabled={busy}
            onChange={(e) => setChosen(e.target.value)}>
            {libraries.data.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select>}
      </div>}
      <p className="mt-3 text-xs leading-relaxed text-fog-500">{tr('AniList entries already made private will not be made public automatically.')}</p>
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="chip" disabled={busy} onClick={() => setOpen(false)}>{tr('Cancel')}</button>
        <button type="button" className="btn-accent disabled:opacity-50" disabled={!ready || busy} onClick={() => void change()}>
          {busy ? tr('Working…') : sharing ? tr('Share this copy') : tr('Make private')}
        </button>
      </div>
    </Modal>}
  </>;
}
