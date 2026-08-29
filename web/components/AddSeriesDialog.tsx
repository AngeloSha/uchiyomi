'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Page, Series } from '@/lib/types';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { IcCheck, IcChevronLeft } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

export interface Provider { source: string; name: string; sourceId: string; title: string; coverUrl?: string }
interface Detail {
  source: string; sourceId: string; title: string; summary: string; coverUrl: string | null;
  genres: string[]; status: string; count: number; first: number | null; last: number | null;
}
interface Job { folder: string; title: string; total: number; done: number; status: string }

export type AddSeed =
  | { kind: 'trending'; title: string }
  | { kind: 'result'; provider: Provider }
  | { kind: 'group'; title: string; providers: Provider[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Never render a swept-up <style>/<script> block as a description. The BFF guards this too. */
const looksCss = (s: string) =>
  s.length > 2500 || /<\/?(?:style|script)\b|\.[a-z][\w-]*\s*[{,]|@import|gtag\(|wp-manga|woocommerce|datalayer/i.test(s);

/**
 * Adding a series, in the app's own dialog.
 *
 * The old one was a hand-rolled div: no `role="dialog"`, no `aria-modal`, no Escape, no focus management,
 * and the page scrolled behind it. `Modal` has all of that, including the fix that stops a dialog closing
 * itself when you type a space into one of its fields.
 *
 * It also did not survive the thing it existed for: after a successful add you got a toast and nothing else.
 * The server returns `folder`, which is the key into `/api/sources/jobs`, so the dialog can stay open and
 * show the real download rather than dismissing itself and hoping.
 */
export function AddSeriesDialog({ seed, sources, onClose, onAdded }: {
  seed: AddSeed;
  /** Which sources to look in. Unscoped, one tap is an outbound request to every source on the server. */
  sources: string[];
  onClose: () => void;
  onAdded: (r: { title: string; folder: string; chapters: number }) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();

  const [providers, setProviders] = useState<Provider[] | null>(seed.kind === 'group' ? seed.providers : null);
  const [picked, setPicked] = useState<Provider | null>(
    seed.kind === 'result' ? seed.provider : seed.kind === 'group' && seed.providers.length === 1 ? seed.providers[0] : null,
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(0);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [adding, setAdding] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; folder: string; chapters: number; started?: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  const title = seed.kind === 'result' ? seed.provider.title : seed.title;

  // Which request the state belongs to. Picking source A then B and having A land last used to overwrite B.
  const want = useRef(0);

  useEffect(() => {
    if (seed.kind !== 'trending') return;
    const mine = ++want.current;
    setLoading(true);
    api<{ content: Provider[] }>(`/api/sources/find?q=${encodeURIComponent(seed.title)}&sources=${encodeURIComponent(sources.join(','))}`)
      .then((r) => { if (mine === want.current) { setProviders(r.content); if (r.content.length === 1) setPicked(r.content[0]); } })
      .catch(() => { if (mine === want.current) setProviders([]); })
      .finally(() => { if (mine === want.current) setLoading(false); });
  }, [seed, sources]);

  useEffect(() => {
    if (!picked) return;
    const mine = ++want.current;
    setLoading(true); setDetail(null);
    api<Detail>(`/api/sources/detail?source=${encodeURIComponent(picked.source)}&sourceId=${encodeURIComponent(picked.sourceId)}`)
      .then((d) => { if (mine === want.current) { setDetail(d); setCount(d.count); } })
      .catch(() => { if (mine === want.current) setDetail(null); })
      .finally(() => { if (mine === want.current) setLoading(false); });
  }, [picked]);

  // Only while the dialog is showing a live download.
  const { data: jobs } = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: !!done,
    refetchInterval: 2000,
  });
  const job = done ? (jobs?.content ?? []).find((j) => j.folder === done.folder) : undefined;

  const add = async (force = false) => {
    if (!picked) return;
    setAdding(true); setDup(null);
    try {
      const r = await api<{ title: string; folder: string; chapters: number; started?: boolean }>('/api/sources/add', {
        json: { source: picked.source, sourceId: picked.sourceId, chapterCount: count || undefined, autoUpdate, force },
        // The client has never set a timeout anywhere, so the only bound was the proxy's 120s -- which
        // turned a slow-but-working add into "Add failed. Try another source." while the download carried
        // on. The request now answers in seconds, so this is a backstop rather than the usual path.
        signal: AbortSignal.timeout(45_000),
      });
      setDone(r);
      onAdded(r);
    } catch (e: any) {
      let body: any = {};
      try { body = JSON.parse(e?.body || '{}'); } catch { /* not JSON */ }
      if (body.error === 'duplicate') setDup(body.message || tr('You already have this title.'));
      else toast(msgOf(e, tr('Add failed. Try another source.')), 'error');
    }
    setAdding(false);
  };

  const openIt = async () => {
    if (!done) return;
    setOpening(true);
    try {
      // addSeriesFromSource persists the scan before returning, so in owned mode the row exists by now.
      const p = await api<Page<Series>>('/api/series/search', { json: { fullTextSearch: done.title, size: 5 } });
      const hit = p.content.find((s) => norm(s.metadata?.title || s.name) === norm(done.title)) ?? p.content[0];
      qc.invalidateQueries({ queryKey: ['library'] });
      router.push(hit ? `/series/?id=${hit.id}` : '/downloads/');
    } catch { router.push('/downloads/'); }
  };

  // ---------------------------------------------------------------- done
  if (done) {
    return (
      <Modal title={tr('Added to your library')} onClose={onClose}>
        <div className="space-y-4 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
            <IcCheck width={26} height={26} />
          </span>
          <div>
            <p className="font-display text-base font-semibold text-fog-50">{done.title}</p>
            <p className="mt-0.5 text-sm text-fog-400">
              {done.chapters > 0 ? tr('Downloading {n} chapters', { n: done.chapters }) : tr('Already in your library')}
            </p>
          </div>
          {done.chapters > 0 && (
            <>
              <ProgressBar value={job && job.total ? job.done / job.total : 0.02} />
              <p className="text-xs tabular-nums text-fog-500">{job ? `${job.done}/${job.total}` : '…'}</p>
            </>
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-ghost flex-1 py-2.5 text-sm">{tr('Done')}</button>
            <button onClick={openIt} disabled={opening} className="btn-accent flex-1 py-2.5 text-sm disabled:opacity-50">
              {tr('Open in library')}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // ---------------------------------------------------------------- pick a source
  if (!picked) {
    return (
      <Modal title={title} onClose={onClose}>
        {loading ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Searching…')}</p>
        ) : !providers?.length ? (
          <p className="py-8 text-center text-sm text-fog-500">{tr('Not found on any source yet — try searching manually.')}</p>
        ) : (
          <>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Available on — pick a source')}</p>
            <div className="space-y-1">
              {providers.map((p, i) => (
                <button key={`${p.source}:${p.sourceId}`} onClick={() => setPicked(p)}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start hover:bg-ink-800/60">
                  <Img src={sourceCover(p.source, p.coverUrl)} alt="" fallbackSrc={p.coverUrl}
                    className="h-14 w-10 shrink-0 rounded" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fog-100">{p.name}</span>
                    <span className="block truncate text-[11px] text-fog-500">{p.title}</span>
                  </span>
                  {i === 0 && <span className="chip shrink-0 text-[10px]">{tr('preferred')}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- options
  const summary = detail?.summary && !looksCss(detail.summary) ? detail.summary : '';
  const presets = [10, 25, 50, 100, 200].filter((n) => detail && n < detail.count);

  return (
    // Not dismissable while the request is in flight. Escape or a backdrop click used to unmount the dialog
    // mid-add: the add still completed, but `setDone` and `onAdded` ran against nothing, so there was no
    // confirmation and the tile was never marked as added -- the worst possible version of "did that work?"
    <Modal title={detail?.title || title} onClose={adding ? () => {} : onClose} wide>
      {loading || !detail ? (
        <p className="py-10 text-center text-sm text-fog-500">{tr('Loading…')}</p>
      ) : (
        <div className="sm:flex sm:gap-4">
          <div className="mb-3 shrink-0 sm:mb-0 sm:w-40">
            <Img src={sourceCover(detail.source, detail.coverUrl)} alt="" fallbackSrc={detail.coverUrl || undefined}
              className="aspect-[2/3] w-28 rounded-xl border border-ink-700 sm:w-40" />
          </div>
          <div className="min-w-0 flex-1">
            {providers && providers.length > 1 && (
              <button onClick={() => { setPicked(null); setDetail(null); }} className="chip mb-2 text-xs">
                <IcChevronLeft width={13} height={13} />{tr('Change source')}
              </button>
            )}
            <p className="text-xs text-fog-500">
              {detail.count} {detail.count === 1 ? tr('chapter') : tr('chapters')}
              {detail.first != null && detail.last != null && <> · {detail.first}–{detail.last}</>}
            </p>
            {detail.genres.length > 0 && (
              <p className="mt-1 line-clamp-1 text-[11px] text-fog-500">{detail.genres.slice(0, 4).join(' · ')}</p>
            )}
            {summary && <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-fog-400">{summary}</p>}

            <label className="mb-1 mt-4 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Chapters to download')}</label>
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="field">
              <option value={detail.count}>{tr('All ({n})', { n: detail.count })}</option>
              {presets.map((n) => <option key={n} value={n}>{tr('First {n}', { n })}</option>)}
            </select>

            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm text-fog-200">{tr('Auto-update new chapters')}</span>
              <Switch on={autoUpdate} onChange={setAutoUpdate} label={tr('Auto-update new chapters')} />
            </div>

            {count > 40 && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                {tr('Grabbing many chapters at once can get you rate-limited. It pauses on its own and you can resume later.')}
              </p>
            )}
            {dup && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">{dup}</p>}

            <button onClick={() => add(!!dup)} disabled={adding} className="btn-accent mt-4 w-full py-2.5 text-sm disabled:opacity-50">
              {adding ? tr('Working…') : dup ? tr('Add anyway') : tr('Add to library')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
