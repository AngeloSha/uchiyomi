'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ProgressBar } from '@/components/ui';
import { Row, SwitchRow, useAutosave } from '@/components/settings';
import { t as tr } from '@/lib/i18n';

/** GET /api/admin/translate. */
export interface TranslateEngine {
  enabled: boolean;
  state: 'unsupported' | 'missing' | 'downloading' | 'ready' | 'failed';
  size: 'large' | 'small' | null;
  pick: 'large' | 'small';
  done: number;
  total: number;
  need: number;
  free: number;
  ram: number;
  running: boolean;
  external: boolean;
  error?: string;
  problem?: string | null;
}

const KEY = ['admin-translate'];

/**
 * Translate pages (v0.85.0, bff lib/translate/): one row in Admin → Settings → Server, for an engine that is never part of
 * Uchiyomi until an admin asks for it. Download first -- the engine and a model, about 19 GB on a server with the memory
 * for the large model, 3 GB elsewhere -- with its progress here, then the one switch, and Remove. Gone on an install that
 * cannot run it (the desktop app). It reads its own endpoint, and asks again every 2 s while a download runs.
 */
export function TranslateRow() {
  const qc = useQueryClient();
  const { data: st } = useQuery({
    queryKey: KEY,
    queryFn: () => api<TranslateEngine>('/api/admin/translate'),
    refetchInterval: (q) => (q.state.data?.state === 'downloading' ? 2000 : false),
  });
  const { status, run } = useAutosave();
  const [removing, setRemoving] = useState(false);
  if (!st || st.state === 'unsupported') return null;
  const call = (path: string, method: string, json?: unknown) =>
    run(async () => { qc.setQueryData(KEY, await api<TranslateEngine>(path, { method, json })); });
  const label = tr('Translate pages');
  const where = tr('Runs on this server: pages never leave it.');

  if (st.state === 'ready') {
    return (
      <div className="py-3 first:pt-1 last:pb-0" data-translate-engine="ready">
        <SwitchRow label={label}
          help={`${tr('Readers turn it on for a series in the reader’s settings, and pages are translated into their language as they read.')} ${where}`}
          on={st.enabled} onChange={(next) => call('/api/admin/translate', 'PUT', { enabled: next })} />
        {st.problem && (
          <p role="alert" className="max-w-prose text-[11px] leading-relaxed text-red-300">
            {tr('Translation stopped.')} <span className="font-mono text-[10px] text-red-300/80">{st.problem}</span>
          </p>
        )}
        <button type="button" onClick={() => setRemoving(true)} className="mt-1 text-[11px] text-fog-500 underline-offset-2 hover:text-fog-300 hover:underline">
          {tr('Remove the translation engine')}
        </button>
        {removing && (
          <ConfirmDialog danger title={tr('Remove the translation engine?')} confirmLabel={tr('Remove')}
            body={tr('Its files are deleted and translating stops. Pages already translated come back if you download it again.')}
            onConfirm={() => { setRemoving(false); void call('/api/admin/translate', 'DELETE'); }}
            onClose={() => setRemoving(false)} />
        )}
      </div>
    );
  }

  if (st.state === 'downloading') {
    const pct = st.total ? st.done / st.total : 0;
    return (
      <Row label={label} stacked status={status}>
        <div role="status" aria-live="polite" data-translate-engine="downloading">
          <p className="text-sm text-fog-200">{tr('Downloading the translation engine…')}</p>
          <div className="mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
            <ProgressBar value={Math.min(1, Math.max(0, pct))} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <p className="text-[11px] tabular-nums text-fog-500">{tr('{done} of {total}', { done: bytes(st.done), total: bytes(st.total) })}</p>
            <button type="button" onClick={() => void call('/api/admin/translate', 'DELETE')} className="text-[11px] text-fog-500 hover:text-fog-300">
              {tr('Cancel')}
            </button>
          </div>
        </div>
      </Row>
    );
  }

  // Missing, or a download that failed: the button, and what it costs before it is pressed.
  const short = st.free > 0 && st.free < st.need;
  return (
    <Row label={label} status={status} stacked
      help={`${tr('Translate the speech bubbles of any chapter into each reader’s language. Needs a one-time download of {size}, and {memory} of memory while it translates.', { size: bytes(st.need), memory: bytes(st.ram) })} ${where}`}>
      <div data-translate-engine={st.state}>
        {st.state === 'failed' && (
          <p role="alert" className="mb-2 max-w-prose text-[11px] leading-relaxed text-red-300">
            {tr('The translation engine could not be downloaded.')}
            {st.error ? <span className="block break-words font-mono text-[10px] text-red-300/80">{st.error}</span> : null}
          </p>
        )}
        {short && (
          <p className="mb-2 max-w-prose text-[11px] leading-relaxed text-amber-300">
            {tr('Not enough free space: {free} free where it goes.', { free: bytes(st.free) })}
          </p>
        )}
        <button type="button" disabled={short} onClick={() => void call('/api/admin/translate/download', 'POST', {})}
          className="btn-accent px-4 py-2 text-sm disabled:opacity-50">
          {st.state === 'failed' ? tr('Try again') : tr('Download ({size})', { size: bytes(st.need) })}
        </button>
      </div>
    </Row>
  );
}
