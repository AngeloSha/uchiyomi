'use client';
// The one-click half of Admin -> Health (v0.41.0), rebuilt in v0.49.0 so every action says what it does, how,
// how long it usually takes, and whether it worked.
//
// Health has always been able to name a problem; since v0.41.0 it can act on one. The nightly repair does
// everything that is reversible or provable on its own; these keys are the same work asked for by hand, on
// ONE row, plus the two things the safe repair deliberately never does -- merging duplicates and deleting a
// chapter whose number is impossible -- which stay a human's decision behind a confirmation. Since v0.55.0 the
// page's Fix everything (components/FixEverythingDialog.tsx) can do those too, as one run the admin chose.
//
// The owner could not tell what a key did, how, how long, or whether it was working. So (v0.49.0):
// - each card opens with a LEGEND of its actions (ActionList): what, how, usually how long; the card-wide
//   actions -- Fix all, Reset the solver, Merge all, Scan now -- are full rows of it with their own status;
// - each finding gets small rectangular keys (ActionKeys, no chips) and an always-visible status line
//   (ActionStatus): working with its step and a ticking clock, then what it did and how long it took;
// - a repair-backed key runs through lib/useRepairRun.tsx, which re-checks Health when the run ENDS, not
//   when it starts, and keeps the outcome from the run history -- still on the row after a reload.
//
// ⚠️ Nothing here is its own remediation route. Every key posts to a route that already existed (or to the
// repair with `only` narrowed to one step and one id), so the rules that protect data -- a bookmarked chapter
// is never deleted, a merge is one-way and carries progress, a repair refuses to run beside a chapter sweep
// -- live in one place and apply however the work was started.
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { ActionKeys, ActionList, ActionStatus, type ActionSpec } from '@/components/ActionList';
import { useContextMenu, type MenuItem } from '@/components/ContextMenu';
import { Disclosure } from '@/components/settings';
import { StatusMark } from '@/components/StatusMark';
import { OnBody } from '@/components/ui';
import { NumberingSheet } from '@/components/NumberingSheet';
import { FindStartDialog } from '@/components/FindSources';
import { ReplaceDialog } from '@/components/ReplaceDialog';
import { t as tr } from '@/lib/i18n';
import { deletedText, skippedBookmarkedText, skippedNotOursText } from '@/lib/counted';
import { isDesktop } from '@/lib/desktop';
import { languageName } from '@/lib/format';
import { IDLE, actionButton, isBusy, type ActionState } from '@/lib/actionState';
import { triggerRefresh, type RefreshAnswer, type ScanProgress } from '@/lib/refresh';
import {
  ACTION_COPY, actionCopy, caveatLine, caveatTone, outcomeLine, repairGate, rowState, solverDownLine,
  type CopyCtx,
} from '@/lib/healthCopy';
import {
  CARD_STEP, cardBody, cardRecord, cardStepState, isRepairAction, itemBody, kindOfBody,
  recordFor, runTouches, solverDown, solverQuiet, stepFindings, type RepairEstimate, type RepairStatus,
} from '@/lib/repairRun';
import { useRepairRun } from '@/lib/useRepairRun';
import { testStep } from '@/lib/sourceEvidence';
import { diagnosisReason, itemDetail, itemTitle, type Said } from '@/lib/said';
import { useFindRun } from '@/lib/useFindRun';
import { findGate, findSlotState } from '@/lib/findSources';
import { numberingOutcome, refusalText, type NumberingAnswer, type PlanMode, type RenumberMode } from '@/lib/numbering';
import { freeSlotHref } from '@/lib/sourcesPanel';
import type { HealthAction, HealthCheck, HealthItem } from '@/lib/types';

type Toast = ReturnType<typeof useToast>;

/** What an action that answers at once said: done, done with something left (`partial`), or not done (`ok: false`). */
type ActOutcome = { text: string; ok?: boolean; partial?: boolean };

/**
 * Ignore one finding, or stop ignoring it (v0.48.3). The server looks the finding up again and records all of
 * it; nothing is deleted, so there is no confirmation -- "Stop ignoring" is the way back.
 */
async function postIgnore(check: string, item: HealthItem, ignored: boolean): Promise<string> {
  await api('/api/admin/health/ignore', { method: 'POST', json: { check, key: item.key, ignored } });
  return ignored ? tr('Ignored — it stays quiet until something about it changes') : tr('Back on the list');
}

/** Which of the pair the merge keeps: the server's suggestion, or the first id when it did not send one. */
const keptIndex = (it: HealthItem): number => {
  const i = it.keep ? (it.seriesIds || []).indexOf(it.keep) : -1;
  return i < 0 ? 0 : i;
};

/** The estimate for a run kind, from the status route, for "usually … · at most …". */
const estOf = (status: RepairStatus | undefined, kind: string): RepairEstimate | null => status?.estimates?.[kind] ?? null;

/** What a scan said, as a status line: the counts, a refusal, or the failure. Shared by the hero and Health. */
export function scanState(r: RefreshAnswer, startedAt: number): ActionState {
  const took = Date.now() - startedAt;
  if (r.scanned) {
    if (typeof r.series !== 'number') return { kind: 'done', finishedAt: Date.now(), tookMs: took, outcome: tr('Scan started') };
    if (!r.series) return { kind: 'done', finishedAt: Date.now(), tookMs: r.ms ?? took, outcome: tr('Scan done: nothing found — check the folder layout'), partial: true };
    const books = r.books ?? 0;
    // Both counts have their singular: "series" does not change in English, but it does in the languages
    // ("1 Serien", "1 séries"), and a library of one series is a first scan.
    const head = r.series === 1
      ? (books === 1 ? tr('Scan done: 1 series, 1 chapter') : tr('Scan done: 1 series, {n} chapters', { n: books }))
      : (books === 1 ? tr('Scan done: {m} series, 1 chapter', { m: r.series }) : tr('Scan done: {m} series, {n} chapters', { m: r.series, n: books }));
    const skipped = r.skipped ? ` · ${r.skipped === 1 ? tr('1 folder skipped, see Health') : tr('{n} folders skipped, see Health', { n: r.skipped })}` : '';
    return { kind: 'done', finishedAt: Date.now(), tookMs: r.ms ?? took, outcome: head + skipped, partial: !!r.skipped };
  }
  if (r.reason === 'rate_limited') return { kind: 'refused', reason: tr('A scan ran less than a minute ago') };
  if (r.reason === 'in_flight') return { kind: 'refused', reason: tr('A scan is already running') };
  // v0.55.6: the server's own words when it says why (an admin's answer); a request that never reached it says nothing more.
  return { kind: 'failed', finishedAt: Date.now(), reason: r.message ? tr('Scan failed: {reason}', { reason: r.message }) : tr('Scan failed') };
}

/**
 * A running scan, as its status line (v0.55.6): the clock from the press, how far it has got -- folder 1,200 of 3,400
 * on a big library, which can take minutes -- and what it is doing. Shared by the hero and Health, as scanState is.
 */
export function scanWorking(p: ScanProgress, startedAt: number): ActionState {
  const detail = p.phase === 'waiting' ? tr('Waiting for another task to finish')
    : p.phase === 'walking' ? tr('Reading the folders')
    : p.phase === 'finishing' ? tr('Finishing')
    : tr('Folder {done} of {total}', { done: p.done.toLocaleString(), total: p.total.toLocaleString() });
  return {
    kind: 'working', startedAt, step: tr('Scanning library…'), detail,
    progress: p.phase === 'indexing' && p.total ? Math.min(1, p.done / p.total) : null,
  };
}

/**
 * Turn off: the one request behind a row's Turn off and Source health's Turn off all (v0.53.0), which makes it for
 * each source in turn (lib/sourceHealth.ts turnOffEach).
 */
export const disableSource = (sourceId: string) =>
  api(`/api/admin/sources/${encodeURIComponent(sourceId)}/disable`, { method: 'POST' });

/**
 * v0.53.0, Source health's compact row (components/SourceHealthBody.tsx): the row on one line -- `lead` before its
 * words, ONE key, and every other action in a ⋯ menu -- with `details` behind a Details disclosure.
 */
export interface CompactRow {
  /** Before the words: the source's tile. */
  lead: ReactNode;
  /** The row's one line, under its name (the row's children). */
  line: ReactNode;
  /** The one key the row shows, or none (lib/sourceHealth.ts primaryOf). Every other action is in its menu. */
  primary: HealthAction | null;
  /** Behind Details, closed until opened. */
  details?: ReactNode;
  /** What the row is about, for its menu's name and its ⋯ key's. */
  name: string;
  /** More hooks on the row, for the browser walks. */
  hooks?: Record<`data-${string}`, string>;
}

/**
 * One finding's row: its words (the caller's children -- title, detail, and #115's evidence), what the last
 * attempt found, what an action will not be able to do, the keys, and the status line.
 *
 * ⚠️ `data-health-item` is what the browser walk finds a key's row by (closest()), and the row is keyed by
 * lib/healthKeys.ts: its state -- a Fix working, a Test's verdict -- must follow the finding when a re-check
 * removes the row above it.
 */
export function HealthRow({ check, item, rowKey, links, children, compact }: {
  check: HealthCheck;
  item: HealthItem;
  rowKey: string;
  links?: ReactNode;
  children: ReactNode;
  /** v0.53.0: Source health's compact row. The actions, their states and their confirmations are this row's own either way. */
  compact?: CompactRow;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const rr = useRepairRun();
  const fr = useFindRun();
  const { status, slots } = rr;
  const slotKey = `item:${check.id}:${rowKey}`;
  const slot = slots[slotKey];
  // Answers-at-once actions keep their own state: pressed, asked, re-checked, then what they said.
  const [sync, setSync] = useState<{ action: HealthAction; state: ActionState; at: number } | null>(null);
  const [asking, setAsking] = useState<'delete' | 'disable' | 'merge' | 'link' | 'find' | 'replace' | null>(null);
  // #116: the renumbering plan a numbering key opened, and which key opened it (its row state is that key's).
  const [plan, setPlan] = useState<{ action: HealthAction; mode: PlanMode } | null>(null);
  const [keepFirst, setKeepFirst] = useState(() => keptIndex(item) === 0);
  // ONE sentence with the title inside it, split around the placeholder so the title can carry its own
  // colour -- the idiom ConfirmDialog.tsx:105-111 documents. The bare verb key + the title rendered
  // "KeepSolo Leveling" in English and "الإبقاء علىSolo Leveling" in Arabic, in the one confirmation that
  // decides which copy of a duplicate survives a one-way merge.
  const [keepBefore, keepAfter] = tr('Keep {title}').split('{title}');
  // No verdict is held here (#115, v0.49.0). A Test records what it found on the server, and the refetched row
  // carries it -- item.diagnosis and the stage lines, drawn by SourceEvidence among the row's children -- so there
  // is ONE verdict on screen, and it survives a reload. The Test's own fix sentence used to sit here as well.

  const actions: HealthAction[] = (item.actions || []).filter((a) => a !== 'solver_reset');
  const bookIds = item.bookIds?.length ? item.bookIds : item.bookId ? [item.bookId] : [];
  // A chapter already said to be fine is listed as `info` with a `fixed` stamp; its key is the way back out.
  const confirmed = !!item.fixed || !!item.info;

  // The run about this row: one this page started for it, or any run on it right now (a card's Fix all, the
  // nightly, another admin's press).
  const touch = runTouches(status?.run, check.id, item);
  const live = status?.run && (touch || (slot?.runId && status.run.id === slot.runId)) ? status.run : null;
  const repairAction = (slot?.action as HealthAction | undefined) ?? actions.find(isRepairAction);
  const record = slot?.runId ? rr.record(slot.runId) ?? recordFor(rr.runs, check.id, item) : recordFor(rr.runs, check.id, item);
  const repairState = rowState({
    slot, run: live, record, action: repairAction ?? 'fix_short',
    onStop: live && touch === 'target' ? () => { void rr.stop(slotKey); } : undefined,
  });
  // v0.49.1: a "Find other sources" run started from this row. It is a background run of minutes or hours, so it keeps
  // a key group and a status line of its own (below): the row's Test, Clear block and Turn off stay usable meanwhile,
  // where one busy key would disable every key of its group for the whole run.
  const findSlot = fr?.slots[slotKey];
  const findNow = findSlotState(findSlot, fr?.runOf(slotKey), () => { void fr?.stop(slotKey); });
  // v0.54.0: a Replace run started from this row, under a key of its own -- the Replace dialog shows the run its key
  // started, never the row's Find other sources -- with its own status line under the row.
  const replaceKey = `${slotKey}:replace`;
  const replaceNow = findSlotState(fr?.slots[replaceKey], fr?.runOf(replaceKey), () => { void fr?.stop(replaceKey); });
  // The newest of the two is the row's line.
  const useSync = !!sync && sync.state.kind !== 'idle' && (repairState.kind === 'idle' || sync.at >= (slot?.startedAt ?? live?.startedAt ?? record?.finishedAt ?? 0));
  const rowNow: ActionState = useSync ? sync!.state : repairState;
  const rowAction: HealthAction | undefined = useSync ? sync!.action : repairAction;

  // `step` is the status line's words while the request runs; its clock ticks beside them (a Test's says the
  // server's limit, testStep: one can take most of a minute).
  const act = (a: HealthAction, run: () => Promise<ActOutcome | null>, step = tr('Working…')) => {
    const at = Date.now();
    setSync({ action: a, at, state: { kind: 'working', startedAt: at, step } });
    void (async () => {
      let out: ActOutcome | null = null;
      let err: string | null = null;
      try { out = await run(); } catch (e) { err = msgOf(e, tr('Could not save that')); }
      // Nothing that could change a finding was done -- a merge with no pair, or Keep the source's numbers answered
      // with a plan to confirm first -- so there is nothing to check again, and the row goes back to its keys.
      if (!out && !err) { setSync(null); return; }
      // Health is asked again even after a failure -- the failure may be the finding having been dealt with
      // elsewhere -- and the row stays busy until it has ANSWERED (v0.48.3).
      setSync({ action: a, at, state: { kind: 'working', startedAt: at, step: tr('Checking the result…') } });
      await rr.recheck().catch(() => {});
      if (err) { setSync({ action: a, at, state: { kind: 'failed', finishedAt: Date.now(), reason: err } }); toast(err, 'error'); return; }
      if (!out) { setSync(null); return; }
      // v0.53.0, Source health: Turn off and Ignore move a compact row into a fold that is closed, and this line goes with
      // it -- so it is said in a notice too, as a delete's and a merge's are.
      if (compact && out.ok !== false && (a === 'disable' || a === 'ignore' || a === 'unignore')) toast(out.text, 'success');
      setSync({ action: a, at, state: out.ok === false
        ? { kind: 'failed', finishedAt: Date.now(), reason: out.text }
        : { kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, outcome: out.text, ...(out.partial ? { partial: true } : {}) } });
    })();
  };

  /**
   * A renumbering confirmed in its plan (#116): posted here rather than by the sheet, so this row's status line
   * carries it -- "Renaming…" and its clock, then what came of it (lib/numbering.ts numberingOutcome), then Health
   * again. A refusal is said as what it is: a download into the folder, a file already at a target name.
   */
  const renumber = async (mode: RenumberMode): Promise<ActOutcome> => {
    let out: ActOutcome;
    try {
      out = numberingOutcome(await api<NumberingAnswer>(`/api/admin/series/${encodeURIComponent(item.seriesId || '')}/numbering`, { json: { mode, confirm: true } }));
    } catch (e) {
      return { text: refusalText(e, tr('Could not do that')), ok: false };
    }
    // Applied, the finding is gone when Health answers, and its row with this line: said in a notice too.
    if (out.ok !== false && !out.partial) toast(out.text, 'success');
    return out;
  };

  const doDelete = async (): Promise<{ text: string; ok?: boolean } | null> => {
    setAsking(null);
    const res = await api<{ applied: number; skipped: { id: string; reason: string }[] }>(
      `/api/admin/series/${encodeURIComponent(item.seriesId || '')}/chapters/delete`,
      { method: 'POST', json: { bookIds } },
    );
    // One line per reason present, and `bookmarked` LEADS: on this page the rows are chapters whose number is
    // impossible, and the one skip the admin can act on is a reader's bookmark inside one.
    const count = (reason: string) => res.skipped.filter((x) => x.reason === reason).length;
    const bookmarked = count('bookmarked');
    const notOwned = count('not_owned');
    const other = res.skipped.length - bookmarked - notOwned;
    const lines = [
      { n: bookmarked, text: skippedBookmarkedText(bookmarked) },
      { n: notOwned, text: skippedNotOursText(notOwned) },
      { n: other, text: other === 1 ? tr('1 chapter could not be deleted') : tr('{n} chapters could not be deleted', { n: other }) },
    ].filter((l) => l.n > 0);
    // ⚠️ A delete that deleted nothing is not a success: a green "0 deleted" over unchanged rows is what a
    // refused delete used to look like, and the reason is what the admin needs in front of them.
    if (res.applied === 0 && lines.length) return { text: lines.map((l) => l.text).join(' · '), ok: false };
    // The row goes when Health answers again, taking its status line with it: the count is said in a notice too.
    toast(deletedText(res.applied), 'success');
    return { text: [deletedText(res.applied), ...lines.map((l) => l.text)].join(' · ') };
  };

  const doMerge = async (): Promise<{ text: string } | null> => {
    setAsking(null);
    const ids = item.seriesIds || [];
    if (ids.length !== 2) return null;
    const keep = keepFirst ? ids[0] : ids[1];
    const gone = keepFirst ? ids[1] : ids[0];
    const r = await api<{ moved: number }>(`/api/admin/series/${encodeURIComponent(gone)}/merge`, { method: 'POST', json: { into: keep } });
    const text = r.moved === 1 ? tr('Merged — one chapter moved') : tr('Merged — {n} chapters moved', { n: r.moved });
    // The pair leaves the page when Health answers, so this is said in a notice as well as on the row.
    toast(text, 'success');
    return { text };
  };

  /**
   * Link the pair as language editions of one work (v0.52.0, #72): the duplicates row of a work in two languages. Both
   * stay series of their own; the pair leaves the page when Health answers, so this is said in a notice too.
   */
  const doLink = async (): Promise<{ text: string } | null> => {
    setAsking(null);
    const ids = item.seriesIds || [];
    if (ids.length !== 2) return null;
    await api(`/api/admin/series/${encodeURIComponent(ids[1])}/editions`, { method: 'POST', json: { with: ids[0] } });
    const text = tr('Linked as editions of one work');
    toast(text, 'success');
    return { text };
  };

  const doDisable = async (): Promise<{ text: string }> => {
    setAsking(null);
    await disableSource(item.sourceId || '');
    return { text: tr('That source is switched off') };
  };

  const ctx: CopyCtx = { limits: status?.limits, check };
  const blocked = rr.blocked;
  const busyHere = rowNow.kind === 'starting' || rowNow.kind === 'working';

  const spec = (a: HealthAction): ActionSpec | null => {
    const copy = actionCopy(a, check);
    if (!copy) return null;
    const mine = rowAction === a ? rowNow : IDLE;
    const base = { id: a, what: copy.what(ctx), state: mine, buttonProps: { 'data-health-action': a } as ActionSpec['buttonProps'] };
    // A repair key waits while a sweep or ANOTHER repair runs, and says why (healthCopy.ts repairGate).
    const gate = isRepairAction(a) ? repairGate(blocked, status?.run, busyHere && rowAction === a) : {};
    switch (a) {
      case 'fix_short':
        return { ...base, ...gate, label: tr('Fix'), onRun: () => { const b = itemBody(a, item); if (b) void rr.start(slotKey, a, b); } };
      case 'fill':
        return { ...base, ...gate, label: tr('Fill now'), onRun: () => { const b = itemBody(a, item); if (b) void rr.start(slotKey, a, b); } };
      case 'retry':
        return { ...base, ...gate, label: tr('Retry now'), onRun: () => { const b = itemBody(a, item); if (b) void rr.start(slotKey, a, b); } };
      case 'confirm_short':
        return {
          ...base, label: confirmed ? tr('Not fine') : tr('It’s fine'),
          onRun: () => act(a, async () => {
            await api(`/api/admin/books/${encodeURIComponent(item.bookId || '')}/confirm-short`, { method: 'POST', json: { confirmed: !confirmed } });
            return { text: confirmed ? tr('Back on the list — the next repair will look for a longer copy') : tr('Marked as fine — the repair will leave it alone') };
          }),
        };
      case 'delete':
        return { ...base, danger: true, label: bookIds.length === 1 ? tr('Delete chapter') : tr('Delete chapters'), onRun: () => setAsking('delete') };
      case 'test':
        return {
          ...base, label: tr('Test'),
          onRun: () => act(a, async () => {
            const r = await api<{ ok: boolean; diagnosis?: { code?: string; reason?: string; fix?: string; fixSaid?: Said } }>(
              `/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/test`, { method: 'POST' });
            return r.ok ? { text: tr('That source is working') } : { text: diagnosisReason(r.diagnosis) || tr('That source is still failing'), ok: false };
          }, testStep(check.testMs)),
        };
      case 'unblock':
        return {
          ...base, label: tr('Clear block'),
          onRun: () => act(a, async () => {
            await api(`/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/unblock`, { method: 'POST' });
            return { text: tr('Block cleared') };
          }),
        };
      case 'disable':
        return { ...base, danger: true, label: tr('Turn off'), onRun: () => setAsking('disable') };
      case 'merge':
        return { ...base, label: tr('Merge'), onRun: () => setAsking('merge') };
      case 'link_editions':
        return { ...base, primary: true, label: tr('Link as editions'), onRun: () => setAsking('link') };
      case 'ignore':
        return { ...base, label: tr('Ignore'), onRun: () => act(a, async () => ({ text: await postIgnore(check.id, item, true) })) };
      case 'unignore':
        return { ...base, label: tr('Stop ignoring'), onRun: () => act(a, async () => ({ text: await postIgnore(check.id, item, false) })) };
      // #72: the Extension engine row. The same route as the Extensions tab's Connect; a refusal (no helper of
      // Uchiyomi's own, an engine too old to have the setting, no answer) is a 4xx/5xx with its message, which
      // act() puts on the row. The Extensions tab reads the engine's state again too.
      case 'engine_solver':
        return {
          ...base, primary: true, label: tr('Connect'),
          onRun: () => act(a, async () => {
            await api('/api/admin/extensions/solver', { method: 'POST', json: {} });
            void qc.invalidateQueries({ queryKey: ['ext-status'] });
            const text = tr('Connected: the extension engine now uses Uchiyomi’s Cloudflare helper.');
            // A connected engine is no finding: the row goes when Health answers again, taking this line with it
            // before anyone could read it. Said in a notice too, as a delete's and a merge's are.
            toast(text, 'success');
            return { text };
          }),
        };
      // v0.49.1: every visible series whose main source is this row's source (a failing source, or a series that can no
      // longer update because of its source), in ONE background run. The key carries the run's own state -- working with
      // its Stop, then what it did -- and waits, saying why, while another run goes (one at a time, server-wide). Its
      // label says how many series that is, "Find other sources (189 series)": the count was in its title alone.
      // v0.51.0: the press asks first how it should follow what it finds -- automatically, or after a review.
      case 'find_sources':
        return {
          ...base, ...findGate(fr?.status, findNow.kind === 'working' || findNow.kind === 'starting'),
          state: findNow, what: copy.what({ ...ctx, n: item.findSeries }), label: copy.label({ ...ctx, n: item.findSeries }),
          onRun: () => setAsking('find'),
        };
      // v0.54.0: every series whose main source is this row's source -- off or failing -- moved to a working source in ONE
      // Replace run. The press opens the Replace dialog, which says the numbers first and becomes the run once started;
      // the run is followed under this row's find slot, so the row's status line says what it is doing too. The one
      // filled key of the row, as it is on Admin → Sources.
      case 'replace_source':
        return { ...base, primary: true, label: tr('Replace'), onRun: () => setAsking('replace') };
      // v0.55.0: a series frozen because its source is over the extension engine's source limit -- Replace was the wrong
      // fix there, since the source works and is only not loaded. Admin → Sources, on that source, where one nothing uses
      // can be switched off to make room. A whole page load: the console reads its tab from the address once.
      case 'free_slot':
        return { ...base, primary: true, label: tr('Free a slot'), onRun: () => { window.location.assign(freeSlotHref(item)); } };
      // #116, the chapter numbering check. Review opens the plan of whatever waits -- the route picks the change --
      // and its Confirm is this row's press (`renumber` above), so nothing is renamed before the admin has seen
      // which file becomes which chapter.
      case 'renumber':
        return { ...base, primary: true, label: tr('Review renumbering'), onRun: () => setPlan({ action: a, mode: 'next' }) };
      // On a proposal, keeping the source's numbers renames nothing and answers at once. On a series already
      // numbered by posting order it is the way back, which renames: the route answers with that plan instead
      // (`needs_confirm`), and the plan opens for its Confirm.
      case 'keep_numbers':
        return {
          ...base, label: tr('Keep the source’s numbers'),
          onRun: () => act(a, async () => {
            const r = await api<NumberingAnswer>(`/api/admin/series/${encodeURIComponent(item.seriesId || '')}/numbering`, { json: { mode: 'source' } });
            if (r.state === 'needs_confirm') { setPlan({ action: a, mode: 'source' }); return null; }
            if (r.state !== 'unchanged') return numberingOutcome(r);
            // The proposal is dropped, and its row with it when Health answers: said in a notice too.
            const text = tr('Kept the source’s numbers');
            toast(text, 'success');
            return { text };
          }),
        };
      default:
        return null;
    }
  };
  const all = actions.map(spec).filter((s): s is ActionSpec => !!s);
  const specs = all.filter((s) => s.id !== 'find_sources');
  const finds = all.filter((s) => s.id === 'find_sources');
  // The stored outcome, unless the status line under the keys already says the same thing ("Every source has
  // the same short copy" twice, one above the other, read as two findings).
  const stored = outcomeLine(item.outcome);
  const outcome = rowNow.kind === 'done' && stored.includes(rowNow.outcome) ? '' : stored;
  // A caveat says what a key will not be able to do, in amber -- except the slow archive's, which says the gaps are
  // on their way and nothing is wrong (healthCopy.ts caveatTone).
  const caveats = (item.caveats ?? []).filter((c) => actions.includes(c.action))
    .map((c) => ({ text: caveatLine(c), tone: caveatTone(c) })).filter((c) => c.text);

  // The plan a numbering key opens and every confirmation, wherever the row draws its keys.
  const dialogs = (
    <>
      {/* #116: the plan a numbering key opened (on <body>, itself). Its Confirm is this row's press. */}
      {plan && item.seriesId && (
        <NumberingSheet seriesId={item.seriesId} mode={plan.mode} onClose={() => setPlan(null)}
          onConfirm={(mode) => act(plan.action, () => renumber(mode), tr('Renaming…'))} />
      )}

      {/* The confirmations on <body>: a Health card is a `.card`, whose backdrop blur made it the dialog's containing
          block -- only the card dimmed, and its overflow-hidden cut the dialog off (ui.tsx OnBody). */}
      {asking === 'delete' && (
        <OnBody>
          <ConfirmDialog
            title={bookIds.length === 1 ? tr('Delete this chapter’s file?') : tr('Delete these chapters’ files?')}
            confirmLabel={bookIds.length === 1 ? tr('Delete chapter') : tr('Delete chapters')}
            danger
            body={
              <>
                <p>
                  {check.id === 'outliers'
                    ? tr('A chapter whose number cannot be right is almost always one the source mis-listed. Deleting removes the file; the chapter stays listed and everyone keeps their reading history.')
                    : tr('Deleting removes the file. The chapter stays listed and everyone keeps their reading history.')}
                </p>
                <p className="mt-2">{tr('A chapter somebody has bookmarked is skipped, and so is anything in a library you built by hand. There is no undo and no recycle bin.')}</p>
              </>
            }
            onConfirm={() => act('delete', doDelete)}
            onClose={() => setAsking(null)}
          />
        </OnBody>
      )}

      {asking === 'find' && (
        <FindStartDialog onClose={() => setAsking(null)}
          onStart={(review) => { setAsking(null); if (item.sourceId) void fr?.start(slotKey, { sourceId: item.sourceId, ...(review ? { review } : {}) }); }} />
      )}

      {/* On <body>: a Health card is a `.card`, whose backdrop blur would make it the sheet's containing block. A source
          row is titled with the source's name; a frozen series' row is the series', and the dialog finds the source's. */}
      {asking === 'replace' && item.sourceId && (
        <OnBody>
          <ReplaceDialog sourceId={item.sourceId} name={check.id === 'sources' ? itemTitle(item) : undefined} fr={fr} slot={replaceKey}
            onClose={() => setAsking(null)} />
        </OnBody>
      )}

      {asking === 'disable' && (
        <OnBody>
          <ConfirmDialog
            title={tr('Turn this source off?')}
            confirmLabel={tr('Turn off')}
            danger
            // True since v0.54.0, when a switched-off source stopped being asked by the sweep too.
            body={<p>{tr('Nothing is deleted. Series that follow it stop getting new chapters from it until you turn it back on in Admin → Sources.')}</p>}
            onConfirm={() => act('disable', doDisable)}
            onClose={() => setAsking(null)}
          />
        </OnBody>
      )}

      {asking === 'link' && (item.seriesIds || []).length === 2 && (
        <OnBody>
          <ConfirmDialog
            title={tr('Link these two as editions?')}
            confirmLabel={tr('Link as editions')}
            body={
              <>
                <p>{tr('Each keeps its own chapters, sources and reading progress. The Library shows one card for the work, and the series page switches between them.')}</p>
                <ul className="mt-3 space-y-2">
                  {(item.titles || []).map((t, i) => (
                    <li key={i} className="flex min-w-0 items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm">
                      <span dir="auto" className="min-w-0 truncate text-fog-100">{t}</span>
                      {item.langs?.[i] && <span className="shrink-0 text-[11px] text-fog-500">{languageName(item.langs[i])}</span>}
                    </li>
                  ))}
                </ul>
              </>
            }
            onConfirm={() => act('link_editions', doLink)}
            onClose={() => setAsking(null)}
          />
        </OnBody>
      )}

      {asking === 'merge' && (item.seriesIds || []).length === 2 && (
        <OnBody>
          <ConfirmDialog
            title={tr('Merge these two?')}
            confirmLabel={tr('Merge')}
            body={
              <>
                <p>{tr('This cannot be undone. Progress, bookmarks, ratings and tracker links move to the kept copy.')}</p>
                <p className="mt-2">{tr('No chapter is dropped even if both copies have it, and no files are touched.')}</p>
                <div className="mt-3 space-y-2">
                  {(item.titles || []).map((t, i) => (
                    <label key={i} className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm">
                      <input type="radio" checked={keepFirst === (i === 0)} onChange={() => setKeepFirst(i === 0)} />
                      <span className="truncate">{keepBefore}<strong className="text-fog-100">{t}</strong>{keepAfter}</span>
                    </label>
                  ))}
                </div>
              </>
            }
            onConfirm={() => act('merge', doMerge)}
            onClose={() => setAsking(null)}
          />
        </OnBody>
      )}
    </>
  );

  // v0.53.0, Source health: the same keys, one shown and the rest in a ⋯ menu. An item there runs exactly what its key
  // would -- the same press, the same state line under the row, the same confirmation -- and is disabled as the key
  // would be: while another key of its group works (a running Find other sources keeps its own group), or Stop while
  // that run goes.
  const main = compact?.primary ? specs.find((sp) => sp.id === compact.primary) ?? null : null;
  const specsBusy = specs.some((sp) => isBusy(sp.state));
  const findBusy = finds.some((sp) => isBusy(sp.state));
  const menu = useContextMenu(() => all
    // A running search shows its Stop as a key beside the row's own, so it is not in the menu twice.
    .filter((sp) => sp !== main && !(findBusy && sp.id === 'find_sources'))
    .map((sp): MenuItem => {
      const st = sp.state ?? IDLE;
      const btn = actionButton(st, sp.runLabel ?? sp.label);
      const groupBusy = sp.id === 'find_sources' ? findBusy : specsBusy;
      return {
        label: btn.stop ? btn.label : (sp.runLabel ?? sp.label),
        hook: sp.id,
        danger: sp.danger,
        divider: sp.id === 'ignore' || sp.id === 'unignore',
        disabled: !!sp.disabled || (st.kind === 'working' && !!st.stopping) || (groupBusy && !btn.stop),
        onSelect: () => { if (btn.stop && st.kind === 'working') st.onStop?.(); else sp.onRun?.(); },
      };
    }), { label: compact?.name ?? '' });

  if (compact) {
    // The name, the key and the ⋯ share the first line, and the row's line runs under them: on a phone across the
    // row's whole width, so neither the key nor a long name squeezes it; from `sm` under the name alone, the tile, the
    // key and the ⋯ centred beside the two lines. ⚠️ Start and end lines only, never `sm:col-span-*` / `sm:row-span-*`:
    // a span utility is the `grid-column` shorthand, which resets the start, and every cell fell back to auto-placement.
    return (
      <div data-health-item={rowKey} data-repair-state={rowNow.kind} {...compact.hooks} {...menu.bind}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 px-4 py-2.5">
        <div className="col-start-1 row-start-1 sm:row-end-3">{compact.lead}</div>
        <div className="col-start-2 row-start-1 min-w-0">{children}</div>
        <div className="col-start-2 col-end-5 row-start-2 min-w-0 sm:col-end-3">{compact.line}</div>
        {(main || findBusy) && (
          <div className="col-start-3 row-start-1 flex items-center gap-1.5 sm:row-end-3">
            {main && (
              <ActionKeys actions={[{
                ...main,
                disabled: main.disabled || (specsBusy && !isBusy(main.state)),
                buttonProps: { ...main.buttonProps, 'data-health-primary': '' } as ActionSpec['buttonProps'],
              }]} />
            )}
            {findBusy && <ActionKeys actions={finds} />}
          </div>
        )}
        <button type="button" data-health-more onClick={(e) => menu.openFrom(e.currentTarget)}
          aria-haspopup="menu" aria-expanded={menu.open} aria-label={`${tr('More')}: ${compact.name}`}
          className="btn-key col-start-4 row-start-1 w-8 px-0 text-fog-400 sm:row-end-3">
          <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </button>
        <div className="col-start-2 col-end-5 row-start-3 min-w-0">
          {outcome && <p data-health-outcome className="mt-1 text-[11px] leading-relaxed text-fog-400">{outcome}</p>}
          {caveats.map((c) => (
            <p key={c.text} data-health-caveat={c.tone} className={`mt-1 text-[11px] leading-relaxed ${c.tone === 'calm' ? 'text-fog-400' : 'text-amber-300/90'}`}>{c.text}</p>
          ))}
          <ActionStatus state={rowNow} />
          {finds.length > 0 && <ActionStatus state={findNow} />}
          {actions.includes('replace_source') && <ActionStatus state={replaceNow} />}
          {compact.details && (
            <div data-health-details>
              <Disclosure label={tr('Details')}>{compact.details}</Disclosure>
            </div>
          )}
        </div>
        {menu.element}
        {dialogs}
      </div>
    );
  }

  return (
    <div data-health-item={rowKey} data-repair-state={rowNow.kind} className={`px-4 py-2.5 ${item.info ? 'opacity-60' : ''}`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {links && <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">{links}</div>}
      </div>
      {outcome && <p data-health-outcome className="mt-1 text-[11px] leading-relaxed text-fog-400">{outcome}</p>}
      {caveats.map((c) => (
        <p key={c.text} data-health-caveat={c.tone} className={`mt-1 text-[11px] leading-relaxed ${c.tone === 'calm' ? 'text-fog-400' : 'text-amber-300/90'}`}>{c.text}</p>
      ))}
      {(specs.length > 0 || finds.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {specs.length > 0 && <ActionKeys actions={specs} />}
          {finds.length > 0 && <ActionKeys actions={finds} />}
        </div>
      )}
      <ActionStatus state={rowNow} />
      {finds.length > 0 && <ActionStatus state={findNow} />}
      {actions.includes('replace_source') && <ActionStatus state={replaceNow} />}

      {dialogs}
    </div>
  );
}

/** Checks whose findings a scan can clear, which get a "Scan the library now" row. */
const SCAN_CHECKS = ['library-scan', 'downloads-missing'];

/** Whether a check has anything for its card body to offer beyond its findings: the page's expandable rule. */
export function hasCardActions(check: HealthCheck): boolean {
  const step = CARD_STEP[check.id];
  return (!!step && stepFindings(check, step).length > 0) || SCAN_CHECKS.includes(check.id) || solverDown(check)
    || (check.id === 'duplicates' && check.items.some((it) => !it.info && (it.seriesIds || []).length === 2 && !!it.actions?.includes('merge')))
    || laterCopies(check).length > 0;
}

/**
 * v0.50.0, The same chapter saved twice: the rows whose later files the card's Fix all deletes -- every row that names
 * later files and that nobody chose to ignore.
 */
const laterCopies = (check: HealthCheck): HealthItem[] =>
  check.id === 'saved-twice' ? check.items.filter((it) => !it.ignored && !!it.seriesId && (it.bookIds?.length ?? 0) > 0) : [];

/**
 * A card's body opens with this: one legend row per kind of action its findings carry (what, how, usually how
 * long), then the card-wide actions as full rows with their own status -- Fix all (the card's one repair
 * step), Reset the solver, Merge all, Scan the library now.
 */
export function HealthCardActions({ check, className = 'border-b border-ink-800/70 px-4 pt-2' }: {
  check: HealthCheck;
  /** Where it sits: above a card's rows by default; Source health opens it at the card's foot (v0.53.0). */
  className?: string;
}) {
  const toast = useToast();
  const rr = useRepairRun();
  const { status, slots } = rr;
  const [asking, setAsking] = useState(false);
  const [merge, setMerge] = useState<ActionState>(IDLE);
  const [scan, setScan] = useState<ActionState>(IDLE);
  const [purge, setPurge] = useState<ActionState>(IDLE);
  const [askingPurge, setAskingPurge] = useState(false);
  const ctx: CopyCtx = { limits: status?.limits, check };
  const findings = check.items.filter((it) => !it.info);
  // A pair in two languages is linked, never merged (v0.52.0): Merge all takes only the rows offering a merge.
  const pairs = check.id === 'duplicates' ? findings.filter((it) => (it.seriesIds || []).length === 2 && !!it.actions?.includes('merge')) : [];
  const later = laterCopies(check);

  const rows: ActionSpec[] = [];
  // The legend: every kind of action a finding here offers, once, with no button of its own (the keys are on
  // the findings). The solver reset is card-wide, below.
  const kinds = [...new Set(check.items.flatMap((it) => it.actions ?? []))].filter((a) => a !== 'solver_reset');
  for (const a of kinds) {
    const copy = actionCopy(a, check);
    if (!copy) continue;
    const est = isRepairAction(a) ? estOf(status, a) : null;
    rows.push({ id: `legend:${a}`, label: a === 'delete' ? tr('Delete chapters') : copy.label(ctx), what: copy.what({ ...ctx, est }), how: copy.how?.({ ...ctx, est }), eta: copy.eta({ ...ctx, est }) });
  }

  const step = CARD_STEP[check.id];
  const stepRows = step ? stepFindings(check, step) : [];
  if (step && stepRows.length) {
    const key = step === 'solver' ? 'solver_reset' : `fixall:${step}`;
    const copy = ACTION_COPY[key];
    const body = cardBody(step);
    const kind = kindOfBody(body);
    const slotKey = `card:${check.id}`;
    const slot = slots[slotKey];
    const run = status?.run && ((slot?.runId && status.run.id === slot.runId) || status.run.kind === kind) ? status.run : null;
    const record = slot?.runId ? rr.record(slot.runId) ?? cardRecord(rr.runs, step) : cardRecord(rr.runs, step);
    const state = rowState({ slot, run, record, action: key, onStop: run ? () => { void rr.stop(slotKey); } : undefined });
    const busy = state.kind === 'starting' || state.kind === 'working';
    const c = { ...ctx, est: estOf(status, kind), n: stepRows.length };
    rows.push({
      id: key, label: copy.label(c), what: copy.what(c), how: copy.how?.(c), eta: copy.eta(c), state, primary: true,
      runLabel: step === 'solver' ? tr('Reset') : tr('Fix all'),
      ...repairGate(rr.blocked, status?.run, busy),
      onRun: () => { void rr.start(slotKey, key, body); },
      buttonProps: { 'data-health-fix-all': check.id } as ActionSpec['buttonProps'],
    });
  }
  if (solverDown(check)) {
    rows.push({ id: 'solver_down', label: tr('Reset the solver'), what: solverDownLine(isDesktop(), solverQuiet(check)) });
  }
  if (pairs.length) {
    const copy = ACTION_COPY.merge_all;
    rows.push({
      id: 'merge_all', label: copy.label(ctx), what: copy.what(ctx), eta: copy.eta(ctx), state: merge, runLabel: tr('Merge all'),
      onRun: () => setAsking(true), buttonProps: { 'data-health-merge-all': check.id } as ActionSpec['buttonProps'],
    });
  }
  if (later.length) {
    // Never part of the safe repair (Fix everything's Let me choose): it runs the repair's steps, and nothing deletes
    // without its own yes. Fix it for me may delete these -- the admin chose it knowing so (bff lib/autofix.ts).
    const copy = ACTION_COPY.delete_all;
    rows.push({
      id: 'delete_all', label: copy.label(ctx), what: copy.what(ctx), eta: copy.eta(ctx), state: purge, runLabel: tr('Fix all'), danger: true,
      onRun: () => setAskingPurge(true), buttonProps: { 'data-health-delete-all': check.id } as ActionSpec['buttonProps'],
    });
  }
  if (SCAN_CHECKS.includes(check.id)) {
    const copy = ACTION_COPY.scan;
    rows.push({
      id: 'scan', label: copy.label(ctx), what: copy.what(ctx), eta: copy.eta(ctx), state: scan, runLabel: tr('Scan now'),
      onRun: () => {
        const at = Date.now();
        setScan({ kind: 'working', startedAt: at, step: tr('Scanning library…') });
        void (async () => {
          const r = await triggerRefresh((p) => setScan(scanWorking(p, at)));
          const out = scanState(r, at);
          if (out.kind === 'done') setScan({ kind: 'working', startedAt: at, step: tr('Checking the result…') });
          await rr.recheck().catch(() => {});
          setScan(out);
        })();
      },
      buttonProps: { 'data-health-scan': check.id } as ActionSpec['buttonProps'],
    });
  }
  if (!rows.length) return null;

  // Each row through its own series' Delete chapters, one after another: the route keeps the rows as tombstones,
  // skips a bookmarked chapter, and says what it skipped. A row whose request failed counts as not deleted.
  const deleteAll = async () => {
    const at = Date.now();
    setAskingPurge(false);
    setPurge({ kind: 'working', startedAt: at, step: tr('Working…') });
    let deleted = 0;
    let kept = 0;
    for (const it of later) {
      try {
        const r = await api<{ applied: number; skipped: unknown[] }>(
          `/api/admin/series/${encodeURIComponent(it.seriesId!)}/chapters/delete`, { method: 'POST', json: { bookIds: it.bookIds } });
        deleted += r.applied || 0;
        kept += r.skipped?.length || 0;
      } catch { kept += it.bookIds?.length ?? 0; }
    }
    const line = [deletedText(deleted),
      ...(kept ? [kept === 1 ? tr('1 chapter could not be deleted') : tr('{n} chapters could not be deleted', { n: kept })] : [])].join(' · ');
    if (deleted) toast(deletedText(deleted), 'success');
    setPurge({ kind: 'working', startedAt: at, step: tr('Checking the result…') });
    await rr.recheck().catch(() => {});
    setPurge(deleted === 0 && kept
      ? { kind: 'failed', finishedAt: Date.now(), reason: line }
      : { kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, outcome: line, partial: kept > 0 });
  };

  const mergeAll = async () => {
    const at = Date.now();
    setAsking(false);
    setMerge({ kind: 'working', startedAt: at, step: tr('Merging…') });
    let merged = 0;
    let moved = 0;
    let failed = 0;
    // Sequential, not Promise.all: each merge rewrites rows on both series, and two of them landing at once
    // on a pair that shares a series (an AniList id matching three rows) would race for the survivor.
    for (const p of pairs) {
      const ids = p.seriesIds!;
      const keep = ids[keptIndex(p)];
      const gone = ids.find((x) => x !== keep)!;
      try {
        const r = await api<{ moved: number }>(`/api/admin/series/${encodeURIComponent(gone)}/merge`, { method: 'POST', json: { into: keep } });
        merged++;
        moved += r.moved || 0;
      } catch { failed++; }
    }
    const line = merged === 1 ? tr('One pair merged, {m} chapters moved', { m: moved }) : tr('{n} pairs merged, {m} chapters moved', { n: merged, m: moved });
    // ⚠️ The pairs that did NOT merge are the ones still on the page: said in red, on its own, not folded in.
    if (failed) toast(failed === 1 ? tr('One pair could not be merged') : tr('{n} pairs could not be merged', { n: failed }), 'error');
    setMerge({ kind: 'working', startedAt: at, step: tr('Checking the result…') });
    await rr.recheck().catch(() => {});
    setMerge({ kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, outcome: line, partial: !!failed });
  };

  return (
    <div data-health-legend={check.id} className={className}>
      <ActionList actions={rows} aria-label={tr('What you can do here')} />
      {asking && (
        <OnBody>
          <ConfirmDialog
            title={pairs.length === 1 ? tr('Merge this pair?') : tr('Merge these {n} pairs?', { n: pairs.length })}
            confirmLabel={tr('Merge all')}
            body={
              <>
                <p>{tr('This cannot be undone. Progress, bookmarks, ratings and tracker links move to the kept copy.')}</p>
                <ul className="mt-3 space-y-2">
                  {pairs.map((p, i) => (
                    <li key={i} className="rounded-lg border border-ink-700 px-3 py-2">
                      {(p.titles || []).map((t, j) => (
                        <p key={j} className="flex min-w-0 items-center gap-2 text-sm">
                          <span className={`truncate ${j === keptIndex(p) ? 'text-fog-100' : 'text-fog-500'}`}>{t}</span>
                          {j === keptIndex(p) && (
                            <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-fog-300">{tr('kept')}</span>
                          )}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </>
            }
            onConfirm={() => { void mergeAll(); }}
            onClose={() => setAsking(false)}
          />
        </OnBody>
      )}
      {askingPurge && (
        <OnBody>
          <ConfirmDialog
            title={later.length === 1 ? tr('Delete the later copies in this series?') : tr('Delete the later copies in these {n} series?', { n: later.length })}
            confirmLabel={tr('Delete chapters')}
            danger
            body={
              <>
                <p>{tr('Deleting removes the file. The chapter stays listed and everyone keeps their reading history.')}</p>
                <p className="mt-2">{tr('A chapter somebody has bookmarked is skipped, and so is anything in a library you built by hand. There is no undo and no recycle bin.')}</p>
                <ul className="mt-3 space-y-2">
                  {later.map((it) => (
                    <li key={it.seriesId} className="min-w-0 rounded-lg border border-ink-700 px-3 py-2 text-sm">
                      <p className="truncate text-fog-100">{it.title}</p>
                      <p dir="auto" className="mt-0.5 text-xs text-fog-400">{itemDetail(it)}</p>
                    </li>
                  ))}
                </ul>
              </>
            }
            onConfirm={() => { void deleteAll(); }}
            onClose={() => setAskingPurge(false)}
          />
        </OnBody>
      )}
    </div>
  );
}

/**
 * The small, non-interactive mark in a card's header while a run is on its step: "working · 3 of 20". The
 * card can be closed; this is how it still says the work is going.
 */
export function CardProgress({ checkId }: { checkId: string }) {
  const { status } = useRepairRun();
  const s = cardStepState(status?.run, checkId);
  if (!s || s.state !== 'running') return null;
  const label = s.planned ? tr('{done} of {of}', { done: Math.min(s.planned, (s.done ?? 0) + 1), of: s.planned }) : tr('Working…');
  return <StatusMark tone="accent" working label={label} size="xs" />;
}
