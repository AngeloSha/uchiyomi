'use client';
// "Who scanlates this": the groups releasing a series, how fast, and -- for admins -- which of them to take.
//
// One card on the series page, between the summary and the chapter list. Members see the statistics: how
// many releases each group made, over which chapters, how many of those are on this server, and whether the
// group still ships or has gone quiet. Admins see the same rows with the Prefer / rank / Block controls and
// the patience input that used to live in Edit details, where nobody looked for them: the question "which
// group do I want" is asked while looking at the groups, not while fixing a title.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { GroupStat, SeriesGroups, StoredPrefs } from '@/lib/types';
import { t as tr } from '@/lib/i18n';
import { chapterLabel, relativeTime } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/lib/auth';
import { msgOf } from '@/components/ConfirmDialog';
import { hasGroup, normGroup, reorder, withoutGroup } from '@/lib/scanlators';
import { cadenceLine } from '@/lib/cadence';

const fld = 'w-full rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-sm text-fog-100 outline-hidden transition focus:border-accent/60';

/** The admin scanlators route: the stored override, the server defaults, what results, and the groups with their stats. */
export interface ScanlatorInfo {
  /** When the listing the figures come from was last checked; absent on a server that does not send it yet. */
  checkedAt?: string | null;
  prefs: StoredPrefs | null;
  global: StoredPrefs;
  effective: { priority: string[]; blocked: string[]; patienceDays: number };
  groups: (GroupStat & { listed: number })[];
}
interface PrefsDraft { priority: string[]; blocked: string[]; patience: string }

/**
 * The groups of a series, from whichever route the viewer may call. Admins read the admin route, whose
 * `groups[]` carry the same statistics plus the prefs the controls need; everyone else reads the public one.
 * One hook, called once in the page, because the group filter beside Oldest/Newest needs the names too and
 * two callers of the same key would be one request anyway -- react-query dedupes, but the page should not
 * have to know that.
 */
export function useSeriesGroups(id: string, isAdmin: boolean) {
  const pub = useQuery({
    queryKey: ['series-groups', id],
    queryFn: () => api<SeriesGroups>(`/api/series/${id}/groups`),
    enabled: !!id && !isAdmin,
    staleTime: 30_000,
    retry: false,
  });
  // ⚠️ `staleTime` on the admin query too. The page mounts this card on every series visit, and the
  // series page invalidates both keys after every chapter action; without a stale window each of those
  // was one more request for figures the server only recomputes on the sweep. (The route itself reads
  // the stored listing since v0.33.0 and calls no source, so this is about request count, not solves.)
  const adm = useQuery({
    queryKey: ['series-scanlators', id],
    queryFn: () => api<ScanlatorInfo>(`/api/admin/series/${id}/scanlators`),
    enabled: !!id && isAdmin,
    staleTime: 30_000,
    retry: false,
  });
  const groups = useMemo<GroupStat[]>(
    () => (isAdmin ? adm.data?.groups ?? [] : pub.data?.content ?? []),
    [isAdmin, adm.data, pub.data],
  );
  return {
    groups,
    admin: isAdmin ? adm.data ?? null : null,
    isLoading: isAdmin ? adm.isLoading : pub.isLoading,
    error: isAdmin ? adm.error : pub.error,
    /** When the figures were last checked; the card says so in its header. */
    checkedAt: (isAdmin ? adm.data?.checkedAt : pub.data?.checkedAt) ?? null,
  };
}

/** A row for a group the stored lists name but nothing lists any more: it still needs a row, or it could never be un-blocked. */
const emptyStat = (name: string): GroupStat => ({
  name, releases: 0, first: null, last: null, lastReleaseAt: null,
  cadence: { kind: 'unknown', intervalDays: null, daysSince: null, quiet: false }, onDisk: 0, chapters: [], langs: [],
});

/**
 * One group's row: the name and its statistics, the chapter chips behind "Show chapters", and the admin
 * controls when there are any. The same renderer for both audiences, so the member's view is exactly the
 * admin's minus the buttons.
 */
function GroupRow({ g, blocked, serverBlocked, haveNumbers, controls }: {
  g: GroupStat;
  blocked: boolean;
  serverBlocked: boolean;
  /** Numbers with a chapter row on this server: those chips are solid, the rest dimmed. */
  haveNumbers: Set<number>;
  controls?: React.ReactNode;
}) {
  const [showChapters, setShowChapters] = useState(false);
  const cadence = cadenceLine(g.cadence, g.lastReleaseAt);
  // `getElementById`, not `querySelector('#ch-12.5')`: a chapter number with a decimal point is not a valid
  // selector and the tap would throw instead of scrolling.
  const jump = (n: number) => document.getElementById(`ch-${n}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return (
    <div className="border-t border-ink-800/70 pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {/* Counts under the name, not beside it: on a phone the buttons leave the name a few characters. */}
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${blocked || serverBlocked ? 'text-fog-600 line-through' : 'text-fog-100'}`} title={g.name}>{g.name}</span>
          <span className="block text-[11px] text-fog-500">
            {/* A group known only from file stamps (no check yet, or an engine source) has nothing listed:
                "0 releases" would read as "released nothing", so the row starts at what is on disk. */}
            {g.releases > 0 && (g.releases === 1 ? tr('1 release') : tr('{n} releases', { n: g.releases }))}
            {g.first != null && g.last != null && <>{g.releases > 0 ? ' · ' : ''}{tr('Ch. {a}–{b}', { a: g.first, b: g.last })}</>}
            {g.onDisk > 0 && <>{g.releases > 0 || (g.first != null && g.last != null) ? ' · ' : ''}{tr('{n} on this server', { n: g.onDisk })}</>}
          </span>
          {cadence.length > 0 && (
            <span className={`block text-[11px] ${g.cadence.quiet ? 'text-amber-300' : 'text-fog-500'}`}>
              {cadence.map((p) => tr(p.key, p.args)).join(' · ')}
            </span>
          )}
        </span>
        {controls}
        {g.chapters.length > 0 && (
          <button type="button" onClick={() => setShowChapters((s) => !s)} aria-expanded={showChapters}
            className="chip shrink-0 px-2 py-0.5 text-[10px]">
            {showChapters ? tr('Hide chapters') : tr('Show chapters')}
          </button>
        )}
      </div>
      {showChapters && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {g.chapters.map((n) => (
            <button key={n} type="button" onClick={() => jump(n)}
              className={`rounded-full border px-1.5 text-[10px] leading-4 ${haveNumbers.has(n) ? 'border-ink-600 bg-ink-800 text-fog-200' : 'border-ink-800 text-fog-600'}`}>
              {chapterLabel({ number: n })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The card. Nothing is rendered while loading, or for a member with no groups or an error: the chapters
 * on disk are the page and this is the margin note. An admin gets the card even with zero groups, because
 * Edit details now only points here and the patience window must stay settable -- and for the same reason
 * an admin gets the card shell with the error in it when the route fails: this is now the ONLY place a
 * group can be un-blocked or the patience changed, and a card that silently vanished on a 5xx left the
 * admin with no controls and no word about why. Reintroduce by returning null on `error` for everyone:
 * an admin whose scanlators route errors has nowhere to set patience.
 *
 * The admin draft is seeded from the STORED override, not from the effective rules. The effective priority
 * is the server default when this series has none of its own, and seeding from it would turn "follows the
 * defaults" into a per-series copy of them on the first Save -- a copy that then stops following when the
 * defaults change. Blank patience means the same thing for the same reason.
 */
export function WhoScanlates({ id, groups, admin, error, isLoading, haveNumbers, checkedAt, onSaved }: {
  id: string;
  groups: GroupStat[];
  /** The admin route's payload, or null for everyone else (and while it has not arrived). */
  admin: ScanlatorInfo | null;
  error: unknown;
  isLoading: boolean;
  /** Numbers with a LIVE chapter row here (not a tombstone): the chips for these are solid. */
  haveNumbers: Set<number>;
  /** When the listing behind the figures was last checked; the header says "as of {ago}" from it. */
  checkedAt: string | null;
  onSaved: () => void;
}) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Open by default when there is something to compare; one group is a fact, not a list. An error opens
  // it too, or the message would sit behind a folded header that looks like a card with nothing in it.
  const [open, setOpen] = useState<boolean | null>(null);
  // Open when there is something to compare, when there is an error to read, and -- for an admin -- when
  // there is nothing at all: the empty card's only content is "no groups yet" and the patience input, and a
  // folded title bar over those reads as a card with nothing in it.
  const isOpen = open ?? (groups.length >= 2 || !!error || (!!admin && groups.length === 0));

  // `null` until the row arrives, so a half-loaded form can never save an empty ruleset over a real one.
  const [draft, setDraft] = useState<PrefsDraft | null>(null);
  useEffect(() => {
    if (admin && !draft) {
      setDraft({ priority: admin.prefs?.priority ?? [], blocked: admin.prefs?.blocked ?? [],
                 patience: admin.prefs?.patienceDays == null ? '' : String(admin.prefs.patienceDays) });
    }
  }, [admin, draft]);

  // One row per group, by the server's equality. Admins: ranked groups first in rank order, then blocked
  // ones, then everything the source lists or the disk holds, busiest first -- a group that is in the
  // stored lists but no longer appears anywhere still gets a row, or there would be no way to un-block it.
  // Members: as served, busiest first.
  const rows = useMemo(() => {
    if (!admin || !draft) return groups;
    const stats = new Map(groups.map((g) => [normGroup(g.name), g]));
    const seen = new Set<string>();
    const out: GroupStat[] = [];
    const push = (name: string) => {
      const k = normGroup(name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(stats.get(k) ?? emptyStat(name));
    };
    // Ranked groups first, in rank order -- they are the reader's own short list -- then everyone else
    // busiest first, and the blocked ones LAST. The Edit-details panel this grew out of put blocked names
    // second, which on a stats card meant a one-release group nobody wants sat above the one that ships
    // the series; a block is still a row (it can be undone here) but it is not a headline.
    draft.priority.forEach(push);
    const blockedKeys = new Set(draft.blocked.map(normGroup));
    const rest = [...groups].sort((a, b) => b.releases - a.releases || b.onDisk - a.onDisk);
    rest.filter((g) => !blockedKeys.has(normGroup(g.name))).forEach((g) => push(g.name));
    rest.filter((g) => blockedKeys.has(normGroup(g.name))).forEach((g) => push(g.name));
    draft.blocked.forEach(push); // a blocked name nothing lists any more still needs its row to be unblocked
    return out;
  }, [admin, draft, groups]);

  const rankIn = (priority: string[], name: string) => { const k = normGroup(name); return priority.findIndex((p) => normGroup(p) === k); };
  // Preferring a group unblocks it and blocking one un-ranks it: a group in both lists would be blocked
  // (the server takes the union) while showing a rank that can never be used.
  const togglePrefer = (name: string) => setDraft((d) => d && (rankIn(d.priority, name) >= 0
    ? { ...d, priority: withoutGroup(d.priority, name) }
    : { ...d, priority: [...d.priority, name], blocked: withoutGroup(d.blocked, name) }));
  const toggleBlock = (name: string) => setDraft((d) => d && (hasGroup(d.blocked, name)
    ? { ...d, blocked: withoutGroup(d.blocked, name) }
    : { ...d, blocked: [...d.blocked, name], priority: withoutGroup(d.priority, name) }));
  const move = (name: string, dir: -1 | 1) => setDraft((d) => d && { ...d, priority: reorder(d.priority, rankIn(d.priority, name), dir) });

  const patch = async (scanlatorPrefs: StoredPrefs | null) => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${id}`, { method: 'PATCH', json: { scanlatorPrefs } });
      toast(tr('Saved'), 'success');
      // The ghost rows' `why` and the versions' `blocked` markers both follow the effective prefs.
      for (const k of ['series-scanlators', 'series-groups', 'series-listing', 'series-versions']) qc.invalidateQueries({ queryKey: [k, id] });
      onSaved();
      return true;
    } catch (e) { toast(msgOf(e, tr('Could not save')), 'error'); return false; }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!draft) return;
    const raw = draft.patience.trim();
    const patienceDays = raw === '' ? null : Number(raw);
    if (patienceDays != null && (!Number.isInteger(patienceDays) || patienceDays < 0 || patienceDays > 30)) {
      toast(tr('Patience is a whole number of days, 0 to 30'), 'error');
      return;
    }
    return patch({ priority: draft.priority, blocked: draft.blocked, patienceDays });
  };
  const useDefaults = async () => { if (await patch(null)) setDraft({ priority: [], blocked: [], patience: '' }); };

  if (isLoading) return null;
  if (error && !isAdmin) return null;
  if (!error && !admin && groups.length === 0) return null;
  const serverDefault = admin?.global.patienceDays ?? 2;

  return (
    <section className="card p-3.5">
      <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} className="flex w-full items-center justify-between gap-2 text-start">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-display text-base font-semibold text-fog-50">{tr('Who scanlates this')}</span>
          {/* No "0 groups" in the header: an admin's empty card (a never-checked or engine-sourced series)
              says so inside, and a count of nothing beside the title read as a verdict on the series. */}
          {groups.length > 0 && (
            <span className="text-xs text-fog-500">{groups.length === 1 ? tr('1 group') : tr('{n} groups', { n: groups.length })}</span>
          )}
          {checkedAt && !error && <span className="text-xs text-fog-500">· {tr('as of {ago}', { ago: relativeTime(checkedAt) })}</span>}
        </span>
        <span className="shrink-0 text-xs text-fog-500">{isOpen ? '▴' : '▾'}</span>
      </button>
      {isOpen && !!error && (
        <p className="mt-3 text-xs text-rose-300">{msgOf(error, tr('Could not load the groups'))}</p>
      )}
      {isOpen && !error && (
        <div className="mt-3">
          {admin && draft && (
            <p className="mb-2 text-[11px] leading-relaxed text-fog-500">
              {tr('Preferred groups are taken first, in this order; blocked groups are never taken. New chapters wait for a preferred group for the patience below, then the best available copy is fetched.')}
            </p>
          )}
          {!rows.length && <p className="text-xs text-fog-500">{tr('No groups known for this series yet.')}</p>}
          <div className="space-y-2">
            {rows.map((g) => {
              const rank = draft ? rankIn(draft.priority, g.name) : -1;
              const blocked = !!draft && hasGroup(draft.blocked, g.name);
              const serverBlocked = !!admin && hasGroup(admin.global.blocked, g.name);
              const controls = admin && draft && (
                <>
                  {rank >= 0 && (
                    <span className="flex shrink-0 items-center">
                      <button onClick={() => move(g.name, -1)} disabled={rank === 0} aria-label={tr('Move up')} className="px-1 text-fog-400 disabled:opacity-30">▲</button>
                      <button onClick={() => move(g.name, 1)} disabled={rank === draft.priority.length - 1} aria-label={tr('Move down')} className="px-1 text-fog-400 disabled:opacity-30">▼</button>
                    </span>
                  )}
                  <button onClick={() => togglePrefer(g.name)} disabled={serverBlocked && rank < 0}
                    className={`chip shrink-0 px-2 py-0.5 text-[10px] disabled:opacity-40 ${rank >= 0 ? 'chip-active' : ''}`}>
                    {rank >= 0 ? `#${rank + 1}` : tr('Prefer')}
                  </button>
                  {serverBlocked
                    ? <span className="shrink-0 text-[10px] text-fog-600">{tr('blocked on server')}</span>
                    : <button onClick={() => toggleBlock(g.name)}
                        className={`chip shrink-0 px-2 py-0.5 text-[10px] ${blocked ? 'border-rose-500/40 text-rose-300' : ''}`}>
                        {blocked ? tr('Blocked') : tr('Block')}
                      </button>}
                </>
              );
              return <GroupRow key={normGroup(g.name) || g.name} g={g} blocked={blocked} serverBlocked={serverBlocked} haveNumbers={haveNumbers} controls={controls || undefined} />;
            })}
          </div>
          {admin && draft && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-800/70 pt-3">
                <label className="text-xs text-fog-400" htmlFor={`patience-${id}`}>{tr('Patience (days)')}</label>
                <input id={`patience-${id}`} type="number" min={0} max={30} step={1} inputMode="numeric" value={draft.patience}
                  onChange={(e) => setDraft((d) => d && { ...d, patience: e.target.value })}
                  placeholder={String(serverDefault)} className={`${fld} w-20`} />
                <span className="text-[11px] text-fog-500">{tr('Currently {n} days', { n: admin.effective.patienceDays })}</span>
              </div>
              <p className="mt-1 text-[11px] text-fog-600">{tr('Blank uses the server default ({n}). 0 takes the best copy available at once.', { n: serverDefault })}</p>
              <div className="mt-3 flex gap-2">
                <button onClick={save} disabled={busy} className="btn-accent flex-1 py-2 text-xs disabled:opacity-50">{tr('Save')}</button>
                <button onClick={useDefaults} disabled={busy || !admin.prefs} className="chip text-xs disabled:opacity-50">{tr('Use server defaults')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
