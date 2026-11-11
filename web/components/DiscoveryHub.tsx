'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { api, getCurrentUser } from '@/lib/api';
import { keys, t as tr } from '@/lib/i18n';
import { catalogItem, discoveryFiltersFrom, discoveryKey, EMPTY_DISCOVERY_STATE, filterDiscovery, isHiddenPick, mixCatalog, NO_DISCOVERY_FILTERS, recommendationItems, surprisePick, titleKey, writeDiscoveryFilters,
  type DiscoveryCountry, type DiscoveryFilters, type DiscoveryItem, type DiscoveryState } from '@/lib/discoveryHub';
import type { Pick } from '@/lib/forYou';
import { DiscoverHero, TrendingCard, type Trending } from './DiscoverHero';
import { ForYouBand } from './ForYouBand';
import { Modal, msgOf } from './ConfirmDialog';
import { ScrollRail } from './ScrollRail';
import { Img } from './ui';
import { sourceCover } from './cards';
import { IcBookmark, IcCheck, IcEyeOff, IcSearch, IcSliders, IcSparkle, IcX } from './icons';
import type { CardWhy } from './DiscoverHero';

const MOODS = keys('All genres', 'Fantasy', 'Action', 'Romance', 'Mystery', 'Comedy', 'Sports');
const COUNTRY_LABELS = keys('All', 'Manga', 'Manhwa', 'Manhua');
const COUNTRIES = ['all', 'JP', 'KR', 'CN'] as const;

type CatalogGroup = { country: DiscoveryCountry; items: Trending[] };
interface Props {
  heroTarget: HTMLElement | null;
  owner: string; state?: DiscoveryState; stateLoading: boolean; stateError: boolean; onRetryState: () => void;
  groups: CatalogGroup[]; picks: Pick[]; whyOf: (p: Pick) => CardWhy;
  waiting: boolean; failed: boolean; onRetry: () => void;
  onFind: (item: { id?: number | null; title: string }) => void;
  stateKey: readonly unknown[];
}

/** One personal page, built from the same cached catalog and recommendation answers as Discover's old rails. */
export function DiscoveryHub({ heroTarget, owner, state, stateLoading, stateError, onRetryState, groups, picks, whyOf, waiting, failed, onRetry, onFind, stateKey }: Props) {
  const qc = useQueryClient();
  const params = useSearchParams();
  const [filters, setFilters] = useState<DiscoveryFilters>(() => discoveryFiltersFrom(params));
  useEffect(() => {
    try { const u = new URL(window.location.href); u.search = writeDiscoveryFilters(u.searchParams, filters).toString();
      window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
    } catch { /* filters still work without history access */ }
  }, [filters]);
  const [preview, setPreview] = useState<DiscoveryItem | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<DiscoveryItem | null>(null);
  const lastSurprise = useRef<string | null>(null);
  const ownState = state ?? EMPTY_DISCOVERY_STATE;
  const hidden = useMemo(() => new Set(ownState.hidden), [ownState.hidden]);
  const saved = useMemo(() => new Set(ownState.saved.flatMap((it) => [discoveryKey(it), titleKey(it.title)])), [ownState.saved]);
  const catalog = useMemo(() => mixCatalog(groups.map((g) => g.items.map((t) => catalogItem(t, g.country)))), [groups]);
  const personal = useMemo(() => recommendationItems(picks, catalog, (p) => whyOf(p).reason ?? tr('Recommended for you')), [picks, catalog, whyOf]);
  const available = useMemo(() => mixCatalog([personal, catalog]), [personal, catalog]);
  const filtered = useMemo(() => filterDiscovery(available, filters, hidden), [available, filters, hidden]);
  const filteredCatalog = useMemo(() => filterDiscovery(catalog, filters, hidden), [catalog, filters, hidden]);
  const filteredPicks = picks.filter((p) => filtered.some((it) => discoveryKey(it) === discoveryKey(p) || titleKey(it.title) === titleKey(p.title)));
  const savedItems = filterDiscovery(ownState.saved, NO_DISCOVERY_FILTERS, hidden);
  // Keep the countries interleaved even when preferring wide art; stable dimensions hold the page while answers arrive.
  const hero = filteredCatalog.slice(0, 10);
  // Resolve an open preview from the CURRENT permitted answers during render, not an effect a frame later.
  const currentPreview = preview ? available.find((it) => discoveryKey(it) === discoveryKey(preview))
    ?? ownState.saved.find((it) => discoveryKey(it) === discoveryKey(preview)) : null;
  const previewItem = currentPreview && !isHiddenPick(currentPreview, hidden) ? currentPreview : null;
  const canChange = !!state && !stateLoading && !stateError && !busy;
  const isCurrent = () => getCurrentUser() === owner;

  useEffect(() => {
    // A new age/reveal answer can remove an open title; don't leave its old details visible above the new catalog.
    if (preview && !available.some((it) => discoveryKey(it) === discoveryKey(preview)) && !ownState.saved.some((it) => discoveryKey(it) === discoveryKey(preview))) setPreview(null);
  }, [available, ownState.saved, preview]);

  const feedback = async (item: DiscoveryItem, patch: { saved?: boolean; hidden?: boolean }) => {
    if (!canChange || !isCurrent()) return;
    setBusy(true); setError(''); setNotice('');
    const key = discoveryKey(item);
    try {
      const result = await api<{ key: string; saved: boolean; hidden: boolean }>(`/api/discover/items/${encodeURIComponent(key)}`, { method: 'PUT', json: { ...patch, item }, expectedOwnerId: owner });
      const resolved = { ...item, key: result.key };
      const same = (it: DiscoveryItem) => discoveryKey(it) === result.key || discoveryKey(it) === key || titleKey(it.title) === titleKey(item.title);
      if (!isCurrent()) return;
      qc.setQueryData<DiscoveryState>(stateKey, (old) => {
        if (!old) return old;
        const nextSaved = patch.saved === true ? [...old.saved.filter((it) => !same(it)), resolved]
          : patch.saved === false ? old.saved.filter((it) => !same(it)) : old.saved;
        let nextHidden = old.hidden;
        if (patch.hidden === true) nextHidden = [...new Set([...nextHidden, key, result.key, titleKey(item.title)])];
        if (patch.hidden === false) nextHidden = nextHidden.filter((k) => k !== key && k !== result.key && k !== titleKey(item.title));
        return { ...old, saved: nextSaved, hidden: nextHidden };
      });
      if (patch.hidden === true) { setUndo(item); setPreview(null); setNotice(tr('This title is hidden from your picks.')); }
      else if (patch.hidden === false) { setUndo(null); setNotice(tr('Title restored.')); }
      else setNotice(patch.saved ? tr('Saved for later') : tr('Removed from saved titles.'));
      void qc.invalidateQueries({ queryKey: stateKey });
    } catch (e) { if (isCurrent()) setError(msgOf(e, tr('Could not save your choice.'))); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const resetHidden = async () => {
    if (!canChange || !isCurrent()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/api/discover/hidden', { method: 'DELETE', expectedOwnerId: owner });
      if (!isCurrent()) return;
      qc.setQueryData<DiscoveryState>(stateKey, (old) => old ? { ...old, hidden: [] } : old);
      setUndo(null); setNotice(tr('Hidden picks restored.'));
      void qc.invalidateQueries({ queryKey: stateKey });
    } catch (e) { if (isCurrent()) setError(msgOf(e, tr('Could not save your choice.'))); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const surprise = () => {
    const n = new Uint32Array(1); crypto.getRandomValues(n);
    const item = surprisePick(filtered, lastSurprise.current, n[0] / 0x100000000);
    if (item) { lastSurprise.current = discoveryKey(item); setPreview(item); }
  };
  const openPick = (p: Pick) => {
    const item = personal.find((it) => discoveryKey(it) === discoveryKey(p));
    if (item) setPreview(item);
  };
  const collection = (title: string, items: DiscoveryItem[], kind: string) => items.length ? (
    <DiscoveryRail key={kind} title={title} kind={kind} items={items.slice(0, 20)} onPreview={setPreview} />
  ) : null;

  return (
    <div data-discovery-hub>
      {heroTarget && createPortal(<DiscoverHero slides={hero} waiting={waiting && !hero.length} onPick={(t) => setPreview(t as DiscoveryItem)} actionLabel={tr('Explore this title')} underChrome={false} />, heroTarget)}
      <section className="py-4" aria-label={tr('Your discovery interests')}>
        <DiscoveryFilterBar filters={filters} open={filtersOpen} onOpen={() => setFiltersOpen(true)} onClear={() => setFilters(NO_DISCOVERY_FILTERS)}
          onSurprise={surprise} surpriseDisabled={!filtered.length} />
        {stateError && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm" role="status">
          <p>{tr('Your saved picks could not be loaded. You can still browse.')}</p>
          <button type="button" className="btn-ghost mt-2 min-h-11 px-3 text-xs" onClick={onRetryState}>{tr('Try again')}</button>
        </div>}
        <div className={error || notice ? 'pt-3' : ''} aria-live="polite" aria-atomic="true">
          {error ? <p className="text-sm text-amber-300">{error}</p> : notice ? <div className="flex flex-wrap items-center gap-2 text-sm text-fog-300">
            <p>{notice}</p>{undo && <button type="button" disabled={!canChange} className="min-h-11 px-3 font-medium text-accent" onClick={() => void feedback(undo, { hidden: false })}>{tr('Undo')}</button>}
          </div> : null}
        </div>
      </section>
      {filteredPicks.length > 0 && <ForYouBand picks={filteredPicks} whyOf={whyOf} onPick={openPick} actionLabel={tr('Explore this title')} />}
      <section className="mb-5 mt-2 rounded-2xl border border-ink-700/70 bg-ink-900/30 p-4 lg:p-5" aria-label={tr('Saved for later')} data-discovery-saved>
        <div className="flex items-center gap-2"><IcBookmark width={18} height={18} className="text-accent" /><h2 className="font-display text-lg font-semibold">{tr('Saved for later')}</h2></div>
        <p className="mt-1 text-xs text-fog-500">{tr('Only you can see these picks. Saving does not download chapters.')}</p>
        {stateLoading ? <div className="mt-3 h-14 animate-pulse rounded-xl bg-ink-800/60" aria-label={tr('Loading…')} />
          : savedItems.length ? <ScrollRail label={tr('Saved for later')} className="mt-3 flex gap-3 pb-3 pt-2 [scroll-snap-type:x_mandatory]">
            {savedItems.map((item) => <TrendingCard key={discoveryKey(item)} t={item} onPick={setPreview} />)}
          </ScrollRail>
          : !stateError && <p className="py-4 text-sm text-fog-400">{tr('Open a title and save it here for another day.')}</p>}
      </section>
      {waiting && !available.length ? <div aria-label={tr('Loading…')} className="grid grid-cols-3 gap-3 pb-8 sm:grid-cols-5 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => <div key={i} className="skeleton aspect-[2/3] rounded-2xl" />)}
      </div> : <>
        {collection(tr('Worlds to escape into'), filteredCatalog.filter((it) => it.genres.includes('Fantasy') || it.genres.includes('Adventure')), 'worlds')}
        {collection(tr('Mystery & suspense'), filteredCatalog.filter((it) => it.genres.includes('Mystery') || it.genres.includes('Thriller')), 'mystery')}
        {collection(tr('Finished stories'), filteredCatalog.filter((it) => it.status === 'FINISHED'), 'finished')}
        {collection(tr('Trending across your interests'), filteredCatalog, 'trending')}
        {!filtered.length && <div className="card my-6 p-6 text-center" role="status">
          <p className="text-sm text-fog-400">{failed ? tr('Discover could not load titles right now.') : tr('No titles match these interests yet.')}</p>
          <button type="button" className="btn-ghost mt-4 min-h-11 px-4 text-sm" onClick={() => { setFilters(NO_DISCOVERY_FILTERS); if (failed) onRetry(); }}>{failed ? tr('Try again') : tr('Clear filters')}</button>
        </div>}
      </>}
      {filtersOpen && <DiscoveryFilterPanel filters={filters} onChange={setFilters} onClose={() => setFiltersOpen(false)}
        hiddenCount={ownState.hidden.length} canResetHidden={canChange} onResetHidden={() => void resetHidden()} />}
      {previewItem && <DiscoveryPreview item={previewItem} saved={isHiddenPick(previewItem, saved)} busy={busy} canChange={canChange}
        onClose={() => setPreview(null)} onFind={() => { const item = previewItem; setPreview(null); onFind(item); }}
        error={error} onSave={() => void feedback(previewItem, { saved: !isHiddenPick(previewItem, saved) })}
        onHide={() => void feedback(previewItem, { hidden: true })} />}
    </div>
  );
}

/** A single compact row; details are only rendered when someone asks for them. */
export function DiscoveryFilterBar({ filters, open = false, onOpen, onClear, onSurprise, surpriseDisabled }: {
  filters: DiscoveryFilters; open?: boolean; onOpen: () => void; onClear: () => void; onSurprise: () => void; surpriseDisabled: boolean;
}) {
  const active = [filters.country !== 'all' ? tr(COUNTRY_LABELS[COUNTRIES.indexOf(filters.country)]) : null,
    filters.genre ? tr(filters.genre) : null, filters.completed ? tr('Completed') : null].filter(Boolean);
  return <div className="flex min-w-0 items-center gap-2" data-discovery-filter-bar>
    <button type="button" className="btn-ghost min-h-11 min-w-0 flex-1 justify-start gap-2 rounded-xl px-3 text-sm sm:flex-none sm:max-w-[70%]"
      aria-haspopup="dialog" aria-expanded={open} onClick={onOpen} data-discovery-filters-trigger>
      <IcSliders width={17} height={17} className="shrink-0 text-accent" />
      <span className="shrink-0">{tr('Filters')}</span>
      {!!active.length && <><span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-md bg-accent-soft text-[11px] font-semibold text-accent">{active.length}</span>
        <span className="min-w-0 truncate text-xs font-normal text-fog-400" data-discovery-filter-summary>{active.join(' · ')}</span></>}
    </button>
    {!!active.length && <button type="button" onClick={onClear} className="btn-ghost min-h-11 min-w-11 shrink-0 rounded-xl px-2 text-fog-400"
      aria-label={tr('Clear filters')} title={tr('Clear filters')}><IcX width={15} height={15} /></button>}
    <button type="button" className="btn-ghost ms-auto min-h-11 min-w-11 shrink-0 gap-2 rounded-xl px-3 text-sm" onClick={onSurprise}
      disabled={surpriseDisabled} aria-label={tr('Surprise me')} title={tr('Surprise me')}>
      <IcSparkle width={17} height={17} className="text-accent" /><span className="hidden sm:inline">{tr('Surprise me')}</span>
    </button>
  </div>;
}

export function DiscoveryFilterPanel({ filters, onChange, onClose, hiddenCount, canResetHidden, onResetHidden }: {
  filters: DiscoveryFilters; onChange: (filters: DiscoveryFilters) => void; onClose: () => void;
  hiddenCount: number; canResetHidden: boolean; onResetHidden: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    // Include the shared modal's close key as well as the controls. Keyboard navigation stays inside
    // this dialog; the shared modal restores focus to the original Filters button on close.
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
        .filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => dialog.removeEventListener('keydown', trap);
  }, []);
  const choice = (selected: boolean) => `min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors ${selected
    ? 'border-accent/40 bg-accent-soft font-medium text-accent' : 'border-ink-700/70 bg-ink-900/30 text-fog-400 hover:border-ink-600 hover:text-fog-100'}`;
  return <Modal title={tr('Filters')} onClose={onClose} fieldFocus={false}>
    <div ref={ref} className="space-y-5" data-discovery-filter-panel>
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-fog-400">{tr('Series type')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label={tr('Series type')}>
          {COUNTRIES.map((country, i) => <button key={country} type="button" className={choice(filters.country === country)}
            aria-pressed={filters.country === country} onClick={() => onChange({ ...filters, country })}>{tr(COUNTRY_LABELS[i])}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-fog-400">{tr('Genre')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={tr('Genre')}>
          {MOODS.map((genre, i) => <button key={genre} type="button" className={choice(i === 0 ? filters.genre === null : filters.genre === genre)}
            aria-pressed={i === 0 ? filters.genre === null : filters.genre === genre}
            onClick={() => onChange({ ...filters, genre: i === 0 ? null : genre })}>{tr(genre)}</button>)}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-fog-400">{tr('Status')}</legend>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={tr('Status')}>
          <button type="button" className={choice(!filters.completed)} aria-pressed={!filters.completed}
            onClick={() => onChange({ ...filters, completed: false })}>{tr('All')}</button>
          <button type="button" className={choice(filters.completed)} aria-pressed={filters.completed}
            aria-label={tr('Completed series only')} onClick={() => onChange({ ...filters, completed: true })}>{tr('Completed')}</button>
        </div>
      </fieldset>
      <p className="text-xs leading-relaxed text-fog-500">{tr('Filters use known catalog details. A completed series may still have missing translations.')}</p>
      {hiddenCount > 0 && <button type="button" className="min-h-11 text-xs text-fog-400 hover:text-fog-100 disabled:opacity-50"
        disabled={!canResetHidden} onClick={onResetHidden}>{tr('Reset hidden picks')}</button>}
      <div className="flex items-center justify-between gap-3 border-t border-ink-700/70 pt-4">
        <button type="button" className="btn-ghost min-h-11 px-3 text-sm" onClick={() => onChange(NO_DISCOVERY_FILTERS)}>{tr('Clear filters')}</button>
        <button type="button" className="btn-accent min-h-11 px-5 text-sm" onClick={onClose}>{tr('Done')}</button>
      </div>
    </div>
  </Modal>;
}

export function DiscoveryRail({ title, kind, items, onPreview }: { title: string; kind: string; items: DiscoveryItem[]; onPreview: (it: DiscoveryItem) => void }) {
  return <section className="pb-4 pt-5 lg:pt-7" data-discovery-collection={kind}>
    <h2 className="mb-2 font-display text-xl font-semibold tracking-tight lg:text-2xl">{title}</h2>
    <ScrollRail label={title} className="bleed bleed-pad flex gap-3 pb-3 pt-2 [scroll-snap-type:x_mandatory]">
      {items.map((item) => <TrendingCard key={discoveryKey(item)} t={item} onPick={onPreview} />)}
    </ScrollRail>
  </section>;
}

export function DiscoveryPreview({ item, saved, busy, canChange, error, onClose, onFind, onSave, onHide }: {
  item: DiscoveryItem; saved: boolean; busy: boolean; canChange: boolean; error?: string;
  onClose: () => void; onFind: () => void; onSave: () => void; onHide: () => void;
}) {
  const status = item.status === 'FINISHED' ? tr('Completed') : item.status === 'RELEASING' ? tr('Ongoing') : null;
  return <Modal title={item.title} onClose={onClose} wide fieldFocus={false}>
    <div data-discovery-preview>
      <div className="flex items-start gap-4">
        <Img src={sourceCover(undefined, item.cover)} fallbackSrc={item.cover || undefined} alt={item.title} className="aspect-[2/3] w-28 shrink-0 overflow-hidden rounded-xl sm:w-36" />
        <div className="min-w-0">
          {item.reason && <p className="mb-2 text-xs font-medium text-accent" dir="auto">{item.reason}</p>}
          <div className="flex flex-wrap gap-1.5 text-xs text-fog-300">
            {item.country && <span className="chip text-xs">{tr(COUNTRY_LABELS[COUNTRIES.indexOf(item.country)])}</span>}
            {status && <span className="chip text-xs">{status}</span>}
            {item.score != null && <span className="chip text-xs">{item.score}%</span>}
          </div>
          {item.chapters != null && <p className="mt-2 text-xs text-fog-400">{item.chapters === 1 ? tr('1 chapter') : tr('{n} chapters', { n: item.chapters })}</p>}
          {!!item.genres.length && <p className="mt-2 text-xs leading-relaxed text-fog-400">{item.genres.join(' · ')}</p>}
        </div>
      </div>
      <p dir="auto" className="mt-4 whitespace-pre-line break-words text-sm leading-relaxed text-fog-300">{item.description || tr('No synopsis is available for this title yet.')}</p>
      <p className="mt-4 text-xs text-fog-500">{tr('Find a source to read a sample or add this series.')}</p>
      {error && <p role="alert" className="mt-3 text-sm text-amber-300">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-accent min-h-11 flex-1 px-4 py-3 text-sm" onClick={onFind}><IcSearch width={17} height={17} />{tr('Find a source')}</button>
        <button type="button" className="btn-ghost min-h-11 px-4 py-3 text-sm disabled:opacity-50" aria-pressed={saved} disabled={!canChange} onClick={onSave}>
          {saved ? <IcCheck width={17} height={17} /> : <IcBookmark width={17} height={17} />}{saved ? tr('Saved') : tr('Save for later')}
        </button>
      </div>
      <button type="button" className="mt-2 flex min-h-11 items-center gap-2 px-2 text-xs text-fog-400 hover:text-fog-100 disabled:opacity-50" disabled={!canChange} onClick={onHide}>
        <IcEyeOff width={16} height={16} />{busy ? tr('Updating…') : tr('Not interested')}
      </button>
    </div>
  </Modal>;
}

/** The short neutral first view while an account's remembered tab is restored. */
export function DiscoveryTabLoading() {
  return <div role="status" aria-busy="true" className="flex min-h-56 items-center justify-center rounded-2xl border border-ink-700/60 bg-ink-900/20 text-sm text-fog-400" data-discovery-tab-loading>
    {tr('Loading…')}
  </div>;
}
