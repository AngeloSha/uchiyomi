'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { Row } from '@/components/settings';

interface PrivateCopy { id: string; title: string; deleted: boolean; autoUpdate: boolean; canDelete: boolean }
type Action = 'pause' | 'resume' | 'remove' | 'restore' | 'delete';

export function PrivateLibraryManager({ seriesId }: { seriesId?: string }) {
  const { user, status } = useAuth();
  const ownerId = user?.id ?? null;
  const currentOwner = useRef(ownerId);
  currentOwner.current = ownerId;
  const qc = useQueryClient();
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ ownerId: string; row: PrivateCopy; action: 'remove' | 'delete' } | null>(null);
  const open = !!ownerId && openOwner === ownerId;
  const confirm = open && confirmation?.ownerId === ownerId ? confirmation : null;
  const query = useQuery({
    queryKey: ['private-series', ownerId],
    queryFn: ({ signal }) => api<{ content: PrivateCopy[] }>('/api/personal/private-series', { signal }),
    enabled: open && status !== 'offline', staleTime: 0, retry: false,
  });
  const rows = (query.data?.content ?? []).filter((row) => !seriesId || row.id === seriesId);
  const run = async (row: PrivateCopy, action: Action) => {
    if (!ownerId || busy || status === 'offline') return;
    const actor = ownerId;
    setBusy(true); setError('');
    try {
      await api(`/api/series/${encodeURIComponent(row.id)}/private-management`, {
        json: { action, ...(action === 'delete' ? { confirmed: true } : {}) },
      });
      if (currentOwner.current !== actor) return;
      setConfirmation(null);
      for (const key of [['private-series', actor], ['series', row.id], ['series-privacy'], ['library'], ['home'], ['collection']]) {
        await qc.invalidateQueries({ queryKey: key });
      }
    } catch (e) {
      if (currentOwner.current === actor) setError(msgOf(e, tr('Could not update this private copy. Try again.')));
    } finally { if (currentOwner.current === actor) setBusy(false); }
  };
  const launch = () => { if (ownerId) { setError(''); setBusy(false); setConfirmation(null); setOpenOwner(ownerId); } };
  const trigger = <button type="button" className={seriesId ? 'text-accent underline underline-offset-2' : 'chip text-xs'}
    disabled={!ownerId || status === 'offline'} onClick={launch}>{seriesId ? tr('Manage private copy') : tr('Manage')}</button>;
  return <>
    {seriesId ? trigger : <Row label={tr('My private copies')} help={tr('Pause updates, remove a copy, or restore a removed copy owned by this account.')}>{trigger}</Row>}
    {open && !confirm && <Modal title={tr('My private copies')} onClose={busy ? () => {} : () => setOpenOwner(null)}>
      <p className="mb-3 text-xs leading-relaxed text-fog-500">{tr('Only copies owned by this account are listed here.')}</p>
      {query.isLoading ? <p role="status" className="text-sm text-fog-400">{tr('Loading…')}</p>
        : query.isError ? <p role="alert" className="text-sm text-amber-300">{tr('Could not load private copies.')}{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>{tr('Try again')}</button></p>
        : rows.length === 0 ? <p className="text-sm text-fog-400">{tr('No private copies yet.')}</p>
        : <ul className="space-y-3" data-private-copies>
          {rows.map((row) => <li key={row.id} className="rounded-xl border border-ink-700 p-3" data-private-copy={row.id}>
            <p dir="auto" className="break-words text-sm font-semibold text-fog-100">{row.title}</p>
            <p className="mt-1 text-xs text-fog-500">{row.deleted ? tr('Removed') : row.autoUpdate ? tr('Automatic updates on') : tr('Automatic updates paused')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {row.deleted
                ? <button className="chip text-xs" disabled={busy} onClick={() => void run(row, 'restore')}>{tr('Restore')}</button>
                : <>
                  <button className="chip text-xs" disabled={busy} onClick={() => void run(row, row.autoUpdate ? 'pause' : 'resume')}>
                    {row.autoUpdate ? tr('Pause updates') : tr('Resume updates')}</button>
                  <button className="chip text-xs" disabled={busy} onClick={() => setConfirmation({ ownerId: ownerId!, row, action: 'remove' })}>{tr('Remove private copy')}</button>
                </>}
              {row.deleted && row.canDelete && <button className="chip text-xs text-red-300" disabled={busy}
                onClick={() => setConfirmation({ ownerId: ownerId!, row, action: 'delete' })}>{tr('Delete files permanently')}</button>}
            </div>
          </li>)}
        </ul>}
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
    </Modal>}
    {confirm && <ConfirmDialog title={confirm.action === 'delete' ? tr('Delete this private copy permanently?') : tr('Remove this private copy?')}
      body={<>
        <p dir="auto" className="mb-2 font-semibold">{confirm.row.title}</p>
        <p>{confirm.action === 'delete'
          ? tr('This deletes the files for this removed, never-shared private copy. It cannot be restored.')
          : tr('Files and reading progress are kept. You can restore this copy from My private copies.')}</p>
        {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
      </>}
      danger={confirm.action === 'delete'} confirmText={confirm.action === 'delete' ? confirm.row.title : undefined}
      confirmLabel={confirm.action === 'delete' ? tr('Delete files permanently') : tr('Remove private copy')} busy={busy}
      onClose={busy ? () => {} : () => setConfirmation(null)} onConfirm={() => void run(confirm.row, confirm.action)} />}
  </>;
}
