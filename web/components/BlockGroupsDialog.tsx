'use client';
// Block & remove, from the chapters themselves (#396): a troll's wrong number -- and the other groups that copied it --
// blocked for this series, and the chapters that leaves to blocked groups alone removed completely, in one confirmed
// step from a chapter's menu or the select bar. Every group behind the picked chapters is ticked (the file's own and
// every group that lists the number); untick one to keep it. The server answers, for the ticked groups, which chapters
// would go (bff lib/blockedPurge.ts blockGroupsFor, rolled back), and the confirm removes exactly those it showed.
// A chapter never downloaded -- listed, its download failing because the source is down -- is asked about by number:
// it has no file to remove, so it is hidden once only blocked groups list it, and its failure entry and read marks
// are cleared. A Modal: the series page opens it with no Sheet up (page.tsx closes sheets before any dialog).
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { normGroup } from '@/lib/scanlators';
import { useToast } from '@/components/Toast';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import {
  blockedNumbersText, chapterGroups, refreshAfterRemoval, sayRemoved, type BlockedChapters,
} from '@/components/BlockedChapters';

/** What the confirm removes, said before it: how many chapters the block leaves to blocked groups alone, and whose history. */
export function blockRemoveText(d: Pick<BlockedChapters, 'chapters' | 'readers'>): string {
  return [
    d.chapters === 1 ? tr('1 downloaded chapter is then only from blocked groups: removed completely.')
      : tr('{n} downloaded chapters are then only from blocked groups: removed completely.', { n: d.chapters }),
    ...(d.readers === 1 ? [tr('Reading history on them goes too, for 1 reader.')]
      : d.readers > 1 ? [tr('Reading history on them goes too, for {n} readers.', { n: d.readers })] : []),
  ].join(' ');
}

/** What the confirm does to the picked chapters not downloaded, said before it. */
export function blockHideText(n: number): string {
  return n === 1 ? tr('Hidden, with failed downloads and read marks cleared: 1 chapter not downloaded.')
    : tr('Hidden, with failed downloads and read marks cleared: {n} chapters not downloaded.', { n });
}

type Preview = BlockedChapters & { groups: Array<{ name: string; already: 'series' | 'server' | null }>; numbers?: number[] };

export function BlockGroupsDialog({ seriesId, books, ghosts = [], copiesOf, onClose, onDone }: {
  seriesId: string;
  /** The picked chapters on the server (deleted ones too): one from a row's menu, or the select bar's. */
  books: ReadonlyArray<{ id: string; number: number; scanlator?: string | null }>;
  /** The picked chapters not downloaded: listed numbers with no file here (a failing download, say). */
  ghosts?: ReadonlyArray<{ number: number; scanlator?: string | null; groups?: string[] }>;
  /** Every copy the sources list for a number (the versions the page already holds). */
  copiesOf: (n: number) => ReadonlyArray<{ groups?: string[]; scanlator?: string | null }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const groups = useMemo(() => chapterGroups([...books, ...ghosts], copiesOf), [books, ghosts, copiesOf]);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = groups.filter((g) => !unticked.has(normGroup(g)));
  const selected = books.map((b) => b.id);
  const numbers = ghosts.map((g) => g.number);
  const { data: preview, isFetching, error } = useQuery({
    queryKey: ['block-preview', seriesId, ticked.map(normGroup).join('|'), selected.join(','), numbers.join(',')],
    queryFn: () => api<Preview>(`/api/admin/series/${encodeURIComponent(seriesId)}/block-groups/preview`, { json: { groups: ticked, selected, numbers } }),
    enabled: ticked.length > 0,
    retry: false,
    staleTime: 0,
  });
  const already = new Map((preview?.groups ?? []).map((g) => [normGroup(g.name), g.already]));
  const [busy, setBusy] = useState(false);
  const toggle = (name: string) => setUnticked((u) => {
    const next = new Set(u);
    const k = normGroup(name);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const removing = preview?.chapters ?? 0;
  const hiding = preview?.numbers ?? [];
  const adds = (preview?.groups ?? []).some((g) => g.already === null);
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api<{ removed: number; left: unknown[]; busy: string[]; blocked: string[]; cleared?: number[] }>(
        `/api/admin/series/${encodeURIComponent(seriesId)}/block-groups`,
        { json: { groups: ticked, selected, bookIds: preview.books.map((b) => b.id), numbers: hiding } },
      );
      if (preview.books.length || hiding.length) sayRemoved(toast, { ...r, removed: r.removed + (r.cleared?.length ?? 0) });
      else toast(tr('Saved'), 'success');
      refreshAfterRemoval(qc);
      onDone();
    } catch (e) { toast(msgOf(e, tr('Could not save')), 'error'); }
    finally { setBusy(false); }
  };
  const picked = [...books, ...ghosts];
  const title = picked.length === 1 ? tr('Block the groups of chapter {n}?', { n: picked[0].number }) : tr('Block the groups of these chapters?');
  return (
    <Modal title={title} onClose={onClose} fieldFocus={false}>
      <div className="text-sm leading-relaxed text-fog-300" data-block-groups>
        {!groups.length ? <p>{tr('No translation group is named for these chapters.')}</p> : (
          <>
            <p>{tr('Blocked for this series: nothing is fetched from these groups again, and a chapter only they released is hidden.')}</p>
            <ul className="mt-2 space-y-1">
              {groups.map((g) => {
                const k = normGroup(g);
                const was = already.get(k);
                return (
                  <li key={k}>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="accent-[rgb(var(--accent))]" checked={!unticked.has(k)} disabled={busy}
                        onChange={() => toggle(g)} data-block-group={g} />
                      <span className="min-w-0 flex-1 truncate text-fog-100">{g}</span>
                      {was === 'server' && <span className="shrink-0 text-[11px] text-fog-500">{tr('blocked on server')}</span>}
                      {was === 'series' && <span className="shrink-0 text-[11px] text-fog-500">{tr('Blocked')}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3" aria-live="polite" data-block-preview>
              {!ticked.length ? <p className="text-fog-500">{tr('Tick a group to block.')}</p>
                : error ? <p className="text-rose-300">{msgOf(error, tr('Could not check which chapters would go'))}</p>
                : !preview || isFetching ? <p className="text-fog-500">{tr('Checking…')}</p>
                : removing > 0 || hiding.length > 0 ? (
                  <>
                    {removing > 0 && (
                      <>
                        <p className="text-fog-100">{blockRemoveText(preview)}</p>
                        <p className="mt-1 text-rose-200" data-block-numbers>{blockedNumbersText(preview.books, false)}</p>
                      </>
                    )}
                    {hiding.length > 0 && (
                      <>
                        <p className={`text-fog-100${removing > 0 ? ' mt-2' : ''}`}>{blockHideText(hiding.length)}</p>
                        <p className="mt-1 text-rose-200" data-block-hidden-numbers>
                          {blockedNumbersText(hiding.map((number) => ({ seriesId, seriesTitle: '', number })), false)}
                        </p>
                      </>
                    )}
                  </>
                ) : <p className="text-fog-400">{tr('Nothing is removed: a group that is not blocked still has each of these chapters.')}</p>}
            </div>
          </>
        )}
      </div>
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
        <button onClick={() => void confirm()} disabled={busy || !preview || isFetching || !ticked.length || (!adds && !removing && !hiding.length)}
          data-block-confirm className="flex-1 rounded-full bg-rose-500/90 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-40">
          {busy ? tr('Working…') : removing > 0 || hiding.length > 0 ? tr('Block and remove') : tr('Block')}
        </button>
      </div>
    </Modal>
  );
}
