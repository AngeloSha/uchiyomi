'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { GroupStat, Page, Series } from '@/lib/types';
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

export interface Provider { source: string; name: string; sourceId: string; title: string; coverUrl?: string }
interface Detail {
  source: string; sourceId: string; title: string; summary: string; coverUrl: string | null;
  genres: string[]; status: string; count: number; first: number | null; last: number | null;
  /** Who releases it, from the live chapter list (so `onDisk` is 0 -- nothing is on disk yet). Absent from an older server. */
  groups?: GroupStat[];
  /** How many numbers have more than one copy. */
  versions?: number;
}
interface Job { folder: string; title: string; total: number; done: number; status: string }

export type AddSeed =
  | { kind: 'trending'; title: string }
  | { kind: 'result'; provider: Provider }
  | { kind: 'group'; title: string; providers: Provider[] };

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
  const [pick, setPick] = useState<ChapterPick>('all');
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [adding, setAdding] = useState(false);
  const [dup, setDup] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; folder: string; chapters: number; started?: boolean; nothing?: boolean } | null>(null);
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
      .then((d) => { if (mine === want.current) { setDetail(d); setPick(d.count === 0 ? 'none' : 'all'); } })
      .catch(() => { if (mine === want.current) setDetail(null); })
      .finally(() => { if (mine === want.current) setLoading(false); });
  }, [picked]);

  // Only while the dialog is showing a live download. A "nothing yet" add starts no job, so there is
  // nothing to poll for.
  const { data: jobs } = useQuery({
    queryKey: ['source-jobs'],
    queryFn: () => api<{ content: Job[] }>('/api/sources/jobs'),
    enabled: !!done && !done.nothing,
    refetchInterval: 2000,
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
    try {
      const r = await api<{ title: string; folder: string; chapters: number; started?: boolean; nothing?: boolean }>('/api/sources/add', {
        json: { source: picked.source, sourceId: picked.sourceId, chapterCount, chapterFrom, autoUpdate, force },
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
      const hit = p.content.find((s) => normTitle(s.metadata?.title || s.name) === normTitle(done.title)) ?? p.content[0];
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
            {/* Where it comes from, named with its favicon, before anything else about it -- and the way
                back to the other providers as a small chip, only when there are any. */}
            <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fog-500">
              <span className="inline-flex items-center gap-1.5">
                {tr('From')}
                <SourceIcon id={detail.source} name={picked.name} size={16} />
                <span className="text-fog-200">{picked.name}</span>
              </span>
              {providers && providers.length > 1 && (
                <button type="button" onClick={() => { setPicked(null); setDetail(null); }} className="chip py-0.5 text-[11px]">
                  {tr('Change')}
                </button>
              )}
            </p>
            <p className="text-xs text-fog-500">
              {detail.count} {detail.count === 1 ? tr('chapter') : tr('chapters')}
              {detail.first != null && detail.last != null && <> · {detail.first}–{detail.last}</>}
            </p>
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
            <select value={pick} onChange={(e) => setPick(e.target.value as ChapterPick)} className="field">
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
