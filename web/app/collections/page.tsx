'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/lib/auth';
import { EmptyState } from '@/components/EmptyState';
import { ART } from '@/lib/art';
import { IcChevronLeft, IcChevronRight, IcHome, IcPlus, IcTrash } from '@/components/icons';
import { useRtl } from '@/components/ui';
import { t as tr } from '@/lib/i18n';
import { useLayer } from '@/lib/layers';
import { ACCENTS, homeIdsOf, isMine, type ListRow } from '@/lib/lists';
import { ListOwnerLine, ListTags } from '@/components/ListBits';
import { invalidateLists, useListsAll } from '@/components/SaveListDialog';

export type CollectionRow = ListRow;

/** A list's name inside a sentence, isolated: in Arabic a Latin name would reorder the words around it. */
const iso = (s: string): string => `\u2068${s}\u2069`;

export default function CollectionsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const rtl = useRtl();
  const { user, setSettings } = useAuth();
  const [homeSaving, setHomeSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  // The New collection dialog below, on the notices' layer stack (lib/layers.ts) while it is open: it toasts
  // "Failed to create" over itself.
  useLayer('dialog', creating);
  const [name, setName] = useState('');
  const [accent, setAccent] = useState<string>(ACCENTS[0]);
  // v0.61.0: every list this reader may read (lib/lists.ts) -- their own, hand-picked and smart, then the household's
  // shared ones -- in two sections. Its own key: ['collections'] stays the plain answer the series page's sheet reads.
  const { data, isLoading } = useListsAll();
  const items = data?.content ?? [];
  const mine = items.filter(isMine);
  const theirs = items.filter((c) => !isMine(c));
  const savedHome = user?.settings?.homeCollections;
  // Until the first edit, mirror Home's legacy first-three-nonempty choice.  An edit writes the complete,
  // valid list and thereby drops deleted or unreadable ids from an older setting. A shared list takes a Home slot
  // like the reader's own (v0.61.0); it never fills one nobody chose for it.
  const homeIds = homeIdsOf(savedHome, items);

  const saveHome = async (next: string[]) => {
    if (homeSaving) return;
    const previous = savedHome;
    setHomeSaving(true);
    setSettings({ homeCollections: next });
    try {
      await api('/api/settings', { method: 'PUT', json: { homeCollections: next } });
      qc.invalidateQueries({ queryKey: ['home'] });
    } catch {
      setSettings({ homeCollections: previous });
      toast(tr('Could not save'), 'error');
    } finally { setHomeSaving(false); }
  };

  const toggleHome = (id: string) => {
    const at = homeIds.indexOf(id);
    if (at >= 0) return void saveHome(homeIds.filter((x) => x !== id));
    if (homeIds.length >= 3) {
      toast(tr('Choose up to 3 lists for Home'), 'error');
      return;
    }
    void saveHome([...homeIds, id]);
  };

  const moveHome = (id: string, by: -1 | 1) => {
    const from = homeIds.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= homeIds.length) return;
    const next = [...homeIds];
    [next[from], next[to]] = [next[to], next[from]];
    void saveHome(next);
  };

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const c = await api<CollectionRow>('/api/collections', { json: { name: n, accent } });
      toast(tr('Collection created'), 'success');
      setCreating(false);
      setName('');
      invalidateLists(qc);
      router.push(`/collection/?id=${c.id}`);
    } catch { toast(tr('Could not create the collection'), 'error'); }
  };

  const remove = async (c: CollectionRow) => {
    if (!window.confirm(tr('Delete “{name}”? The series stay in your library.', { name: iso(c.name) }))) return;
    try {
      await api(`/api/collections/${c.id}`, { method: 'DELETE' });
      toast(tr('Deleted'), 'success');
      invalidateLists(qc);
    } catch { toast(tr('Failed'), 'error'); }
  };

  /** One list's card: the same for the reader's own and a shared one, which has no Delete and says whose it is. */
  const card = (c: CollectionRow) => (
    <div key={c.id} className="card group relative overflow-hidden p-4">
      <span aria-hidden className="absolute inset-y-0 start-0 w-1.5" style={{ background: c.accent || 'rgb(var(--accent))' }} />
      <Link href={`/collection/?id=${c.id}`} className="block ps-2">
        <p className="font-display text-lg font-semibold text-fog-50">{c.name}</p>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-fog-500">{Number(c.item_count) === 1 ? tr('1 series') : tr('{n} series', { n: Number(c.item_count) })}</span>
          <ListTags list={c} />
        </span>
        {c.owner && <ListOwnerLine owner={c.owner} className="mt-1.5" />}
      </Link>
      <div className="mt-3 flex items-center gap-1.5 ps-2">
        <button type="button" onClick={() => toggleHome(c.id)} disabled={homeSaving}
          aria-pressed={homeIds.includes(c.id)}
          className={`chip text-xs disabled:opacity-50 ${homeIds.includes(c.id) ? 'chip-active' : ''}`}>
          <IcHome width={13} height={13} aria-hidden />
          {homeIds.includes(c.id) ? tr('Home {n}', { n: homeIds.indexOf(c.id) + 1 }) : tr('Show on Home')}
        </button>
        {homeIds.includes(c.id) && homeIds.length > 1 && (
          <>
            <button type="button" disabled={homeSaving || homeIds.indexOf(c.id) === 0}
              onClick={() => moveHome(c.id, -1)} aria-label={tr('Move earlier')}
              className="grid h-8 w-8 place-items-center rounded-full border border-ink-700 text-fog-300 disabled:opacity-30">
              {rtl ? <IcChevronRight width={14} height={14} /> : <IcChevronLeft width={14} height={14} />}
            </button>
            <button type="button" disabled={homeSaving || homeIds.indexOf(c.id) === homeIds.length - 1}
              onClick={() => moveHome(c.id, 1)} aria-label={tr('Move later')}
              className="grid h-8 w-8 place-items-center rounded-full border border-ink-700 text-fog-300 disabled:opacity-30">
              {rtl ? <IcChevronLeft width={14} height={14} /> : <IcChevronRight width={14} height={14} />}
            </button>
          </>
        )}
      </div>
      {isMine(c) && (
        <button onClick={() => remove(c)} aria-label={tr('Delete “{name}”', { name: iso(c.name) })}
          className="absolute end-3 top-3 grid h-8 w-8 place-items-center rounded-full border border-ink-700 text-fog-500 opacity-0 transition group-hover:opacity-100">
          <IcTrash width={14} height={14} />
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen-d">
      <header className="safe-top flex items-center gap-2 px-4 pb-2 lg:px-0 lg:pt-6">
        <button onClick={() => router.back()} className="grid h-10 w-10 place-items-center rounded-full bg-ink-800/70 text-fog-100 lg:hidden">
          <IcChevronLeft width={22} height={22} />
        </button>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold lg:text-3xl">{tr('Collections')}</h1>
          <p className="mt-0.5 text-xs text-fog-500">{tr('Choose up to 3 lists for Home. Empty lists stay selected and appear when they have series.')}</p>
        </div>
        <button onClick={() => setCreating(true)} className="btn-accent ms-auto px-3.5 py-2 text-sm">
          <IcPlus width={16} height={16} aria-hidden />{tr('New collection')}
        </button>
      </header>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 px-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 lg:px-0">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState art={ART.emptyLibrary} title={tr('No collections yet')}
          sub={tr('Group series into reading lists — “Plan to read”, “Finished favorites”, anything. Create one and add series from any series page.')}
          cta={undefined} />
      ) : (
        <>
          {/* v0.61.0: the reader's own lists, then those someone else shares with the household -- read-only here, and
              never theirs to delete. A section is named only when there are two. */}
          {theirs.length > 0 && <h2 className="px-4 pt-4 font-display text-base font-semibold text-fog-100 lg:px-0">{tr('Your lists')}</h2>}
          {mine.length > 0 && <div className="grid grid-cols-1 gap-3 px-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 lg:px-0">{mine.map(card)}</div>}
          {theirs.length > 0 && (
            <>
              <h2 className="px-4 pt-6 font-display text-base font-semibold text-fog-100 lg:px-0">{tr('Shared with you')}</h2>
              <div className="grid grid-cols-1 gap-3 px-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 lg:px-0">{theirs.map(card)}</div>
            </>
          )}
        </>
      )}

      {creating && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-xs" onClick={() => setCreating(false)}>
          <div role="dialog" aria-modal="true" aria-label={tr('New collection')} className="glass w-full max-w-sm rounded-2xl border border-ink-700 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-display text-lg font-semibold">{tr('New collection')}</h3>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder={tr('e.g. Plan to read')} autoFocus
              className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-fog-50 outline-hidden focus:border-accent" />
            <div className="mt-3 flex items-center gap-2">
              {ACCENTS.map((a, i) => (
                <button key={a} onClick={() => setAccent(a)} aria-label={tr('Colour {n}', { n: i + 1 })} aria-pressed={accent === a}
                  className={`h-7 w-7 rounded-full transition ${accent === a ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-ink-900' : ''}`}
                  style={{ background: a }} />
              ))}
            </div>
            <button onClick={create} disabled={!name.trim()} className="btn-accent mt-4 w-full py-2.5 text-sm disabled:opacity-50">{tr('Create')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
