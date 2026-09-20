'use client';
// Admin → Settings: four sections on the settings grid, every row saving on its own.
//
// Until v0.39.0 this tab was a `.board` of cards of every shape with three save idioms side by side: three
// full-width "Save name" / "Save interval" buttons, switches that saved on their own with a toast, a tiny
// "Save" chip under the cleanup days, and one dirty-tracked button for the scanlator lists -- eleven cards
// with no order to them. It is now Server · Updates & schedules · Library housekeeping · Scanlators, in
// that DOM order (Server first: `test/e2e/run.mjs` reads the first 4000 characters of body text for the
// install-count payload), composed from `components/settings.tsx` so a field saves when you leave it and
// says "Saved" in one place. The only Save button left is the scanlators' one, because those are lists
// that are edited in several steps and must land as one write.
//
// Toasts survive on exactly two rows, and only for the sentence the inline tick cannot say: the install count
// ("Thank you — counted" / "No longer counted", because opting out destroys the identifier) and the
// read-chapter cleanup ("Read chapters will be deleted" / "Read chapters are kept", because it deletes
// files). Every other row's outcome is its own state plus the tick.
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Switch } from '@/components/Switch';
import { IcFilter, IcRefresh, IcSettings, IcTrash } from '@/components/icons';
import { Disclosure, NumberRow, Row, SETTINGS_GRID, SaveState, Section, SwitchRow, TextRow, useAutosave } from '@/components/settings';
import { t as tr } from '@/lib/i18n';
import type { KnownGroup, StoredPrefs } from '@/lib/types';
import { hasGroup, normGroup, reorder, withoutGroup } from '@/lib/scanlators';
import { suggestGroups } from '@/lib/groupSuggest';

/** One PATCH. Resolves once the server has answered, so the row that called it can show its tick. */
type Save = (body: Record<string, unknown>) => Promise<unknown>;

export function AdminSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<any>('/api/admin/settings') });
  // Returns the PATCH's promise rather than swallowing it: a row awaits it to show Saved ✓ or the server's
  // own sentence, which is why nothing here catches. The refetch is started, not awaited -- the tick should
  // answer the save, not the round trip after it.
  const save: Save = async (body) => {
    await api('/api/admin/settings', { method: 'PATCH', json: body });
    void qc.invalidateQueries({ queryKey: ['admin-settings'] });
  };
  if (!data) {
    return (
      <div className={SETTINGS_GRID}>
        <div className="card grad-border p-6 text-center text-sm text-fog-500">{tr('Loading…')}</div>
      </div>
    );
  }
  return (
    <div className={SETTINGS_GRID}>
      <ServerSection data={data} save={save} />
      <SchedulesSection data={data} save={save} />
      <HousekeepingSection data={data} save={save} />
      <ScanlatorsSection data={data} save={save} />
    </div>
  );
}

/**
 * A switch row with a disclosure under it, as ONE divider group.
 *
 * `SwitchRow`'s help is rendered inside a `<p>`, and a `Disclosure` holds a `<div>` (and here a `<pre>` and a
 * `<ul>`), which cannot sit in a paragraph: the browser would close the `<p>` early while parsing and React
 * would then report a hydration mismatch, which run.mjs counts as a console error. So the disclosure is a
 * sibling of the row, and the two are wrapped so the section's `divide-y` draws one line under the pair
 * rather than one between them. The wrapper takes over the row's vertical padding (`py-0!` on the Row) so
 * the pair keeps the same rhythm as its neighbours.
 *
 * The switch is optimistic the way `SwitchRow` is -- it moves at once and reverts if the save fails -- and
 * it is not disabled while saving, so a keyboard user keeps their place.
 */
function SwitchWithMore({ label, help, on, onChange, more }: {
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
    <div className="py-3 first:pt-1 last:pb-0">
      <Row label={label} help={help} status={status} className="py-0!">
        <Switch on={local} onChange={(next) => { void flip(next); }} label={label} />
      </Row>
      {more}
    </div>
  );
}

/**
 * Server: the name, who may join, and the two network promises.
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
  // Fetched whether or not it is on: seeing exactly what WOULD be sent is the point of the preview, and
  // asking someone to consent first in order to find out would be backwards.
  const { data: preview } = useQuery({
    queryKey: ['install-ping-preview'],
    queryFn: () => api<{ url: string; payload: Record<string, unknown>; sample: boolean }>('/api/admin/install-ping/preview'),
    staleTime: 60_000,
  });

  return (
    <Section title={tr('Server')} icon={<IcSettings width={18} height={18} />}>
      {/* `required`: the server refuses an empty name (zod min(1)) with a bare 400, so an emptied box goes
          back to the saved name on blur instead of a "Could not save" over nothing. */}
      <TextRow label={tr('Server name')} value={data.server_name ?? ''} maxLength={64} autoComplete="off" required
        onSave={(v) => save({ serverName: v })} />
      <SwitchRow label={tr('Open registration')} help={tr('Let anyone create their own account')}
        on={!!data.allow_registration} onChange={(next) => save({ allowRegistration: next })} />
      <SwitchWithMore label={tr('Check for updates')} help={tr('Asks GitHub once a day; nothing about this server is sent.')}
        on={data.update_check !== false} onChange={(next) => save({ updateCheck: next })}
        more={(
          <Disclosure label={tr('How this works')}>
            <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">
              {tr('Ask GitHub once a day whether a newer Uchiyomi has been released, and show it under Health. Nothing about this server is sent — it is the same public page you could open yourself.')}
            </p>
          </Disclosure>
        )} />
      <SwitchWithMore label={tr('Count this server in the anonymous install count')}
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
        )} />
    </Section>
  );
}

/**
 * Updates & schedules: when the background jobs run.
 *
 * The backup hour was shown under Tasks and editable nowhere until v0.39.0; the server re-arms its timer
 * the moment it is saved, so the change applies to tonight's run rather than tomorrow's. The extension rows
 * appear only when there is an extension engine. `extension_hours` cannot answer that -- it has a NOT NULL
 * default, so it is always set -- which is why the endpoint returns a separate flag.
 */
function SchedulesSection({ data, save }: { data: any; save: Save }) {
  return (
    <Section title={tr('Updates & schedules')} icon={<IcRefresh width={18} height={18} />}>
      <NumberRow label={tr('Library update interval (hours)')} min={1} max={168} value={data.updater_hours ?? 6}
        help={tr('How often every followed series is asked for new chapters.')}
        onSave={(n) => save({ updaterHours: n })} />
      <NumberRow label={tr('Backup time (hour, 0–23)')} min={0} max={23} value={data.backup_hour ?? 3}
        help={tr('Nightly, local time. Shown under Tasks.')}
        onSave={(n) => save({ backupHour: n })} />
      {data.extensions_configured && (
        <>
          <SwitchRow label={tr('Update extensions automatically')}
            help={tr('Install new versions of your installed extensions as their repositories publish them. Turn this off to be told about updates and apply them yourself.')}
            on={data.extension_auto_update !== false} onChange={(next) => save({ extensionAutoUpdate: next })} />
          <NumberRow label={tr('Extension check interval (hours)')} min={1} max={168} value={data.extension_hours ?? 6}
            onSave={(n) => save({ extensionHours: n })} />
        </>
      )}
    </Section>
  );
}

/**
 * Library housekeeping: the opt-in read-chapter cleanup.
 *
 * ⚠️ THE ONLY SWITCH ON THIS TAB THAT DELETES FILES, so it is the only one that does not simply toggle.
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
      <Section title={tr('Library housekeeping')} icon={<IcTrash width={18} height={18} />}>
        <Row label={tr('Delete read chapters')} status={status}
          help={tr('Free space by deleting a chapter’s file once everyone who started it has finished it. A chapter someone is partway through is never deleted, and neither is one nobody has read.')}>
          {/* Not a SwitchRow: that one flips at once, and this switch must stay off until the question is
              answered. `on` is the stored value, so cancelling the dialog leaves it exactly where it was. */}
          <Switch on={on} label={tr('Delete read chapters')}
            onChange={(next) => { if (next) setConfirm(true); else save({ cleanupRead: false }, tr('Read chapters are kept')); }} />
        </Row>
        {/* The row and its two notes as one divider group. The Row inside is a first child, so its own
            `first:pt-1` applies; the wrapper's `pt-2` makes up the difference to a plain row's `py-3`. */}
        <div className="pt-2">
          <NumberRow label={tr('Wait (days)')} min={0} max={3650} value={stored} help={dueLine}
            onSave={async (n) => {
              setDays(n);
              try { await patch({ cleanupReadDays: n }); } catch (e) { setDays(null); throw e; }
            }} />
          {/* fog-400 for the line that says what the number means, fog-500 for the one that says what is
              spared: fog-600 measures 2.6:1 on the card, under AA for text, and these two are read, not
              glanced at. fog-600 is for decorative counts only. */}
          <p className="max-w-prose text-[11px] leading-relaxed text-fog-400">
            {cur === 0
              ? tr('0 — the chapter goes at the next hourly run after the last reader finishes it.')
              : tr('Counted from the moment the last reader finished. Re-opening the chapter starts the wait again.')}
          </p>
          <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-fog-500">
            {tr('Only chapters Uchiyomi downloaded itself are removed — nothing in a library you built by hand is touched. The chapter stays listed and everyone keeps their reading history; the pages are what goes. It is not downloaded again by itself; Fetch again on the series page brings it back.')}
          </p>
        </div>
        {/* The reveal for the cleanup above, and for a followed series nobody has fetched: without it Mihon
            counted a pruned or never-downloaded chapter as zero chapters, and told the trackers so. No
            confirmation — nothing here is deleted or written, and turning it off is exactly as reversible
            as turning it on. */}
        <SwitchRow label={tr('Show missing chapters in Mihon')} on={!!data.komga_ghost_chapters}
          help={tr('List the chapters this server has not downloaded, and those whose files were deleted, alongside the ones it holds — so Mihon and your trackers count the whole series rather than only what is on disk. These rows cannot be opened; they are marked “not downloaded”. Only the Mihon extension sees them.')}
          onChange={(next) => patch({ komgaGhostChapters: next })} />
      </Section>
      {confirm && (
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
      )}
    </>
  );
}

const NO_PREFS: StoredPrefs = { priority: [], blocked: [], patienceDays: 2 };

/**
 * A row of group names as chips, with a box to add one. `ordered` adds the arrows that make the row a ranking.
 * Names are compared the way the server compares them, so typing "asura-scans" next to "Asura Scans" is a
 * no-op rather than a second chip the server would fold into the first on save.
 */
function GroupChips({ label, hint, value, ordered, onChange, suggestions }: {
  label: string; hint: string; value: string[]; ordered?: boolean; onChange: (next: string[]) => void;
  /** Every group the server has seen, for the chips under the box. Absent or empty renders no chips. */
  suggestions?: KnownGroup[];
}) {
  const [draft, setDraft] = useState('');
  const toast = useToast();
  const add = (raw: string) => {
    const t = raw.trim().replace(/,$/, '').trim();
    setDraft('');
    if (!t || hasGroup(value, t)) return;
    // The server refuses both of these; refusing them here says why instead of a chip that never lands.
    if (t.length > 80) { toast(tr('A group name is at most 80 characters'), 'error'); return; }
    if (!normGroup(t)) { toast(tr('A group name needs at least one letter or digit'), 'error'); return; }
    onChange([...value, t]);
  };
  return (
    // ⚠️ The draft is committed when focus leaves the WHOLE control, not the input. The input's own blur
    // fired when Tab moved focus to a suggestion chip (they are plain buttons, keyboard-reachable on
    // purpose), so the half-typed draft landed as a chip beside the one then chosen -- "asu" next to
    // "Asura Scans", and a save blocked a group that matches nothing. Focus moving within the control
    // (input -> chip, chip -> chip) commits nothing; leaving it from anywhere commits the draft, so a
    // keyboard user who tabs straight past the chips still gets their text as a chip, as before.
    // Reintroduce by moving the onBlur back onto the input: type "asu", Tab, Enter gives two chips.
    <div className="mt-3" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) add(draft); }}>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-fog-500">{label}</p>
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-ink-700 bg-ink-850 p-2">
        {value.map((g, i) => (
          <span key={g} className="inline-flex items-center gap-1 rounded-full bg-ink-800 px-2.5 py-1 text-xs text-fog-200">
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
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Known groups')}</p>
            {offered.length ? (
              <div className="flex flex-wrap gap-1.5">
                {offered.map((g) => (
                  // ⚠️ preventDefault on mousedown, not click: a click first moves focus off the input, whose
                  // onBlur adds the half-typed draft as a chip, and the suggestion would then land as a
                  // second chip beside a wrong one.
                  <button key={g.name} type="button" data-suggest onMouseDown={(e) => e.preventDefault()} onClick={() => add(g.name)}
                    className="chip text-xs">
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
 * Scanlators: the defaults every series starts from. A series can rank its own groups and block more, but it
 * cannot un-block one that is blocked here: the server takes the union, so this list is the one place a
 * group is refused everywhere at once.
 *
 * The one explicit Save on the tab. Two lists and a number are edited in several steps and have to land as
 * ONE write -- a block that saved on its own while the ranking was still half-typed would apply a preference
 * nobody had finished expressing.
 */
function ScanlatorsSection({ data, save }: { data: any; save: Save }) {
  // `null` until the admin touches something, so the section shows what is stored until then. The draft is
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
  // renders no chips rather than an error: the text field still works without them.
  const { data: known } = useQuery({
    queryKey: ['admin-scanlators'],
    queryFn: () => api<{ content: KnownGroup[] }>('/api/admin/scanlators'),
    staleTime: 30_000,
    retry: false,
  });
  const suggestions = known?.content ?? [];
  return (
    <Section title={tr('Scanlators')} icon={<IcFilter width={18} height={18} />}
      description={tr('When a source lists the same chapter from more than one group, the updater takes the first group ranked here and never a blocked one. Each series can rank its own on its page; blocks made here apply to every series.')}>
      {/* One child, so the section's divide-y draws no line between the two lists. */}
      <div>
        <GroupChips label={tr('Blocked groups')} value={cur.blocked} suggestions={suggestions} onChange={(blocked) => set({ blocked, priority: blocked.reduce((p, g) => withoutGroup(p, g), cur.priority) })}
          hint={tr('Never take a release from these groups, in any series. A chapter only they have released is skipped until someone else releases it.')} />
        <GroupChips label={tr('Default priority')} ordered value={cur.priority} suggestions={suggestions} onChange={(priority) => set({ priority, blocked: priority.reduce((b, g) => withoutGroup(b, g), cur.blocked) })}
          hint={tr('Tried in this order. A series with its own ranking ignores this list.')} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-fog-500" htmlFor="scanlator-patience">{tr('Patience (days)')}</label>
          <input id="scanlator-patience" type="number" min={0} max={30} step={1} inputMode="numeric" placeholder="2"
            value={cur.patienceDays ?? ''}
            onChange={(e) => set({ patienceDays: e.target.value === '' ? null : Math.max(0, Math.min(30, Math.floor(Number(e.target.value)))) })}
            className="field w-24" />
        </div>
        <p className="mt-1 max-w-prose text-[11px] text-fog-500">
          {tr('How long a new chapter waits for a ranked group before the best available copy is fetched instead. 0 takes the best copy at once; blank means 2.')}
        </p>
        <div className="mt-3 flex items-center justify-end gap-3">
          <SaveState status={status} />
          <button type="button"
            onClick={() => { void run(() => save({ scanlatorPrefs: { priority: cur.priority, blocked: cur.blocked, patienceDays: cur.patienceDays } })); }}
            disabled={!dirty} className="btn-accent px-4 py-2 text-sm disabled:opacity-50">{tr('Save scanlator defaults')}</button>
        </div>
      </div>
    </Section>
  );
}
