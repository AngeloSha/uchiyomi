'use client';
/**
 * Every repair-backed action on the Health page goes through here (v0.49.0).
 *
 * Before, each chip posted the repair, toasted "Started — the Tasks line shows what it did" and asked Health
 * again the moment the POST answered -- when the work had only just begun. The row then showed nothing
 * while the repair ran, the finding was still there when it finished, and the result lived on another tab.
 *
 * Now ONE provider per Health tab:
 * - posts the run and keeps its id (the server answers it);
 * - polls GET /api/admin/tasks/repair/status every 2 s while any run is going or one it started is still
 *   unread, so a row can show the step and a ticking clock -- also for a run started elsewhere, the nightly,
 *   or before a tab switch;
 * - asks Health again ONCE per ended run, when it ENDS, and keeps the row "Checking the result…" until
 *   that re-check has ANSWERED (the v0.48.3 rule: a row that woke up over an unchanged finding invited a
 *   second press);
 * - reads the run history, so what a run did is still on its row after a reload.
 *
 * Toasts are for refusals and errors only; success is said in place and stays.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t as tr } from './i18n';
import { blockedReason, endedRunIds, type RepairBody, type RepairRunRecord, type RepairStatus } from './repairRun';
import { refusalLine, type Slot } from './healthCopy';

export const REPAIR_STATUS_KEY = ['repair-status'] as const;
export const REPAIR_RUNS_KEY = ['repair-runs'] as const;
/** The history the page reads: enough for "Recent repairs" and for every row's newest run. */
const RUNS_LIMIT = 20;
const POLL_MS = 2000;
const NO_RUNS: RepairRunRecord[] = [];

const fetchStatus = () => api<RepairStatus>('/api/admin/tasks/repair/status');

/**
 * The status on its own, for a tab without the provider (Tasks). Polls while a run is going, and every
 * `idleMs` otherwise so a run started elsewhere is noticed.
 */
export function useRepairStatus(idleMs: number | false = false) {
  return useQuery({
    queryKey: REPAIR_STATUS_KEY,
    queryFn: fetchStatus,
    refetchInterval: (q) => (q.state.data?.running ? POLL_MS : idleMs),
  });
}

export interface RepairRunApi {
  status: RepairStatus | undefined;
  runs: RepairRunRecord[];
  /** This page's own presses, by slot key (a row's, a card's, the page's). */
  slots: Readonly<Record<string, Slot>>;
  /** Post a run for a slot. Refusals and errors land on the slot AND in a toast. */
  start: (slot: string, action: string, body: RepairBody) => Promise<void>;
  /** Ask the running run to stop (the Downloads view's Server tasks card has the same Stop). */
  stop: (slot?: string) => Promise<void>;
  blocked: ReturnType<typeof blockedReason>;
  /** A finished run from the history, by id. */
  record: (id: string | undefined) => RepairRunRecord | null;
  /** Ask Health again and wait for its answer: what an action that answers at once does after it answers. */
  recheck: () => Promise<unknown>;
}

const Ctx = createContext<RepairRunApi | null>(null);

export function useRepairRun(): RepairRunApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRepairRun outside RepairRunProvider');
  return v;
}

export function RepairRunProvider({ onEnded, children }: { onEnded: () => Promise<unknown>; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  // The ids this page is waiting on: pressed here, not yet seen to end.
  const awaiting = useMemo(() => Object.values(slots).filter((s) => s.phase === 'awaiting' && s.runId).map((s) => s.runId!), [slots]);
  const waiting = awaiting.length > 0;

  const statusQ = useQuery({
    queryKey: REPAIR_STATUS_KEY,
    queryFn: fetchStatus,
    refetchInterval: (q) => (q.state.data?.running || waiting ? POLL_MS : false),
    refetchOnWindowFocus: true,
  });
  const runsQ = useQuery({
    queryKey: REPAIR_RUNS_KEY,
    queryFn: () => api<{ content: RepairRunRecord[] }>(`/api/admin/tasks/repair/runs?limit=${RUNS_LIMIT}`),
  });

  const ended = useRef(onEnded);
  ended.current = onEnded;
  const prev = useRef<RepairStatus | null>(null);
  // Runs seen to end, for which Health has been asked again (`handled`), and those for which it has ANSWERED (`settled`).
  const handled = useRef(new Set<string>());
  const settled = useRef(new Set<string>());
  const awaitingRef = useRef(awaiting);
  awaitingRef.current = awaiting;

  // ⚠️ The one place Health is asked again after a repair: when runs END, once per poll that saw them end,
  // never at the press. Per-row effects would re-check once per row.
  useEffect(() => {
    const next = statusQ.data;
    if (!next) return;
    const all = endedRunIds(prev.current, next, awaitingRef.current);
    prev.current = next;
    const mark = (ids: string[], phase: Slot['phase']) => setSlots((s) => {
      let changed = false;
      const out: Record<string, Slot> = {};
      for (const [k, v] of Object.entries(s)) {
        if (v.runId && ids.includes(v.runId) && v.phase !== phase) { out[k] = { ...v, phase, ...(phase === 'ended' ? { finishedAt: Date.now() } : {}) }; changed = true; }
        else out[k] = v;
      }
      return changed ? out : s;
    });
    // A press whose run was already seen to end (a poll landed between the run finishing and its POST
    // answering): Health has been asked since, so it only needs its slot closed, or it would poll forever --
    // closed once that answer is in, and until then waiting on it, as start() does.
    const stale = all.filter((id) => handled.current.has(id) && awaitingRef.current.includes(id));
    if (stale.length) {
      mark(stale.filter((id) => settled.current.has(id)), 'ended');
      mark(stale.filter((id) => !settled.current.has(id)), 'settling');
    }
    const ids = all.filter((id) => !handled.current.has(id));
    if (!ids.length) return;
    for (const id of ids) handled.current.add(id);
    mark(ids, 'settling');
    void (async () => {
      try {
        await Promise.all([
          ended.current(),
          qc.refetchQueries({ queryKey: REPAIR_RUNS_KEY }),
          qc.invalidateQueries({ queryKey: ['admin-tasks'] }),
        ]);
      } finally {
        for (const id of ids) settled.current.add(id);
        mark(ids, 'ended');
      }
    })();
  }, [statusQ.data, qc]);

  const set = useCallback((key: string, s: Slot | ((prev: Slot | undefined) => Slot)) =>
    setSlots((all) => ({ ...all, [key]: typeof s === 'function' ? s(all[key]) : s })), []);

  const start = useCallback(async (key: string, action: string, body: RepairBody) => {
    const startedAt = Date.now();
    set(key, { phase: 'starting', action, startedAt });
    try {
      const r = await api<{ ok?: boolean; error?: string; started?: boolean; run?: string }>('/api/admin/tasks/repair/run', { method: 'POST', json: body });
      if (r?.ok === false) {
        // ⚠️ A refusal is a 200 with `ok: false`, and the two mean opposite things: `sweep_running` clears by
        // itself in a few minutes, `busy` is another repair already going.
        const reason = refusalLine(r.error);
        set(key, { phase: 'refused', action, startedAt, reason });
        toast(reason, 'error');
        return;
      }
      // A run that polls already saw start AND end while its POST was in flight (a window-focus refetch, the poll
      // of another run): the effect above re-checked Health for it then, when this slot had no id to match, and
      // it will not run again for it -- the refetch below brings nothing new, and React Query hands back the same
      // data object -- so the slot would sit on "Working…", polling every 2 s. It is over: close it here -- once
      // that re-check has ANSWERED. While it is still in flight the slot waits on it, "Checking the result…", and
      // the effect's `finally` closes it: closed at once, the row read "Done" above the old finding for one Health
      // round-trip (the v0.48.3 rule: a row does not wake before Health has answered).
      if (r?.run && settled.current.has(r.run)) {
        set(key, { phase: 'ended', action, startedAt, runId: r.run, finishedAt: Date.now() });
        return;
      }
      if (r?.run && handled.current.has(r.run)) {
        set(key, { phase: 'settling', action, startedAt, runId: r.run });
        return;
      }
      set(key, { phase: 'awaiting', action, startedAt, runId: r?.run });
      if (!r?.run) {
        // A server older than v0.49.0 names no run: nothing to watch for, so read Health again now.
        await ended.current();
        set(key, (p) => ({ ...(p ?? { action, startedAt }), phase: 'ended', finishedAt: Date.now() }));
        return;
      }
      await qc.refetchQueries({ queryKey: REPAIR_STATUS_KEY });
    } catch (e) {
      const reason = msgOf(e, tr('Could not start the repair'));
      set(key, { phase: 'failed', action, startedAt, finishedAt: Date.now(), reason });
      toast(reason, 'error');
    }
  }, [qc, set, toast]);

  const stop = useCallback(async (key?: string) => {
    if (key) set(key, (p) => ({ ...(p ?? { phase: 'awaiting', action: '', startedAt: Date.now() }), stopping: true }));
    try {
      await api('/api/sources/runs/repair/cancel', { method: 'POST' });
      await qc.refetchQueries({ queryKey: REPAIR_STATUS_KEY });
    } catch (e) {
      if (key) set(key, (p) => ({ ...(p ?? { phase: 'awaiting', action: '', startedAt: Date.now() }), stopping: false }));
      toast(msgOf(e, tr('Could not stop the repair')), 'error');
    }
  }, [qc, set, toast]);

  const runs = runsQ.data?.content ?? NO_RUNS;
  const value = useMemo<RepairRunApi>(() => ({
    status: statusQ.data,
    runs,
    slots,
    start,
    stop,
    blocked: blockedReason(statusQ.data),
    record: (id) => (id ? runs.find((r) => r.id === id) ?? null : null),
    recheck: () => ended.current(),
  }), [statusQ.data, runs, slots, start, stop]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
