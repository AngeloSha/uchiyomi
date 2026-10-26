'use client';
// Attach or move a series to another source by hand (#243, @Squeaks72), for the series the automatic Find cannot judge:
// one with fewer than 3 chapters has nothing to line up, so a person picks the match.
//
// The search term is editable (it starts as the series' title; its other names are one tap away), the answer is one rail
// per source as in the import review's manual search, and a pick is compared -- cover, title, chapter count against what
// the series lists now -- before anything is written. POST /api/admin/series/:id/attach-source has no overlap gate, but it
// asks the source what the pick is called: when that is not the series' title or one of its other names it says so
// (`title_differs`), and only then does the footer offer Attach anyway, which sends `force`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { withAdult } from '@/lib/adult';
import { Sheet, Img } from '@/components/ui';
import { ScrollRail } from '@/components/ScrollRail';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { IcCheck, IcSearch, IcX } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { bookCountText } from '@/lib/format';
import { attachButtons, migrateTerms, sourcesParam } from '@/lib/migrateSource';
import { discoverSources, type Src } from '@/lib/sourceGroups';
import type { AltTitle } from '@/lib/findSources';
import { searchPoll, searchProgressLine, searchWait, type SearchProgress } from '@/lib/searchPoll';

interface SourceResult { sourceId: string; title: string; coverUrl?: string }
interface SourceGroup { source: string; name: string; lang: string | null; results: SourceResult[] }
interface Pick { source: string; sourceId: string; title: string; coverUrl?: string; name: string }
interface Detail { title: string; coverUrl: string | null; count: number }

/** A footer key that shares its row: equal widths, and room for a long word to wrap (btn-key is one line tall). */
const GROW = 'h-auto min-h-8 flex-1 py-1.5 text-center leading-tight';

/** A refusal's code, from a failed call's body. */
const errorCode = (e: ApiError): string => { try { return String(JSON.parse(e.body || '{}').error ?? ''); } catch { return ''; } };

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function MigrateSourceSheet({ id, title, attached, mainId, listed, onDone, onClose }: {
  id: string;
  title: string;
  /** Source ids the series already uses (main first): marked in the rails, and the main decides which buttons show. */
  attached: string[];
  mainId: string | null;
  /** How many chapters the series lists now, for the comparison. */
  listed: number | null;
  /** The attach went through: the page refetches. */
  onDone: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [term, setTerm] = useState(title);
  const debounced = useDebounced(term.trim(), 400);
  const [pick, setPick] = useState<Pick | null>(null);
  const [keepOld, setKeepOld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The source called the pick something else (`title_differs`): the action that was refused, for Attach anyway. */
  const [differs, setDiffers] = useState<'follower' | 'main' | null>(null);
  const [choosing, setChoosing] = useState(false);
  /** The ids to search; null means every source. */
  const [selected, setSelected] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const alts = useQuery({
    queryKey: ['series-alt-titles', id],
    queryFn: () => api<{ titles: AltTitle[] }>(`/api/admin/series/${encodeURIComponent(id)}/alt-titles`),
    staleTime: 60_000,
  });
  const terms = migrateTerms(title, (alts.data?.titles ?? []).map((a) => a.title));

  const srcs = useQuery({
    // Under a key of its own: this list is sorted for the sheet, and must not be the one Discover reads.
    queryKey: ['sources', 'migrate'],
    queryFn: () => api<{ content: Src[] }>(withAdult('/api/sources')),
    staleTime: 60_000,
  });
  // A to Z by name, so a source can be found by eye in a list of fifty; the server's order is install order. Never a
  // backup extension's (v0.82.0, lib/sourceGroups.ts discoverSources): the sources a person picks from are their own.
  const allSources = useMemo(
    () => discoverSources(srcs.data?.content ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id)),
    [srcs.data],
  );
  const allIds = allSources.map((s) => s.id);
  // Sources the series already uses are left out until asked for: they are the ones it cannot gain a new entry from.
  const fresh = allIds.filter((x) => !attached.includes(x));
  const pickedIds = selected ?? (fresh.length ? fresh : allIds);
  const only = sourcesParam(selected ?? pickedIds, allIds);
  const toggleSource = (sid: string) => {
    const cur = new Set(pickedIds);
    if (cur.has(sid)) cur.delete(sid); else cur.add(sid);
    setSelected(allIds.filter((x) => cur.has(x)));
  };

  // Polled while sources are still being asked (#353), as Discover's search is: the first answer holds only the
  // sources that beat the server's grace, so with many sources a slow one never showed here ("only 5 sources").
  const { data, isFetching, error } = useQuery({
    queryKey: ['migrate-search', debounced, only],
    queryFn: ({ signal, queryKey, client }) => api<{ content: SourceGroup[] } & SearchProgress>(
      withAdult(`/api/sources/search-all?groupBy=source&q=${encodeURIComponent(debounced)}${only ? `&sources=${encodeURIComponent(only)}` : ''}&wait=${searchWait(client.getQueryState(queryKey)?.dataUpdateCount ?? 0)}`),
      { signal },
    ),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
    refetchInterval: (qy) => searchPoll(qy.state.data),
  });
  const progress = searchProgressLine(data);
  const detail = useQuery({
    queryKey: ['migrate-detail', pick?.source, pick?.sourceId],
    queryFn: () => api<Detail>(withAdult(`/api/sources/detail?source=${encodeURIComponent(pick!.source)}&sourceId=${encodeURIComponent(pick!.sourceId)}`)),
    enabled: !!pick,
    staleTime: 60_000,
  });

  const act = async (as: 'follower' | 'main', force = false) => {
    if (!pick) return;
    setBusy(true);
    setRefusal(null);
    setDiffers(null);
    try {
      await api(`/api/admin/series/${encodeURIComponent(id)}/attach-source`, {
        json: { source: pick.source, sourceSeriesId: pick.sourceId, as, ...(as === 'main' ? { old: keepOld ? 'keep' : 'drop' } : {}), ...(force ? { force: true } : {}) },
      });
      toast(as === 'main' ? tr('{name} is now the main source', { name: `\u2068${pick.name}\u2069` }) : tr('Now also checking {name}', { name: `\u2068${pick.name}\u2069` }), 'success');
      onDone();
    } catch (e) {
      setRefusal(msgOf(e, tr('Could not attach that source')));
      if (e instanceof ApiError && e.status === 409 && errorCode(e) === 'title_differs') setDiffers(as);
    }
    setBusy(false);
  };

  const buttons = attachButtons(mainId);
  const groups = data?.content ?? [];
  const delta = detail.data && listed != null ? detail.data.count - listed : null;

  const footer = pick ? (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-900/50 p-2">
        <Img src={pick.coverUrl ? sourceCover(pick.source, pick.coverUrl) : ''} alt="" fallbackSrc={pick.coverUrl || undefined} className="h-16 w-11 shrink-0 rounded" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fog-100" dir="auto">{pick.title}</p>
          <p className="truncate text-[11px] text-fog-400">
            {pick.name}{detail.isFetching ? ` · ${tr('checking…')}` : detail.data ? ` · ${bookCountText(detail.data.count)}` : ''}
          </p>
          {delta != null && listed != null && (
            <p className={`text-[11px] ${delta >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {tr('This series lists {n} now', { n: listed })}
            </p>
          )}
        </div>
      </div>
      {refusal && <p role="alert" className="text-[11px] leading-relaxed text-amber-300" data-migrate-refusal>{refusal}</p>}
      {differs && (
        <button type="button" onClick={() => act(differs, true)} disabled={busy} className="btn-key w-full" data-migrate-anyway>
          {tr('Attach anyway')}
        </button>
      )}
      {buttons.main && mainId && (
        <label className="flex items-center gap-2 text-[11px] text-fog-400">
          <input type="checkbox" checked={keepOld} onChange={(e) => setKeepOld(e.target.checked)} className="accent-[rgb(var(--accent))]" />
          {tr('Keep the current main source as a backup')}
        </label>
      )}
      {/* Three keys share a phone's row: each may grow to two lines (a German or Russian label is three times
          "Cancel"), never spill out of a fixed-height key. */}
      <div className="flex gap-2">
        <button type="button" onClick={() => { setPick(null); setRefusal(null); setDiffers(null); }} disabled={busy} className={`btn-key ${GROW}`}>{tr('Cancel')}</button>
        {buttons.follower && (
          <button type="button" onClick={() => act('follower')} disabled={busy} className={`btn-key ${GROW}`} data-migrate-follow>
            {tr('Add as extra source')}
          </button>
        )}
        <button type="button" onClick={() => act('main')} disabled={busy} className={`btn-key btn-key-primary ${GROW}`} data-migrate-main>
          {busy ? tr('Working…') : buttons.follower ? tr('Move here') : tr('Use this source')}
        </button>
      </div>
    </div>
  ) : undefined;

  return (
    <Sheet title={tr('Add or move source')} onClose={onClose} overBottomNav footer={footer}>
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-ink-950/90 px-4 pb-2 pt-1 backdrop-blur-xs">
        <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2 focus-within:border-accent">
          <IcSearch aria-hidden width={17} height={17} className="text-fog-500" />
          <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tr('Search sources…')} aria-label={tr('Search sources…')}
            autoCapitalize="none" autoComplete="off" enterKeyHint="search" className="w-full bg-transparent text-sm text-fog-50 outline-hidden focus-visible:outline-accent focus-visible:outline-offset-0 placeholder:text-fog-500" data-migrate-term />
          {term && <button type="button" onClick={() => setTerm('')} className="text-fog-500" aria-label={tr('Clear')}><IcX aria-hidden width={15} height={15} /></button>}
        </div>
        {terms.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {terms.map((t) => (
              <button key={t} type="button" onClick={() => setTerm(t)} aria-pressed={t === term.trim()}
                className={`chip max-w-full truncate text-[11px] ${t === term.trim() ? 'chip-active' : ''}`}>{t}</button>
            ))}
          </div>
        )}
      </div>

      {allSources.length > 1 && (
        <div className="mb-3" data-migrate-sources>
          <button type="button" onClick={() => setChoosing((v) => !v)} aria-expanded={choosing}
            className="flex w-full items-center justify-between rounded-xl border border-ink-700 bg-ink-900/40 px-3 py-2 text-start text-xs text-fog-300">
            <span>{pickedIds.length < allIds.length ? tr('Searching {n} of {total} sources', { n: pickedIds.length, total: allIds.length }) : tr('Searching all {total} sources', { total: allIds.length })}</span>
            <span className="text-accent">{choosing ? tr('Done') : tr('Choose')}</span>
          </button>
          {choosing && (
            <div className="mt-2 rounded-xl border border-ink-700 bg-ink-900/40 p-2">
              <div className="mb-1 flex gap-3 px-1 text-[11px]">
                <button type="button" onClick={() => setSelected(allIds)} className="text-accent" data-migrate-sources-all>{tr('Select all')}</button>
                <button type="button" onClick={() => setSelected([])} className="text-accent" data-migrate-sources-none>{tr('Select none')}</button>
              </div>
              <div className="max-h-56 overflow-y-auto" data-lenis-prevent>
                {allSources.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-fog-200">
                    <input type="checkbox" checked={pickedIds.includes(s.id)} onChange={() => toggleSource(s.id)} className="accent-[rgb(var(--accent))]" />
                    <SourceIcon id={s.id} name={s.name} size={16} />
                    <span className="truncate">{s.name}{s.lang ? ` (${s.lang.toUpperCase()})` : ''}</span>
                    {attached.includes(s.id) && <Marker main={s.id === mainId} />}
                  </label>
                ))}
              </div>
              {selected && selected.length === 0 && (
                <p className="px-1 pt-1 text-[11px] text-amber-300">{tr('Pick at least one source to search them; searching all for now.')}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Who the search is still waiting on (#353): the rails below fill in as they answer. Polite, so a screen reader
          hears it change without the focus moving. */}
      {debounced.length >= 2 && progress && (
        <p className="mb-2 px-0.5 text-xs tabular-nums text-fog-500" aria-live="polite" data-search-progress>{progress}</p>
      )}
      {debounced.length < 2 ? (
        <p role="status" className="py-10 text-center text-sm text-fog-500">{tr('Type at least 2 characters to search.')}</p>
      ) : error ? (
        <p role="alert" className="py-10 text-center text-sm text-fog-500">{tr('Search failed — try again.')}</p>
      ) : isFetching && !data ? (
        <div role="status" aria-label={tr('Loading…')} className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton mb-1.5 h-4 w-32 rounded" />
              <div className="flex gap-2.5">{Array.from({ length: 4 }).map((_, j) => <div key={j} className="skeleton aspect-[2/3] w-24 shrink-0 rounded-lg" />)}</div>
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p role="status" className="py-10 text-center text-sm text-fog-500">{tr('Nobody has that title. Try another name above.')}</p>
      ) : (
        <div className="space-y-4 pb-2">
          {groups.map((g) => (
            <div key={g.source}>
              <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-semibold text-fog-300">
                <SourceIcon id={g.source} name={g.name} size={16} />
                <span className="truncate">{g.name}{g.lang ? ` (${g.lang.toUpperCase()})` : ''}</span>
                {attached.includes(g.source) && <Marker main={g.source === mainId} />}
              </p>
              <ScrollRail className="flex gap-2.5 pb-3">
                {g.results.map((r) => {
                  const selected = pick?.source === g.source && pick?.sourceId === r.sourceId;
                  return (
                    <button key={r.sourceId} type="button" disabled={busy} aria-pressed={selected}
                      onClick={() => { setRefusal(null); setDiffers(null); setPick({ source: g.source, sourceId: r.sourceId, title: r.title, coverUrl: r.coverUrl, name: g.name }); }}
                      className="w-24 shrink-0 text-start disabled:opacity-50">
                      <span className="relative block">
                        <Img src={sourceCover(g.source, r.coverUrl)} alt="" fallbackSrc={r.coverUrl}
                          className={`aspect-[2/3] w-24 rounded-lg border ${selected ? 'border-accent ring-2 ring-accent' : 'border-ink-700'}`} />
                        {selected && <span className="absolute end-1 top-1 grid size-5 place-items-center rounded-full bg-accent text-black"><IcCheck aria-hidden width={12} height={12} /></span>}
                      </span>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-tight text-fog-300" dir="auto">{r.title}</p>
                    </button>
                  );
                })}
              </ScrollRail>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** A source the series already uses, marked as a squared tag (no capsules for statuses: noPills.test.ts). */
function Marker({ main }: { main: boolean }) {
  return main
    ? <span className="shrink-0 rounded-[4px] border border-accent/40 px-1.5 text-[10px] leading-4 text-accent">{tr('main')}</span>
    : <span className="shrink-0 rounded-[4px] border border-ink-700 px-1.5 text-[10px] leading-4 text-fog-300">{tr('attached')}</span>;
}
