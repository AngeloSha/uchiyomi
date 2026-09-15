'use client';
// "Sources & translations": where a series' chapters come from, who translates them, and -- for admins --
// which of them to take. A sheet opened from the supply line under the title, never open by itself.
//
// This replaces the "Who scanlates this" card that sat open between Start reading and the chapter list:
// ~115 words of helper text, group rows and a patience form on every visit, which the owner called "not
// cool for the UX". Members see the sources and the group statistics; admins see the same rows with the
// Prefer / rank / Block controls, the × that stops following a source, Check now, and the patience input in
// the footer. Nothing here is a draft: every Prefer, Block and rank tap is one PATCH, applied at once, because
// a sheet is dismissed by a tap outside or Escape and a draft would go with it.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { GroupStat, Series, SeriesGroups, SeriesSource, StoredPrefs } from '@/lib/types';
import { t as tr } from '@/lib/i18n';
import { chapterLabel, relativeTime } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { Sheet } from '@/components/ui';
import { GroupAvatar } from '@/components/GroupAvatar';
import { ActivityDots } from '@/components/ActivityDots';
import { SourceIcon } from '@/components/SourcePicker';
import { IcInfo } from '@/components/icons';
import { hasGroup, normGroup, reorder, withoutGroup } from '@/lib/scanlators';
import { cadenceLine, cadenceText } from '@/lib/cadence';
import { activityStatus, weeksOf } from '@/lib/activity';
import { namesGroups } from '@/lib/supplyLine';

// The patience field, and only that: `w-14`, not the page's `w-full` field class, so "Patience [ 2 ] days ·
// Currently 2" and the two buttons share one row -- on a phone the footer sits under the sheet's cap and
// every line it takes is a line the group list loses. ⚠️ Measured at 390×667 before this was one row: the
// footer was 172 px (a helper sentence, the field row, a second helper, the buttons) and the Translated by
// section began 9 px BELOW the scroller's bottom -- the only place Prefer and Block live, out of sight on
// exactly the phone the owner complained from. The two sentences are the field's `title` and its
// `aria-describedby` now, and the (i) explainer says the same in more words.
const fld = 'w-14 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 text-sm text-fog-100 outline-hidden transition focus:border-accent/60';

/** The admin scanlators route: the stored override, the server defaults, what results, and the groups with their stats. */
export interface ScanlatorInfo {
  /** When the listing the figures come from was last checked; absent on a server that does not send it yet. */
  checkedAt?: string | null;
  prefs: StoredPrefs | null;
  global: StoredPrefs;
  effective: { priority: string[]; blocked: string[]; patienceDays: number };
  groups: (GroupStat & { listed: number })[];
}

/**
 * The groups of a series, from whichever route the viewer may call. Admins read the admin route, whose
 * `groups[]` carry the same statistics plus the prefs the controls need; everyone else reads the public one.
 * One hook, called once in the page, because the group filter in the Filter sheet needs the names too and
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
  // ⚠️ `staleTime` on the admin query too. The page reads this on every series visit, and the series page
  // invalidates both keys after every chapter action; without a stale window each of those was one more
  // request for figures the server only recomputes on the sweep. (The route itself reads the stored
  // listing since v0.33.0 and calls no source, so this is about request count, not solves.)
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
    /** When the figures were last checked; the supply line and the sheet say so from it. */
    checkedAt: (isAdmin ? adm.data?.checkedAt : pub.data?.checkedAt) ?? null,
  };
}

/**
 * "Check now": ask the server to visit the sources for this series and poll until it is done. Shared by the
 * Check now chip in this sheet and the button in Edit details, so the two report the same way. The download
 * runs on the server; polling rather than holding the request open is what lets the sheet be closed
 * meanwhile.
 */
export function useCheckNow(id: string, onDone: () => void) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      await api(`/api/admin/series/${id}/check`, { method: 'POST' });
      toast('Checking for new chapters…', 'info');
      const started = Date.now();
      const tick = async () => {
        const st = await api<{ running: boolean; added?: number; waiting?: number; error?: string }>(`/api/admin/series/${id}/check`).catch(() => null);
        if (st && !st.running) {
          setChecking(false);
          if (st.error) toast('Check failed', 'error');
          else {
            // A number held for a preferred group is not "up to date": say it is being waited for.
            const held = st.waiting ? ` · ${st.waiting} held for a preferred group` : '';
            toast(st.added ? `Added ${st.added} new chapter${st.added === 1 ? '' : 's'}${held}` : st.waiting ? `Nothing new yet${held}` : 'Already up to date', 'success');
            onDone();
          }
          return;
        }
        if (Date.now() - started > 10 * 60_000) { setChecking(false); return; }
        setTimeout(tick, 3000);
      };
      setTimeout(tick, 2000);
    } catch (e) { setChecking(false); toast(msgOf(e, 'Could not start a check'), 'error'); }
  };
  return { checking, checkNow };
}

/** A row for a group the stored lists name but nothing lists any more: it still needs a row, or it could never be un-blocked. */
const emptyStat = (name: string): GroupStat => ({
  name, releases: 0, first: null, last: null, lastReleaseAt: null,
  cadence: { kind: 'unknown', intervalDays: null, daysSince: null, quiet: false }, onDisk: 0, chapters: [], langs: [],
});

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{children}</p>
);

/** One source the updater asks: favicon, name, its role, what it lists, when it was last asked. */
function SourceRow({ s, onUnfollow, unfollowing }: { s: SeriesSource; onUnfollow?: () => void; unfollowing?: boolean }) {
  // ⚠️ The server names an adapter it no longer loads by its id, and an extension's id is nineteen digits
  // nobody can read (supplyLine.ts applies the same rule to the line under the title).
  const unknown = !s.registered && s.name === s.sourceId;
  return (
    <div className="flex items-center gap-2.5 py-2 text-sm">
      <SourceIcon id={s.sourceId} name={unknown ? '?' : s.name} size={24} registered={s.registered} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate ${s.registered ? 'text-fog-100' : 'text-fog-500'}`}>{unknown ? tr('Source not installed') : s.name}</span>
          <span className="chip shrink-0 px-2 py-0.5 text-[10px]">{s.primary ? tr('main') : tr('also checked')}</span>
          {!s.registered && !unknown && <span className="shrink-0 text-[11px] text-fog-600">{tr('not installed')}</span>}
        </span>
        <span className="block truncate text-[11px] text-fog-500">
          {s.chapters != null && tr('{n} chapters listed', { n: s.chapters })}
          {s.chapters != null && s.checkedAt && ' · '}
          {s.checkedAt && tr('checked {ago}', { ago: relativeTime(s.checkedAt) })}
        </span>
      </span>
      {onUnfollow && (
        <button type="button" onClick={onUnfollow} disabled={unfollowing} aria-label={tr('Stop following {s}', { s: s.name })}
          className="shrink-0 px-1 text-fog-500 hover:text-rose-400 disabled:opacity-50">×</button>
      )}
    </div>
  );
}

/**
 * One group's row: avatar and name, its statistics, the activity strip (or the last-release sentence when
 * there is nothing in twelve weeks to draw), the chapter chips behind "Show chapters", and the admin
 * controls when there are any. The same renderer for both audiences, so the member's view is exactly the
 * admin's minus the buttons.
 */
function GroupRow({ g, blocked, serverBlocked, haveNumbers, seriesStatus, controls, onJump }: {
  g: GroupStat;
  blocked: boolean;
  serverBlocked: boolean;
  /** Numbers with a chapter row on this server: those chips are solid, the rest dimmed. */
  haveNumbers: Set<number>;
  seriesStatus?: string | null;
  controls?: React.ReactNode;
  /** Close the sheet and scroll the page to that chapter's row. */
  onJump: (n: number) => void;
}) {
  const [showChapters, setShowChapters] = useState(false);
  const weeks = weeksOf(g);
  const status = activityStatus(g, seriesStatus);
  const cadence = cadenceText(g.cadence, g.lastReleaseAt);
  // The sentence when there is no strip to draw: "last release {ago}", or the quiet sentence -- cadenceLine
  // already puts the one that applies first, and "ships weekly" alone (no date) says nothing here.
  const fallback = cadenceLine(g.cadence, g.lastReleaseAt).filter((p) => /last release|quiet/.test(p.key));
  const struck = blocked || serverBlocked;
  return (
    <div className="border-t border-ink-800/70 py-2 first:border-t-0">
      {/* The name block keeps at least 14rem; when the controls do not fit beside that (a phone) they wrap
          under it as one group, rather than squeezing the statistics into a two-line column beside them. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          <GroupAvatar name={g.name} size={18} />
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-sm ${struck ? 'text-fog-600 line-through' : 'text-fog-100'}`} title={g.name}>{g.name}</span>
            <span className="block truncate text-[11px] text-fog-500">
              {/* A group known only from file stamps (no check yet, or an engine source) has nothing listed:
                  "0 releases" would read as "released nothing", so the row starts at what is on disk. */}
              {g.releases > 0 && (g.releases === 1 ? tr('1 release') : tr('{n} releases', { n: g.releases }))}
              {g.first != null && g.last != null && <>{g.releases > 0 ? ' · ' : ''}{tr('Ch. {a}–{b}', { a: g.first, b: g.last })}</>}
              {g.onDisk > 0 && <>{g.releases > 0 || (g.first != null && g.last != null) ? ' · ' : ''}{tr('{n} on server', { n: g.onDisk })}</>}
            </span>
            {weeks
              ? <span className="mt-1 block"><ActivityDots weeks={weeks} status={status} label={cadence} /></span>
              : fallback.length > 0 && (
                <span className={`block text-[11px] ${status === 'quiet' ? 'text-amber-300' : 'text-fog-500'}`} title={cadence}>
                  {fallback.map((p) => tr(p.key, p.args)).join(' · ')}
                </span>
              )}
          </span>
        </span>
        {(controls || g.chapters.length > 0) && (
          <span className="ms-auto flex shrink-0 flex-wrap items-center gap-1">
            {controls}
            {g.chapters.length > 0 && (
              <button type="button" onClick={() => setShowChapters((s) => !s)} aria-expanded={showChapters}
                className="chip shrink-0 px-2 py-0.5 text-[10px]">
                {showChapters ? tr('Hide chapters') : tr('Show chapters')}
              </button>
            )}
          </span>
        )}
      </div>
      {showChapters && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {g.chapters.map((n) => (
            <button key={n} type="button" onClick={() => onJump(n)}
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
 * The sheet. Always renders when opened -- the supply line decides whether there is anything to open it
 * for -- so an admin whose groups route failed still gets the sources, the error and the patience footer:
 * this is the ONLY place a group can be un-blocked or the patience changed, and a sheet that showed nothing
 * on a 5xx would leave the admin with no controls and no word about why.
 *
 * The admin's ranked/blocked lists are read from the STORED override, not from the effective rules. The
 * effective priority is the server default when this series has none of its own, and writing from it would
 * turn "follows the defaults" into a per-series copy of them on the first tap -- a copy that then stops
 * following when the defaults change. Blank patience means the same thing for the same reason.
 */
export function SourcesSheet({ id, series, groups, admin, error, isLoading, haveNumbers, checkedAt, onSaved, onClose, onExplain, onFindMissing }: {
  id: string;
  series: Series | undefined;
  groups: GroupStat[];
  /** The admin route's payload, or null for everyone else (and while it has not arrived). */
  admin: ScanlatorInfo | null;
  error: unknown;
  isLoading: boolean;
  /** Numbers with a LIVE chapter row here (not a tombstone): the chips for these are solid. */
  haveNumbers: Set<number>;
  /** When the listing behind the figures was last checked, for a source row that carries no time of its own. */
  checkedAt: string | null;
  onSaved: () => void;
  onClose: () => void;
  /** Open the explainer. The page swaps the two sheets rather than stacking them, so one Escape closes one. */
  onExplain: () => void;
  /** Open Find missing chapters. The page closes this sheet first: a Modal (z-50) opened under a Sheet (z-60) is unreachable. */
  onFindMissing: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const isAdmin = !!admin;
  const sources = series?.sources ?? [];

  // The stored lists, with a local copy that is written the moment a control is tapped and dropped again
  // when the server's answer arrives -- so two quick taps do not both start from the stale server copy, and
  // a failed PATCH falls back to what the server still has.
  const [local, setLocal] = useState<Pick<StoredPrefs, 'priority' | 'blocked'> | undefined>(undefined);
  useEffect(() => { setLocal(undefined); }, [admin]);
  const stored = local ?? { priority: admin?.prefs?.priority ?? [], blocked: admin?.prefs?.blocked ?? [] };
  // The input follows the STORED value, and only that: keyed on the number rather than on `admin`, or every
  // Prefer tap (which refetches the admin payload) would wipe a number typed and not yet saved.
  const storedPatience = admin?.prefs?.patienceDays;
  const [patience, setPatience] = useState<string>('');
  useEffect(() => { setPatience(storedPatience == null ? '' : String(storedPatience)); }, [storedPatience]);

  // One row per group, by the server's equality. Admins: ranked groups first in rank order -- they are the
  // reader's own short list -- then everyone else busiest first, and the blocked ones LAST: a block is still
  // a row (it can be undone here) but it is not a headline. A group that is in the stored lists but no
  // longer appears anywhere still gets a row, or there would be no way to un-block it. Members: as served,
  // busiest first.
  const rows = useMemo(() => {
    if (!admin) return groups;
    const stats = new Map(groups.map((g) => [normGroup(g.name), g]));
    const seen = new Set<string>();
    const out: GroupStat[] = [];
    const push = (name: string) => {
      const k = normGroup(name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(stats.get(k) ?? emptyStat(name));
    };
    stored.priority.forEach(push);
    const blockedKeys = new Set(stored.blocked.map(normGroup));
    const rest = [...groups].sort((a, b) => b.releases - a.releases || b.onDisk - a.onDisk);
    rest.filter((g) => !blockedKeys.has(normGroup(g.name))).forEach((g) => push(g.name));
    rest.filter((g) => blockedKeys.has(normGroup(g.name))).forEach((g) => push(g.name));
    stored.blocked.forEach(push); // a blocked name nothing lists any more still needs its row to be unblocked
    return out;
  }, [admin, stored.priority, stored.blocked, groups]);

  const patch = async (scanlatorPrefs: StoredPrefs | null) => {
    setBusy(true);
    try {
      await api(`/api/admin/series/${id}`, { method: 'PATCH', json: { scanlatorPrefs } });
      toast(tr('Saved'), 'success');
      // The ghost rows' `why` and the versions' `blocked` markers both follow the effective prefs.
      for (const k of ['series-scanlators', 'series-groups', 'series-listing', 'series-versions']) qc.invalidateQueries({ queryKey: [k, id] });
      onSaved();
      return true;
    } catch (e) { toast(msgOf(e, tr('Could not save')), 'error'); setLocal(undefined); return false; }
    finally { setBusy(false); }
  };
  const patienceDays = (): number | null | false => {
    const raw = patience.trim();
    const n = raw === '' ? null : Number(raw);
    if (n != null && (!Number.isInteger(n) || n < 0 || n > 30)) { toast(tr('Patience is a whole number of days, 0 to 30'), 'error'); return false; }
    return n;
  };
  // A control tap: the new lists, written locally and PATCHed with the patience the server already holds
  // (never the input's unsaved text -- Save is for that).
  const apply = (next: Pick<StoredPrefs, 'priority' | 'blocked'>) => {
    setLocal(next);
    return patch({ ...next, patienceDays: admin?.prefs?.patienceDays ?? null });
  };
  const rankIn = (priority: string[], name: string) => { const k = normGroup(name); return priority.findIndex((p) => normGroup(p) === k); };
  // Preferring a group unblocks it and blocking one un-ranks it: a group in both lists would be blocked
  // (the server takes the union) while showing a rank that can never be used.
  const togglePrefer = (name: string) => apply(rankIn(stored.priority, name) >= 0
    ? { ...stored, priority: withoutGroup(stored.priority, name) }
    : { priority: [...stored.priority, name], blocked: withoutGroup(stored.blocked, name) });
  const toggleBlock = (name: string) => apply(hasGroup(stored.blocked, name)
    ? { ...stored, blocked: withoutGroup(stored.blocked, name) }
    : { blocked: [...stored.blocked, name], priority: withoutGroup(stored.priority, name) });
  const move = (name: string, dir: -1 | 1) => apply({ ...stored, priority: reorder(stored.priority, rankIn(stored.priority, name), dir) });
  const savePatience = () => {
    const n = patienceDays();
    if (n === false) return;
    return patch({ priority: stored.priority, blocked: stored.blocked, patienceDays: n });
  };
  const useDefaults = async () => { if (await patch(null)) { setLocal({ priority: [], blocked: [] }); setPatience(''); } };

  // Extra sources are added from Find missing chapters, where a person has seen the source's title and its
  // overlap with what is on disk. Here they can only be removed; the main one is not removable at all,
  // since it is the row the series was created from.
  const [unfollowing, setUnfollowing] = useState<string | null>(null);
  const unfollow = async (s: SeriesSource) => {
    setUnfollowing(s.sourceId);
    try {
      await api(`/api/admin/series/${id}/sources/${encodeURIComponent(s.sourceId)}`, { method: 'DELETE' });
      toast(tr('No longer following {s}', { s: s.name }), 'success');
      onSaved();
      qc.invalidateQueries({ queryKey: ['series-listing', id] });
    } catch (e) { toast(msgOf(e, tr('Could not remove that')), 'error'); }
    setUnfollowing(null);
  };
  const { checking, checkNow } = useCheckNow(id, () => { onSaved(); for (const k of ['series-scanlators', 'series-groups', 'series-listing', 'series-versions']) qc.invalidateQueries({ queryKey: [k, id] }); });

  // `getElementById`, not `querySelector('#ch-12.5')`: a chapter number with a decimal point is not a valid
  // selector and the tap would throw instead of scrolling. ⚠️ The sheet closes FIRST: the row is on the
  // page behind the sheet's backdrop, and scrolling the page under an open modal is a tap that does nothing
  // anyone can see. The frame after the close, the sheet is gone and the row is there.
  const jump = (n: number) => {
    onClose();
    requestAnimationFrame(() => document.getElementById(`ch-${n}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const serverDefault = admin?.global.patienceDays ?? 2;
  const main = sources.find((s) => s.primary) ?? sources[0];
  // A site read by the built-in engine cannot say who translated a chapter; an extension or MangaDex series
  // with no groups yet simply has not been checked (or nothing on it is tagged).
  const emptyText = main && !namesGroups(main.sourceId) ? tr('This site does not name translation groups.') : tr('No translation groups known yet.');

  // One row (it wraps to two at 390 px: the buttons go under the field). The sentences that used to sit
  // above and below the field are read on hover and by a screen reader instead -- the sheet's body is
  // where the room goes.
  const patienceHelp = `${tr('Preferred groups are taken first, blocked groups never. New chapters wait for a preferred group for the patience below.')} ${
    tr('Blank uses the server default ({n}). 0 takes the best copy available at once.', { n: serverDefault })}`;
  const footer = admin && (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      <label className="text-xs text-fog-400" htmlFor={`patience-${id}`}>{tr('Patience')}</label>
      <input id={`patience-${id}`} type="number" min={0} max={30} step={1} inputMode="numeric" value={patience}
        onChange={(e) => setPatience(e.target.value)} placeholder={String(serverDefault)} className={fld}
        title={patienceHelp} aria-describedby={`patience-help-${id}`} />
      <span className="text-xs text-fog-400">{tr('days')}</span>
      <span className="text-[11px] text-fog-500">
        <span aria-hidden className="text-ink-600">· </span>{tr('Currently {n}', { n: admin.effective.patienceDays })}
      </span>
      <p id={`patience-help-${id}`} className="sr-only">{patienceHelp}</p>
      <span className="ms-auto flex shrink-0 gap-1.5">
        <button onClick={savePatience} disabled={busy} className="btn-accent px-3 py-1 text-xs disabled:opacity-50">{tr('Save')}</button>
        <button onClick={useDefaults} disabled={busy || !admin.prefs} className="chip px-2.5 py-1 text-[11px] disabled:opacity-50">{tr('Use server defaults')}</button>
      </span>
    </div>
  );

  return (
    <Sheet title={tr('Sources & translations')} onClose={onClose} overBottomNav footer={footer || undefined}
      action={
        <button type="button" onClick={onExplain} aria-label={tr('What are sources and translations?')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-800/80 text-fog-300">
          <IcInfo width={16} height={16} />
        </button>
      }>
      <section>
        <Eyebrow>{tr('Sources')}</Eyebrow>
        {sources.length > 0
          ? <div className="divide-y divide-ink-800/70">
              {sources.map((s) => (
                <SourceRow key={s.sourceId} s={{ ...s, checkedAt: s.checkedAt ?? (s.primary ? checkedAt : null) }}
                  onUnfollow={isAdmin && !s.primary ? () => unfollow(s) : undefined} unfollowing={unfollowing === s.sourceId} />
              ))}
            </div>
          : <p className="text-xs text-fog-500">{tr('No source — the chapters were scanned from disk.')}</p>}
        {isAdmin && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sources.length > 0 && (
              <button type="button" onClick={checkNow} disabled={checking} className="chip text-xs disabled:opacity-50">
                {checking ? tr('Checking…') : tr('Check now')}
              </button>
            )}
            <button type="button" onClick={onFindMissing} className="chip text-xs">{tr('Add one from Find missing chapters')}</button>
          </div>
        )}
      </section>

      <section className="mt-5">
        <Eyebrow>{tr('Translated by')}</Eyebrow>
        {isLoading && <div className="skeleton h-12 rounded-xl" />}
        {!isLoading && !!error && (
          <p className="text-xs text-rose-300">{msgOf(error, tr('Could not load the groups'))}</p>
        )}
        {!isLoading && !error && !rows.length && <p className="text-xs text-fog-500">{emptyText}</p>}
        {!isLoading && !error && rows.map((g) => {
          const rank = admin ? rankIn(stored.priority, g.name) : -1;
          const blocked = !!admin && hasGroup(stored.blocked, g.name);
          const serverBlocked = !!admin && hasGroup(admin.global.blocked, g.name);
          const controls = admin && (
            <>
              {rank >= 0 && (
                <span className="flex shrink-0 items-center">
                  <button onClick={() => move(g.name, -1)} disabled={busy || rank === 0} aria-label={tr('Move up')} className="px-1 text-fog-400 disabled:opacity-30">▲</button>
                  <button onClick={() => move(g.name, 1)} disabled={busy || rank === stored.priority.length - 1} aria-label={tr('Move down')} className="px-1 text-fog-400 disabled:opacity-30">▼</button>
                </span>
              )}
              <button onClick={() => togglePrefer(g.name)} disabled={busy || (serverBlocked && rank < 0)}
                className={`chip shrink-0 px-2 py-0.5 text-[10px] disabled:opacity-40 ${rank >= 0 ? 'chip-active' : ''}`}>
                {rank >= 0 ? `#${rank + 1}` : tr('Prefer')}
              </button>
              {serverBlocked
                ? <span className="shrink-0 text-[10px] text-fog-600">{tr('blocked on server')}</span>
                : <button onClick={() => toggleBlock(g.name)} disabled={busy}
                    className={`chip shrink-0 px-2 py-0.5 text-[10px] disabled:opacity-40 ${blocked ? 'border-rose-500/40 text-rose-300' : ''}`}>
                    {blocked ? tr('Blocked') : tr('Block')}
                  </button>}
            </>
          );
          return (
            <GroupRow key={normGroup(g.name) || g.name} g={g} blocked={blocked} serverBlocked={serverBlocked} haveNumbers={haveNumbers}
              seriesStatus={series?.metadata?.status} controls={controls || undefined} onJump={jump} />
          );
        })}
      </section>
    </Sheet>
  );
}
