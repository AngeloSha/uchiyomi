'use client';
// Admin → Settings: Server · Series & chapters · Downloads · Maintenance · Notifications, one at a time, with a search
// over every row (v0.86.0, components/SettingsLayout.tsx).
//
// Until v0.39.0 this tab was a `.board` of cards of every shape with three save idioms side by side; v0.39.0 made every
// row save on its own and say "Saved" in one place. Until v0.86.0 it was then nine cards and 44 rows on one screen, in
// the order they were added: the download settings over four cards, the nightly jobs scattered, the AniList switches
// under Scanlators. Now each row is in the category its name says, the settings that are lists or rankings -- notice
// chapters, the 18+ genres, the source order, the scanlation groups, the slow archive -- are one row each that says
// what is set and opens an editor, and the rows few people change fold under More options. Server stays first:
// `test/e2e/run.mjs` reads the first 4000 characters of body text for the install-count payload.
//
// The only Save button left is the scanlation groups' one, in its editor's footer, because those are lists that are
// edited in several steps and must land as one write.
//
// Toasts survive on exactly two rows, and only for the sentence the inline tick cannot say: the install count
// ("Thank you — counted" / "No longer counted", because opting out destroys the identifier) and the read-chapter cleanup
// ("Read chapters will be deleted" / "Read chapters are kept", because it deletes files). Every other row's outcome is
// its own state plus the tick.
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Switch } from '@/components/Switch';
import { OnBody } from '@/components/ui';
import { IcBell, IcDownload, IcFilter, IcRefresh, IcSettings } from '@/components/icons';
import {
  Disclosure, EditorSheet, MoreOptions, NumberRow, Row, RowBlock, RowGroup, SaveState, Segmented, SelectRow, SummaryRow,
  SwitchRow, TextRow, useAutosave, useEditor,
} from '@/components/settings';
import type { PageView } from '@/components/ConsoleLayout';
import { nightlyModeOf, type NightlyMode } from '@/lib/autofix';
import { t as tr } from '@/lib/i18n';
import type { KnownGroup, SeriesType, StoredPrefs } from '@/lib/types';
import { SERIES_TYPES, seriesTypeKey } from '@/lib/seriesTypes';
import { hasGroup, normGroup, reorder, withoutGroup } from '@/lib/scanlators';
import { suggestGroups } from '@/lib/groupSuggest';
import { NotificationsSection } from '@/components/AdminNotifications';
import { NetworkSettings } from '@/components/NetworkSettings';
import { SlowArchiveRow } from '@/components/ArchiveSettings';
import { TranslateRow } from '@/components/TranslateSettings';
import { isDesktop } from '@/lib/desktop';
import { ssoOnly, useAuthConfig } from '@/lib/authConfig';
import { adultShown } from '@/lib/adult';
import { addable, moveIn, orderRows } from '@/lib/sourceOrder';
import { moveTo, useDragReorder } from '@/lib/dragReorder';
import { discoverSources } from '@/lib/sourceGroups';
import { memberDefaultsOf } from '@/lib/memberDefaults';
import { joinSentences } from '@/lib/jobs';
import { clockText, hoursText, intervalChoices } from '@/lib/settingsChoices';

/** One PATCH. Resolves once the server has answered, so the row that called it can show its tick. */
type Save = (body: Record<string, unknown>) => Promise<unknown>;

/**
 * Admin's settings pages: Server · Series & chapters · Downloads · Maintenance · Notifications (v0.86.0), rows of the
 * console's one list since v0.88.0 (components/ConsoleLayout.tsx), which app/admin/page.tsx draws with its other pages.
 * `extra` adds a page's own groups after its settings: Maintenance's Run now (the Tasks tab until v0.88.0) lives in the
 * admin page, beside the rest of the console.
 */
export function useAdminSettingsViews(extra: Partial<Record<string, ReactNode>> = {}): {
  views: Record<string, PageView>;
  sso: boolean;
  extensions: boolean;
} {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<any>('/api/admin/settings') });
  // SSO-only mode (v0.63.0, #208) has no sign-up route at all, so Open registration would be a switch that does nothing.
  const { data: authConfig } = useAuthConfig();
  // Returns the PATCH's promise rather than swallowing it: a row awaits it to show Saved ✓ or the server's
  // own sentence, which is why nothing here catches. The refetch is started, not awaited -- the tick should
  // answer the save, not the round trip after it.
  const save: Save = async (body) => {
    await api('/api/admin/settings', { method: 'PATCH', json: body });
    void qc.invalidateQueries({ queryKey: ['admin-settings'] });
    // A blocklist save hides, or shows again, every series' chapters only blocked groups released (bff
    // reapplyBlocklist): any series page already cached refetches its rows, its versions and its groups.
    if (body.scanlatorPrefs !== undefined) {
      for (const k of ['series-listing', 'series-versions', 'series-groups', 'series-scanlators']) void qc.invalidateQueries({ queryKey: [k] });
    }
  };
  // Until the settings have answered, each settings page says so where its groups will be.
  const loading = <div className="card grad-border p-6 text-center text-sm text-fog-500">{tr('Loading…')}</div>;
  const ready = (pane: ReactNode, id: string) => (data ? <>{pane}{extra[id]}</> : <>{loading}{extra[id]}</>);
  // What each page holds, said once: the sentence under its title, and without its full stop the line under its name in
  // the list, where every other page's line is a phrase.
  const phrase = (sentence: string) => sentence.replace(/[.。]\s*$/u, '');
  const about = {
    server: tr('Its name, who may join, updates, and translation.'),
    series: tr('What members see, and what is looked up online.'),
    downloads: tr('How new chapters arrive, and the space they take.'),
    maintenance: tr('Backups and repairs, every night.'),
    notifications: tr('New chapters and problems, sent to your phone, Home Assistant or Discord.'),
  };
  const views: Record<string, PageView> = {
    server: { icon: <IcSettings width={18} height={18} />, tint: 'bg-slate-400/15 text-slate-200', summary: phrase(about.server), description: about.server,
      pane: ready(data && <ServerSection data={data} save={save} />, 'server') },
    series: { icon: <IcFilter width={18} height={18} />, tint: 'bg-emerald-500/15 text-emerald-300', summary: phrase(about.series), description: about.series,
      pane: ready(data && <SeriesSection data={data} save={save} />, 'series') },
    downloads: { icon: <IcDownload width={18} height={18} />, tint: 'bg-sky-500/15 text-sky-300', summary: phrase(about.downloads), description: about.downloads,
      pane: ready(data && <SchedulesSection data={data} save={save} />, 'downloads') },
    maintenance: { icon: <IcRefresh width={18} height={18} />, tint: 'bg-amber-500/15 text-amber-300', summary: phrase(about.maintenance), description: about.maintenance,
      pane: ready(data && <MaintenanceSection data={data} save={save} />, 'maintenance') },
    // v0.43.0 (#70): webhook, Home Assistant, ntfy and Discord targets. Its rows and its one dialog live in their own
    // file; it reads its own endpoint.
    notifications: { icon: <IcBell width={18} height={18} />, tint: 'bg-rose-500/15 text-rose-300', summary: phrase(about.notifications), description: about.notifications,
      pane: <NotificationsSection /> },
  };
  return { views, sso: ssoOnly(authConfig), extensions: !!data?.extensions_configured };
}

/**
 * Notice chapters (bff lib/noticeChapters.ts): one switch per series type. Many sources post an announcement as a
 * short chapter numbered after the latest with a fraction (100.5); a type switched on here has every such chapter of
 * 3 pages or fewer hidden from the library, the reader, OPDS and Mihon, and the sweep does not download one a source
 * lists as that short. Longer x.y chapters, and any not counted yet, are chapters and stay. Off by default, and
 * nothing is deleted: switching a type off shows them again at once. A series' own switch, in its Sources &
 * translations sheet, outranks its type's; its type is set in Edit series.
 *
 * v0.55.3 (#147, TIGamingTV's switch): "Only hide short ones", on by default, is that page rule; off, every chapter
 * numbered like 12.5 of the types switched on is hidden, real chapters a site split into parts included -- which its
 * help says before it is flipped, and the editor's own sentence says which rule is in force.
 *
 * One row that names the types switched on (v0.86.0), and an editor with the switches.
 *
 * Held locally and saved whole on every flip, re-seeded from the refetch, for the reason AdultFilterSection says:
 * two quick flips must not both start from the list as it was before either landed.
 */
function NoticeChaptersSection({ data, save }: { data: any; save: Save }) {
  const editor = useEditor('notice-chapters');
  const [types, setTypes] = useState<SeriesType[]>(() => (Array.isArray(data.hide_notice_types) ? data.hide_notice_types : []));
  useEffect(() => { setTypes(Array.isArray(data.hide_notice_types) ? data.hide_notice_types : []); }, [data.hide_notice_types]);
  const flip = async (t: SeriesType, on: boolean) => {
    const prev = types;
    const next = SERIES_TYPES.filter((x) => (x === t ? on : prev.includes(x)));
    setTypes(next);
    try { await save({ hideNoticeTypes: next }); } catch (e) { setTypes(prev); throw e; }
  };
  const shortOnly = data.hideNoticeShortOnly !== false;
  return (
    <>
      <SummaryRow id="notice-chapters" ref={editor.row} label={tr('Notice chapters')} onClick={editor.show}
        value={types.length ? types.map((t) => tr(seriesTypeKey(t))).join(', ') : tr('Off')} />
      <EditorSheet title={tr('Notice chapters')} open={editor.open} onClose={editor.close}>
        <p className="max-w-prose py-3 text-[12px] leading-relaxed text-fog-400 first:pt-1">
          {shortOnly
            ? tr('Sources often post notices for readers as a short chapter numbered after the latest one, like 100.5. For each type switched on, chapters numbered like 12.5 with 3 pages or fewer are hidden from the library, the reader, OPDS and Mihon; longer ones, and any whose pages are not counted yet, stay. A chapter a source already lists with 3 pages or fewer is not downloaded. Nothing is deleted: switching a type off shows them again. A series can override this in its Sources & translations sheet.')
            : tr('Sources often post notices for readers as a short chapter numbered after the latest one, like 100.5. For each type switched on, every chapter numbered like 12.5 is hidden from the library, the reader, OPDS and Mihon, and one a source lists is not downloaded. Nothing is deleted: switching a type off shows them again. A series can override this in its Sources & translations sheet.')}
        </p>
        <div data-notice-types className="divide-y divide-ink-800/80">
          {SERIES_TYPES.map((t) => (
            <SwitchRow key={t} label={tr(seriesTypeKey(t))} on={types.includes(t)} onChange={(next) => flip(t, next)} />
          ))}
        </div>
        <div data-notice-short-only>
          <SwitchRow id="notice-short-only" label={tr('Only hide short ones (3 pages or fewer)')}
            help={tr('Off hides every chapter numbered like 12.5 of the types switched on, including real chapters a site split into parts.')}
            on={shortOnly} onChange={(next) => save({ hideNoticeShortOnly: next })} />
        </div>
      </EditorSheet>
    </>
  );
}

/**
 * What the "Show 18+" switch hides, beyond libraries rated 18+ and the sources rated Adult only.
 *
 * Before this the only way to keep a genre off the shelf was to move its series into an 18+ library --
 * a filing decision made to get a display outcome, which the scanner then argued with on every rescan.
 * Naming the genres says the same thing directly, and leaves filing alone.
 *
 * Nothing here is a permission. Everything listed is still openable by anyone who may open it, still
 * reachable by link, and still returned by the by-id routes; the switch only decides what turns up
 * unasked. The permission is an account's age limit, which lives on the member, not here.
 *
 * The sources ticked here until v0.73.0 are rated on the source now (components/SourceSheet.tsx, #256 from @Squeaks72):
 * Adult only became a permission -- refused to an account limited below 18 -- and a permission does not belong in a
 * list of surfacing preferences. The same stored list: what was ticked here is rated Adult only.
 *
 * One row that names the genres (v0.86.0), and an editor where each genre is a square key that stays lit while it is
 * hidden.
 */
function AdultFilterSection({ data, save }: { data: any; save: Save }) {
  const toast = useToast();
  const qc = useQueryClient();
  const editor = useEditor('adult-filter');
  // Held locally and saved whole on every click, re-seeded whenever the settings refetch. Read straight
  // from `data`, two quick clicks both toggled against the list as it was before either save landed, and
  // the second PATCH quietly undid the first.
  const [genres, setGenres] = useState<string[]>(() => (Array.isArray(data.adult_genres) ? data.adult_genres : []));
  useEffect(() => { setGenres(Array.isArray(data.adult_genres) ? data.adult_genres : []); }, [data.adult_genres]);
  // The picker asks with the reveal ON, whatever this browser has it set to. Otherwise the very thing
  // being configured hides the controls for it: with "Show 18+" off, a genre ticked here leaves
  // the list it was ticked in, and can then never be unticked. Same URL rule and the same reason as the
  // admin console's `allSourcesUrl` (app/admin/page.tsx): `?adult=1` only when the reveal is OFF, because
  // lib/api.ts adds its own when it is on and two copies arrive as an array, which the server reads as
  // hidden. Own query keys, so a revealed answer is never replayed to a browsing screen.
  const revealed = (path: string) => (adultShown() ? path : `${path}${path.includes('?') ? '&' : '?'}adult=1`);
  // The genres actually present in this library, so the list offers what can match rather than a
  // vocabulary. A failure just leaves the picker empty rather than breaking the tab.
  const { data: overview } = useQuery({
    queryKey: ['genres-overview', 'all'],
    // `key` is the genre folded to lower case -- the form the filter stores and matches on -- and `label`
    // is how it is written in the library. Storing the key keeps "Sci-Fi" and "sci-fi" one entry.
    queryFn: () => api<{ content: Array<{ key: string; label: string }> }>(revealed('/api/genres/overview?covers=1')),
    staleTime: 5 * 60_000,
  });
  const allGenres = (overview?.content ?? []).filter((g) => g?.key);
  const has = (list: string[], v: string) => list.includes(v.toLowerCase());
  const toggle = (list: string[], v: string) => {
    const k = v.toLowerCase();
    return list.includes(k) ? list.filter((x) => x !== k) : [...list, k];
  };
  // A failed save puts the key back and says so, rather than leaving it lit over a list that was not stored.
  const flip = (field: 'adultGenres', list: string[], set: (v: string[]) => void, v: string) => {
    const next = toggle(list, v);
    set(next);
    save({ [field]: next })
      // Library and Home decide whether to offer the reveal from this; an emptied or first list changes it.
      .then(() => qc.invalidateQueries({ queryKey: ['adult-filter'] }))
      .catch(() => { set(list); toast(tr('Could not save'), 'error'); });
  };
  const named = genres.map((k) => allGenres.find((g) => g.key === k)?.label || k);

  return (
    <>
      <SummaryRow id="adult-filter" ref={editor.row} label={tr('18+ filter')} onClick={editor.show}
        value={named.length ? named.join(', ') : tr('None')} />
      <EditorSheet title={tr('18+ filter')} open={editor.open} onClose={editor.close}>
        <div className="py-3 first:pt-1">
          <p className="mb-2 max-w-prose text-[12px] leading-relaxed text-fog-400">
            {tr('Genres to keep off the shelf while “Show 18+” is off. This hides nothing from anyone who goes looking: links, bookmarks, downloads and reading progress are unaffected.')}
          </p>
          <div className="flex flex-wrap gap-1.5" data-adult-genres>
            {allGenres.length === 0 && <span className="text-[11px] text-fog-500">{tr('No genres yet.')}</span>}
            {allGenres.map((g) => (
              <button key={g.key} type="button"
                onClick={() => flip('adultGenres', genres, setGenres, g.key)}
                aria-pressed={has(genres, g.key)}
                className={`btn-key whitespace-nowrap ${has(genres, g.key) ? 'btn-key-accent' : ''}`}>
                {g.label || g.key}
              </button>
            ))}
          </div>
        </div>
        <p className="max-w-prose py-3 text-[11px] leading-relaxed text-fog-500" data-source-ratings-note>
          {tr('A whole source is rated on its own sheet: Sources ▸ the source ▸ Age rating. Adult only also keeps it from accounts limited below 18.')}
        </p>
        <p className="py-3 text-[11px] leading-relaxed text-fog-500">
          {tr('One series can be let through on its own page — Edit details ▸ “Always show”.')}
        </p>
      </EditorSheet>
    </>
  );
}

/**
 * Which followed source a chapter the server does not have yet is taken from (#93, from @Squeaks72).
 *
 * Ranked after the scanlation group preferences, so it only decides between copies those call equal -- the
 * choice the follow order made alone until now, where the source a series was added from won every tie. A
 * series can have its own order, from its Sources & translations sheet, which replaces this one for it.
 *
 * Nothing already downloaded is replaced because of it, and the help says so: #93's switch that re-fetched
 * held chapters from a better-ranked source was not taken (lib/sourcePrefs.ts says why).
 *
 * Held locally and saved whole on every change, re-seeded when the settings refetch, like the 18+ filter
 * above: read straight from `data`, two quick arrows both moved the list as it was before either save
 * landed, and the second quietly undid the first. EVERY STORED ID IS KEPT (lib/sourceOrder.ts): the list of
 * sources is the registry's, which has no extensions while the engine restarts, and #93 saved an order built
 * from it -- one arrow then, and every extension was gone from the order.
 *
 * Arrows rather than dragging: a short list that changes rarely, and two buttons work on a phone, from a
 * keyboard and with a screen reader. One row that names the first sources (v0.86.0); the ranking is its editor.
 */
function SourceOrderSection({ data, save }: { data: any; save: Save }) {
  const toast = useToast();
  const editor = useEditor('source-order');
  const fromServer = (): string[] => (Array.isArray(data.source_prefs?.priority) ? data.source_prefs.priority : []);
  const [order, setOrder] = useState<string[]>(fromServer);
  useEffect(() => { setOrder(fromServer()); }, [data.source_prefs]); // eslint-disable-line react-hooks/exhaustive-deps
  // Every source, with the reveal ON whatever this browser has it set to: the admin console's `allSourcesUrl`
  // (app/admin/page.tsx) and the 18+ filter above ask the same way under the same key, so the three share one
  // answer. `?adult=1` only when the reveal is off -- lib/api.ts adds its own when it is on.
  const { data: srcList } = useQuery({
    queryKey: ['sources', 'all'],
    queryFn: () => api<{ content: Array<{ id: string; name: string; backup?: boolean }> }>(adultShown() ? '/api/sources' : '/api/sources?adult=1'),
    staleTime: 5 * 60_000,
  });
  const all = srcList?.content ?? [];
  const rows = orderRows(order, all);
  // A backup extension's source is never offered to rank (v0.82.0): it is not one the admin chose.
  const rest = addable(order, discoverSources(all));
  // A failed save puts the list back and says so, rather than leaving an order on screen that is not stored.
  const commit = (next: string[]) => {
    const was = order;
    setOrder(next);
    save({ sourcePrefs: { priority: next } }).catch(() => { setOrder(was); toast(tr('Could not save'), 'error'); });
  };
  // Drag a row to where it belongs; the arrows do the same a step at a time.
  const drag = useDragReorder({ count: rows.length, layout: 'column', onMove: (from, to) => commit(moveTo(order, from, to)) });

  return (
    <>
      <SummaryRow id="source-order" ref={editor.row} label={tr('Source order')} onClick={editor.show}
        value={rows.length ? rows.map((r) => r.name || '…').join(', ') : tr('None')} />
      <EditorSheet title={tr('Source order')} open={editor.open} onClose={editor.close}>
        <div className="py-3 first:pt-1">
          <p className="max-w-prose text-[12px] leading-relaxed text-fog-400">
            {tr('When a series follows more than one source, a new chapter is taken from the highest one here that has it, after your scanlation group preferences. Chapters you already have are never replaced because of it. A series can have its own order in its Sources & translations.')}
          </p>
          {rows.length === 0 && (
            <p className="mt-3 text-[11px] text-fog-500">{tr('No order set: each series prefers the source it was added from.')}</p>
          )}
          {rows.length > 0 && (
            <ol className="mt-3 space-y-1">
              {rows.map((r, i) => (
                <li key={r.id} {...drag.item(i)} className="flex items-center gap-2 rounded-lg bg-ink-900/60 px-3 py-2">
                  <span className="w-5 shrink-0 text-[11px] tabular-nums text-fog-500">{i + 1}</span>
                  {r.name
                    ? <span className="truncate text-sm text-fog-200">{r.name}</span>
                    : <span className="truncate text-sm text-fog-500" title={r.id}>{tr('Not available right now')}</span>}
                  <span className="ms-auto flex shrink-0 gap-1">
                    <button type="button" onClick={() => commit(moveIn(order, i, -1))} disabled={i === 0}
                      aria-label={tr('Move up')} className="btn-key h-7 w-7 px-0">↑</button>
                    <button type="button" onClick={() => commit(moveIn(order, i, 1))} disabled={i === rows.length - 1}
                      aria-label={tr('Move down')} className="btn-key h-7 w-7 px-0">↓</button>
                    <button type="button" onClick={() => commit(order.filter((x) => x !== r.id))}
                      aria-label={tr('Remove')} className="btn-key btn-key-danger h-7 w-7 px-0">✕</button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        {rest.length > 0 && (
          <div className="py-3">
            <p className="mb-1.5 text-[11px] text-fog-500">{tr('Add a source to the order')}</p>
            <div className="flex flex-wrap gap-1.5">
              {rest.map((x) => (
                <button key={x.id} type="button" onClick={() => commit([...order, x.id])} className="btn-key">{x.name}</button>
              ))}
            </div>
          </div>
        )}
      </EditorSheet>
    </>
  );
}

/**
 * A switch row with a disclosure under it, as ONE divider unit (`RowBlock`).
 *
 * `SwitchRow`'s help is rendered inside a `<p>`, and a `Disclosure` holds a `<div>` (and here a `<pre>` and a
 * `<ul>`), which cannot sit in a paragraph: the browser would close the `<p>` early while parsing and React
 * would then report a hydration mismatch, which run.mjs counts as a console error. So the disclosure is a
 * sibling of the row, and the block around the two makes the group draw one line under the pair rather than one
 * between them.
 *
 * The switch is optimistic the way `SwitchRow` is -- it moves at once and reverts if the save fails -- and
 * it is not disabled while saving, so a keyboard user keeps their place.
 */
function SwitchWithMore({ id, label, help, on, onChange, more }: {
  id?: string;
  label: string;
  help: string;
  on: boolean;
  onChange: (next: boolean) => Promise<unknown> | unknown;
  more: ReactNode;
}) {
  const { status, run } = useAutosave();
  const [local, setLocal] = useState(on);
  useEffect(() => { setLocal(on); }, [on]);
  const flip = async (next: boolean) => {
    setLocal(next);
    const ok = await run(() => onChange(next));
    if (!ok) setLocal(on);
  };
  return (
    <RowBlock id={id}>
      <Row label={label} help={help} status={status}>
        <Switch on={local} onChange={(next) => { void flip(next); }} label={label} />
      </Row>
      {more}
    </RowBlock>
  );
}

/**
 * Server: the name, who may join and what a new member starts with, the two network promises, and translation.
 *
 * ⚠️ THE UPDATE CHECK AND THE INSTALL COUNT ARE TWO ROWS BECAUSE THEY ARE TWO DIFFERENT PROMISES. The first
 * reads a public GitHub url and tells nobody anything, which is why it may be on by default. The second
 * sends a small payload to a server the project runs, and is off until somebody says otherwise. Merging them
 * into one "telemetry" switch would make the honest option -- updates yes, counting no -- impossible to
 * express.
 *
 * ⚠️ THE PAYLOAD IS SHOWN, NOT DESCRIBED. It is fetched from the endpoint that produces the real thing, so
 * this cannot drift into being a flattering summary of something else. Written prose here would have been
 * easier and would have been the wrong shape: what an admin agrees to should be the literal object.
 */
function ServerSection({ data, save }: { data: any; save: Save }) {
  const toast = useToast();
  const on = !!data.install_ping;
  // Uchiyomi Desktop has one person and no install count (lib/desktop.ts): no registration switch, and the
  // count's row is gone with its preview, which the server answers 404 for there and never sends.
  const desktop = isDesktop();
  // SSO-only mode (v0.63.0, #208) has no sign-up route at all, so Open registration would be a switch that does nothing.
  const { data: authConfig } = useAuthConfig();
  // Fetched whether or not it is on: seeing exactly what WOULD be sent is the point of the preview, and
  // asking someone to consent first in order to find out would be backwards.
  const { data: preview } = useQuery({
    queryKey: ['install-ping-preview'],
    queryFn: () => api<{ url: string; payload: Record<string, unknown>; sample: boolean }>('/api/admin/install-ping/preview'),
    staleTime: 60_000,
    enabled: !desktop,
  });
  // What a member the server makes by itself starts with (#208, item 6) lives on Members, beside the accounts; this
  // row says what it is and goes there.
  const defaults = memberDefaultsOf(data);

  return (
    <>
      <RowGroup>
        {/* `required`: the server refuses an empty name (zod min(1)) with a bare 400, so an emptied box goes
            back to the saved name on blur instead of a "Could not save" over nothing. */}
        <RowBlock id="server-name">
          <TextRow label={tr('Server name')} value={data.server_name ?? ''} maxLength={64} autoComplete="off" required
            onSave={(v) => save({ serverName: v })} />
        </RowBlock>
        {!desktop && !ssoOnly(authConfig) && (
          <SwitchRow id="registration" label={tr('Open registration')} help={tr('Let anyone create their own account')}
            on={!!data.allow_registration} onChange={(next) => save({ allowRegistration: next })} />
        )}
        {/* "Who is reading?" on the sign-in screen (bff /auth/pick): at home only. */}
        {!desktop && (
          <SwitchRow id="local-pick" label={tr('Choose a profile at home')} help={tr('At home, the sign-in screen lists the profiles that open without a password.')}
            on={!!data.local_pick} onChange={(next) => save({ localPick: next })} />
        )}
        {!desktop && (
          <SummaryRow id="member-defaults-link" label={tr('When someone signs up')} href="/admin/?tab=Members&section=member-defaults"
            value={defaults.perms.canDownload !== false ? tr('Can download') : tr('No downloads')} />
        )}
      </RowGroup>

      {/* Where profiles without a password open, and the proxies that may say who is connecting (bff /api/admin/network).
          Not on desktop: its server is reached from its own computer alone, always at home. */}
      {!desktop && <NetworkSettings />}

      <RowGroup title={tr('Updates and privacy')}>
        <SwitchWithMore id="update-check" label={tr('Check for updates')} help={tr('Asks GitHub once a day; nothing about this server is sent.')}
          on={data.update_check !== false} onChange={(next) => save({ updateCheck: next })}
          more={(
            <Disclosure label={tr('How this works')}>
              <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">
                {tr('Ask GitHub once a day whether a newer Uchiyomi has been released, and show it under Health. Nothing about this server is sent — it is the same public page you could open yourself.')}
              </p>
            </Disclosure>
          )} />
        {!desktop && <SwitchWithMore id="install-count" label={tr('Count this server in the anonymous install count')}
          help={tr('Off by default. Once a day, sends the few facts below to uchiyomi.com and nothing else.')}
          on={on}
          onChange={async (next) => {
            await save({ installPing: next });
            toast(next ? tr('Thank you — counted') : tr('No longer counted'), 'success');
          }}
          more={(
            // Open while counting, and opened by the act of consenting: what is sent must be visible at the
            // moment of consent. The `key` remounts the disclosure when the switch lands on the server, so
            // `defaultOpen` is re-read then -- and nothing opens if the save was refused, because consent did
            // not happen. Reintroduce by `defaultOpen={false}`: an admin who is being counted opens the tab
            // to a closed drawer.
            <Disclosure key={on ? 'counting' : 'not-counting'} defaultOpen={on}
              label={on ? tr('What is sent, once a day') : tr('What would be sent, once a day')}>
              <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">
                {tr('Off by default. Nobody can see how many people self-host this, which makes it hard to know whether a release reached anyone. If you turn this on, once a day your server sends the few facts below — and nothing else — to uchiyomi.com.')}
              </p>
              {preview && (
                <div className="mt-2 rounded-xl border border-ink-700 bg-ink-950/60 p-3">
                  <pre className="overflow-x-auto text-[11px] leading-relaxed text-fog-300">
                    <code>{`POST ${preview.url}\n${JSON.stringify(preview.payload, null, 2)}`}</code>
                  </pre>
                </div>
              )}
              <ul className="mt-2 max-w-prose space-y-1 text-[11px] leading-relaxed text-fog-500">
                {/* The id is the part that needs explaining, so it goes first and in plain words. */}
                <li>{tr('The id changes every month and is a hash of a secret that never leaves this server, so two months of pings cannot be connected to each other.')}</li>
                <li>{tr('No library, no titles, no accounts, no address, no hostname. The list above is the whole of it.')}</li>
                <li>{tr('Turning this off deletes the secret and asks for this month to be forgotten. A new id is made if you ever turn it back on.')}</li>
              </ul>
            </Disclosure>
          )} />}
      </RowGroup>

      {/* v0.85.0: the opt-in translation engine -- a download, then one switch. Not on desktop (the engine's processes do
          not run inside the app); the row and its group hide themselves where the server says it cannot run. */}
      {!desktop && <TranslateRow />}
    </>
  );
}

/**
 * Series & chapters: what members see of a series and its chapters, and what is looked up online for it.
 */
function SeriesSection({ data, save }: { data: any; save: Save }) {
  return (
    <>
      <RowGroup title={tr('Shown to members')}>
        <NoticeChaptersSection data={data} save={save} />
        <AdultFilterSection data={data} save={save} />
        {/* Display only (bff lib/deletedGhosts.ts): a deleted chapter keeps its row, its progress and its place; it is
            drawn as a chapter not here yet instead of "Deleted from the server". A file Verify found missing is not one:
            the sweep fetches those back, and they keep their own look. */}
        <SwitchRow id="deleted-ghosts" label={tr('Show deleted chapters as ghosts')} on={!!data.deleted_as_ghosts}
          help={tr('A chapter whose file was deleted is shown like a chapter not downloaded yet, with Fetch to bring it back, instead of as a deleted chapter. Reading history is kept. Mihon lists it as “not downloaded”.')}
          onChange={(next) => save({ deletedAsGhosts: next })} />
        {/* The reveal for the cleanup, and for a followed series nobody has fetched: without it Mihon counted a pruned or
            never-downloaded chapter as zero chapters, and told the trackers so. No confirmation — nothing here is
            deleted or written. Only the Komga-compatible API reads it, and desktop does not serve that API. */}
        {!isDesktop() && (
          <MoreOptions id="series-more">
            <SwitchRow id="mihon-missing" label={tr('Show missing chapters in Mihon')} on={!!data.komga_ghost_chapters}
              help={tr('List the chapters this server has not downloaded, and those whose files were deleted, alongside the ones it holds — so Mihon and your trackers count the whole series rather than only what is on disk. These rows cannot be opened; they are marked “not downloaded”. Only the Mihon extension sees them.')}
              onChange={(next) => save({ komgaGhostChapters: next })} />
          </MoreOptions>
        )}
      </RowGroup>

      <RowGroup title={tr('From the internet')}>
        {/* v0.73.0 (#257 and #245 from @Squeaks72): the nightly repair's ninth step. Off by default: it asks sources about
            series, and AniList's text is English. What it fills in sits below a series' own details, never over them. */}
        <SwitchRow id="fill-details" label={tr('Fill in missing details')}
          help={tr('Off by default. Once a night, a series with no description, genres or author of its own gets them from AniList, when it is linked there and in English, or else from its own source or one it follows; a series with no chapters yet gets a cover too. A series’ own details always win, and so does anything you set in Edit details. Switching this off takes back everything it filled in.')}
          on={data.fill_details === true} onChange={(next) => save({ fillDetails: next })} />
        {/* Off by default: outbound traffic to sources that carry nothing else for a series. A series can
            switch it for itself on its Sources & translations sheet. */}
        <SwitchRow id="borrow-names" label={tr('Borrow chapter names from other sources')}
          help={tr('Off by default. When a series’ own source only ever says “Chapter 12”, take the names from another source whose numbering was checked against this one — a source that numbers the chapters differently is never used, and the names go into the chapter name only, never the file. The chapter’s own source naming it later wins, and switching this off takes the borrowed names back.')}
          on={data.borrow_names === true} onChange={(next) => save({ borrowNames: next })} />
        {/* v0.56.0: Discover's names looked up on AniList, MangaDex and MangaUpdates. ON by default, which `!== false`
            reads as: a server that does not send the key yet looks them up. */}
        <SwitchRow id="discover-lookups" label={tr('Match Discover titles online')}
          help={tr('On by default. Titles shown in Discover are looked up on AniList, MangaDex and MangaUpdates, once each and in the background, so that a series several sources name differently shows as one card and one you already have stays hidden. Off, only the names themselves are compared and nothing is sent anywhere.')}
          on={data.discover_lookups !== false} onChange={(next) => save({ discoverLookups: next })} />
      </RowGroup>
    </>
  );
}

/**
 * Downloads: how new chapters arrive -- how often the library is asked, what happens when a site will not give them,
 * which source and which group a copy comes from, the slow archive -- and the space they take.
 *
 * The interval is a menu of hours (v0.86.0): the number box took any number and clamped it after, and a value stored
 * before stays one of the menu's until another is picked (lib/settingsChoices.ts intervalChoices).
 */
function SchedulesSection({ data, save }: { data: any; save: Save }) {
  const interval: number = data.updater_hours ?? 6;
  return (
    <>
      <RowGroup title={tr('Getting chapters')}>
        <SelectRow id="update-interval" label={tr('Library update interval')} value={String(interval)}
          help={tr('How often every followed series is asked for new chapters.')}
          options={intervalChoices(interval).map((h) => ({ value: String(h), label: hoursText(h) }))}
          onChange={(v) => save({ updaterHours: Number(v) })} />
        {/* v0.81.0: ONE switch for everything automatic about downloads (the owner, 2026-10-18: too many options to follow).
            Finishing what is still to download (bff lib/finishDownloads.ts) and looking for other sources --
            the sweep's hunt and the scout (lib/sourceHunt.ts, lib/sourceScout.ts), "Use other sources on their own" until
            v0.81.0 -- are written together, and the switch reads on only while both are. ON by default (both columns
            default true), which `!== false` reads as: a server that does not send a key yet does it. */}
        <SwitchRow id="finish-downloads" label={tr('Finish downloads on their own')}
          help={tr('On by default. Uchiyomi keeps downloading until every chapter is here: when a site is slow, blocked or missing chapters, it uses the series’ other sources, and finds a new one when none of them can help, trying a few extensions from your repository if it has to. Off, chapters come only with the library update, from the sources you picked.')}
          on={data.finish_downloads !== false && data.auto_follow_on_failure !== false}
          onChange={(next) => save({ finishDownloads: next, autoFollowOnFailure: next })} />
        <SourceOrderSection data={data} save={save} />
        <ScanlatorsSection data={data} save={save} />
        {/* v0.49.0 (#117): the slow archive's pause and pace, in its own file. */}
        <SlowArchiveRow data={data} save={save} />
        {/* Which languages MangaDex is a source in lives with the sources (components/MangadexCard.tsx); this row goes there, unfolded (`?card=mangadex`, v0.52.0). */}
        <SummaryRow id="mangadex-languages" label={tr('MangaDex languages')} href="/admin/?tab=Sources&card=mangadex" />
        <MoreOptions id="downloads-more">
          {/* v0.89.0 (#305): how many other sources a series may follow (bff lib/followLimit.ts), here since the env's
              MAX_FOLLOWED_SOURCES alone set it -- that number is what the menu shows until one is picked. The help says the
              cost: each one is a chapter list asked for at every update. */}
          <SelectRow id="sources-per-series" label={tr('Other sources per series')}
            help={tr('How many sources besides its main one a series may follow, whether you add them or Uchiyomi finds them. 3 by default. Each one is one more chapter list to ask for at every library update.')}
            value={String(data.followerLimit ?? 3)}
            options={Array.from({ length: data.followerLimitMax ?? 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
            onChange={(v) => save({ maxFollowedSources: Number(v) })} />
          {/* v0.61.0, the release radar's other half (bff lib/releaseRadar.ts isDue): the scheduled sweep asks a long-quiet
              series less often and a due one as usual. Off by default, and `=== true` reads a server that does not send the
              key as off; the help says the limit and that Check now is never kept waiting. */}
          <SwitchRow id="smart-checks" label={tr('Smart update checks')}
            help={tr('Ask series that have been quiet for a long time less often, at least every 3 days, and every series as usual while its next chapter is due. Check now always asks at once.')}
            on={data.update_smart === true} onChange={(next) => save({ updateSmart: next })} />
        </MoreOptions>
      </RowGroup>

      <RowGroup title={tr('Disk space')}>
        <HousekeepingSection data={data} save={save} />
      </RowGroup>
    </>
  );
}

/**
 * Maintenance: what runs every night -- the backup and the repair -- and the extensions' own updates.
 *
 * The backup is ONE menu (v0.86.0): Off, or the hour it runs. It was a switch and an hour box, and the box said
 * nothing while the switch was off. The server re-arms its timer the moment it is saved, so the change applies to
 * tonight's run. ON at 3 by default (`backup_enabled NOT NULL DEFAULT true`), which `!== false` reads as: a server that
 * does not send the key yet backs up. The keep count deletes nothing when saved; the oldest go after the next backup
 * (bff lib/backup.ts), which its help says.
 *
 * The extension rows appear only when there is an extension engine. `extension_hours` cannot answer that -- it has a
 * NOT NULL default, so it is always set -- which is why the endpoint returns a separate flag.
 */
function MaintenanceSection({ data, save }: { data: any; save: Save }) {
  // A computer is often off at 3 a.m.; the desktop server runs a missed backup the next time it opens.
  const nightly = tr('Nightly, local time. Shown under Tasks.');
  const backup = data.backup_enabled === false ? 'off' : String(data.backup_hour ?? 3);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <>
      <RowGroup title={tr('Backups')}>
        <SelectRow id="nightly-backup" label={tr('Nightly backup')} value={backup}
          help={joinSentences(
            tr('Save the database and the config folder every night. Turn it off if you back up another way; Run now under Tasks still makes one.'),
            isDesktop() ? `${nightly} ${tr('If the PC is off then, it runs the next time Uchiyomi opens.')}` : nightly,
          )}
          options={[{ value: 'off', label: tr('Off') }, ...hours.map((h) => ({ value: String(h), label: clockText(h) }))]}
          onChange={(v) => save(v === 'off' ? { backupEnabled: false } : { backupEnabled: true, backupHour: Number(v) })} />
        <RowBlock id="backups-keep">
          <NumberRow label={tr('Backups to keep')} min={1} max={365} value={data.backup_keep ?? 14}
            help={tr('After each backup, the oldest beyond this number are deleted.')}
            onSave={(n) => save({ backupKeep: n })} />
        </RowBlock>
      </RowGroup>

      <RowGroup title={tr('Repair')}>
        {/* v0.41.0: the nightly repair, and since v0.55.0 what it runs -- the safe repair or a whole Fix everything. ONE
            control since v0.86.0 (NightlyModeRow): Off, Safe repair, Fix everything. ON with the safe repair by default
            (`repair_enabled NOT NULL DEFAULT true`), which `!== false` reads as: a server that does not send the key yet
            is a server that repairs. */}
        <NightlyModeRow mode={nightlyModeOf(data)} off={data.repair_enabled === false}
          onPick={(m) => save(m === 'off' ? { repairEnabled: false } : { repairEnabled: true, nightlyMode: m })} />
      </RowGroup>

      {data.extensions_configured && (
        <RowGroup title={tr('Extensions')}>
          <SwitchRow id="extension-auto-update" label={tr('Update extensions automatically')}
            help={tr('Install new versions of your installed extensions as their repositories publish them. Turn this off to be told about updates and apply them yourself.')}
            on={data.extension_auto_update !== false} onChange={(next) => save({ extensionAutoUpdate: next })} />
          <SelectRow id="extension-hours" label={tr('Extension check interval (hours)')} value={String(data.extension_hours ?? 6)}
            options={intervalChoices(data.extension_hours ?? 6).map((h) => ({ value: String(h), label: hoursText(h) }))}
            onChange={(v) => save({ extensionHours: Number(v) })} />
        </RowGroup>
      )}
    </>
  );
}

/**
 * What the nightly runs (v0.55.0), and since v0.86.0 whether it runs at all: Off, the safe repair it always ran, or
 * Health's whole Fix everything -- which may merge, delete, renumber and install extensions, as pressing it on Health
 * does. Saved as it is picked, with the row's own Saved ✓; the choice moves at once and goes back if the save is
 * refused (SwitchRow's rule). The two lines of help say what each choice does, the one in force brighter, so what Fix
 * everything may do is read before it is picked.
 */
export function NightlyModeRow({ mode, off, onPick }: { mode: NightlyMode; off: boolean; onPick: (m: NightlyMode | 'off') => Promise<unknown> }) {
  const { status, run } = useAutosave();
  const now: NightlyMode | 'off' = off ? 'off' : mode;
  const [local, setLocal] = useState<NightlyMode | 'off'>(now);
  // The prop catching up is adopted during render, never in an effect (SwitchRow's "previous prop" pattern).
  const [seen, setSeen] = useState<NightlyMode | 'off'>(now);
  if (now !== seen) { setSeen(now); setLocal(now); }
  const pick = async (m: NightlyMode | 'off') => {
    setLocal(m);
    if (!(await run(() => onPick(m)))) setLocal(now);
  };
  const label = tr('Repair the library nightly');
  // Stacked, as Edit details' choices are: beside the control, the two lines of help wrapped to eight in a narrow column.
  return (
    <Row id="nightly-repair" label={label} status={status} stacked
      help={(
        <>
          <span className={`block ${local === 'repair' ? 'text-fog-300' : ''}`} data-nightly-help="repair">
            {tr('Safe repair: retries, short chapters, gaps and the solver; nothing is deleted or merged.')}
          </span>
          <span className={`block ${local === 'autofix' ? 'text-fog-300' : ''}`} data-nightly-help="autofix">
            {tr('Fix everything: also replaces sources, merges, deletes and installs extensions, as Health’s Fix everything does.')}
          </span>
        </>
      )}>
      <div data-nightly-mode={local}>
        <Segmented label={label} value={local}
          options={[{ value: 'off', label: tr('Off') }, { value: 'repair', label: tr('Safe repair') }, { value: 'autofix', label: tr('Fix everything') }]}
          onChange={(m) => { void pick(m); }} />
      </div>
    </Row>
  );
}

/**
 * The opt-in read-chapter cleanup, under Downloads → Disk space.
 *
 * ⚠️ THE ONLY SWITCH IN THESE SETTINGS THAT DELETES FILES, so it is the only one that does not simply toggle.
 * Turning it ON asks first, and the question carries `cleanup_read_due` from the settings endpoint: the
 * number of chapters that would go on the first run. An admin deciding this needs "1,842 chapters" in front
 * of them, not an adjective. Turning it OFF is instant -- an off switch that argues with you is a bug.
 *
 * The day count saves on its own, and 0 is a legal value meaning "at the next run". They are two controls
 * because they are two decisions, and because a slip in the number must not silently enable the job.
 */
function HousekeepingSection({ data, save: patch }: { data: any; save: Save }) {
  const toast = useToast();
  const { status, run } = useAutosave();
  // The switch's two writes carry a sentence the tick cannot: this is the row that deletes files. The day
  // count below saves through `patch` directly and has a tick of its own.
  const save = (body: Record<string, unknown>, ok: string) => run(async () => { await patch(body); toast(ok, 'success'); });
  const on = !!data.cleanup_read;
  const stored: number = data.cleanup_read_days ?? 30;
  // The last day count this panel sent, until the refetch agrees with it. The switch's dialog quotes it and
  // the due figure is withheld while it differs from what is stored -- see `due` and the confirm below.
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => { if (days !== null && days === stored) setDays(null); }, [days, stored]);
  const [confirm, setConfirm] = useState(false);
  const cur = days ?? stored;
  // What the server says would go on the next run. It is counted at the SAVED day count, so it is withheld
  // from the moment a new number is committed until the server has counted at that number: a figure that
  // does not answer the setting on screen is worse than no figure, and this is the one number someone is
  // about to make an irreversible decision on.
  const due: number | null =
    cur === stored && typeof data.cleanup_read_due === 'number' ? data.cleanup_read_due : null;
  const dueLine = due === null ? null : (
    <span className={due > 0 ? 'text-amber-300' : undefined}>
      {due > 0 ? tr('{n} chapters qualify right now.', { n: due.toLocaleString() }) : tr('No chapters qualify right now.')}
    </span>
  );

  return (
    <>
      <Row id="delete-read" label={tr('Delete read chapters')} status={status}
        help={tr('Free space by deleting a chapter’s file once everyone who started it has finished it. A chapter someone is partway through is never deleted, and neither is one nobody has read.')}>
        {/* Not a SwitchRow: that one flips at once, and this switch must stay off until the question is
            answered. `on` is the stored value, so cancelling the dialog leaves it exactly where it was. */}
        <Switch on={on} label={tr('Delete read chapters')}
          onChange={(next) => { if (next) setConfirm(true); else save({ cleanupRead: false }, tr('Read chapters are kept')); }} />
      </Row>
      {/* The day count and its two notes as one divider unit. */}
      <RowBlock id="delete-read-days">
        <NumberRow label={tr('Wait (days)')} min={0} max={3650} value={stored} help={dueLine}
          onSave={async (n) => {
            setDays(n);
            try { await patch({ cleanupReadDays: n }); } catch (e) { setDays(null); throw e; }
          }} />
        {/* fog-400 for the line that says what the number means, fog-500 for the one that says what is
            spared: fog-600 measures 2.6:1 on the card, under AA for text, and these two are read, not
            glanced at. fog-600 is for decorative counts only. */}
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-fog-400">
          {cur === 0
            ? tr('0 — the chapter goes at the next hourly run after the last reader finishes it.')
            : tr('Counted from the moment the last reader finished. Re-opening the chapter starts the wait again.')}
        </p>
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-fog-500">
          {tr('Only chapters Uchiyomi downloaded itself are removed — nothing in a library you built by hand is touched. The chapter stays listed and everyone keeps their reading history; the pages are what goes. It is not downloaded again by itself; Fetch again on the series page brings it back.')}
        </p>
      </RowBlock>
      {/* Out to <body>: a `.card` blurs its backdrop, and that traps a fixed dialog inside the card (components/ui.tsx OnBody). */}
      {confirm && (
        <OnBody>
          <ConfirmDialog
            title={tr('Start deleting chapters after they are read?')}
            body={(
              <>
                <p>{tr('From now on, an hourly job will permanently delete the file of any chapter that everyone who started it has finished, once it has been finished for {n} days. There is no undo and no recycle bin.', { n: cur })}</p>
                <p className="mt-2">{tr('Chapters somebody is partway through, chapters nobody has read, bookmarked chapters, and files in a library you assembled yourself are all left alone. Reading history is never deleted.')}</p>
                {due !== null && (
                  <p className={`mt-2 font-semibold ${due > 0 ? 'text-amber-300' : 'text-fog-400'}`}>
                    {due > 0
                      ? tr('{n} chapters qualify today and would go on the first run.', { n: due.toLocaleString() })
                      : tr('Nothing qualifies today, so the first run would delete nothing.')}
                  </p>
                )}
              </>
            )}
            confirmLabel={tr('Turn it on')}
            danger
            // ⚠️ The day count goes with the switch when the server has not yet caught up with it. The dialog
            // quotes the number in the box, so confirming it with only `cleanupRead: true` ran the job at the
            // OLD stored value while the box kept showing the new one -- with the due count deliberately
            // withheld in that state, there was no figure left to notice it by. The number now saves on blur,
            // but the click that opens this dialog is the same click that blurs the box, and the refetch has
            // not landed by the time the answer comes. Reintroduce by saving `{ cleanupRead: true }` alone:
            // type 7 over 30, switch on, and the next run uses 30.
            onConfirm={() => { setConfirm(false); save({ cleanupRead: true, ...(cur !== stored ? { cleanupReadDays: cur } : {}) }, tr('Read chapters will be deleted')); }}
            onClose={() => setConfirm(false)}
          />
        </OnBody>
      )}
    </>
  );
}

const NO_PREFS: StoredPrefs = { priority: [], blocked: [], patienceDays: 2 };

/**
 * A row of group names as tags, with a box to add one. `ordered` adds the arrows that make the row a ranking.
 * Names are compared the way the server compares them, so typing "asura-scans" next to "Asura Scans" is a
 * no-op rather than a second tag the server would fold into the first on save.
 */
function GroupChips({ label, hint, value, ordered, onChange, suggestions }: {
  label: string; hint: string; value: string[]; ordered?: boolean; onChange: (next: string[]) => void;
  /** Every group the server has seen, for the keys under the box. Absent or empty renders no keys. */
  suggestions?: KnownGroup[];
}) {
  const [draft, setDraft] = useState('');
  const toast = useToast();
  // A ranking can also be rearranged by dragging a tag to where it belongs; the arrows stay for the keyboard.
  const drag = useDragReorder({ count: value.length, layout: 'flow', enabled: !!ordered, onMove: (from, to) => onChange(moveTo(value, from, to)) });
  const add = (raw: string) => {
    const t = raw.trim().replace(/,$/, '').trim();
    setDraft('');
    if (!t || hasGroup(value, t)) return;
    // The server refuses both of these; refusing them here says why instead of a tag that never lands.
    if (t.length > 80) { toast(tr('A group name is at most 80 characters'), 'error'); return; }
    if (!normGroup(t)) { toast(tr('A group name needs at least one letter or digit'), 'error'); return; }
    onChange([...value, t]);
  };
  return (
    // ⚠️ The draft is committed when focus leaves the WHOLE control, not the input. The input's own blur
    // fired when Tab moved focus to a suggestion key (they are plain buttons, keyboard-reachable on
    // purpose), so the half-typed draft landed as a tag beside the one then chosen -- "asu" next to
    // "Asura Scans", and a save blocked a group that matches nothing. Focus moving within the control
    // (input -> key, key -> key) commits nothing; leaving it from anywhere commits the draft, so a
    // keyboard user who tabs straight past the keys still gets their text as a tag, as before.
    // Reintroduce by moving the onBlur back onto the input: type "asu", Tab, Enter gives two tags.
    <div className="py-3 first:pt-1" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) add(draft); }}>
      <p className="mb-1.5 text-sm text-fog-100">{label}</p>
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-ink-700 bg-ink-850 p-2">
        {value.map((g, i) => (
          <span key={g} {...drag.item(i)} className="inline-flex items-center gap-1 rounded-lg bg-ink-800 px-2.5 py-1 text-xs text-fog-200">
            {ordered && <span className="text-fog-500">{i + 1}.</span>}
            {g}
            {ordered && (
              <>
                <button type="button" onClick={() => onChange(reorder(value, i, -1))} disabled={i === 0} aria-label={tr('Move up')} className="text-fog-500 hover:text-fog-200 disabled:opacity-30">▲</button>
                <button type="button" onClick={() => onChange(reorder(value, i, 1))} disabled={i === value.length - 1} aria-label={tr('Move down')} className="text-fog-500 hover:text-fog-200 disabled:opacity-30">▼</button>
              </>
            )}
            <button type="button" onClick={() => onChange(withoutGroup(value, g))} aria-label={tr('Remove {name}', { name: g })} className="text-fog-500 hover:text-rose-400">×</button>
          </span>
        ))}
        <input
          value={draft}
          // The heading above is a <p>, not a <label>, so the field's name is given here: a placeholder
          // alone is not an accessible name, and the two "Add a group…" boxes read as identical otherwise.
          aria-label={label}
          onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); }
                              else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1)); }}
          placeholder={tr('Add a group…')}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm text-fog-50 outline-hidden"
        />
      </div>
      {/* Names the server has actually seen, filtered by what is being typed: the exact spelling a source
          uses is the one thing nobody knows without looking. Plain buttons, the LibraryFilters "Find a
          genre" pattern -- reachable by keyboard, no combobox state machine. Hidden entirely when the
          server knows no groups at all: an empty "Known groups" heading would only raise the question. */}
      {!!suggestions?.length && (() => {
        const offered = suggestGroups(suggestions, draft, value);
        return (
          <div className="mt-2">
            <p className="mb-1 text-[11px] font-semibold text-fog-500">{tr('Known groups')}</p>
            {offered.length ? (
              <div className="flex flex-wrap gap-1.5">
                {offered.map((g) => (
                  // ⚠️ preventDefault on mousedown, not click: a click first moves focus off the input, whose
                  // onBlur adds the half-typed draft as a tag, and the suggestion would then land as a
                  // second tag beside a wrong one.
                  <button key={g.name} type="button" data-suggest onMouseDown={(e) => e.preventDefault()} onClick={() => add(g.name)}
                    className="btn-key">
                    {g.name}<span className="ms-1 tabular-nums text-fog-600">· {g.onDisk + g.listed}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-fog-500">{tr('No known group matches that.')}</p>
            )}
          </div>
        );
      })()}
      <p className="mt-1 max-w-prose text-[11px] text-fog-500">{hint}</p>
    </div>
  );
}

/**
 * Scanlation groups ("Scanlators" until v0.86.0): the defaults every series starts from. A series can rank its own
 * groups and block more, but it cannot un-block one that is blocked here: the server takes the union, so this list is
 * the one place a group is refused everywhere at once.
 *
 * One row that names the ranking (v0.86.0), and an editor with the lists, the patience, the upgrade switch -- the
 * nightly repair's group step, which belongs with the ranking it follows -- and the one explicit Save of these
 * settings, pinned in the editor's footer. Two lists and a number are edited in several steps and have to land as ONE
 * write: a block that saved on its own while the ranking was still half-typed would apply a preference nobody had
 * finished expressing. The draft lives here, outside the editor, so closing the editor keeps it, and the row says
 * there is something not saved.
 */
function ScanlatorsSection({ data, save }: { data: any; save: Save }) {
  const editor = useEditor('scanlators');
  // `null` until the admin touches something, so the editor shows what is stored until then. The draft is
  // kept after a save rather than cleared: clearing it would show the old values for the moment between
  // the PATCH and the refetch landing, and the button goes quiet on its own once the two agree.
  const [draft, setDraft] = useState<StoredPrefs | null>(null);
  const stored: StoredPrefs = { ...NO_PREFS, ...(data.scanlator_prefs ?? {}) };
  const cur = draft ?? stored;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(stored);
  const set = (patch: Partial<StoredPrefs>) => setDraft({ ...cur, ...patch });
  const { status, run } = useAutosave();
  // Every group name the server has seen, on disk or in a source's listing, busiest first. Memoised on the
  // server for 30 s and held here for the same, so typing into either box never asks again. A failure
  // renders no keys rather than an error: the text field still works without them.
  const { data: known } = useQuery({
    queryKey: ['admin-scanlators'],
    queryFn: () => api<{ content: KnownGroup[] }>('/api/admin/scanlators'),
    staleTime: 30_000,
    retry: false,
    enabled: editor.open,
  });
  const suggestions = known?.content ?? [];
  const value = dirty ? tr('Not saved') : cur.priority.length ? cur.priority.slice(0, 3).join(', ') : tr('None');
  return (
    <>
      <SummaryRow id="scanlators" ref={editor.row} label={tr('Scanlation groups')} onClick={editor.show} value={value} />
      <EditorSheet title={tr('Scanlation groups')} open={editor.open} onClose={editor.close}
        footer={(
          <div className="flex items-center justify-end gap-3 pb-1">
            <SaveState status={status} />
            <button type="button"
              onClick={() => { void run(() => save({ scanlatorPrefs: { priority: cur.priority, blocked: cur.blocked, patienceDays: cur.patienceDays } })); }}
              disabled={!dirty} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">{tr('Save scanlator defaults')}</button>
          </div>
        )}>
        <p className="max-w-prose py-3 text-[12px] leading-relaxed text-fog-400 first:pt-1">
          {tr('When a source lists the same chapter from more than one group, the updater takes the first group ranked here and never a blocked one. Each series can rank its own on its page; blocks made here apply to every series.')}
        </p>
        <div id="blocked-groups">
          <GroupChips label={tr('Blocked groups')} value={cur.blocked} suggestions={suggestions} onChange={(blocked) => set({ blocked, priority: blocked.reduce((p, g) => withoutGroup(p, g), cur.priority) })}
            hint={tr('Never take a release from these groups, in any series. A chapter only they have released is skipped until someone else releases it.')} />
        </div>
        <div id="group-priority">
          <GroupChips label={tr('Default priority')} ordered value={cur.priority} suggestions={suggestions} onChange={(priority) => set({ priority, blocked: priority.reduce((b, g) => withoutGroup(b, g), cur.blocked) })}
            hint={tr('Tried in this order. A series with its own ranking ignores this list.')} />
        </div>
        <div id="patience" className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-fog-100" htmlFor="scanlator-patience">{tr('Patience (days)')}</label>
            <input id="scanlator-patience" type="number" min={0} max={30} step={1} inputMode="numeric" placeholder="2"
              value={cur.patienceDays ?? ''}
              onChange={(e) => set({ patienceDays: e.target.value === '' ? null : Math.max(0, Math.min(30, Math.floor(Number(e.target.value)))) })}
              className="field ms-auto w-24" />
          </div>
          <p className="mt-1 max-w-prose text-[11px] text-fog-500">
            {tr('How long a new chapter waits for a ranked group before the best available copy is fetched instead. 0 takes the best copy at once; blank means 2.')}
          </p>
        </div>
        {/* Group upgrades (#81): the nightly repair's sixth step. Off by default, because it replaces files on
            disk; the help says every rule it keeps, so switching it on is not a leap in the dark. Saved on its own,
            like every switch: it is not part of the lists' one write. */}
        <SwitchRow id="group-upgrade" label={tr('Upgrade chapters to a preferred group')}
          help={tr('Off by default. Once a night, a chapter you already have from another group is replaced when a group you rank higher releases it on a source the series follows — only files Uchiyomi downloaded itself, never with a copy that has fewer pages, never a chapter someone picked a version for by hand, and at most ten a night unless the server is told otherwise. Reading progress is kept.')}
          on={data.group_upgrade === true} onChange={(next) => save({ groupUpgrade: next })} />
      </EditorSheet>
    </>
  );
}
