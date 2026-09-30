'use client';
// Find other sources: the review between "search the other sources for these series" and "follow what I chose"
// (bff lib/findSources.ts). Every place that starts a search opens this page; a run is a URL (`/admin/find/?run=`), so
// a closed tab or a reload comes back to the same review, and it fills in series by series while the search goes.
//
// The shape is the import review's (app/admin/import/page.tsx), because the job is the same: a machine proposes, a
// person confirms, and nothing happens until the one accent key. What a person must see before following a source:
// WHICH name matched ("matched via Only I Level Up"), and whether the chapter numbers line up both ways -- and, one
// press away, the source's whole chapter list beside the series'. Only a green match can be ticked. An amber one
// (the same name, chapter numbers that do not line up) is followed only on its own, from its chapter list, after a
// confirmation -- never in bulk. The idea and the review are @TIGamingTV's (PR #119).
//
// `/admin/find/` -- the trailing slash is load-bearing, see next.config.mjs (`trailingSlash: true`).
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLayer } from '@/lib/layers';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Img, Sheet } from '@/components/ui';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { FindPickSheet } from '@/components/FindPickSheet';
import { FindChapterList } from '@/components/FindChapterList';
import { FindRunRow, stopFind, whenLine } from '@/components/FindSources';
import { IcChevronLeft } from '@/components/icons';
import { seriesHref } from '@/lib/healthLinks';
import { t as tr } from '@/lib/i18n';
import { FIND_KEY, findError, useFindStatus } from '@/lib/useFindRun';
import { kickDownloads } from '@/lib/useServerDownloads';
import {
  candidateStatusColor, candidateStatusLabel, coverageLine, cutShort, findSummary, isOpen, itemLine, mayFollow, pickedFor,
  preselect, reviewHref, runStatusLine, unreachableText, verdictColor, verdictLabel,
  type FindCandidate, type FindItem, type FindReview,
} from '@/lib/findSources';

type Filter = 'all' | 'found' | 'none';

function CandidateRow({ c, full, selected, reviewing, onToggle, onChapters }: {
  c: FindCandidate;
  /** The series has as many ticked as it has free places: an unticked box locks. */
  full: boolean;
  selected: boolean;
  reviewing: boolean;
  onToggle: (id: string) => void;
  /** Open what this source lists, beside what the series has. */
  onChapters: (c: FindCandidate) => void;
}) {
  const open = isOpen(c);
  // Only a green match is ticked for the bulk follow; an amber one is followed on its own from its chapters.
  const tickable = reviewing && open && mayFollow(c);
  const cov = coverageLine(c);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/40 p-2.5" data-find-candidate={c.verdict}>
      {tickable ? (
        <input type="checkbox" checked={selected} disabled={full && !selected} onChange={() => onToggle(c.id)}
          className="size-4 shrink-0 rounded border-ink-600 bg-ink-800 accent-accent disabled:opacity-40" aria-label={tr('Follow this source')} />
      ) : <span className="size-4 shrink-0" aria-hidden />}
      <Img src={c.cover ? sourceCover(c.source, c.cover) : ''} alt="" fallbackSrc={c.cover || undefined} className="h-14 w-10 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <p dir="auto" className="line-clamp-2 break-words text-sm text-fog-100">{c.theirTitle || c.sourceSeriesId}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fog-400">
          <SourceIcon id={c.source} name={c.name} size={16} />
          <bdi className="truncate text-fog-300">{c.name}</bdi>
          <span className={verdictColor(c.verdict)}>· {verdictLabel(c.verdict)}</span>
          {c.manual && <span className="text-fog-500">· {tr('picked by hand')}</span>}
        </p>
        {/* Which name did it: the whole point is a source that calls the series something else, and a reviewer who
            cannot see why "Only I Level Up" is offered for "Solo Leveling" cannot confirm it. */}
        {c.theirName && <p dir="auto" className="text-[11px] text-fog-500" data-matched-via>{tr('matched via “{name}”', { name: c.theirName })}</p>}
        {cov && <p className={`text-[11px] ${c.verdict === 'ok' ? 'text-fog-500' : 'text-amber-400/80'}`}>{cov}</p>}
        {reviewing && open && !mayFollow(c) && <p className="text-[11px] text-fog-500">{tr('Check its chapters to follow it on its own.')}</p>}
        {c.status && <p className={`text-[11px] ${candidateStatusColor(c.status)}`}>{candidateStatusLabel(c.status)}</p>}
      </div>
      <button type="button" onClick={() => onChapters(c)} className="btn-key shrink-0" data-view-chapters>{tr('Chapters')}</button>
    </div>
  );
}

function ItemCard({ it, selected, reviewing, onToggle, onSearch, onChapters }: {
  it: FindItem; selected: Set<string>; reviewing: boolean;
  onToggle: (id: string) => void; onSearch: (it: FindItem) => void; onChapters: (c: FindCandidate) => void;
}) {
  const others = it.names.slice(1);
  const line = itemLine(it);
  const searchable = reviewing && it.freeSlots > 0 && it.state !== 'skipped' && it.state !== 'error';
  return (
    <div className="rounded-2xl border border-ink-800 bg-ink-900/30 p-3" data-find-item={it.state}>
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link href={seriesHref(it.seriesId)} dir="auto" className="line-clamp-2 break-words text-sm font-semibold text-fog-50 hover:underline">{it.title}</Link>
          <p className="text-[11px] text-fog-500">
            {it.primary ? tr('Main source: {name}', { name: it.primary.name }) : tr('No main source')}
            {it.following.length > 0 && <> · {tr('also follows {names}', { names: it.following.map((f) => f.name).join(', ') })}</>}
          </p>
          {others.length > 0 && (
            <p dir="auto" className="line-clamp-2 text-[11px] text-fog-600">{tr('Also searched as: {names}', { names: others.join(' · ') })}</p>
          )}
        </div>
        {searchable && <button type="button" onClick={() => onSearch(it)} className="btn-key shrink-0" data-find-by-hand>{tr('Search by hand')}</button>}
      </div>
      {line && (
        <p className="text-[11px] text-fog-500" data-find-note>
          {line}
          {it.state === 'done' && !it.candidates.length && it.unreachable > 0 && it.unreachable < it.asked && <> · {unreachableText(it.unreachable)}</>}
        </p>
      )}
      {it.candidates.length > 0 && (
        <div className="space-y-1.5">
          {it.freeSlots === 0 && it.candidates.some(isOpen) && (
            <p className="text-[11px] text-amber-400">{tr('Already follows as many other sources as a series may')}</p>
          )}
          {it.candidates.map((c) => (
            <CandidateRow key={c.id} c={c} reviewing={reviewing} full={pickedFor(it, selected) >= it.freeSlots}
              selected={selected.has(c.id)} onToggle={onToggle} onChapters={onChapters} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Earlier searches, when no run is named: each a link to its review. */
function RunList() {
  const { data } = useFindStatus({ poll: true });
  const runs = data?.recent ?? [];
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-1 text-sm font-semibold text-fog-100">{tr('Find other sources')}</p>
      <p className="mb-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
        {tr('Select series in the Library and choose Find other sources under More, or start it from a failing source on Health. The other sources are searched under every name a series goes by, and you choose what to follow here: nothing is followed before that.')}
      </p>
      {!runs.length && <p className="text-xs text-fog-500">{tr('No search for other sources has run yet.')}</p>}
      <ul role="list" className="divide-y divide-ink-800/70">
        {runs.map((r) => (
          <li key={r.id}>
            <Link href={reviewHref(r.id)} className="block py-2 hover:text-accent" data-find-run={r.status}>
              <span className="block text-sm text-fog-100">{runStatusLine(r.status)}{r.sourceName ? ` · ${r.sourceName}` : ''}</span>
              <span className="block text-[11px] text-fog-500">{whenLine(r)} · {findSummary(r, { status: false })}</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link href="/library/" className="btn-key mt-3">{tr('Go to the library')}</Link>
    </div>
  );
}

function FindReviewInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const runId = params.get('run');

  const { data, refetch, error } = useQuery({
    queryKey: ['find-review', runId],
    queryFn: () => api<FindReview>(`/api/admin/sources/find/${encodeURIComponent(runId!)}?adult=1`),
    enabled: !!runId && isAdmin,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
    // Polls while the server works: the search fills the review in series by series.
    refetchInterval: (q) => {
      const st = q.state.data?.run.status;
      return st === 'running' || st === 'linking' ? 2000 : false;
    },
  });
  const run = data?.run;
  // Stable per query result, or the prune effect below would loop (the import page's #185 note).
  const items = useMemo(() => data?.items ?? [], [data]);

  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picking, setPicking] = useState<FindItem | null>(null);
  // The match whose chapter list is open, by id: re-read from `items` on every poll, so its keys see it as it is now.
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState<'follow' | 'resume' | 'stop' | 'discard' | 'single' | null>(null);
  const [confirmSingle, setConfirmSingle] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // What THIS tab sent to follow, to say what came of it once the server has settled every one.
  const [sent, setSent] = useState<Set<string> | null>(null);

  // The selection follows the rows: a match the follow reached, or one closed as stale, leaves it.
  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const open = new Set(items.flatMap((it) => it.candidates.filter(isOpen).map((c) => c.id)));
      const kept = new Set([...s].filter((id) => open.has(id)));
      return kept.size === s.size ? s : kept;
    });
  }, [items]);

  useEffect(() => {
    if (error instanceof ApiError && error.status === 404) {
      toast(tr('That search is gone.'), 'info');
      router.replace('/admin/find/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per error
  }, [error]);

  const all = items.flatMap((it) => it.candidates);
  const refresh = () => {
    void refetch();
    void qc.invalidateQueries({ queryKey: FIND_KEY });
    void kickDownloads(qc);
  };

  // The follow this tab started has ended once every match it sent carries a status: say what came of it, and
  // refresh what the new sources change (the grid and its source counts, the series pages).
  useEffect(() => {
    if (!sent || run?.status === 'linking') return;
    const mine = all.filter((c) => sent.has(c.id));
    if (mine.length < sent.size || mine.some((c) => !c.status)) return;
    const followed = mine.filter((c) => c.status === 'linked').length;
    const not = mine.length - followed;
    toast(
      not ? tr('{followed} followed · {not} not followed', { followed, not })
        : followed === 1 ? tr('1 source followed') : tr('{n} sources followed', { n: followed }),
      not && !followed ? 'error' : 'success',
    );
    setSent(null);
    for (const k of [['library'], ['series']]) void qc.invalidateQueries({ queryKey: k });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per poll result; `all` is derived from it
  }, [data, sent]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = all.filter((c) => selected.has(c.id) && isOpen(c) && mayFollow(c));
  const foundCount = items.filter((it) => it.candidates.length > 0).length;
  const noneCount = items.filter((it) => it.state === 'done' && !it.candidates.length).length;
  const shown = items.filter((it) => filter === 'all' || (filter === 'found' ? it.candidates.length > 0 : it.state === 'done' && !it.candidates.length));
  const pending = items.filter((it) => it.state === 'pending').length;
  const searching = run?.status === 'running';
  const reviewing = !!run && run.status !== 'running' && run.status !== 'linking' && run.status !== 'failed';
  // The footer is there while a green match waits: a search that found none has nothing to follow.
  const followable = reviewing && all.some((c) => isOpen(c) && mayFollow(c));

  const act = async (what: NonNullable<typeof busy>, fn: () => Promise<unknown>, fallback: string) => {
    setBusy(what);
    try { await fn(); } catch (e) { toast(findError(e, fallback), 'error'); }
    setBusy(null);
    refresh();
  };
  const follow = () => act('follow', async () => {
    const r = await api<{ ids?: string[] }>(`/api/admin/sources/find/${runId}/follow`, { json: { candidateIds: chosen.map((c) => c.id) } });
    setSent(new Set(r.ids ?? chosen.map((c) => c.id)));
    setSelected(new Set());
  }, tr('Could not follow those'));
  const followOne = (id: string) => act('single', async () => {
    await api(`/api/admin/sources/find/candidates/${id}/follow`, { json: { confirm: true } });
    toast(tr('1 source followed'), 'success');
    setConfirmSingle(null);
    setViewing(null);
    for (const k of [['library'], ['series']]) void qc.invalidateQueries({ queryKey: k });
  }, tr('Could not follow that source'));
  const resume = () => act('resume', () => api(`/api/admin/sources/find/${runId}/resume`, { method: 'POST' }), tr('Could not start the search'));
  const stop = () => act('stop', () => stopFind(qc), tr('Could not stop the search'));
  const discard = () => act('discard', async () => {
    await api(`/api/admin/sources/find/${runId}`, { method: 'DELETE' });
    qc.removeQueries({ queryKey: ['find-review', runId] });
    setDiscarding(false);
    router.replace('/admin/find/');
  }, tr('Could not discard this search'));

  // The sticky "Follow selected" footer is a toolbar to the notices (lib/layers.ts), as the import page's is: on a
  // phone it rests on the bottom nav, where a notice would otherwise sit on it. Measured with its padding.
  const footerRef = useRef<HTMLDivElement>(null);
  useLayer('toolbar', isAdmin && followable, { ref: footerRef });

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  const viewed = viewing ? all.find((x) => x.id === viewing) ?? null : null;
  const viewedItem = viewed ? items.find((x) => x.id === viewed.itemId) ?? null : null;

  return (
    <div className="min-h-screen-d px-4 pb-10 pt-4 lg:px-0">
      <div className="mb-4 flex items-center gap-2">
        <button type="button" onClick={() => router.back()} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-fog-400 hover:text-fog-100" aria-label={tr('Back')}>
          <IcChevronLeft width={18} height={18} className="rtl:rotate-180" />
        </button>
        <h1 className="min-w-0 truncate font-display text-lg font-semibold text-fog-50">{tr('Find other sources')}</h1>
        {run && run.status !== 'linking' && (
          <button type="button" onClick={() => setDiscarding(true)} className="btn-key btn-key-danger ms-auto shrink-0">{tr('Discard')}</button>
        )}
      </div>

      {!runId ? <RunList /> : !run ? (
        <div className="skeleton h-32 rounded-2xl" />
      ) : (
        <div className="card grad-border wide p-4">
          <FindRunRow run={run} label={runStatusLine(run.status)} stopping={busy === 'stop'} onStop={searching ? () => { void stop(); } : undefined} />
          {searching && (
            <p className="mb-2 max-w-prose text-[11px] leading-relaxed text-fog-500">
              {tr('One series at a time, a few sources each, paced so no site is rushed: this takes a while for many series. You can leave this page; what it finds is kept here.')}
            </p>
          )}
          {cutShort(run.status) && pending > 0 && (
            <div className="mb-3">
              <button type="button" onClick={() => { void resume(); }} disabled={busy === 'resume'} className="btn-key" data-find-resume>
                {pending === 1 ? tr('Search the 1 series not searched yet') : tr('Search the {n} series not searched yet', { n: pending })}
              </button>
            </div>
          )}
          {data.hidden > 0 && (
            <p className="mb-2 text-[11px] text-fog-500">{data.hidden === 1 ? tr('1 series hidden by the 18+ filter') : tr('{n} series hidden by the 18+ filter', { n: data.hidden })}</p>
          )}
          <p className="mb-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
            {tr('Green: the same series, a name matches and the chapter numbers line up. Amber: a name matches exactly, the chapter numbers do not; check its chapters and follow it on its own if it is the same series. Nothing is downloaded: new chapters come from the followed sources on the next check.')}
          </p>
          {followable && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setSelected(preselect(items))} className="btn-key" data-find-preselect>{tr('Select exact matches')}</button>
              {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())} className="btn-key">{tr('Clear selection')}</button>}
            </div>
          )}

          <div className="mb-3 mt-1 flex flex-wrap gap-2">
            <button type="button" onClick={() => setFilter('all')} className={`chip text-xs ${filter === 'all' ? 'chip-active' : ''}`}>{tr('All')} · {items.length}</button>
            <button type="button" onClick={() => setFilter('found')} className={`chip text-xs ${filter === 'found' ? 'chip-active' : ''}`}>{tr('Found')} · {foundCount}</button>
            <button type="button" onClick={() => setFilter('none')} className={`chip text-xs ${filter === 'none' ? 'chip-active' : ''}`}>{tr('Nothing found')} · {noneCount}</button>
          </div>
          <div className="space-y-2">
            {shown.map((it) => (
              <ItemCard key={it.id} it={it} selected={selected} reviewing={reviewing} onToggle={toggle} onSearch={setPicking}
                onChapters={(c) => setViewing(c.id)} />
            ))}
          </div>

          {followable && (
            <div ref={footerRef} className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 mt-4 lg:bottom-0 lg:pb-4">
              <button type="button" onClick={() => { void follow(); }} disabled={busy === 'follow' || !chosen.length}
                className="btn-key btn-key-primary h-10 w-full shadow-lift" data-find-follow>
                {busy === 'follow' ? tr('Starting…') : chosen.length === 1 ? tr('Follow 1 selected source') : tr('Follow {n} selected sources', { n: chosen.length })}
              </button>
            </div>
          )}
        </div>
      )}

      {picking && <FindPickSheet item={picking} onClose={() => setPicking(null)} onAdded={refresh} />}

      {viewed && viewedItem && (
        <Sheet title={viewedItem.title} onClose={() => setViewing(null)} overBottomNav footer={
          <div className="flex gap-2">
            <button type="button" onClick={() => setViewing(null)} className="btn-key flex-1">{tr('Close')}</button>
            {reviewing && isOpen(viewed) && mayFollow(viewed) && (
              <button type="button" onClick={() => toggle(viewed.id)}
                disabled={!selected.has(viewed.id) && pickedFor(viewedItem, selected) >= viewedItem.freeSlots}
                className={`btn-key flex-1 ${selected.has(viewed.id) ? '' : 'btn-key-primary'}`}>
                {selected.has(viewed.id) ? tr('Unselect') : tr('Select this source')}
              </button>
            )}
            {reviewing && isOpen(viewed) && !mayFollow(viewed) && viewedItem.freeSlots > 0 && (
              <button type="button" onClick={() => setConfirmSingle(viewed.id)} className="btn-key flex-1 text-amber-300" data-follow-alone>
                {tr('Follow this one anyway')}
              </button>
            )}
          </div>
        }>
          <p className={`mb-2 text-[11px] ${verdictColor(viewed.verdict)}`}>
            {verdictLabel(viewed.verdict)}{viewed.theirName ? ` · ${tr('matched via “{name}”', { name: viewed.theirName })}` : ''}
          </p>
          <FindChapterList itemId={viewedItem.id} source={viewed.source} sourceSeriesId={viewed.sourceSeriesId} />
        </Sheet>
      )}

      {confirmSingle && (
        <ConfirmDialog
          title={tr('Follow this source even though its chapters do not line up?')}
          body={tr('Its name matches, but its chapter numbers do not match this series both ways. If it is a sequel, a spin-off or another edition, its chapters would be filed under this series. You can stop following a source from the series page at any time.')}
          confirmLabel={tr('Follow anyway')}
          danger
          busy={busy === 'single'}
          onConfirm={() => { void followOne(confirmSingle); }}
          onClose={() => setConfirmSingle(null)}
        />
      )}
      {discarding && (
        <ConfirmDialog
          title={tr('Discard this search?')}
          body={tr('What it found is thrown away. Sources already followed stay followed.')}
          confirmLabel={tr('Discard')}
          danger
          busy={busy === 'discard'}
          onConfirm={() => { void discard(); }}
          onClose={() => setDiscarding(false)}
        />
      )}
    </div>
  );
}

export default function FindReviewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <FindReviewInner />
    </Suspense>
  );
}
