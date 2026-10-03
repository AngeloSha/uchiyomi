'use client';
// Health → Source health, decluttered (v0.53.0).
//
// The owner: "can u do the same for the extension section in health cause it feels like there is a million extention
// that i need to fix but it loks complicated". The card was one list of forty-six rows: the glossary of its four keys
// and a paragraph first, then thirty-one sources he had switched off on purpose, each with a Test key, then five
// failing ones nothing uses, and at its very end the handful his library depends on.
//
// Now the series' sources come first, the most series first, each row ONE line with ONE key (Clear block for a
// source in a cooldown, Test otherwise) and a ⋯ with the rest; under them the failing ones nothing uses, with Turn off
// all; then two folds, closed -- what was switched off, and what is listed for reference -- and at the foot the card's
// note and the keys' glossary, each behind a link. A row is HealthRow in its compact form (HealthActions.tsx): its
// keys, states, runs and confirmations are the ones every other card's rows have. The groups, their order and what
// each row says come from the server (bff lib/health.ts sourceTrouble); lib/sourceHealth.ts words them.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { HealthCardActions, HealthRow, disableSource } from '@/components/HealthActions';
import { ActionStatus } from '@/components/ActionList';
import { SourceEvidence } from '@/components/SourceEvidence';
import { useToast } from '@/components/Toast';
import { IcChevronRight } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { useReduceEffects } from '@/lib/effects';
import { IDLE, isBusy, type ActionState } from '@/lib/actionState';
import { useRepairRun } from '@/lib/useRepairRun';
import { keysFor } from '@/lib/healthKeys';
import { checkNote, itemDetail, itemTitle } from '@/lib/said';
import { healthRowEvidence } from '@/lib/sourceEvidence';
import { sourceIcon } from '@/lib/sourceGroups';
import { TONE_SURFACE, type Tone } from '@/lib/status';
import {
  FINDING_GROUPS, bulkTargets, groupOf, primaryOf, seriesText, stateReason, stateWord, tileLetters, tileTone,
  turnOffAllLabel, turnOffEach, turnOffOutcome, turnOffQuestion,
} from '@/lib/sourceHealth';
import type { HealthCheck, HealthItem, SourceGroup } from '@/lib/types';

/** The card's body: two groups open, two folded, and the note and the glossary at its foot. */
export function SourceHealthBody({ check }: { check: HealthCheck }) {
  const keys = keysFor(check.id, check.items);
  const rows = check.items.map((it, i) => ({ it, key: keys[i] }));
  const of = (g: SourceGroup) => rows.filter((r) => groupOf(r.it) === g);
  const affected = of('affected');
  const unused = of('unused');
  const off = of('off');
  const quiet = of('quiet');
  const bulk = useTurnOffAll(unused.map((r) => r.it));
  const draw = (r: { it: HealthItem; key: string }) => <SourceRow key={r.key} check={check} it={r.it} rowKey={r.key} />;
  return (
    <div data-source-health>
      {affected.length > 0 && <Group id="affected" title={tr('Used by your series')} n={affected.length}>{affected.map(draw)}</Group>}
      {unused.length > 0 && (
        <Group id="unused" title={tr('Failing, used by no series')} n={unused.length} action={bulk.key} notice={bulk.panel}>
          {unused.map(draw)}
        </Group>
      )}
      {off.length > 0 && (
        <Fold id="off" title={tr('Switched off by you')} n={off.length}>
          {off.map(draw)}
          {/* Where each comes back on: Providers for a source turned off there, Admin → Extensions for an extension's
              source switched off or hidden with its language. Plain links, a whole page load: the console reads its
              tab from the address once, so a client-side link to another of its tabs would leave Health on screen. */}
          <p className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2.5 text-xs">
            {off.some((r) => !r.it.offBy || r.it.offBy === 'admin') && (
              <a href="/admin/?tab=Providers" data-source-turn-on="providers" className="text-accent hover:underline">{tr('Turn sources on in Providers')}{'\u00a0'}›</a>
            )}
            {off.some((r) => r.it.offBy === 'extension' || r.it.offBy === 'language') && (
              <a href="/admin/?tab=Extensions" data-source-turn-on="extensions" className="text-accent hover:underline">{tr('Turn sources on in Extensions')}{'\u00a0'}›</a>
            )}
          </p>
        </Fold>
      )}
      {quiet.length > 0 && <Fold id="quiet" title={tr('Nothing to fix right now')} n={quiet.length}>{quiet.map(draw)}</Fold>}
      <Foot check={check} />
    </div>
  );
}

/** A group that is shown open: its name and count, a key of its own, and its rows. */
function Group({ id, title, n, action, notice, children }: {
  id: SourceGroup;
  title: string;
  n: number;
  action?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-source-group={id} aria-label={title} className="border-t border-ink-800/70 first:border-t-0">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-2.5">
        {/* Spaced capitals in the scripts that have them; letter-spacing breaks Arabic's joined letters apart. */}
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fog-500 rtl:tracking-normal">
          {title}<span className="ms-2 tabular-nums text-fog-400">{n}</span>
        </h3>
        {action}
      </div>
      {notice}
      <div className="divide-y divide-ink-800/70">{children}</div>
    </section>
  );
}

/** A group folded into one line, closed until opened. */
function Fold({ id, title, n, children }: { id: SourceGroup; title: string; n: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const plain = useReduceEffects();
  const cid = `health-sources-${id}`;
  return (
    <section data-source-fold={id} className="border-t border-ink-800/70">
      <button type="button" aria-expanded={open} aria-controls={cid} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-start text-sm text-fog-300 hover:text-fog-100">
        <span className="min-w-0 flex-1">{title}<span className="ms-2 tabular-nums text-fog-500">{n}</span></span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-fog-500">
          {open ? tr('Hide') : tr('Show')}
          {/* Mirrored on the outer span and turned on the inner one (ActionList.tsx): both on one pointed it up in Arabic. */}
          <span aria-hidden className="inline-grid rtl:-scale-x-100">
            <IcChevronRight width={14} height={14} className={`${plain ? '' : 'transition'} ${open ? 'rotate-90' : ''}`} />
          </span>
        </span>
      </button>
      {open && <div id={cid} className="divide-y divide-ink-800/70 border-t border-ink-800/40">{children}</div>}
    </section>
  );
}

/**
 * One source: its tile, its name, ONE line -- the state in a word, why, and how many series use it -- one key and a
 * ⋯ (HealthRow's compact form), and Details: the server's whole sentence, the stage lines and the fix. A switched-off
 * row has no Details: its sentence says only that it is off, which its line already does.
 */
function SourceRow({ check, it, rowKey }: { check: HealthCheck; it: HealthItem; rowKey: string }) {
  const name = itemTitle(it);
  const word = stateWord(it);
  const reason = stateReason(it);
  const series = seriesText(it.series);
  const finding = FINDING_GROUPS.includes(groupOf(it));
  return (
    <HealthRow check={check} item={it} rowKey={rowKey}
      compact={{
        lead: <SourceTile it={it} name={name} />,
        primary: primaryOf(it),
        name,
        hooks: { 'data-source-row': it.sourceId ?? rowKey, 'data-source-state': it.state ?? '' },
        line: (
          <p data-source-line className="mt-0.5 text-[11px] leading-snug text-fog-500">
            {word === null ? (
              // A server older than v0.53.0 sends no state: its own sentence, as the card showed it before.
              <span dir="auto">{itemDetail(it)}</span>
            ) : (
              <>
                <span className={finding ? 'font-medium text-amber-300' : 'text-fog-400'}>{word}</span>
                {reason && <> — {reason}</>}
                {series && <> · {series}</>}
                {it.ignored && <> · {tr('Ignored')}</>}
              </>
            )}
          </p>
        ),
        details: groupOf(it) === 'off' ? undefined : (
          <div data-source-details className="mt-1">
            {/* The server's words, in the reader's language where it sent their codes; a source's name or a site's own
                error inside them is in any script (`dir="auto"`). */}
            <p dir="auto" data-health-detail className="text-[11px] leading-relaxed text-fog-400">{itemDetail(it)}</p>
            <SourceEvidence {...healthRowEvidence(it)} />
          </div>
        ),
      }}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span dir="auto" data-source-name className="min-w-0 break-words text-sm text-fog-100">{name}</span>
        {it.sourceId?.startsWith('sw:') && (
          <span className="shrink-0 rounded-[4px] bg-ink-800 px-1.5 text-[10px] font-semibold leading-4 text-fog-400">{tr('Extension')}</span>
        )}
      </p>
    </HealthRow>
  );
}

/** The ring an extension's logo wears in its row's tone. Written out: Tailwind compiles only what it finds. */
const TILE_RING: Record<Tone, string> = {
  ok: 'ring-emerald-500/40', warn: 'ring-amber-400/50', problem: 'ring-red-400/50', info: 'ring-ink-600', off: 'ring-ink-700', accent: 'ring-accent/40',
};

/** The source's initials on its state's tint, or its extension's logo when it has one. */
function SourceTile({ it, name }: { it: HealthItem; name: string }) {
  const [failed, setFailed] = useState(false);
  const tone = tileTone(it);
  const calm = tone === 'off' || tone === 'info';
  if (it.icon && it.sourceId && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={sourceIcon(it.sourceId)} alt="" aria-hidden width={32} height={32} loading="lazy" decoding="async"
      onError={() => setFailed(true)}
      className={`h-8 w-8 shrink-0 rounded-lg bg-ink-700 object-cover ring-1 ${TILE_RING[tone]} ${calm ? 'opacity-60' : ''}`} />;
  }
  return (
    <span aria-hidden data-source-tile={tone}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border text-[11px] font-semibold ${TONE_SURFACE[tone]}`}>
      {tileLetters(name)}
    </span>
  );
}

/**
 * Turn off all, for the failing sources nothing uses: a key in the group's head, which asks first -- inline, under the
 * head -- and then runs each row's own Turn off in turn (lib/sourceHealth.ts turnOffEach), with its progress on a
 * status line and one notice at the end. Health is then asked again, and the rows move to Switched off.
 */
function useTurnOffAll(items: HealthItem[]): { key: ReactNode; panel: ReactNode } {
  const toast = useToast();
  const rr = useRepairRun();
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState<ActionState>(IDLE);
  const targets = bulkTargets(items);
  const n = targets.length;
  const busy = isBusy(state);

  const run = async () => {
    setAsking(false);
    const at = Date.now();
    setState({ kind: 'starting' });
    const { off, failed } = await turnOffEach(targets.map((t) => t.sourceId!), disableSource, (done, total) => setState(done < total
      ? { kind: 'working', startedAt: at, step: tr('Turning off {done} of {total}…', { done: done + 1, total }), progress: done / total }
      : { kind: 'working', startedAt: at, step: tr('Checking the result…'), progress: 1 }));
    const line = turnOffOutcome(off.length, failed.length);
    toast(line, failed.length ? (off.length ? 'info' : 'error') : 'success');
    await rr.recheck().catch(() => {});
    setState(!off.length && failed.length
      ? { kind: 'failed', finishedAt: Date.now(), reason: line }
      : { kind: 'done', finishedAt: Date.now(), tookMs: Date.now() - at, outcome: line, ...(failed.length ? { partial: true } : {}) });
  };
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setAsking(false); } };

  return {
    key: n > 0 ? (
      <button type="button" data-source-bulk-off aria-expanded={asking} disabled={busy} onClick={() => setAsking(!asking)} className="btn-key">
        {turnOffAllLabel(n)}
      </button>
    ) : null,
    panel: (
      <>
        {asking && n > 0 && (
          <div data-source-bulk-confirm role="group" aria-label={turnOffAllLabel(n)} onKeyDown={escape}
            className="mx-4 mb-1 mt-2 rounded-xl border border-ink-700 bg-ink-900/70 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-fog-200">{turnOffQuestion(n)}</p>
            <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
              {/* Cancel takes the focus: Enter pressed twice on the head's key must not switch anything off. */}
              <button type="button" autoFocus data-source-bulk-cancel onClick={() => setAsking(false)} className="btn-key">{tr('Cancel')}</button>
              <button type="button" data-source-bulk-go onClick={() => { void run(); }} className="btn-key btn-key-danger">{turnOffAllLabel(n)}</button>
            </div>
          </div>
        )}
        <div data-source-bulk-status>
          <ActionStatus state={state} className="px-4" />
        </div>
      </>
    ),
  };
}

/**
 * The card's foot: how a source counts as failing (the card's note) and what the buttons do (the keys' glossary,
 * HealthCardActions), each behind a link and one at a time -- where the glossary used to stand above the list.
 */
function Foot({ check }: { check: HealthCheck }) {
  const [open, setOpen] = useState<'note' | 'legend' | null>(null);
  const plain = useReduceEffects();
  const legend = check.items.some((it) => (it.actions ?? []).some((a) => a !== 'solver_reset'));
  if (!check.note && !legend) return null;
  const link = (id: 'note' | 'legend', label: string) => (
    <button type="button" data-source-foot={id} aria-expanded={open === id} aria-controls={`health-sources-${id}`}
      onClick={() => setOpen(open === id ? null : id)} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
      {label}
      <span aria-hidden className="inline-grid rtl:-scale-x-100">
        <IcChevronRight width={12} height={12} className={`${plain ? '' : 'transition'} ${open === id ? 'rotate-90' : ''}`} />
      </span>
    </button>
  );
  return (
    <div className="border-t border-ink-800/70">
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-4 py-3">
        {check.note && link('note', tr('How a source counts as failing'))}
        {legend && link('legend', tr('What the buttons do'))}
      </div>
      {open === 'note' && check.note && (
        <p id="health-sources-note" data-health-note dir="auto" className="px-4 pb-3 text-[11px] leading-relaxed text-fog-500">{checkNote(check)}</p>
      )}
      {open === 'legend' && (
        <div id="health-sources-legend">
          <HealthCardActions check={check} className="px-4 pb-1" />
        </div>
      )}
    </div>
  );
}
