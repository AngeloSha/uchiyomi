'use client';
/**
 * Starting, following and stopping Health's "Fix everything" run (v0.55.0), the way lib/useRepairRun.tsx and
 * lib/useFindRun.tsx follow theirs.
 *
 * One run at a time server-wide, in the background: POST /api/admin/health/autofix answers 202 with its id (or 409
 * `busy`, naming what holds the server), GET says the live run and the newest finished one, POST …/stop stops it at its
 * next safe point -- never inside a merge, a delete or a renumber. Health mounts ONE provider, which:
 * - keeps this page's press -- starting, awaiting its run, settling while Health is asked again, ended -- so the dialog
 *   says what it is doing, and then what it did;
 * - polls every 2 s while a run goes or the press has not been seen to end (lib/autofix.ts autofixPollMs);
 * - asks Health again ONCE per run it saw end, and keeps the press "Checking the result…" until that has ANSWERED (the
 *   v0.48.3 rule, useRepairRun's);
 * - remembers which runs it saw going, so the dialog opened again after "Run in background" shows how that run ENDED,
 *   until the end is set aside (`dismiss`).
 *
 * Toasts are for refusals and errors only; what a run did is said in the dialog and stays.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t as tr } from './i18n';
import { REPAIR_RUNS_KEY } from './useRepairRun';
import { autofixEndedIds, autofixPollMs, autofixRefusal, type AutofixSlot, type AutofixStatus } from './autofix';

export const AUTOFIX_KEY = ['autofix'] as const;
export const AUTOFIX_URL = '/api/admin/health/autofix';

export const fetchAutofix = () => api<AutofixStatus>(AUTOFIX_URL);

/** The run a refusal names: 409 `{ error: 'busy', running }`. Null when it is not that refusal. */
export const busyOf = (e: unknown): string | null => {
  try {
    if (!(e instanceof ApiError) || e.status !== 409) return null;
    const b = JSON.parse(e.body);
    return b?.error === 'busy' ? String(b.running ?? 'autofix') : null;
  } catch { return null; }
};

/**
 * The status on its own, for a page without the provider (Library → Downloads' Server tasks, an admin's): every 2 s
 * while a run goes, every `idleMs` otherwise so a run started elsewhere is noticed.
 */
export function useAutofixStatus(enabled: boolean, idleMs: number | false = 30_000) {
  return useQuery({
    queryKey: AUTOFIX_KEY,
    queryFn: fetchAutofix,
    enabled,
    retry: false,
    refetchInterval: (q) => autofixPollMs(q.state.data, false, idleMs),
  });
}

/** Ask the running run to stop at its next safe point. */
export const stopAutofix = () => api(`${AUTOFIX_URL}/stop`, { method: 'POST' });

export interface AutofixApi {
  status: AutofixStatus | undefined;
  /** This page's own press, until its run has been read back. */
  slot: AutofixSlot | null;
  /** The runs this page saw going (or started): their end is what the dialog shows when it opens again. */
  seen: ReadonlySet<string>;
  /** Ends set aside: read and closed, or replaced by a new run. */
  aside: ReadonlySet<string>;
  /** The run asked to stop, until it has. */
  stopping: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Set a run's end aside: the dialog asks afresh next time. */
  dismiss: (id: string) => void;
}

/** Exported for the tests, which hand the dialog a run of their own (test/autofix.test.ts). */
export const AutofixContext = createContext<AutofixApi | null>(null);

/** Health's one follower of the autofix run. Null outside it. */
export function useAutofix(): AutofixApi | null {
  return useContext(AutofixContext);
}

export function AutofixRunProvider({ onEnded, children }: { onEnded: () => Promise<unknown>; children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [slot, setSlot] = useState<AutofixSlot | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [aside, setAside] = useState<string[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);
  const awaiting = slot?.phase === 'awaiting' && slot.runId ? slot.runId : null;

  const q = useQuery({
    queryKey: AUTOFIX_KEY,
    queryFn: fetchAutofix,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (qq) => autofixPollMs(qq.state.data, !!awaiting),
  });

  const ended = useRef(onEnded);
  ended.current = onEnded;
  const prev = useRef<AutofixStatus | null>(null);
  const handled = useRef(new Set<string>());
  const awaitingRef = useRef(awaiting);
  awaitingRef.current = awaiting;

  const see = useCallback((id: string) => setSeen((s) => (s.includes(id) ? s : [...s, id])), []);
  const closeSlot = useCallback((ids: string[], phase: AutofixSlot['phase']) => setSlot((s) => (
    s?.runId && ids.includes(s.runId) && s.phase !== phase ? { ...s, phase, ...(phase === 'ended' ? { finishedAt: Date.now() } : {}) } : s
  )), []);

  // Every run seen going is this page's to show the end of.
  const live = q.data?.run?.status === 'running' ? q.data.run.id : null;
  useEffect(() => { if (live) see(live); }, [live, see]);

  // ⚠️ The one place Health is asked again after Fix everything: when a run ENDS, once per answer that saw it end --
  // never at the press, when the run has only just begun.
  useEffect(() => {
    const next = q.data;
    if (!next) return;
    const all = autofixEndedIds(prev.current, next, awaitingRef.current ? [awaitingRef.current] : []);
    prev.current = next;
    const ids = all.filter((id) => !handled.current.has(id));
    if (!ids.length) return;
    for (const id of ids) handled.current.add(id);
    closeSlot(ids, 'settling');
    setStopping((s) => (s && ids.includes(s) ? null : s));
    void (async () => {
      try {
        await Promise.all([
          ended.current(),
          // Recent repairs lists Fix everything's runs too (they are kept with the repair's).
          qc.refetchQueries({ queryKey: REPAIR_RUNS_KEY }),
          qc.invalidateQueries({ queryKey: ['admin-tasks'] }),
        ]);
      } finally {
        closeSlot(ids, 'ended');
      }
    })();
  }, [q.data, qc, closeSlot]);

  const start = useCallback(async () => {
    const startedAt = Date.now();
    setSlot({ phase: 'starting', startedAt });
    try {
      const r = await api<{ ok?: boolean; runId?: string }>(AUTOFIX_URL, { method: 'POST', json: {} });
      const id = r?.runId;
      if (id) {
        see(id);
        // A new run sets every earlier end aside: the dialog shows this one.
        setAside((a) => [...new Set([...a, ...(q.data?.last ? [q.data.last.id] : [])])]);
      }
      // A run so short that an answer already saw it start and end while this POST was in flight was followed up then.
      const over = !!id && handled.current.has(id);
      setSlot(over ? { phase: 'ended', runId: id, startedAt, finishedAt: Date.now() } : { phase: 'awaiting', runId: id, startedAt });
      if (!over) await qc.refetchQueries({ queryKey: AUTOFIX_KEY });
    } catch (e) {
      const running = busyOf(e);
      // Another admin's run (or the nightly's) is going: nothing to refuse -- the dialog shows that run.
      if (running === 'autofix') {
        setSlot(null);
        await qc.refetchQueries({ queryKey: AUTOFIX_KEY });
        return;
      }
      const reason = running ? autofixRefusal(running) : msgOf(e, autofixRefusal(null));
      setSlot(running ? { phase: 'refused', startedAt, reason } : { phase: 'failed', startedAt, finishedAt: Date.now(), reason });
      toast(reason, 'error');
    }
  }, [qc, see, toast, q.data?.last]);

  const stop = useCallback(async () => {
    const id = q.data?.run?.status === 'running' ? q.data.run.id : null;
    setStopping(id);
    try {
      await stopAutofix();
      await qc.refetchQueries({ queryKey: AUTOFIX_KEY });
    } catch (e) {
      setStopping(null);
      toast(msgOf(e, tr('Could not stop Fix everything')), 'error');
    }
  }, [qc, toast, q.data?.run]);

  const dismiss = useCallback((id: string) => setAside((a) => (a.includes(id) ? a : [...a, id])), []);

  const status = q.data;
  const value = useMemo<AutofixApi>(() => ({
    status, slot, seen: new Set(seen), aside: new Set(aside), stopping, start, stop, dismiss,
  }), [status, slot, seen, aside, stopping, start, stop, dismiss]);
  return <AutofixContext.Provider value={value}>{children}</AutofixContext.Provider>;
}
