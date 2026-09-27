'use client';
// The one-click half of Admin -> Health (v0.41.0), rebuilt in v0.49.0 so every action says what it does, how,
// how long it usually takes, and whether it worked.
//
// Health has always been able to name a problem; since v0.41.0 it can act on one. The nightly repair does
// everything that is reversible or provable on its own; these keys are the same work asked for by hand, on
// ONE row, plus the two things the nightly deliberately never does -- merging duplicates and deleting a
// chapter whose number is impossible -- which stay a human's decision behind a confirmation.
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
import { StatusMark } from '@/components/StatusMark';
import { t as tr } from '@/lib/i18n';
import { isDesktop } from '@/lib/desktop';
import { IDLE, type ActionState } from '@/lib/actionState';
import { triggerRefresh, type RefreshAnswer } from '@/lib/refresh';
import {
  ACTION_COPY, caveatLine, fixAllWhat, outcomeLine, planFooter, planLine, repairGate, rowState, solverDownLine, timeLine,
  type CopyCtx,
} from '@/lib/healthCopy';
import {
  CARD_STEP, cardBody, cardRecord, cardStepState, isRepairAction, itemBody, kindOfBody, pageBody,
  pagePlan, pageRecord, recordFor, runTouches, solverDown, stepFindings, type RepairEstimate, type RepairStatus,
} from '@/lib/repairRun';
import { useRepairRun } from '@/lib/useRepairRun';
import { testStep } from '@/lib/sourceEvidence';
import type { HealthAction, HealthCheck, HealthItem } from '@/lib/types';

type Toast = ReturnType<typeof useToast>;

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
    const head = books === 1 ? tr('Scan done: {series} series, 1 chapter', { series: r.series })
      : tr('Scan done: {series} series, {n} chapters', { series: r.series, n: books });
    const skipped = r.skipped ? ` · ${r.skipped === 1 ? tr('1 folder skipped, see Health') : tr('{n} folders skipped, see Health', { n: r.skipped })}` : '';
    return { kind: 'done', finishedAt: Date.now(), tookMs: r.ms ?? took, outcome: head + skipped, partial: !!r.skipped };
  }
  if (r.reason === 'rate_limited') return { kind: 'refused', reason: tr('A scan ran less than a minute ago') };
  if (r.reason === 'in_flight') return { kind: 'refused', reason: tr('A scan is already running') };
  return { kind: 'failed', finishedAt: Date.now(), reason: tr('Scan failed') };
}

/**
 * One finding's row: its words (the caller's children -- title, detail, and #115's evidence), what the last
 * attempt found, what an action will not be able to do, the keys, and the status line.
 *
 * ⚠️ `data-health-item` is what the browser walk finds a key's row by (closest()), and the row is keyed by
 * lib/healthKeys.ts: its state -- a Fix working, a Test's verdict -- must follow the finding when a re-check
 * removes the row above it.
 */
export function HealthRow({ check, item, rowKey, links, children }: {
  check: HealthCheck;
  item: HealthItem;
  rowKey: string;
  links?: ReactNode;
  children: ReactNode;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const rr = useRepairRun();
  const { status, slots } = rr;
  const slotKey = `item:${check.id}:${rowKey}`;
  const slot = slots[slotKey];
  // Answers-at-once actions keep their own state: pressed, asked, re-checked, then what they said.
  const [sync, setSync] = useState<{ action: HealthAction; state: ActionState; at: number } | null>(null);
  const [asking, setAsking] = useState<'delete' | 'disable' | 'merge' | null>(null);
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
  // The newest of the two is the row's line.
  const useSync = !!sync && sync.state.kind !== 'idle' && (repairState.kind === 'idle' || sync.at >= (slot?.startedAt ?? live?.startedAt ?? record?.finishedAt ?? 0));
  const rowNow: ActionState = useSync ? sync!.state : repairState;
  const rowAction: HealthAction | undefined = useSync ? sync!.action : repairAction;

  // `step` is the status line's words while the request runs; its clock ticks beside them (a Test's says the
  // server's limit, testStep: one can take most of a minute).
  const act = (a: HealthAction, run: () => Promise<{ text: string; ok?: boolean } | null>, step = tr('Working…')) => {
    const at = Date.now();
    setSync({ action: a, at, state: { kind: 'working', startedAt: at, step } });
    void (async () => {
      let out: { text: string; ok?: boolean } | null = null;
      let err: string | null = null;
      try { out = await run(); } catch (e) { err = msgOf(e, tr('Could not save that')); }
      // Health is asked again even after a failure -- the failure may be the finding having been dealt with
      // elsewhere -- and the row stays busy until it has ANSWERED (v0.48.3).
      setSync({ action: a, at, state: { kind: 'working', startedAt: at, step: tr('Checking the result…') } });
      await rr.recheck().catch(() => {});
      if (err) { setSync({ action: a, at, state: { kind: 'failed', finishedAt: Date.now(), reason: err } }); toast(err, 'error'); return; }
      if (!out) { setSync(null); return; }
      setSync({ action: a, at, state: out.ok === false
        ? { kind: 'failed', finishedAt: Date.now(), reason: out.text }
        : { kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, outcome: out.text } });
    })();
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
      { n: bookmarked, text: tr('{n} skipped: bookmarked by a reader', { n: bookmarked }) },
      { n: notOwned, text: tr('{n} skipped: not downloaded by Uchiyomi', { n: notOwned }) },
      { n: other, text: tr('{n} could not be deleted', { n: other }) },
    ].filter((l) => l.n > 0);
    // ⚠️ A delete that deleted nothing is not a success: a green "0 deleted" over unchanged rows is what a
    // refused delete used to look like, and the reason is what the admin needs in front of them.
    if (res.applied === 0 && lines.length) return { text: lines.map((l) => l.text).join(' · '), ok: false };
    // The row goes when Health answers again, taking its status line with it: the count is said in a notice too.
    toast(tr('{n} deleted', { n: res.applied }), 'success');
    return { text: [tr('{n} deleted', { n: res.applied }), ...lines.map((l) => l.text)].join(' · ') };
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

  const doDisable = async (): Promise<{ text: string }> => {
    setAsking(null);
    await api(`/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/disable`, { method: 'POST' });
    return { text: tr('That source is switched off') };
  };

  const ctx: CopyCtx = { limits: status?.limits, check };
  const blocked = rr.blocked;
  const busyHere = rowNow.kind === 'starting' || rowNow.kind === 'working';

  const spec = (a: HealthAction): ActionSpec | null => {
    const copy = ACTION_COPY[a];
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
            const r = await api<{ ok: boolean; diagnosis?: { reason?: string; fix?: string } }>(
              `/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/test`, { method: 'POST' });
            return r.ok ? { text: tr('That source is working') } : { text: r.diagnosis?.reason || tr('That source is still failing'), ok: false };
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
            return { text: tr('Connected: the extension engine now uses Uchiyomi’s Cloudflare helper.') };
          }),
        };
      default:
        return null;
    }
  };
  const specs = actions.map(spec).filter((s): s is ActionSpec => !!s);
  // The stored outcome, unless the status line under the keys already says the same thing ("Every source has
  // the same short copy" twice, one above the other, read as two findings).
  const stored = outcomeLine(item.outcome);
  const outcome = rowNow.kind === 'done' && stored.includes(rowNow.outcome) ? '' : stored;
  const caveats = (item.caveats ?? []).filter((c) => actions.includes(c.action)).map(caveatLine).filter(Boolean);

  return (
    <div data-health-item={rowKey} data-repair-state={rowNow.kind} className={`px-4 py-2.5 ${item.info ? 'opacity-60' : ''}`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {links && <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">{links}</div>}
      </div>
      {outcome && <p data-health-outcome className="mt-1 text-[11px] leading-relaxed text-fog-400">{outcome}</p>}
      {caveats.map((c) => <p key={c} data-health-caveat className="mt-1 text-[11px] leading-relaxed text-amber-300/90">{c}</p>)}
      {specs.length > 0 && <ActionKeys actions={specs} className="mt-2" />}
      <ActionStatus state={rowNow} />

      {asking === 'delete' && (
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
      )}

      {asking === 'disable' && (
        <ConfirmDialog
          title={tr('Turn this source off?')}
          confirmLabel={tr('Turn off')}
          danger
          body={<p>{tr('Nothing is deleted. Series that follow it stop being asked for new chapters until you turn it back on under Providers.')}</p>}
          onConfirm={() => act('disable', doDisable)}
          onClose={() => setAsking(null)}
        />
      )}

      {asking === 'merge' && (item.seriesIds || []).length === 2 && (
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
      )}
    </div>
  );
}

/** Checks whose findings a scan can clear, which get a "Scan the library now" row. */
const SCAN_CHECKS = ['library-scan', 'downloads-missing'];

/** Whether a check has anything for its card body to offer beyond its findings: the page's expandable rule. */
export function hasCardActions(check: HealthCheck): boolean {
  const step = CARD_STEP[check.id];
  return (!!step && stepFindings(check, step).length > 0) || SCAN_CHECKS.includes(check.id) || solverDown(check)
    || (check.id === 'duplicates' && check.items.some((it) => !it.info && (it.seriesIds || []).length === 2));
}

/**
 * A card's body opens with this: one legend row per kind of action its findings carry (what, how, usually how
 * long), then the card-wide actions as full rows with their own status -- Fix all (the card's one repair
 * step), Reset the solver, Merge all, Scan the library now.
 */
export function HealthCardActions({ check }: { check: HealthCheck }) {
  const toast = useToast();
  const rr = useRepairRun();
  const { status, slots } = rr;
  const [asking, setAsking] = useState(false);
  const [merge, setMerge] = useState<ActionState>(IDLE);
  const [scan, setScan] = useState<ActionState>(IDLE);
  const ctx: CopyCtx = { limits: status?.limits, check };
  const findings = check.items.filter((it) => !it.info);
  const pairs = check.id === 'duplicates' ? findings.filter((it) => (it.seriesIds || []).length === 2) : [];

  const rows: ActionSpec[] = [];
  // The legend: every kind of action a finding here offers, once, with no button of its own (the keys are on
  // the findings). The solver reset is card-wide, below.
  const kinds = [...new Set(check.items.flatMap((it) => it.actions ?? []))].filter((a) => a !== 'solver_reset');
  for (const a of kinds) {
    const copy = ACTION_COPY[a];
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
    rows.push({ id: 'solver_down', label: tr('Reset the solver'), what: solverDownLine(isDesktop()) });
  }
  if (pairs.length) {
    const copy = ACTION_COPY.merge_all;
    rows.push({
      id: 'merge_all', label: copy.label(ctx), what: copy.what(ctx), eta: copy.eta(ctx), state: merge, runLabel: tr('Merge all'),
      onRun: () => setAsking(true), buttonProps: { 'data-health-merge-all': check.id } as ActionSpec['buttonProps'],
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
          const r = await triggerRefresh();
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
    <div data-health-legend={check.id} className="border-b border-ink-800/70 px-4 pt-2">
      <ActionList actions={rows} aria-label={tr('What you can do here')} />
      {asking && (
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

/**
 * "Fix all issues" for the whole Health page (v0.48.3), as one action row (v0.49.0): ONE run of the repair with
 * every page step that has something to do -- the same steps the cards' Fix all rows run, so nothing here is a
 * new remedy. Its plan, with each step's caps, is under "How it works" BEFORE the press, where the old
 * confirmation hid it until after; the failures step asks for `now`.
 *
 * ⚠️ Health is checked again when the run ENDS (lib/useRepairRun.tsx), not when it starts.
 */
export function FixAllIssues({ checks }: { checks: HealthCheck[] }) {
  const rr = useRepairRun();
  const { status, slots } = rr;
  const plan = pagePlan(checks);
  const slot = slots.page;
  const body = pageBody(plan);
  const kind = kindOfBody(body);
  const run = status?.run && ((slot?.runId && status.run.id === slot.runId) || (status.run.kind === kind && plan.length > 1)) ? status.run : null;
  const record = slot?.runId ? rr.record(slot.runId) ?? pageRecord(rr.runs) : pageRecord(rr.runs);
  const state = rowState({ slot, run, record, action: 'fix_all_issues', onStop: run ? () => { void rr.stop('page'); } : undefined });
  if (!plan.length && state.kind === 'idle') return null;
  const ctx: CopyCtx = { limits: status?.limits };
  // Usually: this plan's own history when there is one; otherwise the sum of its steps' estimates (the
  // searches are shared, so "at most" is generous rather than short).
  const own = estOf(status, kind);
  const parts = plan.map((p) => estOf(status, kindOfBody(cardBody(p.step))));
  const est: RepairEstimate | null = own?.typicalMs != null ? own : parts.some(Boolean) ? {
    typicalMs: null, runs: 0,
    worstMs: parts.reduce<number | null>((a, e) => (a === null || e?.worstMs == null ? null : a + e.worstMs), 0),
    downloads: parts.reduce((a, e) => a + (e?.downloads ?? 0), 0),
  } : own;
  const copy = ACTION_COPY.fix_all_issues;
  const lines = plan.map((p) => `• ${planLine(p.step, { ...ctx, n: p.n })}`);
  const caps = tr('One run takes up to {short} short chapters and {gaps} series with gaps. The nightly repair carries on with the rest, or press Fix all issues again.',
    { short: ctx.limits?.shortMax ?? 20, gaps: ctx.limits?.gapsMax ?? 5 });
  const busy = state.kind === 'starting' || state.kind === 'working';
  const gate = repairGate(rr.blocked, status?.run, busy);
  const spec: ActionSpec = {
    id: 'fix_all_issues',
    label: copy.label(ctx),
    what: fixAllWhat(plan.length, ctx),
    how: [...lines, caps, planFooter(plan.map((p) => p.step))].join('\n'),
    eta: timeLineOr(est),
    state,
    primary: true,
    runLabel: tr('Start'),
    disabled: !plan.length || !!gate.disabled,
    disabledWhy: gate.disabledWhy,
    onRun: () => { void rr.start('page', 'fix_all_issues', body); },
    buttonProps: { 'data-health-fix-all-page': '' } as ActionSpec['buttonProps'],
  };
  return (
    <div data-health-fix-all-issues className="card grad-border full px-4 py-1">
      <ActionList actions={[spec]} />
    </div>
  );
}

/** The estimate line, or a plain bound before the status route has answered. */
function timeLineOr(e: RepairEstimate | null): string {
  return timeLine(e) || tr('A few minutes at most');
}
