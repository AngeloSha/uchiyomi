'use client';
// Connect sources' manual search: find the series on a source by hand when the search did not, or found the
// wrong one. One rail per source, as the import's match sheet (components/ImportMatchSheet.tsx) -- this asks
// "what does THIS source call it". A tap only marks a pick; "Check this one" sends it to the server, which
// judges it by the same exact-name and numbering rule as the search's own finds and adds it to the review.
// Nothing is followed from here.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Sheet, Img } from '@/components/ui';
import { ScrollRail } from '@/components/ScrollRail';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { IcSearch, IcX } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { verdictLabel, type LinkCandidate, type LinkItem } from '@/lib/linkBatch';
import { LinkChapterList } from '@/components/LinkChapterList';

interface SourceResult { source: string; sourceId: string; title: string; coverUrl?: string }
interface SourceGroup { source: string; name: string; lang: string | null; results: SourceResult[] }

export function LinkPickSheet({ item, onClose, onAdded }: {
  item: LinkItem;
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [term, setTerm] = useState(item.title);
  const [debounced, setDebounced] = useState(item.title.trim());
  useEffect(() => { const t = setTimeout(() => setDebounced(term.trim()), 300); return () => clearTimeout(t); }, [term]);
  const [pending, setPending] = useState<SourceResult | null>(null);
  // The pick's chapter list, in place of the search results: a second Sheet on top would share one Escape.
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // The series' own sources are not offered: following the primary lists every chapter twice, and one it
  // already follows is already connected.
  const taken = new Set([...(item.primary ? [item.primary.source] : []), ...item.following.map((f) => f.source)]);
  const { data, isFetching, error } = useQuery({
    queryKey: ['link-search-source', debounced],
    queryFn: () => api<{ content: SourceGroup[] }>(`/api/sources/search-all?groupBy=source&q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });
  const groups = (data?.content ?? []).filter((g) => !taken.has(g.source));

  const check = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api<{ ok: true; candidate: LinkCandidate | null }>(`/api/admin/link/items/${item.id}/candidates`, {
        json: { source: pending.source, sourceSeriesId: pending.sourceId },
      });
      const v = r.candidate?.verdict;
      toast(v ? tr('Added to the review: {verdict}', { verdict: verdictLabel(v) }) : tr('Added to the review'), v === 'ok' ? 'success' : 'info');
      onAdded();
      onClose();
    } catch (e) { toast(msgOf(e, tr('Could not check that one')), 'error'); }
    setBusy(false);
  };

  const footer = pending ? (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-900/50 p-2">
        <Img src={pending.coverUrl ? sourceCover(pending.source, pending.coverUrl) : ''} alt="" fallbackSrc={pending.coverUrl}
          className="h-16 w-11 shrink-0 rounded" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fog-500">{tr('New pick')}</p>
          <p className="truncate text-sm text-fog-100">{pending.title}</p>
          <p className="truncate text-[11px] text-fog-400">{groups.find((g) => g.source === pending.source)?.name ?? pending.source}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => { setPending(null); setPreview(false); }} disabled={busy} className="chip flex-1 py-1.5 text-xs disabled:opacity-50">{tr('Cancel')}</button>
        <button onClick={() => setPreview((v) => !v)} className="chip flex-1 py-1.5 text-xs" aria-pressed={preview}>
          {preview ? tr('Back to results') : tr('Chapters')}
        </button>
        <button onClick={check} disabled={busy} className="btn-accent flex-1 py-1.5 text-xs disabled:opacity-50">
          {busy ? tr('Checking…') : tr('Check this one')}
        </button>
      </div>
    </div>
  ) : (
    <p className="text-center text-[11px] text-fog-500">{tr('Tap a cover to check it against this series.')}</p>
  );

  return (
    <Sheet title={item.title} onClose={onClose} overBottomNav footer={footer}>
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-ink-950/90 px-4 pb-2 pt-1 backdrop-blur-xs">
        <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2 focus-within:border-accent">
          <IcSearch width={17} height={17} className="text-fog-500" />
          <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tr('Search sources…')}
            autoCapitalize="none" className="w-full bg-transparent text-sm text-fog-50 outline-hidden placeholder:text-fog-500" />
          {term && (
            <button onClick={() => setTerm('')} className="text-fog-500" aria-label={tr('Clear')}><IcX width={15} height={15} /></button>
          )}
        </div>
        {item.names.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.names.map((n) => (
              <button key={n} type="button" onClick={() => setTerm(n)} className={`chip text-[11px] ${term === n ? 'chip-active' : ''}`}>{n}</button>
            ))}
          </div>
        )}
      </div>

      {preview && pending ? (
        <LinkChapterList itemId={item.id} source={pending.source} sourceSeriesId={pending.sourceId} />
      ) : debounced.length < 2 ? (
        <p className="py-10 text-center text-sm text-fog-500">{tr('Type at least 2 characters to search.')}</p>
      ) : error ? (
        <p className="py-10 text-center text-sm text-fog-500">{tr('Search failed — try again.')}</p>
      ) : isFetching && !data ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex gap-2.5">
              {Array.from({ length: 4 }).map((_, j) => <div key={j} className="skeleton aspect-[2/3] w-24 shrink-0 rounded-lg" />)}
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
              <ScrollRail className="flex gap-2.5 pb-3">
                {g.results.map((r) => {
                  const selected = pending?.source === g.source && pending?.sourceId === r.sourceId;
                  return (
                    <button key={r.sourceId} type="button" disabled={busy}
                      onClick={() => { setPending({ source: g.source, sourceId: r.sourceId, title: r.title, coverUrl: r.coverUrl }); setPreview(false); }}
                      className="w-24 shrink-0 text-start disabled:opacity-50">
                      <Img src={sourceCover(g.source, r.coverUrl)} alt={r.title} fallbackSrc={r.coverUrl}
                        className={`aspect-[2/3] w-24 rounded-lg border ${selected ? 'border-accent ring-2 ring-accent' : 'border-ink-700'}`} />
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
