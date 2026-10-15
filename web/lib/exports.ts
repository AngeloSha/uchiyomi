'use client';
// Zip exports: start one, and follow every export job of this browser. The finished file is fetched with the job's
// token (returned once, at the start), which is why the tokens live here for the life of the page.
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ExportJobView {
  id: string; name: string; status: 'queued' | 'zipping' | 'ready' | 'failed' | 'cancelled';
  chapters: number; totalBytes: number; doneBytes: number; fileBytes: number; error: string | null;
}
export interface ExportRequest { seriesId?: string; seriesIds?: string[]; bookIds?: string[]; collectionId?: string }

const tokens = new Map<string, string>();
const fetched = new Set<string>();
let jobs: ExportJobView[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const exportFileUrl = (id: string): string | null => {
  const t = tokens.get(id);
  return t ? `/api/exports/${encodeURIComponent(id)}/file?t=${encodeURIComponent(t)}` : null;
};

/** Hands the finished file to the browser, once. */
export function saveExport(id: string): void {
  const url = exportFileUrl(id);
  if (!url || fetched.has(id)) return;
  fetched.add(id);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  emit();
}
export const wasSaved = (id: string): boolean => fetched.has(id);

async function poll(): Promise<void> {
  try {
    const r = await api<{ content: ExportJobView[] }>('/api/exports');
    // Only this browser's own jobs: the ones it holds a token for.
    jobs = r.content.filter((j) => tokens.has(j.id));
    for (const j of jobs) if (j.status === 'ready' && !fetched.has(j.id)) saveExport(j.id);
  } catch { /* try again on the next tick */ }
  if (!jobs.some((j) => j.status === 'queued' || j.status === 'zipping') && timer) { clearInterval(timer); timer = null; }
  emit();
}

export async function startExport(req: ExportRequest): Promise<ExportJobView> {
  const j = await api<ExportJobView & { token: string }>('/api/exports', { json: req });
  tokens.set(j.id, j.token);
  jobs = [j, ...jobs.filter((x) => x.id !== j.id)];
  emit();
  if (!timer) timer = setInterval(() => void poll(), 1000);
  void poll();
  return j;
}

export async function dismissExport(id: string): Promise<void> {
  jobs = jobs.filter((j) => j.id !== id);
  tokens.delete(id);
  emit();
  await api(`/api/exports/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useExports = (): ExportJobView[] => useSyncExternalStore(subscribe, () => jobs, () => jobs);

/** Whether an admin has turned Download as zip on (Admin → Settings): nothing offers it until the server says so. */
export function useZipExports(): boolean {
  const { data } = useQuery({
    queryKey: ['zip-exports'], staleTime: 60_000,
    queryFn: () => api<{ enabled?: boolean }>('/api/exports').then((r) => r.enabled === true),
  });
  return data === true;
}
