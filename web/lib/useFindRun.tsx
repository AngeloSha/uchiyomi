'use client';
/**
 * Starting, following and stopping "Find other sources" runs (v0.49.1), the way lib/useRepairRun.tsx does repairs.
 *
 * One run at a time server-wide, in the background: POST /api/admin/sources/find answers 202 with the run's id, GET
 * says how far the running one has got (or what the newest one did), POST …/stop stops it at once (the series in
 * flight is not tried unless it already followed a source). A press here:
 * - keeps its slot -- starting, then awaiting its run's id, then settling while the page is asked again, then ended --
 *   so the key that started it says what it is doing, and then what it did;
 * - polls every 2 s while any run goes or one it started is not yet seen to end;
 * - calls `onEnded` ONCE per run it saw end, and keeps the slot "Checking the result…" until that has ANSWERED (the
 *   v0.48.3 rule: a row that woke over an unchanged finding invited a second press).
 *
 * Health mounts it once for every row (FindRunProvider); the Sources & translations sheet calls the hook itself.
 * Credit: the idea is @TIGamingTV's (PR #119).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t as tr } from './i18n';
import { findEndedRunIds, startRefusal, type FindRun, type FindScope, type FindSlot, type FindStatus } from './findSources';

export type { FindSlot };

export const FIND_KEY = ['find-sources'] as const;
const POLL_MS = 2000;

export const fetchFind = () => api<FindStatus>('/api/admin/sources/find');

export interface FindRunApi {
  status: FindStatus | undefined;
  slots: Readonly<Record<string, FindSlot>>;
  /**
   * Start a run for a slot. A refusal (409 busy, 400 nothing to search or too many series) lands on the slot and in a
   * notice.
   */
  start: (slot: string, scope: FindScope) => Promise<FindSlot>;
  /** Stop the running run, at once. */
  stop: (slot?: string) => Promise<void>;
  /** The run a slot started, once the status names it: running, or the newest finished one. */
  runOf: (slot: string) => FindRun | null;
}

/** The error code of a refusal (`{ error: 'busy' }`), or null. */
const codeOf = (e: unknown): string | null => {
  try { return e instanceof ApiError ? (JSON.parse(e.body)?.error ?? null) : null; } catch { return null; }
};

/**
 * A start that did not start, in words: another run (409 `busy`), nothing to search (400 `empty_scope`), too many
 * series (400 `bad_request`), or the server's message.
 */
export const findRefusal = (e: unknown): string =>
  startRefusal(e instanceof ApiError ? e.status : null, codeOf(e)) ?? msgOf(e, tr('Could not start the search'));

export function useFindRuns({ enabled = true, onEnded }: { enabled?: boolean; onEnded?: () => Promise<unknown> | void } = {}): FindRunApi {
  const qc = useQueryClient();
  const toast = useToast();
  const [slots, setSlots] = useState<Record<string, FindSlot>>({});
  const awaiting = useMemo(() => Object.values(slots).filter((s) => s.phase === 'awaiting' && s.runId).map((s) => s.runId!), [slots]);
  const waiting = awaiting.length > 0;
  const q = useQuery({
    queryKey: FIND_KEY,
    queryFn: fetchFind,
    enabled,
    retry: false,
    refetchInterval: (qq) => (qq.state.data?.running || waiting ? POLL_MS : false),
  });

  const ended = useRef(onEnded);
  ended.current = onEnded;
  const prev = useRef<FindStatus | null>(null);
  const handled = useRef(new Set<string>());
  const awaitingRef = useRef(awaiting);
  awaitingRef.current = awaiting;

  const mark = useCallback((ids: string[], phase: FindSlot['phase']) => setSlots((s) => {
    let changed = false;
    const out: Record<string, FindSlot> = {};
    for (const [k, v] of Object.entries(s)) {
      if (v.runId && ids.includes(v.runId) && v.phase !== phase) {
        out[k] = { ...v, phase, ...(phase === 'ended' ? { finishedAt: Date.now() } : {}) };
        changed = true;
      } else out[k] = v;
    }
    return changed ? out : s;
  }), []);

  // ⚠️ The one place a finished run is followed up: when runs END, once per answer that saw them end -- never at
  // the press, when the run has only just begun.
  useEffect(() => {
    const next = q.data;
    if (!next) return;
    const all = findEndedRunIds(prev.current, next, awaitingRef.current);
    prev.current = next;
    const ids = all.filter((id) => !handled.current.has(id));
    if (!ids.length) return;
    for (const id of ids) handled.current.add(id);
    mark(ids, 'settling');
    void (async () => {
      try { await ended.current?.(); } finally { mark(ids, 'ended'); }
    })();
  }, [q.data, mark]);

  const set = useCallback((key: string, s: FindSlot | ((p: FindSlot | undefined) => FindSlot)) =>
    setSlots((all) => ({ ...all, [key]: typeof s === 'function' ? s(all[key]) : s })), []);

  const start = useCallback(async (key: string, scope: FindScope): Promise<FindSlot> => {
    const startedAt = Date.now();
    set(key, { phase: 'starting', startedAt });
    try {
      const r = await api<{ runId: string; total: number }>('/api/admin/sources/find', { method: 'POST', json: scope });
      // A run so short that an answer already saw it start and end while this POST was in flight has been followed up
      // then (the effect above), when this slot had no id to match: it is over.
      const over = !!r?.runId && handled.current.has(r.runId);
      const slot: FindSlot = over ? { phase: 'ended', startedAt, runId: r.runId, finishedAt: Date.now() } : { phase: 'awaiting', startedAt, runId: r?.runId };
      set(key, slot);
      if (!over) await qc.refetchQueries({ queryKey: FIND_KEY });
      return slot;
    } catch (e) {
      // Another run, or nothing to search, is a refusal (amber: it will work later, or there is nothing to do); anything
      // else a failure.
      const refused = startRefusal(e instanceof ApiError ? e.status : null, codeOf(e)) !== null;
      const slot: FindSlot = { phase: refused ? 'refused' : 'failed', startedAt, ...(refused ? {} : { finishedAt: Date.now() }), reason: findRefusal(e) };
      set(key, slot);
      toast(slot.reason!, 'error');
      return slot;
    }
  }, [qc, set, toast]);

  const stop = useCallback(async (key?: string) => {
    if (key) set(key, (p) => ({ ...(p ?? { phase: 'awaiting', startedAt: Date.now() }), stopping: true }));
    try {
      await api('/api/admin/sources/find/stop', { method: 'POST' });
      await qc.refetchQueries({ queryKey: FIND_KEY });
    } catch (e) {
      if (key) set(key, (p) => ({ ...(p ?? { phase: 'awaiting', startedAt: Date.now() }), stopping: false }));
      toast(msgOf(e, tr('Could not stop the search')), 'error');
    }
  }, [qc, set, toast]);

  const status = q.data;
  return useMemo<FindRunApi>(() => ({
    status,
    slots,
    start,
    stop,
    runOf: (key) => {
      const id = slots[key]?.runId;
      return id && status?.run?.id === id ? status.run : null;
    },
  }), [status, slots, start, stop]);
}

const Ctx = createContext<FindRunApi | null>(null);

/** Health's one follower of find runs, for every row that offers the key. Null outside it. */
export function useFindRun(): FindRunApi | null {
  return useContext(Ctx);
}

export function FindRunProvider({ onEnded, children }: { onEnded: () => Promise<unknown>; children: ReactNode }) {
  const value = useFindRuns({ onEnded });
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
