'use client';
// The slow archive (#117), where it is watched and where it is turned on: its covers in Library -> Downloads,
// the sheet a cover opens, its line under Needs attention and in a series' band, and the keys that pause,
// resume and stop it. What each state means and says is lib/archive.ts's; this only draws it.
//
// ⚠️ Nothing here animates. The archive fetches a chapter every quarter of an hour or so for days, and the
// owner asked that it never turn a ring: every ring below is `static` and amber, with an hourglass for a glyph.
// The one poll it rides on is AppShell's ['source-jobs']; an action here asks it again (kickDownloads) rather
// than starting a timer of its own.
//
// ⚠️ The sheet and the Stop confirmation are on <body> (ui.tsx OnBody): the band and the Needs attention rows are
// `.card`s, whose backdrop blur made each the dialog's containing block -- only the card dimmed, the panel over
// the row or off the top of the screen, the next card over its buttons. Only the Queued cover, not a card, worked.
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { bytes, etaText, relativeTime } from '@/lib/format';
import {
  ARCHIVE_MAX_SERIES, archiveBulkNotice, archiveOutcomeNotice, archiveProgressText, archiveStateText, attentionText, globalWaitOf,
  leftBehindLines, waitingText, type ArchiveItem, type ArchiveView, type EnqueueResult,
} from '@/lib/archive';
import { kickDownloads } from '@/lib/useServerDownloads';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { Img, OnBody, Sheet } from '@/components/ui';
import { CoverProgress, ProgressRing } from '@/components/ProgressRing';
import { IcHourglass } from '@/components/icons';

const enc = encodeURIComponent;

/**
 * Ask the downloads again now, and once more a moment later. The first answer carries the change itself (the
 * row's state, the pause flag); the server kicks its scheduler on every change, and why each archive now waits
 * is in the answer after that. The poll would bring it too, but the archive never makes the poll faster (lib/
 * serverDownloads.ts), so without the second ask a Resume could read "paused" for half a minute.
 */
function kickTwice(qc: QueryClient): void {
  void kickDownloads(qc);
  setTimeout(() => { void kickDownloads(qc); }, 2500);
}

/**
 * Pause, resume, stop and dismiss one archive (POST .../pause|resume, DELETE). The server refuses anyone but
 * the one who queued it and admins (403), which `ArchiveItem.may` already mirrors, so a refusal here is a race
 * and is said as the server's own sentence. Each answer asks the downloads again at once, and the series page's
 * chapter list, whose grey rows read "being archived slowly" while it runs.
 */
export function useArchiveActions() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (path: string, method: 'POST' | 'DELETE', seriesId: string, ok?: string) => {
    setBusy(true);
    try {
      await api(path, { method });
      if (ok) toast(ok, 'success');
    } catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
    kickTwice(qc);
    void qc.invalidateQueries({ queryKey: ['series-listing', seriesId] });
    setBusy(false);
  };
  return {
    busy,
    pause: (id: string) => run(`/api/sources/archive/${enc(id)}/pause`, 'POST', id),
    resume: (id: string) => run(`/api/sources/archive/${enc(id)}/resume`, 'POST', id),
    stop: (id: string) => run(`/api/sources/archive/${enc(id)}`, 'DELETE', id, tr('Stopped archiving. What came in stays.')),
    dismiss: (id: string) => run(`/api/sources/archive/${enc(id)}`, 'DELETE', id),
  };
}

/**
 * Queue series for the slow archive: one from its page or its card menu, or a Library selection. At most
 * ARCHIVE_MAX_SERIES per request, so a "Select all" of a big shelf is several. One notice for all of it, in the
 * words of lib/archive.ts. Resolves to the results, or null when a request failed outright.
 */
export function useArchiveEnqueue() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (ids: readonly string[], title?: string): Promise<EnqueueResult[] | null> => {
    const results: EnqueueResult[] = [];
    try {
      for (let i = 0; i < ids.length; i += ARCHIVE_MAX_SERIES) {
        const r = await api<{ results: EnqueueResult[] }>('/api/sources/archive', { method: 'POST', json: { seriesIds: ids.slice(i, i + ARCHIVE_MAX_SERIES) } });
        results.push(...r.results);
      }
    } catch (e) {
      toast(msgOf(e, tr('Could not do that')), 'error');
      return null;
    } finally {
      kickTwice(qc);
      // One series is queued from its own page, whose older chapters now read "being archived slowly".
      if (ids.length === 1) void qc.invalidateQueries({ queryKey: ['series-listing', ids[0]] });
    }
    const n = ids.length === 1 ? archiveOutcomeNotice(results[0]?.outcome, title ?? results[0]?.title ?? '') : archiveBulkNotice(results);
    toast(n.msg, n.tone);
    return results;
  };
}

/**
 * The confirmation before an archive stops. What landed stays. The row and its boundary go (bff lib/archive.ts
 * archiveAct), so the series' floor is its own again (updater.ts: `max(chapter_floor, boundary)`): the scheduled
 * check fetches the rest at its own pace, unless a "Nothing yet" or Latest-N floor keeps it for someone to fetch.
 * It said "the rest are left for you to fetch later" for every series, which the docs and the code contradict.
 */
function StopConfirm({ item, onClose, onStopped }: { item: ArchiveItem; onClose: () => void; onStopped?: () => void }) {
  const a = useArchiveActions();
  return (
    <OnBody>
      <ConfirmDialog
        title={tr('Stop archiving {title}?', { title: item.title })}
        body={<p data-stop-body>{tr('Chapters already fetched stay. The rest go back to the scheduled check, or wait for you on a Latest N or Nothing yet series.')}</p>}
        confirmLabel={tr('Stop archiving')}
        danger busy={a.busy}
        onConfirm={async () => { await a.stop(item.seriesId); onClose(); onStopped?.(); }}
        onClose={onClose} />
    </OnBody>
  );
}

/**
 * The keys for one archive, each only for someone who may press it: Pause or Resume, Stop, Dismiss for a
 * finished one. Rectangular keys, never chips. `onStop` hands the Stop question to a caller that cannot show a
 * dialog over itself -- a Sheet paints over a Modal, so the sheet closes first and asks.
 */
export function ArchiveKeys({ item, onStop }: { item: ArchiveItem; onStop?: () => void }) {
  const a = useArchiveActions();
  const [asking, setAsking] = useState(false);
  return (
    <>
      {item.may.pause && <button type="button" disabled={a.busy} onClick={() => a.pause(item.seriesId)} className="btn-key">{tr('Pause')}</button>}
      {item.may.resume && <button type="button" disabled={a.busy} onClick={() => a.resume(item.seriesId)} className="btn-key">{tr('Resume')}</button>}
      {item.may.stop && (
        <button type="button" disabled={a.busy} onClick={() => (onStop ? onStop() : setAsking(true))} className="btn-key btn-key-danger">{tr('Stop archiving')}</button>
      )}
      {item.may.dismiss && <button type="button" disabled={a.busy} onClick={() => a.dismiss(item.seriesId)} className="btn-key">{tr('Dismiss')}</button>}
      {asking && <StopConfirm item={item} onClose={() => setAsking(false)} />}
    </>
  );
}

/** The still amber ring with its hourglass: the archive's mark wherever it is drawn small. */
function ArchiveMark({ item, size }: { item: ArchiveItem; size: number }) {
  const paused = item.entry.state === 'paused';
  return (
    <span className="relative grid shrink-0 place-items-center">
      <ProgressRing progress={paused ? 'idle' : item.progress} size={size} tone={paused ? 'muted' : 'amber'} static
        label={tr('Slow archive')} valueText={archiveProgressText(item.entry)} />
      <IcHourglass width={Math.round(size * 0.42)} height={Math.round(size * 0.42)} aria-hidden
        className={`absolute ${paused ? 'text-fog-500' : 'text-amber-400'}`} />
    </span>
  );
}

/**
 * One archive, in full: how far it has got, what it is doing or waiting for, about how long is left and how
 * much more space it will take, which way it fills, what a finished one left behind -- and the keys. Over the
 * bottom nav, like every sheet opened from a page that has one.
 */
export function ArchiveSheet({ item, view, onClose }: { item: ArchiveItem; view?: ArchiveView | null; onClose: () => void }) {
  const [stopping, setStopping] = useState(false);
  if (stopping) return <StopConfirm item={item} onClose={() => setStopping(false)} onStopped={onClose} />;
  const e = item.entry;
  const now = Date.now();
  const total = e.left == null ? null : e.done + e.left;
  // What it is doing, else the first reason it is not: its own pause, the whole archive's, then its own wait.
  const everyone = waitingText(globalWaitOf(view), view, now);
  const status = e.current ? tr('Fetching Ch. {n} now', { n: e.current.number })
    : item.section === 'attention' ? attentionText(e, now)
    : e.state === 'paused' ? tr('Paused')
    : everyone || waitingText(e.waiting, view, now);
  const size = e.left && e.done > 0 && e.bytes > 0 ? (e.bytes / e.done) * e.left : 0;
  const lines = [
    e.state !== 'done' && e.etaMs != null && e.left ? tr('{eta} to go', { eta: etaText(e.etaMs) }) : '',
    e.state !== 'done' && (total ?? 0) > 1 ? (e.direction === 'down' ? tr('Newest chapters first') : tr('Oldest chapters first')) : '',
    size > 0 ? tr('About {size} more on disk', { size: bytes(size) }) : '',
    e.state !== 'done' && e.failed > 0
      ? (e.failed === 1 ? tr('1 chapter failed so far and will be tried again') : tr('{n} chapters failed so far and will be tried again', { n: e.failed }))
      : '',
    ...(e.state === 'done' ? leftBehindLines(e.note) : []),
    e.startedAt ? tr('Started {ago}', { ago: relativeTime(e.startedAt) }) : tr('Queued {ago}', { ago: relativeTime(e.queuedAt) }),
  ].filter(Boolean);
  return (
    <OnBody>
      <Sheet title={item.title} onClose={onClose} overBottomNav>
        <div data-archive-sheet className="space-y-4 pb-2">
          <div className="flex items-center gap-3">
            <ArchiveMark item={item} size={44} />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/90">{tr('Slow archive')}</p>
              <p className="text-sm font-medium tabular-nums text-fog-100">
                {e.state === 'done' ? archiveProgressText(e)
                  : total == null ? archiveProgressText(e)
                  : total === 1 ? tr('{done} of 1 chapter', { done: e.done }) : tr('{done} of {n} chapters', { done: e.done, n: total })}
              </p>
            </div>
          </div>
          {status && (
            <p dir="auto" className={`text-[13px] leading-relaxed ${item.section === 'attention' ? 'text-amber-300' : 'text-fog-200'}`}>{status}</p>
          )}
          {lines.length > 0 && (
            <ul className="space-y-1 text-[12px] leading-relaxed text-fog-400">
              {lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <ArchiveKeys item={item} onStop={() => setStopping(true)} />
            <Link href={`/series/?id=${enc(item.seriesId)}`} onClick={onClose} className="btn-key">{tr('Open series')}</Link>
          </div>
        </div>
      </Sheet>
    </OnBody>
  );
}

/**
 * An archived series in Queued: its cover under a still amber ring filling with done / (done + left), an
 * hourglass for a glyph, and under it how far and how long. A tap opens the sheet, which is where its keys are:
 * a cover a thumb can brush is no place for Stop.
 */
export function ArchiveTile({ item, view }: { item: ArchiveItem; view?: ArchiveView | null }) {
  const [open, setOpen] = useState(false);
  const e = item.entry;
  // Paused by its owner, or for everyone by an admin: either way nothing is coming, and the cover says so.
  const paused = e.state === 'paused' || !!view?.paused;
  const progress = archiveProgressText(e);
  const state = archiveStateText(item, view);
  const label = [item.title, tr('Slow archive'), progress, state].filter(Boolean).join(' · ');
  return (
    <div data-download-tile data-state="queued" data-archive={e.state} className="relative min-w-0">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="block w-full text-start">
        <div className="grad-border relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700/60">
          <Img src={img.seriesThumb(item.seriesId)} alt="" className="h-full w-full" />
          <CoverProgress state={paused ? 'paused' : 'waiting'} progress={item.progress} label={label} tone="amber" static
            glyph={<IcHourglass width={18} height={18} className={paused ? 'text-fog-400' : 'text-amber-300'} />} />
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-tight text-fog-200">{item.title}</p>
        <p className="mt-0.5 truncate text-[11px] tabular-nums text-fog-400">{progress}</p>
        {state && <p className="truncate text-[11px] text-fog-500">{state}</p>}
      </button>
      {open && <ArchiveSheet item={item} view={view} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * An archive under Needs attention: why, in amber, with what can be done about it. A full disk is the admin's
 * to answer (more space, or a lower floor under Settings), so an admin gets the way there.
 */
export function ArchiveAttentionRow({ item, view, admin }: { item: ArchiveItem; view?: ArchiveView | null; admin: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-attention="archive" className="card flex min-w-0 items-start gap-3 px-4 py-3">
      <Img src={img.seriesThumb(item.seriesId)} alt="" className="h-[60px] w-10 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        {/* Its own direction: in an Arabic page the line's ellipsis cut an English title at its start. */}
        <p dir="auto" className="truncate text-sm font-medium text-fog-100">{item.title}</p>
        <p dir="auto" className="mt-0.5 text-[12px] leading-relaxed text-amber-300">{attentionText(item.entry)}</p>
        {/* Still taking a chapter (the retry after a backoff): said here, not only inside the sheet. */}
        {item.entry.current && <p className="mt-0.5 text-[12px] text-fog-200" data-archive-current>{tr('Fetching Ch. {n} now', { n: item.entry.current.number })}</p>}
        <p className="mt-0.5 text-[11px] text-fog-500">{tr('Slow archive')} · {archiveProgressText(item.entry)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <ArchiveKeys item={item} />
          <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="btn-key">{tr('Details')}</button>
          {admin && item.entry.attention?.why === 'disk' && <Link href="/admin/?tab=Settings" className="btn-key">{tr('Settings')}</Link>}
        </div>
      </div>
      {open && <ArchiveSheet item={item} view={view} onClose={() => setOpen(false)} />}
    </li>
  );
}

/**
 * The line under Queued's heading while archives are in it: the pace every source is held to, why nothing is
 * moving when that is the whole archive's reason, and for an admin the server-wide pause and the way to the
 * settings. Pause all is Admin -> Settings -> Downloads' switch, not a pause of each row: resuming it puts
 * back exactly what was running.
 */
export function ArchiveQueueNote({ view, admin }: { view: ArchiveView; admin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try { await api('/api/admin/settings', { method: 'PATCH', json: { archivePaused: !view.paused } }); }
    catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
    kickTwice(qc);
    void qc.invalidateQueries({ queryKey: ['admin-settings'] });
    setBusy(false);
  };
  const wait = waitingText(globalWaitOf(view), view);
  return (
    <div data-archive-note className="mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-fog-400 lg:mx-0">
      <IcHourglass width={14} height={14} aria-hidden className="text-amber-400" />
      <span>{view.perHour === 1 ? tr('Slow archive: 1 chapter an hour per source') : tr('Slow archive: {n} chapters an hour per source', { n: view.perHour })}</span>
      {wait && <span className="text-amber-300">{wait}</span>}
      {admin && (
        <span className="flex items-center gap-3">
          <button type="button" disabled={busy} onClick={flip} className="btn-key">{view.paused ? tr('Resume all') : tr('Pause all')}</button>
          <Link href="/admin/?tab=Settings" className="text-accent hover:underline">{tr('Settings')}</Link>
        </span>
      )}
    </div>
  );
}

/**
 * The series band's archive line: the series page's one place to watch its archive (the Actions column and the
 * older-chapters row only start one). A still ring, one sentence, the keys, and Details for the rest.
 */
export function ArchiveBand({ item, view }: { item: ArchiveItem; view?: ArchiveView | null }) {
  const [open, setOpen] = useState(false);
  const attention = item.section === 'attention';
  // A finished one left something behind (it is only here then): what, not how far it got.
  const sentence = (item.entry.state === 'done'
    ? [tr('Slow archive'), attentionText(item.entry)]
    : [tr('Archiving slowly'), archiveProgressText(item.entry), archiveStateText(item, view)]).filter(Boolean).join(' · ');
  return (
    <div data-band-state={attention ? 'archive-attention' : 'archive'}
      className={`card flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${attention ? 'border-amber-500/40' : ''}`}>
      <ArchiveMark item={item} size={28} />
      <p dir="auto" className={`min-w-0 flex-1 basis-40 text-[13px] leading-snug ${attention ? 'text-amber-300' : 'text-fog-200'}`}>{sentence}</p>
      <div className="flex flex-wrap items-center gap-2">
        <ArchiveKeys item={item} />
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="shrink-0 text-[12px] font-medium text-accent hover:underline">
          {tr('Details')}
        </button>
      </div>
      {open && <ArchiveSheet item={item} view={view} onClose={() => setOpen(false)} />}
    </div>
  );
}
