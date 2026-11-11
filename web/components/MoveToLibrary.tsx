'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, getCurrentUser } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { moveLibraryRefusal, moveLibrarySummary, moveVisibilityConfirmation, type LibraryDestination, type MoveLibraryOptions, type MoveLibraryResult, type VisibilityConfirmation } from '@/lib/moveLibrary';
import { Modal } from '@/components/ConfirmDialog';
import { LibraryFolders } from '@/components/LibraryFolders';
import { foldersOf } from '@/lib/libraryFolders';
import { useToast } from './Toast';

/** One filing picker, including the explicit privacy transition and refusal, for every entry point. */
export function MoveToLibrary({ n, busy, onClose, onPick, current }: {
  n: number; busy: boolean; onClose: () => void;
  onPick: (libraryId: string | null, options: MoveLibraryOptions) => Promise<MoveLibraryResult>;
  current?: { libraryId: string };
}) {
  const toast = useToast();
  const owner = useRef(getCurrentUser());
  const initialCount = useRef(n);
  const lastPick = useRef<string | null | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<(VisibilityConfirmation & { libraryId: string | null; name: string }) | null>(null);
  const [partial, setPartial] = useState<MoveLibraryResult | null>(null);
  const locked = busy || working;
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['admin-libraries', owner.current],
    queryFn: () => api<{ content: LibraryDestination[] }>('/api/admin/libraries', { expectedOwnerId: owner.current }),
  });
  const pick = async (libraryId: string | null, confirmed = false) => {
    if (locked) return;
    lastPick.current = libraryId;
    setWorking(true); setError(''); setPartial(null);
    try {
      const result = await onPick(libraryId, { expectedOwnerId: owner.current, ...(confirmed ? { confirmVisibilityChange: true } : {}) });
      if (getCurrentUser() !== owner.current) return;
      setPending(null);
      if (result.skipped.length) setPartial(result);
      else { toast(moveLibrarySummary(result), 'success'); onClose(); }
    } catch (e) {
      if (getCurrentUser() !== owner.current) return;
      const confirmation = moveVisibilityConfirmation(e);
      if (confirmation) setPending({ ...confirmation, libraryId,
        name: data?.content.find((l) => l.id === libraryId)?.name ?? tr('Automatic — follow the folder') });
      else setError(moveLibraryRefusal(e));
    } finally { setWorking(false); }
  };
  useEffect(() => {
    if (lastPick.current === undefined) return;
    const dialog = ref.current?.closest<HTMLElement>('[role="dialog"]');
    const previous = [...(ref.current?.querySelectorAll<HTMLElement>('[data-library-destination]') ?? [])]
      .find((el) => el.getAttribute('data-library-destination') === (lastPick.current ?? ''));
    (pending || partial ? dialog?.querySelector<HTMLElement>('button') : previous)?.focus();
  }, [pending, partial]);
  useEffect(() => {
    const dialog = ref.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    // Also works inside Edit details: its outer trap and Escape handler must not consume this dialog's keys.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); if (!locked) onClose(); }
      if (e.key !== 'Tab') return;
      const all = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length);
      if (!all.length) return;
      if (e.shiftKey && document.activeElement === all[0]) { e.preventDefault(); all.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0].focus(); }
    };
    dialog.addEventListener('keydown', onKey);
    return () => dialog.removeEventListener('keydown', onKey);
  }, [locked, onClose]);
  return <Modal title={pending ? tr('Change visibility') : initialCount.current === 1 ? tr('File this series') : tr('File {n} series', { n: initialCount.current })}
    fieldFocus={false} onClose={locked ? () => {} : onClose}>
    <div ref={ref} data-move-library>
      {pending ? <div data-move-visibility-confirmation>
        <h4 className="text-sm font-semibold text-fog-100">{pending.visibility === 'shared'
          ? pending.count === 1 ? tr('Share 1 copy?') : tr('Share {n} copies?', { n: pending.count })
          : pending.count === 1 ? tr('Make 1 copy private?') : tr('Make {n} copies private?', { n: pending.count })}</h4>
        <p className="mt-2 text-sm leading-relaxed text-fog-300">{pending.visibility === 'shared'
          ? tr('People with access to this library will be able to browse and read the selected copies. Earlier private reading history stays private.')
          : tr('Only your account will be able to browse and read the selected server copies. Copies already downloaded by other people cannot be recalled.')}</p>
        <p dir="auto" className="mt-3 rounded-lg bg-ink-800/50 p-3 text-sm text-fog-100">{pending.name}</p>
        <p className="mt-3 text-xs leading-relaxed text-fog-500">{tr('AniList entries already made private will not be made public automatically.')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost min-h-11 px-4 text-sm" disabled={locked} onClick={() => { setPending(null); setError(''); }}>{tr('Cancel')}</button>
          <button type="button" className="btn-accent min-h-11 px-4 text-sm" disabled={locked} onClick={() => void pick(pending.libraryId, true)}>
            {locked ? tr('Working…') : tr('Confirm')}
          </button>
        </div>
      </div> : partial ? <div role="status" data-move-result>
        <p className="text-sm text-fog-200">{moveLibrarySummary(partial)}</p>
        <ul className="mt-3 space-y-2 text-xs text-amber-300">{[...new Set(partial.skipped.map((s) => moveLibraryRefusal(s)))].map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <div className="mt-4 flex justify-end"><button type="button" className="btn-accent min-h-11 px-4 text-sm" onClick={onClose}>{tr('Done')}</button></div>
      </div> : <>
        {isPending ? <p role="status" className="py-4 text-sm text-fog-400">{tr('Loading…')}</p> : isError ? <div role="alert" className="py-2 text-sm text-amber-300">
          <p>{tr('Could not load libraries.')}</p><button type="button" className="btn-ghost mt-3 min-h-11 px-3" onClick={() => void refetch()}>{tr('Try again')}</button>
        </div> : <div className="space-y-1">
          {(data?.content ?? []).map((l) => {
            const here = current?.libraryId === l.id;
            return <button key={l.id} type="button" data-library-destination={l.id} disabled={locked} onClick={() => void pick(l.id)} aria-current={here ? 'true' : undefined}
              className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-start disabled:opacity-50 ${here ? 'bg-accent-soft' : 'hover:bg-ink-800/60'}`}>
              <span className="min-w-0">
                <span dir="auto" className="block truncate text-sm text-fog-100">{l.name}</span>
                {l.managed_private ? <span className="text-[11px] text-fog-500">{tr('Private library')}</span>
                  : <LibraryFolders paths={foldersOf(l)} className="text-[11px] text-fog-500" />}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {l.age_rating != null && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">{l.age_rating}+</span>}
                {here && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{tr('Current')}</span>}
              </span>
            </button>;
          })}
          <button type="button" data-library-destination="" disabled={locked} onClick={() => void pick(null)}
            className="mt-2 min-h-11 w-full rounded-lg border border-ink-700 px-2.5 py-2 text-sm text-fog-400 hover:text-fog-200 disabled:opacity-50">
            {tr('Automatic — follow the folder')}
          </button>
        </div>}
        <p className="mt-3 text-[11px] leading-relaxed text-fog-600">{tr('Filing between shared libraries keeps files in place. Changing visibility needs your confirmation.')}</p>
      </>}
      {error && <p role="alert" className="mt-3 text-sm text-amber-300">{error}</p>}
    </div>
  </Modal>;
}
