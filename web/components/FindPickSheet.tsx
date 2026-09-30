'use client';
// Find other sources' search by hand: find the series on a source yourself when the search did not, or found the
// wrong book. One rail per source, as the import's match sheet (components/ImportMatchSheet.tsx) -- this asks "what
// does THIS source call it". A tap only marks a pick; "Check this one" sends it to the server, which judges it by the
// same rule as the search's own finds and adds it to the review -- or says why not (not a name of this series,
// numbered by posting order, followed already). Nothing is followed from here.
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Img, Sheet } from '@/components/ui';
import { ScrollRail } from '@/components/ScrollRail';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { IcSearch, IcX } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { findError } from '@/lib/useFindRun';
import { unreachableText, verdictLabel, type FindCandidate, type FindItem } from '@/lib/findSources';
import { FindChapterList } from '@/components/FindChapterList';

interface SourceResult { source: string; sourceId: string; title: string; coverUrl?: string }
interface SourceGroup { source: string; name: string; lang: string | null; results: SourceResult[] }
interface SourceLine { id: string; name: string; state: 'ok' | 'empty' | 'timeout' | 'failed' | 'skipped' | 'pending' }
interface SearchAnswer { content: SourceGroup[]; pending?: number; asked?: number; sources?: SourceLine[] }

/**
 * The server answers a search shortly after the FIRST source with a hit and keeps asking the rest; the answer says
 * how many are still `pending`. Here the first hit is nearly always the series' own main source -- which is hidden --
 * so one request showed "nobody has it" while every other source was still being asked. So the first request waits
 * the long wait, later ones join the running search with a short one, and it polls while anything is pending
 * (Discover's rule).
 */
const FIRST_WAIT_MS = 6000;
const POLL_WAIT_MS = 1500;
const POLL_MS = 1500;

export function FindPickSheet({ item, onClose, onAdded }: { item: FindItem; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  // What is in the box, and what was searched. ⚠️ Searched on Search (or a name), never per keystroke: every term is a
  // fan-out to every source, the search slots are shared and first-come, and a debounce searched "so", "solo",
  // "solo lev"… so that the title the admin finished typing queued behind all of them and came back empty.
  const [term, setTerm] = useState(item.title);
  const [searched, setSearched] = useState(item.title.trim());
  const search = (t: string) => { setTerm(t); setSearched(t.trim()); };
  const dirty = term.trim() !== searched;
  const [pending, setPending] = useState<SourceResult | null>(null);
  // The pick's chapter list, in place of the results: a second Sheet on top would share one Escape.
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // The series' own sources are not offered: its main source lists every chapter already, and one it follows is
  // followed already.
  const taken = new Set([...(item.primary ? [item.primary.source] : []), ...item.following.map((f) => f.source)]);
  const { data, isFetching, error } = useQuery({
    queryKey: ['find-search-source', searched],
    queryFn: ({ signal, queryKey, client }) => {
      const first = (client.getQueryState(queryKey)?.dataUpdateCount ?? 0) === 0;
      return api<SearchAnswer>(
        `/api/sources/search-all?groupBy=source&wait=${first ? FIRST_WAIT_MS : POLL_WAIT_MS}&q=${encodeURIComponent(searched)}`, { signal });
    },
    enabled: searched.length >= 2,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (qy) => (qy.state.data?.pending ? POLL_MS : false),
  });
  const still = data?.pending ?? 0;
  const groups = (data?.content ?? []).filter((g) => !taken.has(g.source));
  // Hits exist, but only on the sources this series reads from already: say that, not "nobody has it".
  const onlyTaken = !groups.length && (data?.content ?? []).length > 0;
  // Why an empty answer is empty: "nobody has it" is only true of the sources that were asked AND answered.
  const lines = data?.sources ?? [];
  const noAnswer = lines.filter((l) => l.state === 'timeout' || l.state === 'failed').length;

  const check = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api<{ candidate: FindCandidate | null }>(`/api/admin/sources/find/items/${encodeURIComponent(item.id)}/candidates`, {
        json: { source: pending.source, sourceSeriesId: pending.sourceId, cover: pending.coverUrl ?? null },
      });
      const v = r.candidate?.verdict;
      toast(v ? tr('Added to the review: {verdict}', { verdict: verdictLabel(v) }) : tr('Added to the review'), v === 'ok' ? 'success' : 'info');
      onAdded();
      onClose();
    } catch (e) { toast(findError(e, tr('Could not check that one')), 'error'); }
    setBusy(false);
  };

  const footer = pending ? (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-ink-700 bg-ink-900/50 p-2">
        <Img src={pending.coverUrl ? sourceCover(pending.source, pending.coverUrl) : ''} alt="" fallbackSrc={pending.coverUrl}
          className="h-16 w-11 shrink-0 rounded" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fog-500">{tr('Your pick')}</p>
          <p dir="auto" className="truncate text-sm text-fog-100">{pending.title}</p>
          <p className="truncate text-[11px] text-fog-400">{groups.find((g) => g.source === pending.source)?.name ?? pending.source}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => { setPending(null); setPreview(false); }} disabled={busy} className="btn-key flex-1">{tr('Cancel')}</button>
        <button type="button" onClick={() => setPreview((v) => !v)} className="btn-key flex-1" aria-pressed={preview}>
          {preview ? tr('Back to results') : tr('Chapters')}
        </button>
        <button type="button" onClick={() => { void check(); }} disabled={busy} className="btn-key btn-key-primary flex-1" data-find-check>
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
        <form role="search" onSubmit={(e) => { e.preventDefault(); search(term); }}
          className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-3 py-2 focus-within:border-accent">
          <IcSearch width={17} height={17} className="text-fog-500" />
          <input ref={inputRef} dir="auto" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={tr('Search sources…')}
            enterKeyHint="search" autoCapitalize="none" className="w-full bg-transparent text-sm text-fog-50 outline-hidden placeholder:text-fog-500" />
          {term && <button type="button" onClick={() => setTerm('')} className="text-fog-500" aria-label={tr('Clear')}><IcX width={15} height={15} /></button>}
          <button type="submit" disabled={term.trim().length < 2 || !dirty} className="btn-key h-7 shrink-0">{tr('Search')}</button>
        </form>
        {item.names.length > 1 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.names.map((n) => (
              <button key={n} type="button" dir="auto" onClick={() => search(n)} className={`chip text-[11px] ${searched === n.trim() ? 'chip-active' : ''}`}>{n}</button>
            ))}
          </div>
        )}
      </div>

      {preview && pending ? (
        <FindChapterList itemId={item.id} source={pending.source} sourceSeriesId={pending.sourceId} />
      ) : searched.length < 2 ? (
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
        <p className="py-10 text-center text-sm text-fog-500" data-search-empty>
          {still > 0
            ? (still === 1 ? tr('Still asking 1 source…') : tr('Still asking {n} sources…', { n: still }))
            : onlyTaken ? tr('Only found on sources this series reads from already.')
            : tr('No other source lists it under this name.')}
          {still === 0 && noAnswer > 0 && <span className="mt-1 block text-[11px] text-fog-600">{unreachableText(noAnswer)}</span>}
        </p>
      ) : (
        <div className="space-y-4 pb-2">
          {still > 0 && (
            <p className="text-center text-[11px] text-fog-500">{still === 1 ? tr('Still asking 1 source…') : tr('Still asking {n} sources…', { n: still })}</p>
          )}
          {groups.map((g) => (
            <div key={g.source}>
              <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-semibold text-fog-300">
                <SourceIcon id={g.source} name={g.name} size={16} />
                <bdi className="truncate">{g.name}{g.lang ? ` (${g.lang.toUpperCase()})` : ''}</bdi>
              </p>
              <ScrollRail className="flex gap-2.5 pb-3">
                {g.results.map((r) => {
                  const chosen = pending?.source === g.source && pending?.sourceId === r.sourceId;
                  return (
                    <button key={r.sourceId} type="button" disabled={busy}
                      onClick={() => { setPending({ source: g.source, sourceId: r.sourceId, title: r.title, coverUrl: r.coverUrl }); setPreview(false); }}
                      className="w-24 shrink-0 text-start disabled:opacity-50">
                      <Img src={sourceCover(g.source, r.coverUrl)} alt={r.title} fallbackSrc={r.coverUrl}
                        className={`aspect-[2/3] w-24 rounded-lg border ${chosen ? 'border-accent ring-2 ring-accent' : 'border-ink-700'}`} />
                      <p dir="auto" className="mt-1 line-clamp-2 text-[11px] leading-tight text-fog-300">{r.title}</p>
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
