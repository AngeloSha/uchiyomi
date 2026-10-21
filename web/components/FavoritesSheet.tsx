'use client';
/**
 * Home's Favourites sheet (v0.97.0): your favourites in the order Home shows them, to drag into place, move a step with
 * the arrows, or take off.
 *
 * The owner: "we need a better system to reorder favorites". Favourites were listed newest first everywhere, and the only
 * way to move one was to unfavourite it and favourite it again; the rail's Manage went to Profile, which had nothing for
 * them. The order is kept on the server (bff lib/favorites.ts), so every device and the OPDS feed read it too.
 *
 * Shaped like Customize Home (HomeCustomize.tsx), on purpose: rows, the same keys, drag through the shared hook
 * (lib/dragReorder.ts), and one save in flight carrying the newest order, so a quick run of moves is one request each
 * at most and never lands out of order.
 */
import { useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import type { Series } from '@/lib/types';
import { moveTo, useDragReorder } from '@/lib/dragReorder';
import { IcChevronLeft, IcChevronRight, IcX } from './icons';
import { useToast } from './Toast';
import { Img, Sheet } from './ui';

/** The rail's Manage key, and the sheet it opens. A word, as the rail's other actions are. */
export function FavoritesManage() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="text-xs text-accent" data-favorites-manage>
        {tr('Manage')}
      </button>
      {open && <FavoritesSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function FavoritesSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['favorites'], queryFn: () => api<{ content: Series[] }>('/api/favorites') });
  // The server's answer until the first change in this sheet, then what is on screen.
  const [shown, setShown] = useState<Series[] | null>(null);
  const items = shown ?? data?.content ?? [];
  const after = () => {
    void qc.invalidateQueries({ queryKey: ['home'] });
    void qc.invalidateQueries({ queryKey: ['favorites'] });
  };

  // One request at a time, the newest order each time. A refusal puts the server's order back and says so.
  const sending = useRef<{ busy: boolean; next?: string[] }>({ busy: false });
  const save = (ids: string[]) => {
    const s = sending.current;
    s.next = ids;
    if (s.busy) return;
    s.busy = true;
    void (async () => {
      while (s.next) {
        const want = s.next;
        s.next = undefined;
        try {
          await api('/api/favorites/order', { method: 'PUT', json: { seriesIds: want } });
        } catch {
          s.next = undefined;
          setShown(null);
          toast(tr('Could not save'), 'error');
        }
      }
      s.busy = false;
      after();
    })();
  };
  const reorder = (next: Series[]) => { setShown(next); save(next.map((s) => s.id)); };
  const drag = useDragReorder({ count: items.length, layout: 'column', onMove: (from, to) => reorder(moveTo(items, from, to)) });
  const remove = async (s: Series) => {
    setShown(items.filter((x) => x.id !== s.id));
    try {
      await api(`/api/favorites/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      toast(tr('Removed from favourites'), 'success');
    } catch {
      setShown(null);
      toast(tr('Could not save'), 'error');
    }
    after();
  };

  return (
    <Sheet title={tr('Your favorites')} onClose={onClose} overBottomNav
      footer={
        // `pb-2`: the sheet's nav clearance is 4 px short of the nav's measured height (as Customize Home's footer).
        <div className="flex items-center justify-end gap-3 pb-2">
          <button type="button" onClick={onClose} className="btn-key btn-key-primary">{tr('Done')}</button>
        </div>
      }>
      <p className="pb-1 text-xs text-fog-500">{tr('Home shows your favorites in this order. Drag one into place, or move it with its arrows.')}</p>
      <ul data-favorites-order>
        {items.map((s, i) => (
          <FavoriteRow key={s.id} series={s} first={i === 0} last={i === items.length - 1} dragProps={drag.item(i)}
            onMove={(by) => reorder(moveTo(items, i, i + by))} onRemove={() => void remove(s)} />
        ))}
      </ul>
    </Sheet>
  );
}

function FavoriteRow({ series, first, last, onMove, onRemove, dragProps }: {
  series: Series;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  /** The row's handle for drag to reorder (lib/dragReorder.ts), spread onto the row. */
  dragProps?: object;
}) {
  // The keys name the series they act on: "Move up" thirty times over says nothing to a screen reader on its own.
  const id = useId();
  return (
    <li {...dragProps} data-favorite-row={series.id} className="flex items-center gap-3 border-b border-ink-800/70 py-2 last:border-b-0">
      <div className="h-12 w-8 shrink-0 overflow-hidden rounded-md border border-ink-700">
        <Img src={img.seriesThumb(series.id)} alt="" className="h-full w-full" />
      </div>
      <p id={id} dir="auto" className="min-w-0 flex-1 truncate text-sm text-fog-100">{series.metadata?.title || series.name}</p>
      {/* Up and down whatever the language: a column of rows does not mirror. */}
      <button type="button" onClick={() => onMove(-1)} disabled={first} aria-label={tr('Move up')} aria-describedby={id}
        className="btn-key w-8 px-0" data-favorite-up>
        <IcChevronLeft width={14} height={14} className="rotate-90" aria-hidden />
      </button>
      <button type="button" onClick={() => onMove(1)} disabled={last} aria-label={tr('Move down')} aria-describedby={id}
        className="btn-key w-8 px-0" data-favorite-down>
        <IcChevronRight width={14} height={14} className="rotate-90" aria-hidden />
      </button>
      <button type="button" onClick={onRemove} aria-label={tr('Remove from favourites')} aria-describedby={id}
        className="btn-key w-8 px-0" data-favorite-remove>
        <IcX width={14} height={14} aria-hidden />
      </button>
    </li>
  );
}
