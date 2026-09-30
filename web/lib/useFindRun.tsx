'use client';
/**
 * Starting and following "Find other sources" searches.
 *
 * One search at a time server-wide, in the background: POST /api/admin/sources/find answers 202 with the run's id,
 * and every place that starts one -- Health's row, the Library's More, a series' Sources sheet -- then opens the run's
 * review (app/admin/find/page.tsx), which fills in as the search goes and is where the admin chooses what to follow.
 * GET says whether one is searching (a key waits, saying why, while another does) and what the newest did.
 *
 * The idea and the review are @TIGamingTV's (PR #119).
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t as tr } from './i18n';
import { kickDownloads } from './useServerDownloads';
import { findRefusalLine, reviewHref, startRefusal, type FindScope, type FindStatus } from './findSources';

export const FIND_KEY = ['find-sources'] as const;
const POLL_MS = 2000;

export const fetchFind = () => api<FindStatus>('/api/admin/sources/find');

/** The error code of a refusal (`{ error: 'busy' }`), or null. */
export const codeOf = (e: unknown): string | null => {
  try { return e instanceof ApiError ? (JSON.parse(e.body)?.error ?? null) : null; } catch { return null; }
};
const fieldOf = (e: unknown, field: string): string | null => {
  try { return e instanceof ApiError ? (JSON.parse(e.body)?.[field] ?? null) : null; } catch { return null; }
};

/** A start that did not start, in words: another search, nothing to search, too many series, or the server's message. */
export const findRefusal = (e: unknown): string =>
  startRefusal(e instanceof ApiError ? e.status : null, codeOf(e)) ?? msgOf(e, tr('Could not start the search'));

/** Any other refusal of the find routes, in words: the code worded, else the server's message, else `fallback`. */
export const findError = (e: unknown, fallback: string): string =>
  findRefusalLine(codeOf(e), fieldOf(e, 'theirTitle')) ?? msgOf(e, fallback);

/**
 * Whether a search is going, and the newest. `poll` asks again every 2 s while one searches -- only where the page has
 * nothing else following it, since every observer with an interval polls on its own timer.
 */
export function useFindStatus({ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}) {
  return useQuery({
    queryKey: FIND_KEY,
    queryFn: fetchFind,
    enabled,
    retry: false,
    refetchInterval: poll ? (q) => (q.state.data?.running ? POLL_MS : false) : undefined,
  });
}

/**
 * Start a search and open its review. While another search runs the server answers 409 `busy` with that run's id:
 * said in a notice, and nothing else changes (the selection, the row). Answers the run's id, or null.
 */
export function useStartFind() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const start = useCallback(async (scope: FindScope): Promise<string | null> => {
    setStarting(true);
    try {
      const r = await api<{ runId: string; total: number }>('/api/admin/sources/find', { method: 'POST', json: scope });
      void qc.invalidateQueries({ queryKey: FIND_KEY });
      void kickDownloads(qc);
      router.push(reviewHref(r.runId));
      return r.runId;
    } catch (e) {
      toast(findRefusal(e), 'error');
      return null;
    } finally {
      setStarting(false);
    }
  }, [qc, router, toast]);
  return { start, starting };
}
