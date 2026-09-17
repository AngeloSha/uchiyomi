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

interface SourceResult {
  source: string; sourceId: string; title: string; coverUrl?: string; inLibrary?: boolean;
}
interface SourceGroup { source: string; name: string; lang: string | null; results: SourceResult[] }

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
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
  const [busy, setBusy] = useState<string | null>(null); // sourceId of the row being applied, for a per-card spinner state
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const { data, isFetching, error } = useQuery({
    queryKey: ['import-search-source', debounced],
    queryFn: () => api<{ content: SourceGroup[] }>(`/api/sources/search-all?groupBy=source&q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  const patch = async (body: Record<string, unknown>) => {
    await api(`/api/admin/import/candidates/${candidate.id}`, { method: 'PATCH', json: body });
    await qc.invalidateQueries({ queryKey: ['import-batch', batchId] });
  };

  const pick = async (g: SourceGroup, r: SourceResult) => {
    setBusy(r.sourceId);
    try {
      await patch({ decision: 'manual', source: g.source, sourceId: r.sourceId, title: r.title, coverUrl: r.coverUrl });
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
        <div className="mt-2 flex gap-2">
          <button onClick={skip} disabled={!!busy} className="chip flex-1 py-1.5 text-xs disabled:opacity-50">
            {busy === '__skip' ? tr('Working…') : tr('Skip this one')}
          </button>
          {candidate.auto_source_id && candidate.decision !== 'auto' && (
            <button onClick={useAuto} disabled={!!busy} className="chip flex-1 py-1.5 text-xs disabled:opacity-50">
              {busy === '__auto' ? tr('Working…') : tr('Use the auto match')}
            </button>
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
                {g.results.map((r) => (
                  <button
                    key={r.sourceId}
                    type="button"
                    onClick={() => pick(g, r)}
                    disabled={!!busy}
                    className="w-24 shrink-0 text-start disabled:opacity-50"
                  >
                    <span className="relative block">
                      <Img src={sourceCover(g.source, r.coverUrl)} alt={r.title} fallbackSrc={r.coverUrl}
                        className="aspect-[2/3] w-24 rounded-lg border border-ink-700" />
                      {r.inLibrary && (
                        <span className="absolute end-1 top-1 grid size-5 place-items-center rounded-full bg-accent text-black">
                          <IcCheck width={12} height={12} />
                        </span>
                      )}
                      {busy === r.sourceId && (
                        <span className="absolute inset-0 grid place-items-center rounded-lg bg-ink-950/60 text-[10px] text-fog-200">{tr('Working…')}</span>
                      )}
                    </span>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-tight text-fog-300">{r.title}</p>
                  </button>
                ))}
              </ScrollRail>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
