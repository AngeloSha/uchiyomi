'use client';
// What a "Find other sources" run did, and where to see it (v0.49.1).
//
// - FindRunRow: the running run, or the newest finished one, as one action row: how far it has got and what it is
//   on, with its Stop; then what it did, and how long it took. The same row heads the results and sits on Health.
// - FindResultsSheet: which series got which sources, which found nothing and why, which were skipped, and which the
//   run never reached -- "not tried" is its own section, never "nothing found", with a key to search those now.
//   Opened from the run's Server tasks card (Library -> Downloads) and from Health.
// - FindRunCard: Health's card for it, under the checks, while there is a run to show.
// - Review first (v0.51.0, #132; @TIGamingTV's idea from PR #133): FindStartDialog asks how a search should follow
//   what it finds -- automatically (the default) or after a review -- and ReviewSeries shows a review's matches the
//   way the Backup Import shows its picks: our cover beside each match's, its source and chapter count, the line-up
//   in words, and Follow / Skip. "Follow all green" follows every green match at once; an amber one only on its own.
//
// The run itself is the server's (POST /api/admin/sources/find); GET says how far the running one has got, or what the
// newest one did, and keeps the newest twenty. The idea, the other-names list and the name parsing are @TIGamingTV's
// (PR #119).
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { durationText, relativeTime } from '@/lib/format';
import { runStatusWord } from '@/lib/healthCopy';
import { seriesHref } from '@/lib/healthLinks';
import { IDLE, type ActionState } from '@/lib/actionState';
import {
  amberNote, bulkOutcome, decideRefusal, earlierRuns, findReviewFirst, findRunState, findSlotState, findSummary, findWhyLine,
  greenToFollow, groupResults, lineUpText, notTriedIds, setFindReviewFirst, toMs, type FindProposal, type FindResult, type FindRun,
  type FindRunSummary, type FindStatus,
} from '@/lib/findSources';
import { FIND_KEY, codeOf, fetchFind, fetchFindRun, useFindRun, useFindRuns } from '@/lib/useFindRun';
import { kickDownloads } from '@/lib/useServerDownloads';
import { ActionKeys, ActionList, ActionStatus, type ActionSpec } from '@/components/ActionList';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { sourceCover } from '@/components/cards';
import { SourceIcon } from '@/components/SourcePicker';
import { Img, OnBody, Sheet } from '@/components/ui';

/** "3h ago", or while it runs "Started 5 min ago": when, beside the run's name. */
function whenLine(run: FindRunSummary): string {
  if (run.status === 'running') {
    const at = toMs(run.startedAt);
    return Number.isFinite(at) ? tr('Started {time} ago', { time: durationText(Date.now() - at) }) : '';
  }
  const at = toMs(run.finishedAt ?? run.startedAt);
  return Number.isFinite(at) ? relativeTime(new Date(at).toISOString()) : '';
}

/**
 * The run as one action row. While it runs the row's key is Stop (at once: the series in flight is not tried unless
 * it already followed a source); a finished run has no key -- its words are what it did. `label` is the run's name,
 * or -- where the sheet's title already is the name -- its status, which the line under it then does not say again.
 */
export function FindRunRow({ run, onStop, stopping, label }: { run: FindRun; onStop?: () => void; stopping?: boolean; label?: string }) {
  const running = run.status === 'running';
  const spec: ActionSpec = {
    id: 'find-run',
    label: label ?? tr('Other-source search'),
    what: whenLine(run),
    state: findRunState(run, { onStop, stopping, status: label === undefined }),
    ...(running && onStop ? { onRun: onStop, buttonProps: { 'data-find-stop': '' } as ActionSpec['buttonProps'] } : {}),
  };
  return <ActionList actions={[spec]} />;
}

/**
 * One series and what became of it. The server leaves the title out for a series this admin may not list -- the 18+
 * hide, a tidy screen they chose -- and the row says so instead: an empty link read as a blank line between two
 * series (the review's s5-01), and a name of the page's own making would be one the series does not have. Not a link
 * either: its only words would be the placeholder.
 */
export function FindResultRow({ r, onOpen }: { r: FindResult; onOpen: () => void }) {
  return (
    <li data-find-result={r.seriesId} className="min-w-0 py-2">
      {r.title
        ? <Link href={seriesHref(r.seriesId)} onClick={onOpen} className="block truncate text-sm text-fog-100 hover:text-accent" dir="auto">{r.title}</Link>
        : <p data-find-hidden className="truncate text-sm text-fog-500">{tr('Hidden by the 18+ filter')}</p>}
      {r.followed.length > 0
        ? r.followed.map((f) => (
          <p key={f.sourceId} className="mt-0.5 flex min-w-0 gap-1.5 text-[11px] text-fog-400">
            <bdi className="truncate text-fog-200">{f.name}</bdi>
            {f.chapters != null && <span className="shrink-0 tabular-nums text-fog-500">{f.chapters === 1 ? tr('1 chapter') : tr('{n} chapters', { n: f.chapters })}</span>}
          </p>
        ))
        : r.why !== 'not_tried' && <p className="mt-0.5 text-[11px] leading-relaxed text-fog-500">{findWhyLine(r.why)}</p>}
    </li>
  );
}

function Group({ id, title, rows, note, onOpen }: { id: string; title: string; rows: FindResult[]; note?: string; onOpen: () => void }) {
  if (!rows.length) return null;
  return (
    <section data-find-group={id} aria-labelledby={`find-${id}`} className="mt-4">
      <h3 id={`find-${id}`} className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-fog-500">
        {title}<span className="tabular-nums text-fog-600">{rows.length}</span>
      </h3>
      {note && <p className="mt-1 text-[11px] leading-relaxed text-fog-500">{note}</p>}
      <ul role="list" className="divide-y divide-ink-800/70">
        {rows.map((r) => <FindResultRow key={r.seriesId} r={r} onOpen={onOpen} />)}
      </ul>
    </section>
  );
}

/**
 * The newest run's results, in four groups. `poll`: ask again every 2 s while it runs -- off where a follower on the
 * page already does (Health's FindRunProvider), since every observer with an interval polls on its own timer.
 *
 * An earlier search opens in its place (v0.52.0): each one under Earlier searches is a key, and its results are read by
 * its id -- a review-first run's matches can be followed or skipped there as on the newest. Its own query, under
 * FIND_KEY, so the refetch every decision ends with reads it again; and finished, so it is never polled.
 */
export function FindResultsSheet({ onClose, poll = true }: { onClose: () => void; poll?: boolean }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: FIND_KEY,
    queryFn: fetchFind,
    enabled: isAdmin,
    retry: false,
    refetchInterval: poll ? (qq) => (qq.state.data?.running ? 2000 : false) : undefined,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  // Opening a run (or going back to the latest) starts the sheet at its top: the keys are at the bottom, under the
  // results, and the run they open would otherwise begin a screen above where the reader is.
  const top = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (shown.current === openId) return;
    shown.current = openId;
    top.current?.scrollIntoView({ block: 'start' });
  }, [openId]);
  const opened = useQuery({
    queryKey: [...FIND_KEY, 'run', openId],
    queryFn: () => fetchFindRun(openId!),
    enabled: isAdmin && !!openId,
    retry: false,
  });
  // A search of what the run never reached, from here: the same route, the same one-run rule.
  const again = useFindRuns({ enabled: false });
  const [stopping, setStopping] = useState<string | null>(null);
  const data: FindStatus | undefined = q.data;
  const run = openId ? opened.data?.run ?? null : data?.run ?? null;
  const g = groupResults(run?.results);
  // What the run never reached, once it is over -- stopped, out of time, or cut short by a restart, whose unreached
  // series the server lists as not tried exactly as a stop's.
  const untried = run && run.status !== 'running' ? notTriedIds(run) : [];
  const retry = again.slots.retry;
  const stop = async () => {
    if (!run) return;
    setStopping(run.id);
    try { await api('/api/admin/sources/find/stop', { method: 'POST' }); } catch { setStopping(null); }
    void qc.invalidateQueries({ queryKey: FIND_KEY });
    void kickDownloads(qc);
  };
  const earlier = earlierRuns(data?.recent, openId);
  return (
    <OnBody>
      <Sheet title={tr('Other-source search')} onClose={onClose} overBottomNav>
        <div data-find-results ref={top} className="pb-2">
          {openId && (
            <div className="mb-2">
              <button type="button" className="btn-key" onClick={() => setOpenId(null)} data-find-latest>{tr('Back to the latest search')}</button>
            </div>
          )}
          {(openId ? opened.isLoading : q.isLoading) && <div className="skeleton h-16 rounded-xl" />}
          {!q.isLoading && q.isError && !data && <p className="text-xs text-rose-300">{tr('Could not load the results')}</p>}
          {!openId && !q.isLoading && data && !run && <p className="text-xs text-fog-500">{tr('No search for other sources has run yet.')}</p>}
          {openId && opened.isError && <p className="text-xs text-fog-500">{tr('That search is no longer kept.')}</p>}
          {run && (
            <>
              <FindRunRow run={run} label={runStatusWord(run.status)} onStop={isAdmin ? () => { void stop(); } : undefined} stopping={stopping === run.id} />
              {untried.length > 0 && (
                <div className="mt-2">
                  <button type="button" className="btn-key" disabled={retry?.phase === 'starting' || !!data?.running}
                    onClick={() => { void again.start('retry', { seriesIds: untried, ...(run.review ? { review: true } : {}) }).then(() => { setOpenId(null); void q.refetch(); void kickDownloads(qc); }); }}>
                    {untried.length === 1 ? tr('Search the 1 series not tried') : tr('Search the {n} series not tried', { n: untried.length })}
                  </button>
                  {(retry?.phase === 'refused' || retry?.phase === 'failed') && <ActionStatus state={findSlotState(retry, null)} />}
                </div>
              )}
              {/* Keyed by the run: a press's state belongs to the run it was made in. */}
              {g.review.length > 0 && <ReviewGroup key={run.id} run={run} rows={g.review} onOpen={onClose} />}
              <Group id="found" title={tr('New sources')} rows={g.found} onOpen={onClose} />
              <Group id="nothing" title={tr('Nothing found')} rows={g.nothing} onOpen={onClose} />
              {/* Its own key, not the shared "Skipped" (v0.52.0): the heading is about series, which several languages
                  agree it with ("Series omitidas"), and a match's state or an import row is not. */}
              <Group id="skipped" title={tr('Skipped series')} rows={g.skipped} onOpen={onClose} />
              <Group id="not-tried" title={tr('Not tried')} rows={g.notTried} onOpen={onClose}
                note={tr('The search was stopped, ran out of time or was interrupted by a restart before it got to these.')} />
            </>
          )}
          {earlier.length > 0 && (
            <section data-find-group="earlier" className="mt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Earlier searches')}</h3>
              <ul role="list" className="mt-1 divide-y divide-ink-800/50">
                {/* The status word leads each line, so the summary after it leaves its own out: "Stopped before it
                    finished · 6m ago · Stopped before it finished · 3 of 7 series" said it twice. Each line opens its run
                    in the sheet (v0.52.0); a review-first run says so, since its matches may still wait. */}
                {earlier.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setOpenId(r.id)} data-find-earlier={r.id}
                      className="block w-full py-2 text-start text-[11px] leading-relaxed text-fog-400 hover:text-fog-200">
                      <span className="text-fog-300">{runStatusWord(r.status)}</span>
                      {whenLine(r) && <span className="text-fog-500"> · {whenLine(r)}</span>}
                      {r.review && <span className="text-fog-500"> · {tr('Review first')}</span>}
                      <span className="text-fog-500"> · {findSummary(r, { status: false })}</span>
                      <span className="text-accent"> · {tr('Open')}{'\u00a0'}›</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Sheet>
    </OnBody>
  );
}

/**
 * How a search follows what it finds (v0.51.0): automatically, the default, or after a review. A pair of radios, so it
 * reads as one choice of two; whoever starts the search remembers it (setFindReviewFirst).
 */
export function FindModeChoice({ review, onChange }: { review: boolean; onChange: (review: boolean) => void }) {
  const name = useId();
  const options = [
    { on: false, label: tr('Follow automatically'), what: tr('Follows each source whose title and chapter numbers match, as soon as it is found.') },
    { on: true, label: tr('Review first'), what: tr('Follows nothing yet: you see each match with its cover beside your series’ cover, and choose.') },
  ];
  return (
    <fieldset data-find-mode aria-label={tr('Find other sources')} className="grid grid-cols-1 gap-1.5">
      {options.map((o) => (
        <label key={o.label} className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${review === o.on ? 'border-accent/60 bg-ink-800/60' : 'border-ink-700'}`}>
          <input type="radio" name={name} checked={review === o.on} onChange={() => onChange(o.on)} className="mt-1 shrink-0 accent-accent"
            data-find-mode-option={o.on ? 'review' : 'auto'} />
          <span className="min-w-0">
            <span className="block text-sm text-fog-100">{o.label}</span>
            <span className="block text-[11px] leading-relaxed text-fog-500">{o.what}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The start dialog of every one-press start point (Health's row, the Library's More): the choice above, opening on the
 * admin's last one on this device, and Start. On <body>, as Health's own confirmations are: a `.card` would hold it.
 */
export function FindStartDialog({ onStart, onClose }: { onStart: (review: boolean) => void; onClose: () => void }) {
  const [review, setReview] = useState(findReviewFirst);
  return (
    <OnBody>
      <Modal title={tr('Find other sources')} onClose={onClose}>
        <FindModeChoice review={review} onChange={setReview} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-key">{tr('Cancel')}</button>
          <button type="button" onClick={() => { setFindReviewFirst(review); onStart(review); }} className="btn-key btn-key-primary" data-find-start>
            {tr('Start')}
          </button>
        </div>
      </Modal>
    </OnBody>
  );
}

/** Follow and Skip for one run's matches, and Follow all green: each press posts, then the run is read again. */
function useReviewActions(runId: string, onFollowed?: () => void) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Record<string, 'follow' | 'dismiss'>>({});
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<ActionState>(IDLE);
  const key = (seriesId: string, sourceId: string) => `${seriesId}\n${sourceId}`;
  /** The refusal in words, or null once it is done. */
  const post = async (kind: 'follow' | 'dismiss', seriesId: string, sourceId: string): Promise<string | null> => {
    try {
      await api(`/api/admin/sources/find/${encodeURIComponent(runId)}/${kind}`, { method: 'POST', json: { seriesId, sourceId } });
      return null;
    } catch (e) {
      return decideRefusal(codeOf(e)) ?? msgOf(e, kind === 'follow' ? tr('Could not follow that source') : tr('Could not skip that match'));
    }
  };
  const said = (k: string, why: string | null) => setRefusals((all) => {
    const next = { ...all };
    if (why) next[k] = why; else delete next[k];
    return next;
  });
  const decide = async (kind: 'follow' | 'dismiss', seriesId: string, sourceId: string) => {
    const k = key(seriesId, sourceId);
    setPending((p) => ({ ...p, [k]: kind }));
    const why = await post(kind, seriesId, sourceId);
    said(k, why);
    if (!why && kind === 'follow') onFollowed?.();
    await qc.refetchQueries({ queryKey: FIND_KEY }).catch(() => {});
    setPending((p) => { const next = { ...p }; delete next[k]; return next; });
  };
  // One at a time, in the run's order: each is the same follow as a single press, under the same checks.
  const followAll = async (items: Array<{ seriesId: string; sourceId: string }>) => {
    const at = Date.now();
    let followed = 0, refused = 0;
    for (const [i, it] of items.entries()) {
      setBulk({ kind: 'working', startedAt: at, step: tr('Following {done} of {total}…', { done: i + 1, total: items.length }), progress: i / items.length });
      const why = await post('follow', it.seriesId, it.sourceId);
      said(key(it.seriesId, it.sourceId), why);
      if (why) refused++; else followed++;
    }
    if (followed) onFollowed?.();
    await qc.refetchQueries({ queryKey: FIND_KEY }).catch(() => {});
    setBulk({ kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, ...bulkOutcome(followed, refused) });
  };
  return { pending, refusals, bulk, key, decide, followAll };
}
type ReviewActions = ReturnType<typeof useReviewActions>;

/** One match: our cover beside its cover, its title and source, what it lists and how it lines up, then the keys. */
function ProposalRow({ r, p, act }: { r: FindResult; p: FindProposal; act: ReviewActions }) {
  const k = act.key(r.seriesId, p.sourceId);
  const pressed = act.pending[k];
  const why = act.refusals[k];
  const note = amberNote(p);
  const busy = (kind: 'follow' | 'dismiss'): ActionState => (pressed === kind ? { kind: 'working', startedAt: Date.now() } : IDLE);
  const keys: ActionSpec[] = [
    { id: 'follow', label: tr('Follow'), what: tr('Follow this source for this series'), primary: p.verdict === 'green', state: busy('follow'),
      disabled: act.bulk.kind === 'working', onRun: () => { void act.decide('follow', r.seriesId, p.sourceId); },
      buttonProps: { 'data-review-follow': p.sourceId } as ActionSpec['buttonProps'] },
    { id: 'skip', label: tr('Skip'), what: tr('Skip this match for good'), state: busy('dismiss'),
      disabled: act.bulk.kind === 'working', onRun: () => { void act.decide('dismiss', r.seriesId, p.sourceId); },
      buttonProps: { 'data-review-skip': p.sourceId } as ActionSpec['buttonProps'] },
  ];
  return (
    <li data-review-proposal={p.sourceId} data-verdict={p.verdict} className="flex min-w-0 gap-3 py-2.5">
      <div className="flex shrink-0 gap-1.5">
        <Img src={img.seriesThumb(r.seriesId)} alt="" className="h-14 w-10 rounded" />
        <Img src={sourceCover(p.sourceId, p.coverUrl)} alt="" fallbackSrc={p.coverUrl || undefined}
          className={`h-14 w-10 rounded ring-1 ${p.verdict === 'green' ? 'ring-accent/50' : 'ring-amber-400/60'}`} />
      </div>
      <div className="min-w-0 flex-1">
        {p.url
          ? <a href={p.url} target="_blank" rel="noopener noreferrer" dir="auto" className="line-clamp-2 break-words text-sm text-fog-100 hover:text-accent">{p.title}</a>
          : <p dir="auto" className="line-clamp-2 break-words text-sm text-fog-100">{p.title}</p>}
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-fog-400">
          <SourceIcon id={p.sourceId} name={p.sourceName} size={16} />
          <bdi className="truncate text-fog-200">{p.sourceName}</bdi>
          <span className="shrink-0 tabular-nums text-fog-500">{p.chapters === 1 ? tr('1 chapter') : tr('{n} chapters', { n: p.chapters })}</span>
        </p>
        <p className={`mt-0.5 text-[11px] tabular-nums ${p.verdict === 'green' ? 'text-fog-400' : 'text-amber-300/90'}`}>{lineUpText(p)}</p>
        {note && !p.state && <p data-amber-note className="mt-0.5 text-[11px] leading-relaxed text-amber-300/90">{note}</p>}
        {p.state
          ? <p data-review-state={p.state} className="mt-1 text-[11px] text-fog-300">{p.state === 'followed' ? tr('Followed') : tr('Skipped for good')}</p>
          : <ActionKeys actions={keys} className="mt-1.5" />}
        {why && !p.state && <ActionStatus state={{ kind: 'refused', reason: why }} />}
      </div>
    </li>
  );
}

/**
 * One series' matches. `head` puts the series' own title above them (the results sheet); the Sources sheet, which IS
 * the series, leaves it out. A series hidden by the 18+ filter keeps its row and offers nothing to decide: the server
 * sends no title or cover of its matches, and nobody follows what they could not look at.
 */
function ReviewSeries({ r, act, head = true, onOpen }: { r: FindResult; act: ReviewActions; head?: boolean; onOpen?: () => void }) {
  return (
    <li data-review-series={r.seriesId} className="min-w-0 py-2">
      {head && (r.title
        ? <Link href={seriesHref(r.seriesId)} onClick={onOpen} className="block truncate text-sm font-medium text-fog-100 hover:text-accent" dir="auto">{r.title}</Link>
        : <p data-find-hidden className="truncate text-sm text-fog-500">{tr('Hidden by the 18+ filter')}</p>)}
      {r.title && (
        <ul role="list" className="divide-y divide-ink-800/50">
          {r.proposals!.map((p) => <ProposalRow key={p.sourceId} r={r} p={p} act={act} />)}
        </ul>
      )}
    </li>
  );
}

/** One series' matches where the page is that series (the Sources sheet): no head, and `onFollowed` per follow. */
export function SeriesReview({ runId, r, onFollowed }: { runId: string; r: FindResult; onFollowed?: () => void }) {
  const act = useReviewActions(runId, onFollowed);
  return <ul role="list" data-series-review className="mt-1"><ReviewSeries r={r} act={act} head={false} /></ul>;
}

/** A review's series with their matches, and Follow all green over them. */
function ReviewGroup({ run, rows, onOpen }: { run: FindRun; rows: FindResult[]; onOpen: () => void }) {
  const act = useReviewActions(run.id);
  const greens = greenToFollow(run);
  return (
    <section data-find-group="review" aria-labelledby="find-review" className="mt-4">
      <h3 id="find-review" className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-fog-500">
        {tr('To review')}<span className="tabular-nums text-fog-600">{rows.length}</span>
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-fog-500">
        {tr('Nothing is followed until you choose. Green matches are the ones an automatic search would follow; amber ones need a look first.')}
      </p>
      {greens.length > 0 && (
        <div className="mt-2">
          <button type="button" className="btn-key btn-key-primary" disabled={act.bulk.kind === 'working'} data-review-follow-green
            onClick={() => { void act.followAll(greens); }}>
            {tr('Follow all green')} · {greens.length}
          </button>
        </div>
      )}
      <ActionStatus state={act.bulk} />
      <ul role="list" className="divide-y divide-ink-800/70">
        {rows.map((r) => <ReviewSeries key={r.seriesId} r={r} onOpen={onOpen} act={act} />)}
      </ul>
    </section>
  );
}

/** Health's card: the running run or the newest one, with its results a press away. Nothing before the first run. */
export function FindRunCard() {
  const fr = useFindRun();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const run = fr?.status?.run;
  if (!fr || !run) return null;
  return (
    <section data-find-card={run.id} className="card grad-border full px-4 py-1">
      <FindRunRow run={run} stopping={stopping === run.id} onStop={() => { setStopping(run.id); void fr.stop(); }} />
      <div className="pb-3">
        <button type="button" onClick={() => setOpen(true)} className="btn-key" data-find-results-open>{tr('Show results')}</button>
      </div>
      {open && <FindResultsSheet poll={false} onClose={() => setOpen(false)} />}
    </section>
  );
}
