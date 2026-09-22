'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AutoFollow, AutoFollowResult, FollowWhy, GroupStat, Page, Series } from '@/lib/types';
import { Modal, msgOf } from '@/components/ConfirmDialog';
import { Img, ProgressBar } from '@/components/ui';
import { sourceCover } from '@/components/cards';
import { Switch } from '@/components/Switch';
import { useToast } from '@/components/Toast';
import { IcCheck } from '@/components/icons';
import { SourceIcon } from '@/components/SourcePicker';
import { GroupAvatar } from '@/components/GroupAvatar';
import { ActivityDots } from '@/components/ActivityDots';
import { activityStatus, weeksOf } from '@/lib/activity';
import { relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { normTitle } from '@/lib/normTitle';
import { cadenceText } from '@/lib/cadence';
import { jobNoteLines, type JobCardNotes } from '@/lib/jobNotes';

export interface Provider { source: string; name: string; sourceId: string; title: string; coverUrl?: string }
interface Detail {
  source: string; sourceId: string; title: string; summary: string; coverUrl: string | null;
  genres: string[]; status: string; count: number; first: number | null; last: number | null;
  /** Who releases it, from the live chapter list (so `onDisk` is 0 -- nothing is on disk yet). Absent from an older server. */
  groups?: GroupStat[];
  /** How many numbers have more than one copy. */
  versions?: number;
}
interface Job extends JobCardNotes {
  folder: string; title: string; total: number; done: number; status: string;
  /** The add-time auto-follow (v0.36.0), once the server has judged the other sources. See lib/types.ts. */
  autoFollow?: AutoFollow;
}

export type AddSeed =
  | { kind: 'trending'; title: string }
  | { kind: 'result'; provider: Provider }
  | { kind: 'group'; title: string; providers: Provider[] };

/**
 * Per-device memory of the "Also check the other sources" switch. A device setting, not an account one: it
 * is about how this person adds, and the server has nothing to store for a choice the dialog makes at add
 * time. Off until switched on.
 */
const ALSO_FOLLOW_KEY = 'uchiyomi.alsoFollow';
/** At most this many candidates ride with an add: the server judges each with two outbound calls, under one wall budget. */
const ALSO_FOLLOW_MAX = 6;

/**
 * The server's reason a candidate source was not followed, as a person would say it. Every branch is a
 * literal so the locale-parity test sees each; a code this list does not know is printed as it came, so a
 * new reason is at least visible rather than silently "not followed".
 */
export function autoFollowWhy(why: FollowWhy | string): string {
  switch (why) {
    case 'numbering_differs': return tr('numbering differs');
    case 'title_differs': return tr('different title');
    case 'unreachable': return tr('could not be reached');
    case 'too_few_listed': return tr('lists too few chapters');
    case 'not_tried': return tr('not checked — it took too long');
    case 'cap': return tr('already following two');
    case 'unavailable': return tr('not available');
    default: return why;
  }
}

/**
 * One candidate's line on the done step: what was followed, under which title there, or why not. The
 * percent sign is glued to its number after translation: at 390 px "· 95 %" broke with a lone "%" on the
 * next line. Done on the output rather than in the keys so no locale file carries an invisible character;
 * a language that writes "95٪" or "95%" has no space to glue.
 */
function autoFollowLine(r: AutoFollowResult): string {
  const pct = Math.round((r.coverage ?? 0) * 100);
  if (r.followed) {
    const line = r.theirTitle
      ? tr('Followed {name} — listed there as “{theirTitle}” · {pct} %', { name: r.name, theirTitle: r.theirTitle, pct })
      : tr('Followed {name} · {pct} %', { name: r.name, pct });
    return line.replace(/(\d) %/, '$1 %');
  }
  return tr('Not followed: {name} — {why}', { name: r.name, why: autoFollowWhy(r.why) });
}

/**
 * What the chapter <select> holds. Sources list chapters ascending, so "First N" has always meant the OLDEST
 * N -- right for a title you are starting, wrong for one you are catching up on. "Latest N" is the other
 * end, and the server puts a floor under the series so auto-update fetches new releases only.
 *
 * `none` is "Nothing yet -- pick chapters later" (#40): the series is created with a listing and a floor
 * above its newest chapter, nothing is fetched, and auto-update takes releases from here on. It is also the
 * only option that survives a source listing zero chapters -- `All (0)` posts a count the server refuses
 * with `no_chapters` -- so it is the default and the only choice then.
 */
type ChapterPick = 'all' | 'none' | `first:${number}` | `latest:${number}`;
const CHAPTER_PRESETS = [10, 25, 50, 100, 200];

/**
 * How long a looked-up detail stays fresh on this device. The server caches the same lookup for ten minutes
 * too, so a longer time here would only show a listing the server itself has already refreshed.
 */
const DETAIL_STALE_MS = 10 * 60_000;
/** One source's series and chapter list. The signal is the query's, so a pick abandoned mid-flight is cancelled. */
const fetchDetail = (p: Pick<Provider, 'source' | 'sourceId'>, signal?: AbortSignal) =>
  api<Detail>(`/api/sources/detail?source=${encodeURIComponent(p.source)}&sourceId=${encodeURIComponent(p.sourceId)}`, { signal });

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
export function AddSeriesDialog({ seed, sources, mayFollow, onClose, onAdded }: {
  seed: AddSeed;
  /** Which sources to look in. Unscoped, one tap is an outbound request to every source on the server. */
  sources: string[];
  /**
   * Whether this person may have the other sources followed (an admin). The manual follow route and the
   * sheet's × are admin-only, so a member who was shown the switch could follow two sources and never undo
   * it; for them the switch is not rendered and no `alsoFollow` is sent, whatever the device remembers.
   */
  mayFollow: boolean;
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
  // The trending `find` in flight. The detail has its own query below and no longer shares this flag.
  const [loading, setLoading] = useState(false);
  // What the person chose in the chapter <select>, or null for "whatever the detail says is the default".
  // Derived rather than set when the detail lands: a `count === 0` listing used to render one frame with
  // `all` selected and no such option before the effect corrected it, and picking another source now
  // simply clears the choice instead of racing the arrival of the new detail.
  const [pickChoice, setPickChoice] = useState<ChapterPick | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [adding, setAdding] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; folder: string; chapters: number; started?: boolean; nothing?: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  const title = seed.kind === 'result' ? seed.provider.title : seed.title;

  // ---- also follow the other sources (v0.36.0, #49) ----
  // The candidates are the sources this dialog ALREADY found for the title (a trending search, or the
  // wall's fold): no new search is ever run for them, one per source, the picked one left out, at most six.
  // ⚠️ A `result` seed (a Discover-wall tap on a single-source tile) has no list at all -- `providers` stays
  // null -- so it gets no switch and sends nothing; the series page's Find missing chapters is its way in.
  // Reintroduce by seeding `others` from a search here: every wall tap becomes a fan-out to every source.
  const others = useMemo(() => {
    if (!picked || !providers) return [];
    const seen = new Set<string>([picked.source]);
    const out: Provider[] = [];
    for (const p of providers) {
      if (seen.has(p.source)) continue;
      seen.add(p.source);
      out.push(p);
    }
    return out.slice(0, ALSO_FOLLOW_MAX);
  }, [providers, picked]);
  const [alsoFollow, setAlsoFollowState] = useState<boolean>(() => {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(ALSO_FOLLOW_KEY) === '1'; } catch { return false; }
  });
  const setAlsoFollow = (v: boolean) => {
    setAlsoFollowState(v);
    try { localStorage.setItem(ALSO_FOLLOW_KEY, v ? '1' : '0'); } catch { /* private mode: the switch still works for this dialog */ }
  };
  // How many candidates rode with the add, so the done step knows whether to look for results on the job
  // card and what "Checking {n} sources" counts. Zero when the switch was off or there was nobody to check.
  const [sentFollow, setSentFollow] = useState(0);

  // Which `find` the state belongs to: a seed that changes under an open dialog must not have the first
  // search's answer land last and win. Only the trending search uses it now; the detail is a keyed query.
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

  /**
   * The picked source's series and chapter list, as a query keyed on the source and its id.
   *
   * It was an effect with a request counter, so picking A then B then A again asked the server for A twice
   * and showed "Loading…" both times, and the step after picking a source was the slow one the owner named.
   * Keyed, the second pick is instant, and the pre-warm below can fill the cache before anyone picks at all.
   * The server keeps its own ten-minute cache and joins concurrent requests, so a fresh key costs one round
   * trip and a repeat costs none. `retry: false`: a source that failed is shown as failed, with the way to
   * another source right beside it; retrying would be another twenty-second budget against the same site.
   */
  const detailQ = useQuery({
    // ⚠️ The same shape as the pre-warm's key below, or the pre-warm warms nothing.
    queryKey: ['src-detail', picked?.source, picked?.sourceId],
    queryFn: ({ signal }) => fetchDetail(picked!, signal),
    enabled: !!picked,
    staleTime: DETAIL_STALE_MS,
    retry: false,
  });
  const detail = detailQ.data;
  const pick: ChapterPick = pickChoice ?? (detail && detail.count === 0 ? 'none' : 'all');

  // The pre-warm: a group with a choice to make looks up its first two providers as it opens, so by the
  // time a person has read the list and tapped one, the detail is already in the cache (or in flight, and
  // the query above joins it). Two, not all: each is a live request to a site, and the list is ranked, so
  // the first two are where nearly every tap lands. A group of one picks itself and needs no pre-warm.
  useEffect(() => {
    if (seed.kind !== 'group' || seed.providers.length < 2) return;
    for (const p of seed.providers.slice(0, 2)) {
      qc.prefetchQuery({ queryKey: ['src-detail', p.source, p.sourceId], queryFn: ({ signal }) => fetchDetail(p, signal), staleTime: DETAIL_STALE_MS, retry: false });
    }
  }, [seed, qc]);

  // Only while the dialog is showing a live download -- or, since v0.36.0, while an auto-follow it asked
  // for is still being judged: a "nothing yet" add starts no download, but with candidates sent the server
  // leaves a finished job entry on the card carrying `autoFollow`, and this same poll is how the results
  // reach the done step. That poll stops the moment `autoFollow.done` is true; the download case keeps its
  // 2 s rhythm as before.
  const { data: jobs } = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: !!done && (!done.nothing || sentFollow > 0),
    refetchInterval: (q) => {
      if (!done) return false;
      if (!done.nothing) return 2000;
      const j = (q.state.data?.content ?? []).find((x) => x.folder === done.folder);
      return j?.autoFollow?.done ? false : 2000;
    },
  });
  const job = done ? (jobs?.content ?? []).find((j) => j.folder === done.folder) : undefined;

  // Derived, not stored: the payload, the rate-limit warning and the "latest" hint all read these.
  // `none` sends no count at all -- `chapterFrom: 'none'` is the whole instruction -- and counts as zero
  // for the rate-limit warning, since nothing is grabbed.
  const chapterCount = pick === 'all' || pick === 'none' ? undefined : Number(pick.slice(pick.indexOf(':') + 1));
  const chapterFrom: 'oldest' | 'newest' | 'none' = pick === 'none' ? 'none' : pick.startsWith('latest:') ? 'newest' : 'oldest';
  const count = pick === 'none' ? 0 : chapterCount ?? detail?.count ?? 0;

  const add = async (force = false) => {
    if (!picked) return;
    setAdding(true); setDup(null);
    // Only the identity of each candidate goes: the server looks each up itself and judges it against the
    // listing it has just written, so a stale title or cover from the search cannot steer the match.
    const alsoFollowBody = mayFollow && alsoFollow && others.length ? others.map(({ source, sourceId }) => ({ source, sourceId })) : undefined;
    try {
      const r = await api<{ title: string; folder: string; chapters: number; started?: boolean; nothing?: boolean }>('/api/sources/add', {
        json: { source: picked.source, sourceId: picked.sourceId, chapterCount, chapterFrom, autoUpdate, force, alsoFollow: alsoFollowBody },
        // The client has never set a timeout anywhere, so the only bound was the proxy's 120s -- which
        // turned a slow-but-working add into "Add failed. Try another source." while the download carried
        // on. The request now answers in seconds, so this is a backstop rather than the usual path. The
        // auto-follow is judged behind the reply too (on the job card), never inside this request.
        signal: AbortSignal.timeout(45_000),
      });
      // The judgement only happens for a series the add created (a download, or nothing-yet); "already in
      // your library" answers with neither flag and the server does nothing with the candidates.
      setSentFollow(alsoFollowBody && (r.started || r.nothing) ? alsoFollowBody.length : 0);
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
      const hit = p.content.find((s) => normTitle(s.metadata?.title || s.name) === normTitle(done.title)) ?? p.content[0];
      qc.invalidateQueries({ queryKey: ['library'] });
      router.push(hit ? `/series/?id=${hit.id}` : '/downloads/');
    } catch { router.push('/downloads/'); }
  };

  // ---------------------------------------------------------------- done
  if (done) {
    // What the other sources came to, as the job card reports it. A `result` seed never had a list, so it
    // is pointed at Find missing chapters rather than told "no other source carries it" -- nothing was
    // checked. A list with nobody else on it says exactly that: "none of the sources CHECKED", because a
    // trending search asks the page's budgeted sources and the wall's fold holds whoever listed it lately,
    // never every source. Off switch: nothing to say.
    const af = job?.autoFollow;
    const fresh = !!done.started || !!done.nothing;
    const followBlock = (() => {
      if (seed.kind === 'result') return <p className="text-start text-[11px] text-fog-500">{tr('Other sources: Find missing chapters on the series page.')}</p>;
      if (!providers || !fresh) return null;
      // A member never had the switch, so there are no results to show and nothing was "checked": one dim
      // line naming who can, and where.
      if (!mayFollow) return <p className="text-start text-[11px] text-fog-500">{tr('Other sources: an admin can follow them from Sources & translations.')}</p>;
      if (others.length === 0) return <p className="text-start text-[11px] text-fog-500">{tr('None of the other sources checked lists this title.')}</p>;
      if (!sentFollow) return null;
      if (!af || !af.done) {
        // A download that died before its listing existed has no judgement to wait for.
        if (job?.status === 'error') return null;
        return (
          <p className="text-start text-[11px] text-fog-500" data-auto-follow="checking">
            {sentFollow === 1
              ? tr('Checking this source…')
              : tr('Checking {n} sources — this can take a minute. You can close this; anything followed shows under Sources & translations.', { n: sentFollow })}
          </p>
        );
      }
      if (!af.results.length) return null;
      const followed = af.results.filter((r) => r.followed).length;
      const m = af.results.length;
      return (
        <div className="space-y-1 text-start text-[11px]" data-auto-follow="done">
          {af.results.map((r) => (
            <p key={r.source} className={`break-words ${r.followed ? 'text-emerald-400' : 'text-fog-500'}`}>{autoFollowLine(r)}</p>
          ))}
          <p className="text-fog-300">
            {m === 1
              ? (followed === 1 ? tr('Followed the other source') : tr('Not followed'))
              : tr('Followed {n} of {m}', { n: followed, m })}
          </p>
        </div>
      );
    })();
    return (
      <Modal title={tr('Added to your library')} onClose={onClose}>
        <div className="space-y-4 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
            <IcCheck width={26} height={26} />
          </span>
          <div>
            <p className="font-display text-base font-semibold text-fog-50">{done.title}</p>
            <p className="mt-0.5 text-sm text-fog-400">
              {/* "Fetching", the server-side word: the chapters land on the server for everyone, which is not
                  what "download" means on this device. `nothing` is a nothing-yet add: no job, no bar. */}
              {done.nothing ? tr('Added — new chapters will be fetched as they come out')
                : done.chapters > 0 ? tr('Fetching {n} chapters', { n: done.chapters })
                : tr('Already in your library')}
            </p>
          </div>
          {done.chapters > 0 && !done.nothing && (
            <>
              <ProgressBar value={job && job.total ? job.done / job.total : 0.02} />
              <p className="text-xs tabular-nums text-fog-500">{job ? `${job.done}/${job.total}` : '…'}</p>
              {/* v0.40.0: a chapter the picked source could not serve is taken from another followed one,
                  and one that arrived short is saved with placeholders. Both are worth a line under the
                  counter while it runs, in the same words as the downloads pill. */}
              {jobNoteLines(job, (id) => providers?.find((p) => p.source === id)?.name ?? id).map((line, i) => (
                <p key={i} className="text-start text-[11px] leading-relaxed text-fog-400" data-job-note>{line}</p>
              ))}
            </>
          )}
          {followBlock}
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
                    <span className="flex items-center gap-1.5 text-sm text-fog-100">
                      <SourceIcon id={p.source} name={p.name} size={20} />
                      <span className="truncate">{p.name}</span>
                    </span>
                    <span className="block truncate text-[11px] text-fog-500">{p.title}</span>
                  </span>
                  {/* The page's own rank: health first, then what the library actually came from. "Most used"
                      is what that is; "preferred" made it sound like a setting someone had chosen. */}
                  {i === 0 && <span className="chip shrink-0 text-[10px]">{tr('most used')}</span>}
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
  const presets = CHAPTER_PRESETS.filter((n) => detail && n < detail.count);
  // The picked provider's own cover until the detail lands, then the detail's: the same picture nearly
  // always, so nothing jumps, and the body paints at once instead of behind a bare "Loading…".
  const coverUrl = detail?.coverUrl ?? picked.coverUrl;

  return (
    // Not dismissable while the request is in flight. Escape or a backdrop click used to unmount the dialog
    // mid-add: the add still completed, but `setDone` and `onAdded` ran against nothing, so there was no
    // confirmation and the tile was never marked as added -- the worst possible version of "did that work?"
    <Modal title={detail?.title || title} onClose={adding ? () => {} : onClose} wide>
      {/* ⚠️ No gate around the body. Everything the pick already knows -- the cover, the source, the way back
          to the other providers, the switches -- renders now; only the count, the groups and the chapter
          <select> wait for the detail, and say so in their own place. A whole-body "Loading…" was the second
          "takes forever" the owner reported, and it hid the Change chip exactly when a slow source made it
          the thing to tap. Reintroduce by wrapping the body in `!detail ? <p>Loading…</p> : …`. */}
      <div className="sm:flex sm:gap-4">
        <div className="mb-3 shrink-0 sm:mb-0 sm:w-40">
          <Img src={sourceCover(picked.source, coverUrl)} alt="" fallbackSrc={coverUrl || undefined}
            className="aspect-[2/3] w-28 rounded-xl border border-ink-700 sm:w-40" />
        </div>
        <div className="min-w-0 flex-1">
          {/* Where it comes from, named with its favicon, before anything else about it -- and the way
              back to the other providers as a small chip, only when there are any. */}
          <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-500">
            <span className="inline-flex items-center gap-1.5">
              {tr('From')}
              <SourceIcon id={picked.source} name={picked.name} size={16} />
              <span className="text-fog-200">{picked.name}</span>
            </span>
            {providers && providers.length > 1 && (
              <button type="button" onClick={() => { setPicked(null); setPickChoice(null); }} className="chip py-0.5 text-[11px]">
                {tr('Change')}
              </button>
            )}
          </p>
          {detail ? (
            <p className="text-xs text-fog-500">
              {detail.count} {detail.count === 1 ? tr('chapter') : tr('chapters')}
              {detail.first != null && detail.last != null && <> · {detail.first}–{detail.last}</>}
            </p>
          ) : detailQ.isError ? (
            // The picker's own words for a source that did not answer; Change is right above it.
            <p className="text-xs text-amber-300" data-detail="failed">{tr('Could not be reached right now.')}</p>
          ) : (
            <p className="text-xs text-fog-500" aria-live="polite" data-detail="loading">{tr('Loading chapter list…')}</p>
          )}
          {detail && (<>
            {/* The series page's Translated by section, compressed to what fits a dialog: the five busiest
                groups and their rhythm, so "is this being translated" is answered before the add, not after.
                No controls -- there is no series to set preferences on yet. */}
            {!!detail.groups?.length && (
              <div className="mt-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Translated by')}</p>
                {[...detail.groups].sort((a, b) => b.releases - a.releases).slice(0, 5).map((g) => {
                  const cadence = cadenceText(g.cadence, g.lastReleaseAt);
                  // The twelve-week strip when there is anything to draw (lib/activity.ts says when there is
                  // not: an older server, or a group silent for twelve weeks -- every group of a finished
                  // series), else words: the quiet sentence, amber only while the series is still running,
                  // or when the last release was.
                  const weeks = weeksOf(g);
                  const status = activityStatus(g, detail.status);
                  return (
                    // ⚠️ No `truncate` here, and the rhythm on its own line. The column is ~290 px even on a
                    // desktop, and one truncated line cut exactly the words this block exists for: "quiet
                    // -- no release in 100 ..." lost the day count, "ships weekly · last release ..." lost
                    // when. The name still gets a `title` in case it is the long part. Reintroduce by
                    // putting the cadence back on the first line with `truncate`: the day count is gone.
                    <div key={g.name} className="mt-0.5 text-[11px] text-fog-500">
                      <p className="flex flex-wrap items-center gap-x-1.5 break-words">
                        <GroupAvatar name={g.name} size={16} />
                        <span className="text-fog-300" title={g.name}>{g.name}</span>
                        <span>· {g.releases === 1 ? tr('1 release') : tr('{n} releases', { n: g.releases })}</span>
                      </p>
                      {weeks ? (
                        <p className="mt-0.5"><ActivityDots weeks={weeks} status={status} label={cadence || g.name} /></p>
                      ) : g.cadence.quiet ? (
                        <p className={`break-words ${status === 'quiet' ? 'text-amber-300' : ''}`}>{cadence}</p>
                      ) : g.lastReleaseAt ? (
                        <p>{tr('last release {ago}', { ago: relativeTime(g.lastReleaseAt) })}</p>
                      ) : null}
                    </div>
                  );
                })}
                {(detail.versions ?? 0) > 0 && (
                  <p className="mt-0.5 text-[11px] text-fog-500">{detail.versions === 1 ? tr('1 chapter has more than one version') : tr('{n} chapters have more than one version', { n: detail.versions ?? 0 })}</p>
                )}
              </div>
            )}
            {detail.genres.length > 0 && (
              <p className="mt-1 line-clamp-1 text-[11px] text-fog-500">{detail.genres.slice(0, 4).join(' · ')}</p>
            )}
            {summary && <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-fog-400">{summary}</p>}

            {/* "Fetch now", not "download": the chapters land on the server, and the server side of the app
                is called fetching everywhere else. With nothing listed, "Nothing yet" is the only option that
                can succeed, so it is the only one offered. */}
            <label className="mb-1 mt-4 block text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Chapters to fetch now')}</label>
            <select value={pick} onChange={(e) => setPickChoice(e.target.value as ChapterPick)} className="field">
              {detail.count > 0 && <option value="all">{tr('All ({n})', { n: detail.count })}</option>}
              {presets.map((n) => <option key={`first:${n}`} value={`first:${n}`}>{tr('First {n}', { n })}</option>)}
              {presets.map((n) => <option key={`latest:${n}`} value={`latest:${n}`}>{tr('Latest {n}', { n })}</option>)}
              <option value="none">{tr('Nothing yet — pick chapters later')}</option>
            </select>
            {pick === 'none' ? (
              <p className="mt-1.5 text-[11px] text-fog-500">
                {tr('Nothing is fetched now. New chapters arrive with auto-update; older ones can be fetched from the series page.')}
              </p>
            ) : chapterFrom === 'newest' && (
              <p className="mt-1.5 text-[11px] text-fog-500">
                {tr('Older chapters are not fetched by auto-update; fetch them from the series page when you want them.')}
              </p>
            )}
          </>)}

          {/* The switches depend on nothing the detail brings, so they are there from the first paint. */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-sm text-fog-200">{tr('Auto-update new chapters')}</span>
            <Switch on={autoUpdate} onChange={setAutoUpdate} label={tr('Auto-update new chapters')} />
          </div>

          {/* Only for an admin, and only when the dialog holds other sources for this title (a trending
              search, a wall fold). The helper leads with why anyone would: the benefit is the reason #49
              was filed. "Up to two per series" is the total, not two of these. */}
          {mayFollow && others.length > 0 && (
            <div className="mt-3" data-also-follow>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-fog-200">{tr('Also check the other sources that carry this title')}</span>
                <Switch on={alsoFollow} onChange={setAlsoFollow} label={tr('Also check the other sources that carry this title')} />
              </div>
              <p className="mt-1 text-[11px] text-fog-500">
                {tr('Following one means new chapters are taken from whichever source has them first. Each is checked against this title\'s chapter list — only a source listing at least 90 % of the same numbers is followed, up to two per series.')}
              </p>
            </div>
          )}

          {count > 40 && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
              {tr('Grabbing many chapters at once can get you rate-limited. It pauses on its own and you can resume later.')}
            </p>
          )}
          {dup && <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">{dup}</p>}

          {/* Disabled until the chapter list is here: the count and the from/none choice go in the request. */}
          <button onClick={() => add(!!dup)} disabled={adding || !detail} className="btn-accent mt-4 w-full py-2.5 text-sm disabled:opacity-50">
            {adding ? tr('Working…') : dup ? tr('Add anyway') : tr('Add to library')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
