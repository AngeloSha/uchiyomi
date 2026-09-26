'use client';
/**
 * Finding, and confirming, the chapters a series is missing.
 *
 * The button is the entry point; this dialog is the feature. A chapter fetched from the wrong series lands as
 * `Chapter 47.cbz` exactly where the right one belongs, looks identical in every listing, and is only found
 * by opening it. Nothing here downloads anything until a person has been shown which source, which title on
 * that source, and how many chapters, and has pressed a button that repeats all three back to them.
 *
 * Sources that were checked and rejected are shown too, with the reason and the measured overlap, because
 * "MangaDex has this but numbers it differently" is worth knowing and a silently shortened list is not.
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import { followable } from '@/lib/scanlators';
import { offerOf, runState, runsOf, scanPoll, stillAsking, toggleOne, toggleRun, type OfferMode } from '@/lib/chapterPicker';
import type { SeriesSource } from '@/lib/types';
import { jobNoteLines, type JobCardNotes } from '@/lib/jobNotes';
import { fetchingToast, joinSentences } from '@/lib/jobs';

interface Candidate {
  source: string; name: string; sourceSeriesId: string; title: string; coverUrl?: string;
  count: number; first: number | null; last: number | null;
  coverage: number; matched: number;
  fillable: number[]; newer: number[]; older: number[];
  why: string; pinned: boolean;
  health?: { status: string; consecutive: number; lastFailAt: string | null; lastOkAt: string | null } | null;
}
interface Scan {
  seriesId: string; title: string; folder: string;
  have: { count: number; first?: number; last?: number };
  gaps: { lo: number; hi: number; count: number }[];
  candidates: Candidate[];
  planId: string;
  /** The most chapters one fill may take; the server refuses more, so the dialog never asks for more. */
  fillMax?: number;
  /** Source ids the updater already asks for this series, so a followed one offers no second follow button. */
  following?: string[];
  refusal: { code: string; message: string } | null;
  /** v0.48.4: the scan answers as it goes. Absent from a scan that never started (too few chapters). */
  scanId?: string;
  done?: boolean;
  /** The sources it is waiting for right now, and how many have not had a turn yet. */
  asking?: { source: string; name: string }[];
  waiting?: number;
  /** The scan itself broke (not one source): said instead of a list. */
  failed?: string;
}
interface Job extends JobCardNotes { folder: string; title: string; total: number; done: number; status: string; reason?: string }

/** The error code in an API refusal (`{error: 'plan_stale'}`), or null. */
function codeOf(e: unknown): string | null {
  try { return e instanceof ApiError ? (JSON.parse(e.body)?.error ?? null) : null; } catch { return null; }
}

/** Why a source was not offered, in words rather than a code. */
function whyText(c: Candidate): string {
  switch (c.why) {
    case 'numbering_mismatch':
      return tr('Numbers its chapters differently') +
        ` (${Math.round(c.coverage * 100)}%` + tr(' of yours match') + ')';
    // A member sees a matching source with newer chapters here (only an admin can follow it): not "nothing".
    case 'nothing_to_fill': return c.newer.length
      ? c.newer.length === 1 ? tr('Has 1 chapter newer than yours; an admin can follow it')
        : tr('Has {n} chapters newer than yours; an admin can follow it', { n: c.newer.length })
      : tr('Has nothing you are missing');
    case 'no_chapters': return tr('Listed no chapters');
    case 'blocked': return tr('Temporarily unavailable');
    case 'unreachable': return tr('Could not be reached (timed out or refused)');
    case 'not_tried': return tr('Not asked: enough sources already had it');
    case 'disabled': return tr('Switched off');
    default: return tr('Not usable');
  }
}

/**
 * The chapters one source can supply, as chips (v0.48.3): a run of consecutive chapters is one chip, and its
 * "⋯" opens it into one chip per chapter. Everything starts selected -- "the rest of the missing chapters" is
 * what the owner came for -- and a tap takes a run, or a chapter, out.
 */
function ChapterPicker({ numbers, selected, onChange }: {
  numbers: number[]; selected: ReadonlySet<number>; onChange: (next: Set<number>) => void;
}) {
  const runs = useMemo(() => runsOf(numbers), [numbers]);
  const [open, setOpen] = useState<number | null>(null);
  const opened = runs.find((r) => r.lo === open);
  const count = numbers.filter((n) => selected.has(n)).length;
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fog-500">
        <span>{tr('{n} selected', { n: count })}</span>
        <button type="button" onClick={() => onChange(new Set(numbers))} className="hover:text-fog-200">{tr('Select all')}</button>
        <button type="button" onClick={() => onChange(new Set())} className="hover:text-fog-200">{tr('Select none')}</button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {runs.map((r) => {
          const state = runState(r, selected);
          return (
            <span key={r.lo} className="inline-flex items-center gap-0.5">
              <button
                type="button"
                aria-pressed={state === 'all'}
                onClick={() => onChange(toggleRun(selected, r))}
                className={`chip text-xs ${state === 'all' ? 'border-accent/60 text-accent' : state === 'some' ? 'border-accent/30 text-fog-200' : 'text-fog-500 line-through decoration-fog-600'}`}
              >
                {/* <bdi>: a number range stays one unit inside an Arabic sentence. */}
                <bdi>{r.lo === r.hi ? tr('Ch. {n}', { n: r.lo }) : tr('Ch. {a}–{b}', { a: r.lo, b: r.hi })}</bdi>
              </button>
              {r.nums.length > 1 && (
                <button type="button" aria-label={tr('Pick chapters one by one')} aria-expanded={open === r.lo}
                  onClick={() => setOpen(open === r.lo ? null : r.lo)} className="chip px-2 text-xs text-fog-400">⋯</button>
              )}
            </span>
          );
        })}
      </div>
      {opened && (
        <div className="mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto" data-lenis-prevent>
          {opened.nums.map((n) => (
            <button key={n} type="button" aria-pressed={selected.has(n)} onClick={() => onChange(toggleOne(selected, n))}
              className={`chip px-2 text-[11px] ${selected.has(n) ? 'border-accent/60 text-accent' : 'text-fog-500'}`}>{n}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FindMissingDialog({ seriesId, onClose }: { seriesId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [altTitle, setAltTitle] = useState('');
  const [term, setTerm] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Each source's chosen chapters, by `${source}:${sourceSeriesId}`; absent means everything it offers. */
  const [picked, setPicked] = useState<Record<string, number[]>>({});

  // One scan per title: POST starts it (or joins the one already running) and answers after a moment with what
  // has arrived; every read after that is the scan's own route, every two seconds until it is done. A scan used to
  // be one request that waited for the slowest source, and a proxy gave up first: "The scan failed." (v0.48.4)
  const scanRef = useRef<{ key: string; id: string } | null>(null);
  const scanKey = `${seriesId}\u0000${term}`;
  const scan = useQuery({
    queryKey: ['fill-scan', seriesId, term],
    queryFn: async () => {
      const cur = scanRef.current?.key === scanKey ? scanRef.current : null;
      let res: Scan | null = null;
      if (cur) {
        try {
          res = await api<Scan>(`/api/sources/fill/scan/${encodeURIComponent(cur.id)}`);
        } catch (e) {
          // A blip keeps what is on screen and asks again in two seconds; a scan the server no longer has (it
          // restarted, or the scan aged out) is started again.
          const prev = qc.getQueryData<Scan>(['fill-scan', seriesId, term]);
          if (codeOf(e) !== 'scan_gone' && prev) return prev;
        }
      }
      res ??= await api<Scan>('/api/sources/fill/scan', { method: 'POST', json: { seriesId, altTitle: term || undefined } });
      scanRef.current = res.scanId && res.done === false ? { key: scanKey, id: res.scanId } : null;
      return res;
    },
    refetchInterval: (qy) => scanPoll(qy.state.data),
    staleTime: 60_000,
    retry: false,
  });

  // The same key the downloads pill uses, so both surfaces agree and neither polls on its own schedule.
  const jobs = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: !!started,
    refetchInterval: 2000,
  });
  const job = jobs.data?.content?.find((j) => j.folder === started);

  const run = async (c: Candidate, which: 'fillable' | 'older' = 'fillable') => {
    if (!scan.data) return;
    setBusy(true);
    try {
      // The older run can be long (a "Latest 25 of 200" add leaves 175 behind); the nearest chapters to what
      // we hold go first, so a second press continues where this one stopped.
      const numbers = which === 'older' ? c.older.slice(-(scan.data.fillMax ?? 300)) : c.fillable;
      const res = await api<{ folder: string }>('/api/sources/fill', {
        method: 'POST',
        json: { planId: scan.data.planId, source: c.source, sourceSeriesId: c.sourceSeriesId, numbers },
      });
      setStarted(res.folder);
      qc.invalidateQueries({ queryKey: ['source-jobs'] });
      toast(fetchingToast(numbers.length), 'info');
    } catch (e) {
      toast(msgOf(e, tr('Could not start.')), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Following is the same decision as filling -- this source, under this title, with this overlap -- made
  // once for every future chapter instead of for the gaps in front of us. It goes through the same planId so
  // the server can refuse a stale scan the same way. The scan's `following` is patched in place rather than
  // refetched: a refetch is a fresh scan, which asks every source again and costs a cooldown when one is
  // slow, all to learn a fact the response already carries.
  // `announce` false when "Follow and download" follows on the way to downloading: the download says the rest.
  const follow = async (c: Candidate, announce = true): Promise<boolean> => {
    if (!scan.data) return false;
    if (announce) setBusy(true);
    try {
      const res = await api<{ ok: true; sources: SeriesSource[] }>(`/api/admin/series/${seriesId}/sources`, {
        method: 'POST',
        json: { planId: scan.data.planId, source: c.source, sourceSeriesId: c.sourceSeriesId },
      });
      const following = res.sources.map((x) => x.sourceId);
      qc.setQueryData<Scan>(['fill-scan', seriesId, term], (old) => (old ? { ...old, following } : old));
      qc.invalidateQueries({ queryKey: ['series', seriesId] });
      // The follow refreshes the series' listing in the background, which is where its chapters appear.
      qc.invalidateQueries({ queryKey: ['series-listing', seriesId] });
      // Said plainly, because a follow on its own downloads nothing today: that is what the owner read as broken.
      if (announce) toast(tr('Now following {s}. It is checked for new chapters every few hours; download what it has now below.', { s: c.name }), 'success');
      return true;
    } catch (e) {
      if (codeOf(e) === 'plan_stale') stale();
      else toast(msgOf(e, tr('Could not follow that source.')), 'error');
      return false;
    } finally {
      if (announce) setBusy(false);
    }
  };

  // A scan is good for five minutes (bff lib/fill.ts). One read at leisure is older than that: ask the sources again
  // rather than leave the person with an error and no way back to a fresh list.
  const stale = () => {
    scanRef.current = null;
    void scan.refetch();
    toast(tr('That list was too old, so the sources were asked again. Press it again.'), 'info');
  };

  /**
   * Download what was picked, now. Through the fetch route for the series' own source and the ones it follows
   * (it refreshes the listing and takes the best copy of each chapter across them), following the source first
   * where it has to -- following is what puts its chapters in the listing. By WHOLE number (`floored`): the
   * scan compares sources by whole chapter numbers, so 12 here means 12 and 12.5 there. A source nobody follows
   * fills its holes through the fill plan, as before.
   */
  const download = async (c: Candidate, mode: OfferMode, numbers: number[]) => {
    if (!scan.data || !numbers.length) return;
    const max = scan.data.fillMax ?? 300;
    setBusy(true);
    let followedNow = false;
    try {
      if (mode === 'fill') {
        const res = await api<{ folder: string }>('/api/sources/fill', {
          method: 'POST',
          json: { planId: scan.data.planId, source: c.source, sourceSeriesId: c.sourceSeriesId, numbers: numbers.slice(0, max) },
        });
        setStarted(res.folder);
        toast(fetchingToast(Math.min(numbers.length, max)), 'info');
      } else {
        if (mode === 'follow') {
          if (!(await follow(c, false))) return;
          followedNow = true;
        }
        const res = await api<{ folder: string; total: number; skipped?: Array<{ number: number; reason: string }> }>('/api/sources/fetch', { method: 'POST', json: { seriesId, numbers: numbers.slice(0, max), floored: true } });
        setStarted(res.folder);
        const skipped = res.skipped ?? [];
        const later = skipped.filter((x) => x.reason === 'not_listed').length;
        const other = skipped.filter((x) => x.reason !== 'not_listed' && x.reason !== 'already_here').length;
        // Two sentences, each with its own count, so both agree at one: "1 is not listed yet", "Downloading 1 chapter."
        const also = later
          ? later === 1 ? tr('1 is not listed yet and comes with the next check.') : tr('{m} are not listed yet and come with the next check.', { m: later })
          : other
            ? other === 1 ? tr('1 could not be fetched now.') : tr('{m} could not be fetched now.', { m: other })
            : '';
        const downloading = res.total === 1 ? tr('Downloading 1 chapter.') : tr('Downloading {n} chapters.', { n: res.total });
        toast(also ? joinSentences(downloading, also) : fetchingToast(res.total), 'info');
      }
      qc.invalidateQueries({ queryKey: ['source-jobs'] });
      qc.invalidateQueries({ queryKey: ['series-listing', seriesId] });
      qc.invalidateQueries({ queryKey: ['series-books', seriesId] });
    } catch (e) {
      const code = codeOf(e);
      if (code === 'plan_stale') stale();
      // Followed, but a slow source (a Cloudflare challenge can take a minute) has not listed its chapters yet:
      // the follow stands, and the card now offers a plain Download for when it has.
      else if (followedNow && code === 'nothing_to_fetch') toast(tr('Now following {s}. It is still listing its chapters: press Download again in a minute.', { s: c.name }), 'info');
      else toast(msgOf(e, tr('Could not start.')), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** The follow button for one candidate, or nothing when this person cannot follow or the source cannot be followed. */
  const followButton = (c: Candidate) => {
    if (!isAdmin || !followable(c)) return null;
    const already = !!scan.data?.following?.includes(c.source);
    return (
      <button disabled={busy || already} onClick={() => follow(c)} className="btn-ghost mt-2 w-full text-sm disabled:opacity-50">
        {already ? tr('Already followed') : tr('Also follow this source')}
      </button>
    );
  };

  if (started) {
    return (
      <Modal title={tr('Filling in the gaps')} onClose={onClose}>
        <p className="text-sm text-fog-400">
          {job?.reason
            ? job.reason
            : tr('This runs in the background. You can close this and it will keep going.')}
        </p>
        <div className="mt-4">
          <ProgressBar value={job && job.total ? job.done / job.total : 0.02} />
          <p className="mt-2 text-xs text-fog-500">
            {job ? `${job.done} / ${job.total}` : tr('Starting…')}
          </p>
          {/* A fill asks one source for numbers it has; when a chapter still came from another one, or was
              saved short, the card says so here -- the same lines as the downloads pill. Names from the
              scan's candidates, which is every source this fill could have touched. */}
          {jobNoteLines(job, (id) => scan.data?.candidates.find((c) => c.source === id)?.name ?? id).map((line, i) => (
            <p key={i} className="mt-1.5 text-xs leading-relaxed text-fog-400">{line}</p>
          ))}
        </div>
        <button onClick={onClose} className="btn-ghost mt-5 w-full text-sm">{tr('Close')}</button>
      </Modal>
    );
  }

  const d = scan.data;
  const following = new Set(d?.following ?? []);
  const offer = (c: Candidate) => offerOf(c, { following, isAdmin, followable });
  // Every source that can give this person a chapter the series lacks, in the scan's order: interior holes,
  // AND the chapters past the last one held -- which is where "the rest of the missing chapters" usually are,
  // and which the dialog used to show only as a follow button, under a line calling the source up to date.
  const offering = (d?.candidates || []).filter((c) => offer(c).mode !== 'none' || (c.pinned && c.older.length > 0));
  // Matches our numbering and has nothing we lack yet: worth following for what comes next.
  const alsoFollow = isAdmin ? (d?.candidates || []).filter((c) => !offering.includes(c) && followable(c)) : [];
  const rejected = (d?.candidates || []).filter((c) => !offering.includes(c) && !alsoFollow.includes(c));
  const max = d?.fillMax ?? 300;
  // "Still asking aqua, MangaDex and 2 more…", while the scan is not done.
  const still = d?.done === false ? stillAsking(d.asking ?? [], d.waiting ?? 0) : null;
  const asking = !still ? null
    : !still.names.length ? (still.more === 1 ? tr('Still asking 1 source…') : tr('Still asking {n} sources…', { n: still.more }))
    : tr('Still asking {s}…', { s: still.more ? `${still.names.join(', ')} ${tr('and {n} more', { n: still.more })}` : still.names.join(', ') });

  const header = (c: Candidate) => (
    <div className="flex gap-3">
      <Img src={sourceCover(c.source, c.coverUrl)} alt="" className="h-16 w-12 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{c.name}</p>
        {/* Their title, verbatim. If it is not this series, this line is where a person notices. */}
        <p className="truncate text-xs text-fog-400">{tr('Listed there as')} “{c.title}”</p>
        <p className="mt-1 text-xs text-fog-500">
          {c.count} {tr('chapters')} ({c.first}–{c.last}) · {tr('matches {m} of your {n}')
            .replace('{m}', String(c.matched)).replace('{n}', String(d?.have.count ?? 0))}
          {c.pinned && ` · ${tr('this series’ own source')}`}
        </p>
        {c.newer.length > 0 && (
          <p className="mt-1 text-xs text-fog-300">
            {c.newer.length === 1 ? tr('1 chapter newer than yours') : tr('{n} chapters newer than yours', { n: c.newer.length })}
          </p>
        )}
        {/* A warning, never a filter: hiding a source with a streak would deadlock it, because only a
            successful download clears the streak. The person decides, with the record in front of them. */}
        {c.health && (
          <p className="mt-1 text-xs text-amber-300">
            {tr('Recently unreliable')} · {c.health.status === 'rate_limited' ? tr('rate-limited us')
              : c.health.status === 'blocked' ? tr('refused us') : tr('did not answer')}
            {c.health.consecutive > 1 && ` ${tr('{n} times in a row').replace('{n}', String(c.health.consecutive))}`}
            {!c.health.lastOkAt && ` · ${tr('never completed a download here')}`}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <Modal title={tr('Find missing chapters')} onClose={onClose}>
      {scan.isLoading && <p className="text-sm text-fog-400">{tr('Asking your sources…')}</p>}
      {scan.error && !d && <p className="text-sm text-rose-300">{msgOf(scan.error, tr('The scan failed.'))}</p>}

      {d && (
        <>
          <p className="text-sm text-fog-300">
            {d.have.count === 1 ? tr('You have 1 chapter') : tr('You have {n} chapters').replace('{n}', String(d.have.count))}
            {d.have.first != null && `, ${d.have.first}–${d.have.last}`}
            {d.gaps.length
              ? `. ${tr('Missing')}: ${d.gaps.map((g) => (g.lo === g.hi ? g.lo : `${g.lo}–${g.hi}`)).join(', ')}`
              : `. ${tr('No gaps between them.')}`}
          </p>

          {d.refusal && <p className="mt-3 text-sm text-amber-300">{d.refusal.message}</p>}
          {d.failed && <p className="mt-3 text-sm text-rose-300">{tr(d.failed)}</p>}
          {/* Each source's card comes in as that source answers; this says who it is still waiting for. */}
          {asking && (
            <p className="mt-3 flex items-center gap-2 text-xs text-fog-400" aria-live="polite">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />
              {asking}
            </p>
          )}

          {offering.map((c) => {
            const key = `${c.source}:${c.sourceSeriesId}`;
            const { mode, numbers } = offer(c);
            const selected = new Set(picked[key] ?? numbers);
            const chosen = numbers.filter((n) => selected.has(n));
            const n = Math.min(chosen.length, max);
            return (
              <div key={key} data-find-missing-source={c.source} className="mt-4 rounded-2xl border border-ink-700 p-3">
                {header(c)}
                {mode !== 'none' && (
                  <>
                    <ChapterPicker numbers={numbers} selected={selected} onChange={(next) => setPicked((p) => ({ ...p, [key]: [...next] }))} />
                    <button
                      disabled={busy || !n}
                      onClick={() => download(c, mode, chosen)}
                      className="btn-accent mt-3 w-full text-sm disabled:opacity-50"
                    >
                      {mode === 'follow'
                        ? n === 1 ? tr('Follow {s} and download 1 chapter', { s: c.name }) : tr('Follow {s} and download {n} chapters', { s: c.name, n })
                        : mode === 'fill'
                          ? n === 1 ? tr('Fetch 1 chapter from {s}', { s: c.name }) : tr('Fetch {n} chapters from {s}', { n, s: c.name })
                          : n === 1 ? tr('Download 1 chapter') : tr('Download {n} chapters', { n })}
                    </button>
                    {chosen.length > max && (
                      <p className="mt-1 text-xs text-fog-500">{tr('Up to {max} at a time: the rest can be fetched once this finishes.', { max })}</p>
                    )}
                  </>
                )}
                {/* The chapters a "Latest N" add left behind, from the series' own source only. */}
                {c.older.length > 0 && (
                  <button
                    disabled={busy}
                    onClick={() => run(c, 'older')}
                    className={`${mode !== 'none' ? 'btn-ghost' : 'btn-accent'} mt-2 w-full text-sm disabled:opacity-50`}
                  >
                    {(Math.min(c.older.length, max) === 1 ? tr('Fetch 1 older chapter from {s}')
                      : tr('Fetch {n} older chapters from {s}').replace('{n}', String(Math.min(c.older.length, max))))
                      .replace('{s}', c.name)}
                  </button>
                )}
                {/* Following alone, for what comes next without downloading anything now. */}
                {followButton(c)}
              </div>
            );
          })}

          {!offering.length && !scan.isLoading && d.done !== false && !d.refusal && !d.failed && (
            <p className="mt-3 text-sm text-fog-400">{tr('No source could supply what is missing.')}</p>
          )}

          {/* The series that prompted this is listed elsewhere under a completely different English name. */}
          <div className="mt-5">
            <label className="text-xs text-fog-500">{tr('Known under another name?')}</label>
            <div className="mt-1 flex gap-2">
              <input
                value={altTitle}
                onChange={(e) => setAltTitle(e.target.value)}
                placeholder={tr('Search under a different title')}
                className="min-w-0 flex-1 rounded-full border border-ink-700 bg-transparent px-3 py-2 text-sm"
              />
              <button onClick={() => setTerm(altTitle.trim())} className="btn-ghost shrink-0 text-sm">
                {tr('Search')}
              </button>
            </div>
          </div>

          {alsoFollow.length > 0 && (
            <div className="mt-5">
              <p className="text-xs uppercase tracking-wide text-fog-600">{tr('Could also be followed')}</p>
              <p className="mt-1 text-xs text-fog-500">{tr('Has everything you have and nothing newer yet. Following one means new chapters are taken from whichever source has them first.')}</p>
              {alsoFollow.map((c) => (
                <div key={`${c.source}:${c.sourceSeriesId}`} className="mt-2 rounded-2xl border border-ink-700 p-3">
                  <div className="flex gap-3">
                    <Img src={sourceCover(c.source, c.coverUrl)} alt="" className="h-16 w-12 shrink-0 rounded-lg object-cover" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">{c.name}</p>
                      <p className="truncate text-xs text-fog-400">{tr('Listed there as')} “{c.title}”</p>
                      <p className="mt-1 text-xs text-fog-500">
                        {c.count} {tr('chapters')} ({c.first}–{c.last}) · {tr('matches {m} of your {n}')
                          .replace('{m}', String(c.matched)).replace('{n}', String(d.have.count))}
                      </p>
                    </div>
                  </div>
                  {followButton(c)}
                </div>
              ))}
            </div>
          )}

          {rejected.length > 0 && (
            <div className="mt-5">
              <p className="text-xs uppercase tracking-wide text-fog-600">{tr('Checked, not usable')}</p>
              <ul className="mt-2 space-y-1">
                {rejected.map((c) => (
                  <li key={`${c.source}:${c.sourceSeriesId}`} className="text-xs text-fog-500">
                    <span className="text-fog-400">{c.name}</span> · {whyText(c)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
