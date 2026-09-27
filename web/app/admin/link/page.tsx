'use client';
// Connect sources (bff lib/linkBatch.ts): the review between "search every source for these series" and
// "follow what I ticked". Started from the library's select bar with the chosen series; a batch is a URL
// (`/admin/link/?batch=`), so a closed tab or a reload comes back to the same review.
//
// The shape is the import review's (app/admin/import/page.tsx) because the job is the same one: a machine
// proposes, a person confirms, and nothing happens until the one accent button. What differs is what a
// person must be able to see before ticking: WHICH name matched ("matched via Only I Level Up"), and whether
// the chapter numbers line up both ways. A candidate whose numbers do not line up is shown in amber and never
// preselected; connecting one asks first, and the server records the override.
//
// `/admin/link/` -- the trailing slash is load-bearing, see next.config.mjs (`trailingSlash: true`).
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar, Sheet } from '@/components/ui';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { LinkPickSheet } from '@/components/LinkPickSheet';
import { LinkChapterList } from '@/components/LinkChapterList';
import { IcChevronLeft } from '@/components/icons';
import { relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import {
  isOpen, needsOverride, mayRun, preselect, pickedFor, verdictLabel, verdictColor, coverageLine, linkStatusLabel, linkStatusColor,
  linkBatchStateLabel, type LinkBatch, type LinkCandidate, type LinkItem,
} from '@/lib/linkBatch';

type Filter = 'all' | 'found' | 'none';

function CandidateRow({ c, full, selected, onToggle, onChapters }: {
  c: LinkCandidate;
  /** The series has as many ticked as it has free slots: an unticked box locks. */
  full: boolean;
  selected: boolean; onToggle: (id: string) => void;
  /** Open what this source lists, beside what the series has. */
  onChapters: (c: LinkCandidate) => void;
}) {
  const open = isOpen(c);
  const cov = coverageLine(c);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/40 p-2.5" data-link-candidate>
      {open ? (
        <input type="checkbox" checked={selected} disabled={full && !selected} onChange={() => onToggle(c.id)}
          className="size-4 shrink-0 rounded border-ink-600 bg-ink-800 accent-accent disabled:opacity-40" aria-label={tr('Connect this source')} />
      ) : <span className="size-4 shrink-0" aria-hidden />}
      <Img src={c.cover ? sourceCover(c.source, c.cover) : ''} alt="" fallbackSrc={c.cover || undefined} className="h-14 w-10 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 break-words text-sm text-fog-100">{c.their_title || c.source_series_id}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fog-400">
          <SourceIcon id={c.source} name={c.name} size={16} />
          <span className="truncate text-fog-300">{c.name}</span>
          <span className={verdictColor(c.verdict)}>· {verdictLabel(c.verdict)}</span>
          {c.manual && <span className="text-fog-500">· {tr('picked by hand')}</span>}
        </p>
        {/* Which name did it: the whole point of this feature is a source that calls the series something
            else, and a reviewer who cannot see why "Only I Level Up" is offered for "Solo Leveling" cannot
            confirm it. */}
        {c.their_name && (
          <p className="text-[11px] text-fog-500" data-matched-via>{tr('matched via “{name}”', { name: c.their_name })}</p>
        )}
        {cov && <p className={`text-[11px] ${c.verdict === 'ok' ? 'text-fog-500' : 'text-amber-400/80'}`}>{cov}</p>}
        {c.status && <p className={`text-[11px] ${linkStatusColor(c.status)}`}>{linkStatusLabel(c.status)}</p>}
      </div>
      <button type="button" onClick={() => onChapters(c)} className="chip shrink-0 text-xs" data-view-chapters>{tr('Chapters')}</button>
    </div>
  );
}

function ItemCard({ it, selected, onToggle, onSearch, onChapters, reviewing }: {
  it: LinkItem; selected: Set<string>; onToggle: (id: string) => void; onSearch: (it: LinkItem) => void;
  onChapters: (c: LinkCandidate) => void; reviewing: boolean;
}) {
  const others = it.names.slice(1);
  return (
    <div className="rounded-2xl border border-ink-800 bg-ink-900/30 p-3" data-link-item>
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link href={`/series/?id=${it.series_id}`} className="line-clamp-2 break-words text-sm font-semibold text-fog-50 hover:underline">{it.title}</Link>
          <p className="text-[11px] text-fog-500">
            {it.primary ? tr('Main source: {name}', { name: it.primary.name }) : tr('No main source')}
            {it.following.length > 0 && <> · {tr('also follows {names}', { names: it.following.map((f) => f.name).join(', ') })}</>}
          </p>
          {others.length > 0 && (
            <p className="line-clamp-2 text-[11px] text-fog-600">{tr('Also searched as: {names}', { names: others.join(' · ') })}</p>
          )}
        </div>
        {reviewing && it.freeSlots > 0 && (
          <button onClick={() => onSearch(it)} className="chip shrink-0 text-xs">{tr('Search by hand')}</button>
        )}
      </div>
      {it.state === 'pending' ? (
        <p className="text-[11px] text-fog-500">{tr('Waiting to be searched…')}</p>
      ) : it.state === 'error' ? (
        <p className="text-[11px] text-amber-400">{tr('This series could not be read — it may have been removed.')}</p>
      ) : it.candidates.length === 0 ? (
        <p className="text-[11px] text-fog-500">
          {it.unreachable
            ? tr('Not found on {n} sources asked ({m} did not answer).', { n: it.asked, m: it.unreachable })
            : tr('Not found on {n} sources asked.', { n: it.asked })}
        </p>
      ) : (
        <div className="space-y-1.5">
          {it.freeSlots === 0 && it.candidates.some(isOpen) && (
            <p className="text-[11px] text-amber-400">{tr('Already follows two other sources — stop following one from the series page first.')}</p>
          )}
          {it.candidates.map((c) => (
            <CandidateRow key={c.id} c={c} full={pickedFor(it, selected) >= it.freeSlots} selected={selected.has(c.id)} onToggle={onToggle} onChapters={onChapters} />
          ))}
        </div>
      )}
    </div>
  );
}

function LinkWizardInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const batchId = params.get('batch');

  const { data: list } = useQuery({
    queryKey: ['link-batches'],
    queryFn: () => api<{ content: (LinkBatch & { stale?: boolean })[] }>('/api/admin/link/batches'),
    enabled: !batchId && isAdmin,
    staleTime: 10_000,
  });

  const { data, refetch, error: batchError } = useQuery({
    queryKey: ['link-batch', batchId],
    queryFn: () => api<{ batch: LinkBatch; items: LinkItem[] }>(`/api/admin/link/batches/${batchId}`),
    enabled: !!batchId && isAdmin,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
    // Polls while the server works: the search fills the review in series by series.
    refetchInterval: (q) => {
      const st = q.state.data?.batch.state;
      return st === 'searching' || st === 'linking' ? 2000 : false;
    },
  });
  const batch = data?.batch;
  // Stable per query result, or the prune effect below would loop (the import page's #185 note).
  const items = useMemo(() => data?.items ?? [], [data]);

  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState<LinkItem | null>(null);
  // The candidate whose chapter list is open, by id: the row is re-read from `items` on every poll, so the
  // sheet's Select button always sees the candidate as it is now.
  const [viewing, setViewing] = useState<string | null>(null);
  // What THIS tab last sent to /run, for the linking card's count; null when the run started elsewhere.
  const [runIds, setRunIds] = useState<Set<string> | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);

  // The selection follows the rows: a candidate a run reached is no longer open and leaves it.
  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const open = new Set(items.flatMap((it) => it.candidates.filter(isOpen).map((c) => c.id)));
      const kept = new Set([...s].filter((id) => open.has(id)));
      return kept.size === s.size ? s : kept;
    });
  }, [items]);

  useEffect(() => {
    if (batchError instanceof ApiError && batchError.status === 404) {
      toast(tr('That batch is gone'), 'info');
      router.replace('/admin/link/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per error
  }, [batchError]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const all = items.flatMap((it) => it.candidates);
  const chosen = all.filter((c) => selected.has(c.id));
  const warnings = chosen.filter(needsOverride).length;
  const foundCount = items.filter((it) => it.candidates.length > 0).length;
  const shown = items.filter((it) => filter === 'all' || (filter === 'found' ? it.candidates.length > 0 : it.state === 'done' && it.candidates.length === 0));

  const run = async (override: boolean) => {
    if (!batchId || !chosen.length) return;
    setRunning(true);
    try {
      const ids = chosen.map((c) => c.id);
      const r = await api<{ ok: true; total: number; held?: number }>(`/api/admin/link/batches/${batchId}/run`, { json: { candidateIds: ids, override } });
      // Held back by the server (a warning sent without the override): they stay open to tick again.
      if (r.held) toast(tr('{n} left open — their chapters do not line up', { n: r.held }), 'info');
      // Only what the server will run: a held candidate never gets a status, and waiting on it would keep
      // this page from ever noticing the run had finished.
      setRunIds(new Set(chosen.filter((c) => mayRun(c, override)).map((c) => c.id)));
      setSelected(new Set());
      setConfirmOverride(false);
      refetch();
    } catch (e) { toast(msgOf(e, tr('Could not connect those')), 'error'); }
    setRunning(false);
  };
  const onRun = () => (warnings > 0 ? setConfirmOverride(true) : run(false));

  // The run this tab started has finished once every candidate it sent carries a status. Then: say what
  // happened, refresh what the new links change (the grid, its source filter counts, the series pages),
  // and go back to the library. Without this the page re-read the batch, which the server puts back to
  // `review` while any candidate is still unticked -- the same screen as before the tap, as though nothing
  // had been connected. A run started elsewhere (runIds null: a reload, another tab) is left alone.
  useEffect(() => {
    if (!runIds || !runIds.size || batch?.state === 'linking') return;
    const sent = all.filter((c) => runIds.has(c.id));
    if (sent.length < runIds.size || sent.some((c) => !c.status)) return;
    const linked = sent.filter((c) => c.status === 'linked').length;
    const failed = sent.length - linked;
    toast(
      failed
        ? tr('Done — {linked} connected · {failed} not connected', { linked, failed })
        : linked === 1 ? tr('Connected 1 source') : tr('Connected {n} sources', { n: linked }),
      failed && !linked ? 'error' : 'success',
    );
    setRunIds(null);
    for (const k of [['library'], ['library-sources'], ['series'], ['link-batches']]) qc.invalidateQueries({ queryKey: k });
    // Back where it was started from: the edit dialog starts a batch of one series, the library a selection.
    router.push(items.length === 1 ? `/series/?id=${items[0].series_id}` : '/library/');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per poll result; `all` is derived from it
  }, [data, runIds]);

  const resume = async () => {
    try { await api(`/api/admin/link/batches/${batchId}/resume`, { method: 'POST' }); refetch(); }
    catch (e) { toast(msgOf(e, tr('Could not resume')), 'error'); }
  };
  const discard = async () => {
    if (!batchId) return;
    setDiscardBusy(true);
    try {
      await api(`/api/admin/link/batches/${batchId}`, { method: 'DELETE' });
      qc.removeQueries({ queryKey: ['link-batch', batchId] });
      qc.invalidateQueries({ queryKey: ['link-batches'] });
      setDiscarding(false);
      router.replace('/admin/link/');
    } catch (e) { toast(msgOf(e, tr('Could not discard this batch')), 'error'); }
    setDiscardBusy(false);
  };

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  const reviewing = batch?.state === 'review';
  return (
    <div className="min-h-screen-d px-4 pb-10 pt-4 lg:px-0">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => router.push('/library/')} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-fog-400 hover:text-fog-100" aria-label={tr('Back')}>
          <IcChevronLeft width={18} height={18} className="rtl:rotate-180" />
        </button>
        <h1 className="min-w-0 truncate font-display text-lg font-semibold text-fog-50">{tr('Connect sources')}</h1>
        {batch && batch.state !== 'done' && (
          <button onClick={() => setDiscarding(true)} className="chip ms-auto shrink-0 text-xs">{tr('Discard')}</button>
        )}
      </div>

      {!batchId ? (
        <div className="card grad-border wide p-4">
          <p className="mb-1 text-sm font-semibold text-fog-100">{tr('Connect other sources to your series')}</p>
          <p className="mb-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
            {tr('Pick series in the Library (Select), then Connect sources. Every other source is searched under each name the series goes by; you confirm every match before anything is followed. A followed source is used when the main one is down or lacks a chapter.')}
          </p>
          {(list?.content ?? []).filter((b) => b.state !== 'done').map((b) => (
            <button key={b.id} onClick={() => router.replace(`/admin/link/?batch=${b.id}`)}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-ink-800/60">
              <span className="text-sm text-fog-100">{tr('{n} series', { n: b.total })} · <span className="text-fog-500">{relativeTime(b.created_at)}</span></span>
              <span className="text-[11px] text-fog-400">{b.stale ? tr('Interrupted — resume') : linkBatchStateLabel(b.state)}</span>
            </button>
          ))}
          <Link href="/library/" className="btn-ghost mt-2 inline-block px-3 py-1.5 text-xs">{tr('Go to the library')}</Link>
        </div>
      ) : !batch ? (
        <div className="skeleton h-32 rounded-2xl" />
      ) : (
        <div className="card grad-border wide p-4">
          {batch.state === 'searching' ? (
            <>
              <p className="mb-1 text-sm font-semibold text-fog-100">{batch.stale ? tr('The search was interrupted') : tr('Searching your sources…')}</p>
              <p className="mb-3 text-[11px] text-fog-500">
                {batch.stale
                  ? tr('The server restarted before this finished. Resume to pick up where it left off.')
                  : tr('Every source is asked under every name, so this takes a while for many series. You can leave this page; the results are kept.')}
              </p>
              <ProgressBar value={batch.total ? batch.searched / batch.total : 0} />
              <p className="mt-1.5 text-[11px] tabular-nums text-fog-500">{tr('{done}/{total}', { done: batch.searched, total: batch.total })}</p>
              {batch.stale && <button onClick={resume} className="btn-accent mt-3 w-full py-2 text-sm">{tr('Resume search')}</button>}
            </>
          ) : batch.state === 'linking' ? (
            <p className="text-sm font-semibold text-fog-100">
              {runIds
                ? tr('Connecting… {done}/{total}', { done: all.filter((c) => runIds.has(c.id) && !!c.status).length, total: runIds.size })
                : tr('Connecting…')}
            </p>
          ) : (
            <>
              <p className="mb-1 text-sm font-semibold text-fog-100">
                {batch.state === 'done'
                  ? tr('Done — {linked} connected · {failed} not connected', { linked: batch.linked, failed: batch.failed })
                  : tr('Found on other sources for {n} of {m} series', { n: foundCount, m: items.length })}
              </p>
              <p className="mb-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
                {tr('Green means a name matches exactly and the chapter numbers line up both ways. Amber means a name matches but the numbers do not — check before connecting. Nothing is downloaded; new chapters come from the connected sources on the next update.')}
              </p>
              {reviewing && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <button onClick={() => setSelected(preselect(items))} className="chip text-xs">{tr('Select exact matches')}</button>
                  {selected.size > 0 && <button onClick={() => setSelected(new Set())} className="chip text-xs">{tr('Clear selection')}</button>}
                  <span className="ms-auto text-[11px] text-fog-500">{tr('{n} selected', { n: selected.size })}</span>
                </div>
              )}
            </>
          )}

          <div className="mb-3 mt-3 flex flex-wrap gap-2">
            <button onClick={() => setFilter('all')} className={`chip text-xs ${filter === 'all' ? 'chip-active' : ''}`}>{tr('All')} · {items.length}</button>
            <button onClick={() => setFilter('found')} className={`chip text-xs ${filter === 'found' ? 'chip-active' : ''}`}>{tr('Found')} · {foundCount}</button>
            <button onClick={() => setFilter('none')} className={`chip text-xs ${filter === 'none' ? 'chip-active' : ''}`}>{tr('Nothing found')}</button>
          </div>
          <div className="space-y-2">
            {shown.map((it) => (
              <ItemCard key={it.id} it={it} selected={selected} onToggle={toggle} onSearch={setPicking}
                onChapters={(c) => setViewing(c.id)} reviewing={reviewing} />
            ))}
          </div>

          {reviewing && (
            <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 mt-4 lg:bottom-4">
              <button onClick={onRun} disabled={running || selected.size === 0} className="btn-accent w-full py-2.5 text-sm shadow-lift disabled:opacity-50">
                {running ? tr('Starting…') : tr('Connect selected — {n}', { n: selected.size })}
              </button>
            </div>
          )}
        </div>
      )}

      {picking && <LinkPickSheet item={picking} onClose={() => setPicking(null)} onAdded={() => refetch()} />}

      {(() => {
        const c = viewing ? all.find((x) => x.id === viewing) : null;
        const it = c ? items.find((x) => x.id === c.item_id) : null;
        if (!c || !it) return null;
        const sel = selected.has(c.id);
        const canTick = reviewing && isOpen(c) && (sel || pickedFor(it, selected) < it.freeSlots);
        return (
          <Sheet title={it.title} onClose={() => setViewing(null)} overBottomNav footer={
            <div className="flex gap-2">
              <button onClick={() => setViewing(null)} className="chip flex-1 py-1.5 text-xs">{tr('Close')}</button>
              {reviewing && isOpen(c) && (
                <button onClick={() => toggle(c.id)} disabled={!canTick}
                  className={`flex-1 py-1.5 text-xs disabled:opacity-50 ${sel ? 'chip' : 'btn-accent'}`}>
                  {sel ? tr('Unselect') : tr('Select this source')}
                </button>
              )}
            </div>
          }>
            <p className={`mb-2 text-[11px] ${verdictColor(c.verdict)}`}>{verdictLabel(c.verdict)}{c.their_name ? ` · ${tr('matched via “{name}”', { name: c.their_name })}` : ''}</p>
            <LinkChapterList itemId={it.id} source={c.source} sourceSeriesId={c.source_series_id} />
          </Sheet>
        );
      })()}

      {confirmOverride && (
        <ConfirmDialog
          title={warnings === 1 ? tr('Connect 1 source whose chapters do not line up?') : tr('Connect {n} sources whose chapters do not line up?', { n: warnings })}
          body={tr('Their name matches, but their chapter numbers do not match this series both ways. If it is a sequel, a spin-off or a different edition, its chapters would be filed under this series. You can stop following a source from the series page at any time.')}
          confirmLabel={tr('Connect anyway')}
          danger
          busy={running}
          onConfirm={() => run(true)}
          onClose={() => setConfirmOverride(false)}
        />
      )}
      {discarding && (
        <ConfirmDialog
          title={tr('Discard this batch?')}
          body={tr('The search results are thrown away. Sources already connected stay connected.')}
          confirmLabel={tr('Discard')}
          danger
          busy={discardBusy}
          onConfirm={discard}
          onClose={() => setDiscarding(false)}
        />
      )}
    </div>
  );
}

export default function LinkWizardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <LinkWizardInner />
    </Suspense>
  );
}
