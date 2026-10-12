'use client';
// Save as list (v0.61.0): the Library's shelf as a smart list, a saved search answered afresh whenever it is opened.
//
// The keys sit at the end of the Library's active-filter row, which shows whenever the shelf is narrowed, run the
// other way or put in an order by its address: Save as list, and -- opened from a smart list's "Edit filters", which
// carries `?list=` -- Update "Name", which gives that list the shelf now on screen. Keys, not chips: the chips beside
// them are filters, these are actions (the owner's "no pills").
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { ACCENTS, homeIdsOf, isMine, type ListRow } from '@/lib/lists';
import { sameQuery, type SmartQuery } from '@/lib/libraryQuery';
import { Modal } from './ConfirmDialog';
import { Switch } from './Switch';
import { useToast } from './Toast';

/**
 * The lists this reader may read, counted for them (lib/lists.ts). Asked again on every mount by default, as the Lists
 * page always was: an item added from a series page changes a count. Home keeps its five minutes.
 */
export const useListsAll = (enabled = true, staleTime = 0) =>
  useQuery({ queryKey: ['lists-all'], queryFn: () => api<{ content: ListRow[] }>('/api/collections?scope=all'), staleTime, enabled });

/** Everything that shows a list or the lists, asked again after one changed. */
export function invalidateLists(qc: ReturnType<typeof useQueryClient>, id?: string) {
  for (const key of [['lists-all'], ['collections'], ['home'], ...(id ? [['collection', id]] : [])]) qc.invalidateQueries({ queryKey: key });
}

/** A name inside a sentence, isolated: in Arabic a Latin name would reorder the words around it. */
const iso = (s: string): string => `⁨${s}⁩`;

export function SaveListDialog({ query, suggested, onClose }: { query: SmartQuery; suggested: string; onClose: () => void }) {
  const { user, setSettings } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useListsAll();
  const [name, setName] = useState(suggested);
  const [accent, setAccent] = useState<string>(ACCENTS[0]);
  const [shared, setShared] = useState(false);
  const [onHome, setOnHome] = useState(false);
  const [busy, setBusy] = useState(false);
  // Home's choice is only known once the lists are: adding to an unknown choice would write over it.
  const homeIds = homeIdsOf(user?.settings?.homeCollections, data?.content ?? []);
  const homeFull = !data || homeIds.length >= 3;

  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const made = await api<ListRow>('/api/collections', { json: { name: n, accent, query, shared } });
      if (onHome && !homeFull) {
        const next = [...homeIds, made.id];
        setSettings({ homeCollections: next });
        // The list is made either way: a Home slot that would not save is said, and the list stays.
        await api('/api/settings', { method: 'PUT', json: { homeCollections: next } })
          .catch(() => { setSettings({ homeCollections: user?.settings?.homeCollections }); toast(tr('Could not save'), 'error'); });
      }
      invalidateLists(qc);
      toast(tr('Saved'), 'success', { link: { href: `/collection/?id=${made.id}`, label: tr('Open') } });
      onClose();
    } catch { toast(tr('Could not save'), 'error'); }
    setBusy(false);
  };

  return (
    <Modal title={tr('Save as list')} onClose={onClose}>
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} maxLength={120}
        aria-label={tr('Name')} placeholder={tr('Name')} data-save-list-name
        className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-fog-50 outline-hidden focus:border-accent" />
      <div className="mt-3 flex items-center gap-2">
        {ACCENTS.map((a, i) => (
          <button key={a} type="button" onClick={() => setAccent(a)} aria-label={tr('Colour {n}', { n: i + 1 })} aria-pressed={accent === a}
            className={`h-7 w-7 rounded-full transition ${accent === a ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-ink-900' : ''}`}
            style={{ background: a }} />
        ))}
      </div>
      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fog-100">{tr('Show on Home')}</span>
          {/* Home holds three lists; at three the switch says so by being off and still. */}
          <Switch on={onHome && !homeFull} onChange={setOnHome} disabled={homeFull} label={tr('Show on Home')} />
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-fog-100">{tr('Share with the household')}</span>
            <Switch on={shared} onChange={setShared} label={tr('Share with the household')} />
          </div>
          <p className="mt-1 text-xs text-fog-500">{tr('Everyone here can open it and sees only what they may open; only you can change it.')}</p>
        </div>
      </div>
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={save} disabled={!name.trim() || busy} className="btn-key btn-key-primary" data-save-list-go>{tr('Save')}</button>
      </div>
    </Modal>
  );
}

/**
 * The Library row's keys: Save as list, and Update "Name" when the shelf was opened from one of this reader's own smart
 * lists (`listId`, the address's `list`). Update is still while the shelf is the list's own search already.
 */
export function SaveListKeys({ query, suggested, listId }: { query: SmartQuery; suggested: string; listId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data } = useListsAll(!!listId);
  const list = listId ? data?.content.find((l) => l.id === listId && isMine(l) && l.kind === 'smart') : undefined;
  const update = async () => {
    if (!list || busy) return;
    setBusy(true);
    try {
      await api(`/api/collections/${list.id}`, { method: 'PATCH', json: { query } });
      invalidateLists(qc, list.id);
      toast(tr('Saved'), 'success', { link: { href: `/collection/?id=${list.id}`, label: tr('Open') } });
    } catch { toast(tr('Could not save'), 'error'); }
    setBusy(false);
  };
  return (
    <>
      {list && (
        <button type="button" onClick={update} disabled={busy || sameQuery(list.query, query)} className="btn-key" data-update-list>
          {tr('Update “{name}”', { name: iso(list.name) })}
        </button>
      )}
      <button type="button" onClick={() => setSaving(true)} className="btn-key" data-save-list>{tr('Save as list')}</button>
      {saving && <SaveListDialog query={query} suggested={suggested} onClose={() => setSaving(false)} />}
    </>
  );
}
