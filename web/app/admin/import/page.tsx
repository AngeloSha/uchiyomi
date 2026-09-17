'use client';
// The reviewable import wizard (issue #48): backup / MangaDex list / paste → match each title against a
// source → show the pick → let the admin change it or skip it → Continue adds only what was accepted.
//
// A dedicated route rather than a Sheet off the admin Providers card (which still has the older one-shot
// /import): this is a multi-step flow that can run for minutes and needs room for hundreds of rows on a
// phone, and admin/page.tsx is already one very large client component. `/admin/import/` — trailing slash
// is load-bearing, see next.config.mjs (`trailingSlash: true`, static export).
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { SourceIcon } from '@/components/SourcePicker';
import { sourceCover } from '@/components/cards';
import { ImportMatchSheet } from '@/components/ImportMatchSheet';
import { IcChevronLeft } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import type { Src } from '@/lib/sourceGroups';
import { needsAttention, confidenceLabel, confidenceColor, type ImportBatch, type ImportCandidate } from '@/lib/importBatch';

type Filter = 'all' | 'attention' | 'skipped';

function IntakeCard({ backupRef, mdUrl, setMdUrl, pasted, setPasted, starting, onFile, onMangadex, onPaste }: {
  backupRef: React.RefObject<HTMLInputElement | null>;
  mdUrl: string; setMdUrl: (v: string) => void;
  pasted: string; setPasted: (v: string) => void;
  starting: boolean;
  onFile: (f: File) => void;
  onMangadex: () => void;
  onPaste: () => void;
}) {
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Bring your library over')}</p>
      <p className="mb-3 text-[11px] text-fog-500">
        {tr('Uchiyomi matches each title against your sources and shows you the pick before anything is added — nothing lands in your library until you press Continue.')}
      </p>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input ref={backupRef} type="file" accept=".tachibk,.proto.gz,.gz" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} />
        <button onClick={() => backupRef.current?.click()} disabled={starting} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50">
          {tr('Mihon / Tachiyomi backup')}
        </button>
        <span className="text-[11px] text-fog-600">{tr('or')}</span>
        <input value={mdUrl} onChange={(e) => setMdUrl(e.target.value)} placeholder={tr('public MangaDex list link')}
          autoCapitalize="none" className="field min-w-0 flex-1" />
        <button onClick={onMangadex} disabled={starting || !mdUrl.trim()} className="chip text-xs disabled:opacity-50">{tr('Load')}</button>
      </div>
      <p className="mb-2 text-[10px] text-fog-600">
        {tr('A .tachibk backup stays on your server — only the titles (and, where available, which source they came from) are read.')}
      </p>

      <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={4}
        placeholder={tr('…or paste titles, one per line')} className="field resize-y" />
      <button onClick={onPaste} disabled={starting || !pasted.trim()} className="btn-accent mt-2 w-full py-2 text-sm disabled:opacity-50">
        {starting ? tr('Starting…') : tr('Start matching')}
      </button>
    </div>
  );
}

function ResolvingCard({ batch, onResume }: { batch: ImportBatch; onResume: () => void }) {
  const pct = batch.total ? Math.round((batch.resolved / batch.total) * 100) : 0;
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-1 text-sm font-semibold text-fog-100">
        {batch.stale ? tr('Matching was interrupted') : tr('Matching your titles…')}
      </p>
      <p className="mb-3 text-[11px] text-fog-500">
        {batch.stale
          ? tr('The server restarted before this finished. Resume to pick up where it left off.')
          : tr('Checking each title against your sources — this can take a few minutes for a long list. You can leave this page; your progress is saved.')}
      </p>
      <ProgressBar value={batch.total ? batch.resolved / batch.total : 0} />
      <p className="mt-1.5 text-[11px] tabular-nums text-fog-500">{tr('{done}/{total} · {pct}%', { done: batch.resolved, total: batch.total, pct })}</p>
      {batch.stale && <button onClick={onResume} className="btn-accent mt-3 w-full py-2 text-sm">{tr('Resume matching')}</button>}
    </div>
  );
}

function ReviewRow({ c, sourceName, onEdit }: {
  c: ImportCandidate;
  sourceName: (id: string | null) => string;
  onEdit: (c: ImportCandidate) => void;
}) {
  const matched = (c.decision === 'auto' || c.decision === 'manual') && !!c.match_title;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/40 p-2.5">
      <Img src={c.match_cover ? sourceCover(c.match_source || undefined, c.match_cover) : ''} alt=""
        fallbackSrc={c.match_cover || undefined} className="h-14 w-10 shrink-0 rounded" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fog-100">{c.backup_title}</p>
        {c.decision === 'skip' ? (
          <p className="text-[11px] text-fog-500">{c.in_library ? tr('Already in your library') : tr('Skipped')}</p>
        ) : matched ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-fog-400">
            <SourceIcon id={c.match_source!} name={sourceName(c.match_source)} size={16} />
            <span className="truncate text-fog-300">{sourceName(c.match_source)}</span>
            <span className={confidenceColor(c.confidence)}>· {confidenceLabel(c.confidence)}</span>
            {c.decision === 'manual' && <span className="text-fog-500">· {tr('manual')}</span>}
          </p>
        ) : (
          <p className="text-[11px] text-amber-400">{tr('No match found')}</p>
        )}
      </div>
      <button onClick={() => onEdit(c)} className="chip shrink-0 text-xs">{tr('Change')}</button>
    </div>
  );
}

function ReviewCard({ items, allCount, attentionCount, skippedCount, importCount, filter, setFilter, q, setQ, onEdit, onRun, running, sourceName }: {
  items: ImportCandidate[];
  allCount: number; attentionCount: number; skippedCount: number; importCount: number;
  filter: Filter; setFilter: (f: Filter) => void;
  q: string; setQ: (v: string) => void;
  onEdit: (c: ImportCandidate) => void;
  onRun: () => void;
  running: boolean;
  sourceName: (id: string | null) => string;
}) {
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-3 text-sm font-semibold text-fog-100">{tr('{n} titles matched', { n: allCount })}</p>

      <div className="mb-2 flex flex-wrap gap-2">
        <button onClick={() => setFilter('all')} className={`chip text-xs ${filter === 'all' ? 'chip-active' : ''}`}>{tr('All')} · {allCount}</button>
        <button onClick={() => setFilter('attention')} className={`chip text-xs ${filter === 'attention' ? 'chip-active' : ''}`}>{tr('Needs attention')} · {attentionCount}</button>
        <button onClick={() => setFilter('skipped')} className={`chip text-xs ${filter === 'skipped' ? 'chip-active' : ''}`}>{tr('Skipped')} · {skippedCount}</button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Filter by title…')} className="field mb-3" />

      <div className="space-y-1.5">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Nothing here.')}</p>
        ) : items.map((c) => <ReviewRow key={c.id} c={c} sourceName={sourceName} onEdit={onEdit} />)}
      </div>

      <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 mt-4 lg:bottom-4">
        <button onClick={onRun} disabled={running || importCount === 0} className="btn-accent w-full py-2.5 text-sm shadow-lift disabled:opacity-50">
          {running ? tr('Starting…') : tr('Continue — import {n}', { n: importCount })}
        </button>
      </div>
    </div>
  );
}

function RunCard({ batch, items, onStartOver }: { batch: ImportBatch; items: ImportCandidate[]; onStartOver: () => void }) {
  const targeted = items.filter((c) => c.decision === 'auto' || c.decision === 'manual');
  const done = batch.added + batch.already + batch.failed;
  const total = targeted.length;
  return (
    <div className="card grad-border wide p-4">
      <p className="mb-1.5 text-sm font-semibold text-fog-100">
        {batch.state === 'importing'
          ? tr('Importing… {done}/{total}', { done, total })
          : tr('Done — {added} added · {already} already had · {failed} failed', { added: batch.added, already: batch.already, failed: batch.failed })}
      </p>
      <ProgressBar value={total ? done / total : 0} />
      <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto">
        {targeted.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-xs">
            <span className={c.status === 'added' ? 'text-emerald-400' : c.status === 'already' ? 'text-fog-500' : c.status ? 'text-red-400' : 'text-fog-600'}>
              {c.status === 'added' ? '✓' : c.status === 'already' ? '·' : c.status ? '✗' : '…'}
            </span>
            <span className="min-w-0 flex-1 truncate text-fog-200">{c.backup_title}</span>
          </li>
        ))}
      </ul>
      {batch.state === 'done' && <button onClick={onStartOver} className="btn-ghost mt-4 w-full py-2 text-sm">{tr('Import another list')}</button>}
    </div>
  );
}

function ImportWizardInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [batchId, setBatchId] = useState<string | null>(params.get('batch'));
  useEffect(() => { setBatchId(params.get('batch')); }, [params]);

  const backupRef = useRef<HTMLInputElement>(null);
  const [mdUrl, setMdUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [starting, setStarting] = useState(false);

  const start = async (body: Record<string, unknown>) => {
    setStarting(true);
    try {
      const r = await api<{ batchId: string; total: number; truncated: boolean }>('/api/admin/import/batches', { json: body });
      if (r.truncated) toast(tr('Only the first 500 titles were kept.'), 'info');
      setBatchId(r.batchId);
      router.replace(`/admin/import/?batch=${r.batchId}`);
    } catch (e: any) { toast(msgOf(e, tr('Could not start the import')), 'error'); }
    setStarting(false);
  };
  const startFromFile = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast(tr('That file is unusually large (max ~10 MB)'), 'error'); return; }
    try {
      const dataUrl = await new Promise<string>((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result));
        rd.onerror = () => rej(new Error('read'));
        rd.readAsDataURL(f);
      });
      await start({ dataUrl });
    } catch { toast(tr('Could not read that file'), 'error'); }
  };
  const startFromMangadex = () => start({ mangadexList: mdUrl.trim() });
  const startFromPaste = () => {
    const titles = pasted.split('\n').map((t) => t.trim()).filter(Boolean);
    if (titles.length) start({ titles });
  };

  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<{ content: Src[] }>('/api/sources'),
    staleTime: 30_000,
  });
  const sourceName = (id: string | null): string => (id && sourcesData?.content.find((s) => s.id === id)?.name) || id || '';

  const { data, refetch } = useQuery({
    queryKey: ['import-batch', batchId],
    queryFn: () => api<{ batch: ImportBatch; items: ImportCandidate[] }>(`/api/admin/import/batches/${batchId}`),
    enabled: !!batchId,
    refetchInterval: (q) => {
      const st = q.state.data?.batch.state;
      return st === 'resolving' || st === 'importing' ? 1500 : false;
    },
  });
  const batch = data?.batch;
  const items = data?.items ?? [];

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ImportCandidate | null>(null);
  const [running, setRunning] = useState(false);

  const filtered = items.filter((c) => {
    if (filter === 'attention' && !needsAttention(c)) return false;
    if (filter === 'skipped' && c.decision !== 'skip') return false;
    if (q.trim() && !c.backup_title.toLowerCase().includes(q.trim().toLowerCase())) return false;
    return true;
  });
  const attentionCount = items.filter(needsAttention).length;
  const skippedCount = items.filter((c) => c.decision === 'skip').length;
  const importCount = items.filter((c) => c.decision === 'auto' || c.decision === 'manual').length;

  const resume = async () => {
    if (!batchId) return;
    try { await api(`/api/admin/import/batches/${batchId}/resume`, { method: 'POST' }); refetch(); }
    catch (e: any) { toast(msgOf(e, tr('Could not resume')), 'error'); }
  };
  const runImport = async () => {
    if (!batchId) return;
    setRunning(true);
    try { await api(`/api/admin/import/batches/${batchId}/run`, { method: 'POST' }); refetch(); }
    catch (e: any) { toast(msgOf(e, tr('Could not start the import')), 'error'); }
    setRunning(false);
  };
  const startOver = () => { setBatchId(null); setMdUrl(''); setPasted(''); router.replace('/admin/import/'); };
  const closeEditor = () => { setEditing(null); qc.invalidateQueries({ queryKey: ['import-batch', batchId] }); };

  if (!isAdmin) return <div className="flex min-h-screen-d items-center justify-center text-fog-400">{tr('Admins only.')}</div>;

  return (
    <div className="min-h-screen-d px-4 pb-10 pt-4 lg:px-0">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => router.push('/admin/')} className="grid h-8 w-8 place-items-center rounded-full text-fog-400 hover:text-fog-100" aria-label={tr('Back')}>
          <IcChevronLeft width={18} height={18} className="rtl:rotate-180" />
        </button>
        <h1 className="font-display text-lg font-semibold text-fog-50">{tr('Import & review matches')}</h1>
      </div>

      {!batch ? (
        <IntakeCard backupRef={backupRef} mdUrl={mdUrl} setMdUrl={setMdUrl} pasted={pasted} setPasted={setPasted}
          starting={starting} onFile={startFromFile} onMangadex={startFromMangadex} onPaste={startFromPaste} />
      ) : batch.state === 'resolving' ? (
        <ResolvingCard batch={batch} onResume={resume} />
      ) : batch.state === 'review' ? (
        <ReviewCard items={filtered} allCount={items.length} attentionCount={attentionCount} skippedCount={skippedCount}
          importCount={importCount} filter={filter} setFilter={setFilter} q={q} setQ={setQ}
          onEdit={setEditing} onRun={runImport} running={running} sourceName={sourceName} />
      ) : (
        <RunCard batch={batch} items={items} onStartOver={startOver} />
      )}

      {editing && batchId && <ImportMatchSheet batchId={batchId} candidate={editing} onClose={closeEditor} />}
    </div>
  );
}

export default function ImportWizardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen-d" />}>
      <ImportWizardInner />
    </Suspense>
  );
}
