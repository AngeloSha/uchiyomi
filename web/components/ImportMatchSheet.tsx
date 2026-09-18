'use client';
// The manual-search screen from issue #48's mockup: correcting one import row, on demand.
//
// Search is grouped BY SOURCE (one rail per provider) rather than by title, which is what
// `/api/sources/search-all` normally returns — Discover wants "who has this title", this wants "what does
// THIS provider call it", so a `groupBy=source` mode was added to the same endpoint (same fan-out, different
// shaping) instead of building a second search route.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Sheet, Img } from '@/components/ui';
import { ScrollRail } from '@/components/ScrollRail';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { IcCheck, IcSearch, IcX } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import type { ImportCandidate } from '@/lib/importBatch';
import type { Src } from '@/lib/sourceGroups';

interface SourceResult {
  source: string; sourceId: string; title: string; coverUrl?: string; inLibrary?: boolean;
}
interface SourceGroup { source: string; name: string; lang: string | null; results: SourceResult[] }
/** A pick under consideration — set by tapping a result card, not yet written to the candidate row. */
interface Pending { source: string; sourceId: string; title: string; coverUrl?: string }
/** The fields this screen reads off GET /api/sources/detail; see routes/sources.ts for the rest. */
interface Detail { title: string; coverUrl: string | null; count: number }

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Cover + title + chapter count for one pick, so "currently selected" and "new pick" render identically. */
function MiniCard({ label, title, coverUrl, sourceId, sourceLabel, count, loading }: {
  label: string; title: string; coverUrl?: string | null;
  /** Adapter id, e.g. `sw:123` — for the cover proxy, never shown. */
  sourceId: string;
  /** Human-readable source name, for display only. */
  sourceLabel: string;
  count?: number; loading?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-900/50 p-2">
      <Img src={coverUrl ? sourceCover(sourceId, coverUrl) : ''} alt="" fallbackSrc={coverUrl || undefined}
        className="h-16 w-11 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fog-500">{label}</p>
        <p className="truncate text-sm text-fog-100">{title}</p>
        <p className="truncate text-[11px] text-fog-400">
          {sourceLabel}{loading ? ` · ${tr('checking…')}` : count != null ? ` · ${tr('{n} chapters', { n: count })}` : ''}
        </p>
      </div>
    </div>
  );
}

export function ImportMatchSheet({ batchId, candidate, onClose }: {
  batchId: string;
  candidate: ImportCandidate;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [term, setTerm] = useState(candidate.backup_title);
  const debounced = useDebounced(term.trim(), 300);
  const [busy, setBusy] = useState<string | null>(null); // sourceId (or '__skip'/'__auto'/'__confirm') of the action in flight
  // A card tap SELECTS a pick for comparison; it is not written until "Use this pick" is pressed. That is
  // the whole point of this screen -- see the chapter-count delta below, which only exists to be looked at
  // before committing, not after.
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const { data, isFetching, error } = useQuery({
    queryKey: ['import-search-source', debounced],
    queryFn: () => api<{ content: SourceGroup[] }>(`/api/sources/search-all?groupBy=source&q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  // Source display names for the preview cards -- the candidate row only carries the source id.
  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: Src[] }>('/api/sources'),
    staleTime: 30_000,
  });
  const sourceName = (id: string | null | undefined): string => (id && sourcesData?.content.find((s) => s.id === id)?.name) || id || '';

  // The row's current pick, if it has one -- shown immediately on open, before anything is typed. Chapter
  // count is not stored on the candidate (it can change between the resolve pass and this screen opening),
  // so it is looked up the same way the add dialog looks it up: GET /api/sources/detail.
  const currentDetail = useQuery({
    queryKey: ['import-detail', candidate.match_source, candidate.match_source_id],
    queryFn: () => api<Detail>(`/api/sources/detail?source=${encodeURIComponent(candidate.match_source!)}&sourceId=${encodeURIComponent(candidate.match_source_id!)}`),
    enabled: !!candidate.match_source && !!candidate.match_source_id,
    staleTime: 60_000,
  });
  const pendingDetail = useQuery({
    queryKey: ['import-detail', pending?.source, pending?.sourceId],
    queryFn: () => api<Detail>(`/api/sources/detail?source=${encodeURIComponent(pending!.source)}&sourceId=${encodeURIComponent(pending!.sourceId)}`),
    enabled: !!pending,
    staleTime: 60_000,
  });
  const delta = currentDetail.data && pendingDetail.data ? pendingDetail.data.count - currentDetail.data.count : null;

  const patch = async (body: Record<string, unknown>) => {
    await api(`/api/admin/import/candidates/${candidate.id}`, { method: 'PATCH', json: body });
    await qc.invalidateQueries({ queryKey: ['import-batch', batchId] });
  };

  const confirmPending = async () => {
    if (!pending) return;
    setBusy('__confirm');
    try {
      await patch({ decision: 'manual', source: pending.source, sourceId: pending.sourceId, title: pending.title, coverUrl: pending.coverUrl });
      onClose();
    } catch (e: any) { toast(msgOf(e, tr('Could not save that pick')), 'error'); }
    setBusy(null);
  };

  const skip = async () => {
    setBusy('__skip');
    try { await patch({ decision: 'skip' }); onClose(); }
    catch (e: any) { toast(msgOf(e, tr('Could not skip this one')), 'error'); }
    setBusy(null);
  };

  const useAuto = async () => {
    setBusy('__auto');
    try { await patch({ decision: 'auto' }); onClose(); }
    catch (e: any) { toast(msgOf(e, tr('Could not restore the automatic match')), 'error'); }
    setBusy(null);
  };

  const groups = data?.content ?? [];

  return (
    <Sheet title={candidate.backup_title} onClose={onClose} overBottomNav>
      <div className="sticky top-0 -mx-4 mb-3 bg-ink-950/0 px-4 pb-2 pt-1 backdrop-blur-xs">
        <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2 focus-within:border-accent">
          <IcSearch width={17} height={17} className="text-fog-500" />
          <input
            ref={inputRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={tr('Search sources…')}
            autoCapitalize="none"
            className="w-full bg-transparent text-sm text-fog-50 outline-hidden placeholder:text-fog-500"
          />
          {term && (
            <button onClick={() => setTerm('')} className="text-fog-500" aria-label={tr('Clear')}>
              <IcX width={15} height={15} />
            </button>
          )}
        </div>
        <div className="mt-2.5 space-y-2">
          {candidate.match_source && candidate.match_source_id ? (
            <MiniCard label={tr('Currently selected')} title={candidate.match_title || candidate.backup_title}
              coverUrl={candidate.match_cover} sourceId={candidate.match_source!} sourceLabel={sourceName(candidate.match_source)}
              count={currentDetail.data?.count} loading={currentDetail.isFetching} />
          ) : (
            <div className="rounded-xl border border-dashed border-ink-700 px-3 py-2.5 text-center text-[11px] text-fog-500">
              {candidate.decision === 'skip' ? tr('Skipped — nothing will be imported for this title.') : tr('No match yet — pick one below.')}
            </div>
          )}

          {pending ? (
            <>
              <MiniCard label={tr('New pick')} title={pending.title} coverUrl={pending.coverUrl}
                sourceId={pending.source} sourceLabel={sourceName(pending.source)}
                count={pendingDetail.data?.count} loading={pendingDetail.isFetching} />
              {delta != null && (
                <p className={`text-center text-[11px] ${delta === 0 ? 'text-fog-500' : delta > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {delta === 0 ? tr('Same chapter count as the current pick')
                    : delta > 0 ? tr('+{n} chapters vs the current pick', { n: delta })
                    : tr('{n} fewer chapters than the current pick', { n: Math.abs(delta) })}
                </p>
              )}
              <div className="flex gap-2">
                <button onClick={() => setPending(null)} disabled={busy === '__confirm'} className="chip flex-1 py-1.5 text-xs disabled:opacity-50">
                  {tr('Cancel')}
                </button>
                <button onClick={confirmPending} disabled={busy === '__confirm'} className="btn-accent flex-1 py-1.5 text-xs disabled:opacity-50">
                  {busy === '__confirm' ? tr('Working…') : tr('Use this pick')}
                </button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <button onClick={skip} disabled={!!busy} className="chip flex-1 py-1.5 text-xs disabled:opacity-50">
                {busy === '__skip' ? tr('Working…') : tr('Skip this one')}
              </button>
              {candidate.auto_source_id && candidate.decision !== 'auto' && (
                <button onClick={useAuto} disabled={!!busy} className="chip flex-1 py-1.5 text-xs disabled:opacity-50">
                  {busy === '__auto' ? tr('Working…') : tr('Use the auto match')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {debounced.length < 2 ? (
        <p className="py-10 text-center text-sm text-fog-500">{tr('Type at least 2 characters to search.')}</p>
      ) : error ? (
        <p className="py-10 text-center text-sm text-fog-500">{tr('Search failed — try again.')}</p>
      ) : isFetching && !data ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton mb-1.5 h-4 w-32 rounded" />
              <div className="flex gap-2.5">
                {Array.from({ length: 4 }).map((_, j) => <div key={j} className="skeleton aspect-[2/3] w-24 shrink-0 rounded-lg" />)}
              </div>
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-fog-500">{tr('Nobody has that title yet.')}</p>
      ) : (
        <div className="space-y-4 pb-2">
          {groups.map((g) => (
            <div key={g.source}>
              <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-semibold text-fog-300">
                <SourceIcon id={g.source} name={g.name} size={16} />
                <span className="truncate">{g.name}{g.lang ? ` (${g.lang.toUpperCase()})` : ''}</span>
              </p>
              <ScrollRail className="hide-scrollbar gap-2.5 pb-1">
                {g.results.map((r) => {
                  const selected = pending?.source === g.source && pending?.sourceId === r.sourceId;
                  return (
                    <button
                      key={r.sourceId}
                      type="button"
                      onClick={() => setPending({ source: g.source, sourceId: r.sourceId, title: r.title, coverUrl: r.coverUrl })}
                      disabled={busy === '__confirm'}
                      className="w-24 shrink-0 text-start disabled:opacity-50"
                    >
                      <span className="relative block">
                        <Img src={sourceCover(g.source, r.coverUrl)} alt={r.title} fallbackSrc={r.coverUrl}
                          className={`aspect-[2/3] w-24 rounded-lg border ${selected ? 'border-accent ring-2 ring-accent' : 'border-ink-700'}`} />
                        {r.inLibrary && (
                          <span className="absolute end-1 top-1 grid size-5 place-items-center rounded-full bg-accent text-black">
                            <IcCheck width={12} height={12} />
                          </span>
                        )}
                        {selected && (
                          <span className="absolute bottom-1 start-1 rounded-md bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-black">
                            {tr('Comparing')}
                          </span>
                        )}
                      </span>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-tight text-fog-300">{r.title}</p>
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
