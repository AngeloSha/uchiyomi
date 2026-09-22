'use client';
// The one-click half of Admin -> Health (v0.41.0).
//
// Health has always been able to name a problem and never to do anything about it: "Suspiciously short
// chapters 14", "Chapter gaps 40", "Chapters that would not download 183" with an Open link beside each,
// and every remedy somewhere else in the console. The nightly repair now does everything that is
// reversible or provable on its own; these chips are the same work asked for by hand, on ONE row, plus
// the two things the nightly deliberately never does -- merging duplicates and deleting a chapter whose
// number is impossible -- which stay a human's decision behind a confirmation.
//
// ⚠️ Nothing here is its own remediation route. Every chip posts to a route that already existed (or to
// the repair with `only` narrowed to one step and one id), so the rules that protect data -- a bookmarked
// chapter is never deleted, a merge is one-way and carries progress, a repair refuses to run beside a
// chapter sweep -- live in one place and apply however the work was started.
//
// The chips live here rather than in app/admin/page.tsx because that file is already 2,200 lines and the
// branching is real: ten actions, three confirmations and a diagnosis panel.
import { useState } from 'react';
import { api } from '@/lib/api';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { t as tr } from '@/lib/i18n';
import type { HealthAction, HealthCheck, HealthItem, RepairStep } from '@/lib/types';

type Toast = (msg: string, type?: 'info' | 'success' | 'error') => void;
interface RepairBody { only: RepairStep[]; seriesId?: string; bookId?: string; sourceId?: string }

/**
 * Ask the repair to run one step, for one thing.
 *
 * ⚠️ A refusal is a 200 with `ok: false`, exactly as the Tasks panel's Run now is, and the two refusals
 * mean opposite things to the person reading them: `sweep_running` is "come back in a few minutes" (the
 * repair and the chapter sweep never overlap, by design) while `busy` is "it is already doing this". A
 * shared "Failed" for both sent an admin looking for a broken button in the first case.
 */
async function postRepair(body: RepairBody, toast: Toast): Promise<boolean> {
  try {
    const r = await api<{ ok?: boolean; error?: string; started?: boolean }>('/api/admin/tasks/repair/run', { method: 'POST', json: body });
    if (r?.ok === false) {
      toast(r.error === 'sweep_running' ? tr('A chapter sweep is running — try again in a few minutes')
        : r.error === 'busy' ? tr('The repair is already running')
        : tr('Could not start the repair'), 'error');
      return false;
    }
    // Detached, like Verify chapter files: the counts cannot be in this answer, and "Started" followed by
    // nothing changing is what #34 reported as "the run now buttons don't work". Say where to look.
    toast(tr('Started — the Tasks line shows what it did'), 'success');
    return true;
  } catch (e) {
    toast(msgOf(e, tr('Could not start the repair')), 'error');
    return false;
  }
}

/** One action. Disabled while its own request is in flight, never while a sibling's is. */
function Chip({ action, label, busy, danger, onClick }: {
  action: string; label: string; busy: boolean; danger?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-health-action={action}
      onClick={onClick}
      disabled={busy}
      className={`chip shrink-0 text-xs disabled:opacity-50 ${danger ? 'hover:border-red-400/50 hover:text-red-300' : 'hover:border-accent/50 hover:text-accent'}`}
    >
      {label}
    </button>
  );
}

/** Which of the pair the merge keeps: the server's suggestion, or the first id when it did not send one. */
const keptIndex = (it: HealthItem): number => {
  const i = it.keep ? (it.seriesIds || []).indexOf(it.keep) : -1;
  return i < 0 ? 0 : i;
};

/**
 * The chips for one Health item, driven entirely by `item.actions`.
 *
 * Returns a FRAGMENT, not a box: the caller's row is a `flex-wrap` container, so the chips sit beside the
 * title on a laptop and wrap under it at 390 px, and the Test chip's diagnosis takes a full line of its
 * own (`basis-full`) because a fix is a sentence, not a label.
 */
export function HealthActions({ check, item, onDone }: { check: string; item: HealthItem; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<HealthAction | null>(null);
  const [asking, setAsking] = useState<'delete' | 'disable' | 'merge' | null>(null);
  // Which copy of a duplicate pair survives. Seeded from the server's suggestion (more live chapters, more
  // readers, older row) so the common case is one tap, and still a choice.
  const [keepFirst, setKeepFirst] = useState(() => keptIndex(item) === 0);
  // ONE sentence with the title inside it, split around the placeholder so the title can carry its own
  // colour -- the idiom ConfirmDialog.tsx:105-111 already documents. The bare verb key + the title rendered
  // "KeepSolo Leveling" in English and "الإبقاء علىSolo Leveling" in Arabic (الإبقاء على is the fragment
  // "keeping of"), in the one confirmation that decides which copy of a duplicate survives a one-way
  // merge; a bare verb also cannot be reordered, and German and Japanese want the title first.
  const [keepBefore, keepAfter] = tr('Keep {title}').split('{title}');
  // What the last Test said to do about this source. Held here rather than refetched: the diagnosis is a
  // live verdict about a site, and the stored `last_error` behind the item's detail line can be months
  // older than the running container.
  const [fix, setFix] = useState<string | null>(null);
  const actions = item.actions || [];
  if (!actions.length) return null;

  // Every chip ends the same way: the row's request, one toast, then Health is asked again -- a chip that
  // leaves a fixed item on screen reads as a chip that did nothing. The refetch runs even after a failure,
  // because the failure may itself be the item having already been dealt with elsewhere.
  const act = (a: HealthAction, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(a);
    void (async () => {
      try { await run(); } finally { setBusy(null); onDone(); }
    })();
  };

  const bookIds = item.bookIds?.length ? item.bookIds : item.bookId ? [item.bookId] : [];
  // A chapter the admin has already said is fine is listed as `info` with a `fixed` stamp; its chip is the
  // way back out, or a mistaken "It's fine" would be permanent from this page.
  const confirmed = !!item.fixed || !!item.info;

  const doDelete = async () => {
    try {
      const res = await api<{ applied: number; skipped: { id: string; reason: string }[] }>(
        `/api/admin/series/${encodeURIComponent(item.seriesId || '')}/chapters/delete`,
        { method: 'POST', json: { bookIds } },
      );
      // One line per reason present, and `bookmarked` LEADS. On this page the rows are chapters whose
      // number is impossible, so the only one the admin can act on is the chapter somebody has a bookmark
      // inside: that bookmark points at a page number, and the answer is to ask the reader, not to retry.
      // The rest (`unlink_failed`, `outside_root`, `already_pruned` after a race) share one line, because
      // the fix for all of them is the server log.
      const count = (reason: string) => res.skipped.filter((x) => x.reason === reason).length;
      const bookmarked = count('bookmarked');
      const notOwned = count('not_owned');
      const other = res.skipped.length - bookmarked - notOwned;
      const lines = [
        { n: bookmarked, text: tr('{n} skipped: bookmarked by a reader', { n: bookmarked }) },
        { n: notOwned, text: tr('{n} skipped: not downloaded by Uchiyomi', { n: notOwned }) },
        { n: other, text: tr('{n} could not be deleted', { n: other }) },
      ].filter((l) => l.n > 0);
      // ⚠️ A delete that deleted nothing is not a success: a green "0 deleted" over unchanged rows is what
      // a refused delete used to look like, and the reason is what the admin needs in front of them.
      if (res.applied === 0 && lines.length) {
        const [head, ...rest] = lines;
        toast(head.text, 'error');
        for (const l of rest) toast(l.text, 'info');
      } else {
        toast(tr('{n} deleted', { n: res.applied }), 'success');
        for (const l of lines) toast(l.text, 'info');
      }
    } catch (e) { toast(msgOf(e, tr('Could not delete those')), 'error'); }
    setAsking(null);
  };

  const doMerge = async () => {
    const ids = item.seriesIds || [];
    if (ids.length !== 2) return;
    const keep = keepFirst ? ids[0] : ids[1];
    const gone = keepFirst ? ids[1] : ids[0];
    try {
      const r = await api<{ moved: number }>(`/api/admin/series/${encodeURIComponent(gone)}/merge`, { method: 'POST', json: { into: keep } });
      toast(r.moved === 1 ? tr('Merged — one chapter moved') : tr('Merged — {n} chapters moved', { n: r.moved }), 'success');
    } catch (e) { toast(msgOf(e, tr('Could not merge')), 'error'); }
    setAsking(null);
  };

  const doDisable = async () => {
    try {
      await api(`/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/disable`, { method: 'POST' });
      toast(tr('That source is switched off'), 'success');
    } catch (e) { toast(msgOf(e, tr('Could not switch that source off')), 'error'); }
    setAsking(null);
  };

  const chip = (a: HealthAction) => {
    // Every chip on the row goes quiet while any one of them is in flight, not just the one that was
    // tapped: `act` refuses a second request anyway, so an enabled-looking sibling is a button that does
    // nothing -- and on a short-chapter row the two chips ("Fix", "It's fine") contradict each other.
    const b = !!busy;
    switch (a) {
      case 'fix_short':
        return <Chip key={a} action={a} label={tr('Fix')} busy={b}
          onClick={() => act(a, () => postRepair({ only: ['short'], bookId: item.bookId! }, toast).then(() => {}))} />;
      case 'confirm_short':
        return <Chip key={a} action={a} label={confirmed ? tr('Not fine') : tr('It’s fine')} busy={b}
          onClick={() => act(a, async () => {
            try {
              await api(`/api/admin/books/${encodeURIComponent(item.bookId || '')}/confirm-short`, { method: 'POST', json: { confirmed: !confirmed } });
              toast(confirmed ? tr('Back on the list — the next repair will look for a longer copy') : tr('Marked as fine — the repair will leave it alone'), 'success');
            } catch (e) { toast(msgOf(e, tr('Could not save that')), 'error'); }
          })} />;
      case 'delete':
        return <Chip key={a} action={a} label={bookIds.length === 1 ? tr('Delete chapter') : tr('Delete chapters')} busy={b}
          danger onClick={() => setAsking('delete')} />;
      case 'fill':
        return <Chip key={a} action={a} label={tr('Fill now')} busy={b}
          onClick={() => act(a, () => postRepair({ only: ['gaps'], seriesId: item.seriesId! }, toast).then(() => {}))} />;
      case 'retry':
        return <Chip key={a} action={a} label={tr('Retry now')} busy={b}
          onClick={() => act(a, () => postRepair({ only: ['failures'], sourceId: item.sourceId! }, toast).then(() => {}))} />;
      case 'test':
        return <Chip key={a} action={a} label={tr('Test')} busy={b}
          onClick={() => act(a, async () => {
            try {
              const r = await api<{ ok: boolean; diagnosis?: { reason?: string; fix?: string } }>(
                `/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/test`, { method: 'POST' });
              setFix(r.diagnosis?.fix || r.diagnosis?.reason || null);
              toast(r.ok ? tr('That source is working') : (r.diagnosis?.reason || tr('That source is still failing')), r.ok ? 'success' : 'error');
            } catch (e) { toast(msgOf(e, tr('Could not test that source')), 'error'); }
          })} />;
      case 'unblock':
        return <Chip key={a} action={a} label={tr('Clear block')} busy={b}
          onClick={() => act(a, async () => {
            try {
              await api(`/api/admin/sources/${encodeURIComponent(item.sourceId || '')}/unblock`, { method: 'POST' });
              toast(tr('Block cleared'), 'success');
            } catch (e) { toast(msgOf(e, tr('Could not clear that block')), 'error'); }
          })} />;
      case 'disable':
        return <Chip key={a} action={a} label={tr('Turn off')} busy={b} danger onClick={() => setAsking('disable')} />;
      case 'merge':
        return <Chip key={a} action={a} label={tr('Merge')} busy={b} onClick={() => setAsking('merge')} />;
      case 'solver_reset':
        return <Chip key={a} action={a} label={tr('Reset solver sessions')} busy={b}
          onClick={() => act(a, () => postRepair({ only: ['solver'] }, toast).then(() => {}))} />;
      default:
        return null;
    }
  };

  return (
    <>
      {actions.map(chip)}
      {/* ⚠️ `order-last` as well as `basis-full`: this is a fragment inside the caller's wrap container,
          and a full-width item in the middle of it pushes everything declared after it -- the item's Open
          link -- onto a third line below the diagnosis. Ordered last, the fix is the row's final line
          wherever the caller mounts the chips. */}
      {fix && <p className="order-last basis-full text-[11px] leading-relaxed text-fog-400">{fix}</p>}

      {asking === 'delete' && (
        <ConfirmDialog
          title={bookIds.length === 1 ? tr('Delete this chapter’s file?') : tr('Delete these chapters’ files?')}
          confirmLabel={bookIds.length === 1 ? tr('Delete chapter') : tr('Delete chapters')}
          danger
          busy={busy === 'delete'}
          body={
            <>
              <p>
                {check === 'outliers'
                  ? tr('A chapter whose number cannot be right is almost always one the source mis-listed. Deleting removes the file; the chapter stays listed and everyone keeps their reading history.')
                  : tr('Deleting removes the file. The chapter stays listed and everyone keeps their reading history.')}
              </p>
              <p className="mt-2">{tr('A chapter somebody has bookmarked is skipped, and so is anything in a library you built by hand. There is no undo and no recycle bin.')}</p>
            </>
          }
          onConfirm={() => act('delete', doDelete)}
          onClose={() => setAsking(null)}
        />
      )}

      {asking === 'disable' && (
        <ConfirmDialog
          title={tr('Turn this source off?')}
          confirmLabel={tr('Turn off')}
          danger
          busy={busy === 'disable'}
          body={<p>{tr('Nothing is deleted. Series that follow it stop being asked for new chapters until you turn it back on under Providers.')}</p>}
          onConfirm={() => act('disable', doDisable)}
          onClose={() => setAsking(null)}
        />
      )}

      {asking === 'merge' && (item.seriesIds || []).length === 2 && (
        <ConfirmDialog
          title={tr('Merge these two?')}
          confirmLabel={tr('Merge')}
          busy={busy === 'merge'}
          body={
            <>
              <p>{tr('This cannot be undone. Progress, bookmarks, ratings and tracker links move to the kept copy.')}</p>
              <p className="mt-2">{tr('No chapter is dropped even if both copies have it, and no files are touched.')}</p>
              <div className="mt-3 space-y-2">
                {(item.titles || []).map((t, i) => (
                  <label key={i} className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-700 px-3 py-2 text-sm">
                    <input type="radio" checked={keepFirst === (i === 0)} onChange={() => setKeepFirst(i === 0)} />
                    <span className="truncate">{keepBefore}<strong className="text-fog-100">{t}</strong>{keepAfter}</span>
                  </label>
                ))}
              </div>
            </>
          }
          onConfirm={() => act('merge', doMerge)}
          onClose={() => setAsking(null)}
        />
      )}
    </>
  );
}

/**
 * Which repair step a whole check's Fix all runs.
 *
 * ⚠️ There is deliberately no entry for `duplicates` or `outliers`. The nightly never merges, deletes,
 * tombstones or renumbers anything, and a "Fix all" that quietly did would be the one button in this
 * console capable of destroying a household's library in a tap.
 */
const FIX_ALL: Record<string, RepairStep> = {
  'short-chapters': 'short',
  'chapter-gaps': 'gaps',
  'chapter-failures': 'failures',
  solver: 'solver',
};

/**
 * The header-level actions for a whole check: Fix all, and Merge all for duplicates.
 *
 * ⚠️ Mounted as a SIBLING of the card's disclosure button, never inside it: a button inside a button is
 * invalid HTML, and browsers repair it by moving the inner one out of the header entirely. It also comes
 * after the disclosure in the DOM, because the end-to-end walk clicks the first button in the card to
 * open it.
 */
export function HealthCheckActions({ check, onDone }: { check: HealthCheck; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const step = FIX_ALL[check.id];
  // `info` items are statements, not findings: a source that is switched off, a gap nobody lists. A check
  // holding only those has nothing to fix, and offering the button anyway starts a run that does nothing.
  const findings = check.items.filter((it) => !it.info);
  const pairs = check.id === 'duplicates' ? findings.filter((it) => (it.seriesIds || []).length === 2) : [];
  if (!findings.length) return null;
  if (!step && !pairs.length) return null;

  const mergeAll = async () => {
    setBusy(true);
    let merged = 0;
    let moved = 0;
    let failed = 0;
    // Sequential, not Promise.all: each merge rewrites rows on both series, and two of them landing at
    // once on a pair that shares a series (an AniList id matching three rows) would race for the survivor.
    for (const p of pairs) {
      const ids = p.seriesIds!;
      const keep = ids[keptIndex(p)];
      const gone = ids.find((x) => x !== keep)!;
      try {
        const r = await api<{ moved: number }>(`/api/admin/series/${encodeURIComponent(gone)}/merge`, { method: 'POST', json: { into: keep } });
        merged++;
        moved += r.moved || 0;
      } catch { failed++; }
    }
    toast(merged === 1 ? tr('One pair merged, {m} chapters moved', { m: moved }) : tr('{n} pairs merged, {m} chapters moved', { n: merged, m: moved }), failed ? 'info' : 'success');
    // ⚠️ Its own toast, in red. Folded into the line above it read as a footnote on a success, and the
    // pairs that did NOT merge are the ones still sitting on the page.
    if (failed) toast(failed === 1 ? tr('One pair could not be merged') : tr('{n} pairs could not be merged', { n: failed }), 'error');
    setBusy(false);
    setAsking(false);
    onDone();
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 pe-4">
      {step && (
        <button
          type="button"
          data-health-fix-all={check.id}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void postRepair({ only: [step] }, toast).finally(() => { setBusy(false); onDone(); });
          }}
          className="chip shrink-0 text-xs hover:border-accent/50 hover:text-accent disabled:opacity-50"
        >
          {tr('Fix all')}
        </button>
      )}
      {!!pairs.length && (
        <button
          type="button"
          data-health-merge-all={check.id}
          disabled={busy}
          onClick={() => setAsking(true)}
          className="chip shrink-0 text-xs hover:border-accent/50 hover:text-accent disabled:opacity-50"
        >
          {tr('Merge all')}
        </button>
      )}
      {asking && (
        <ConfirmDialog
          title={pairs.length === 1 ? tr('Merge this pair?') : tr('Merge these {n} pairs?', { n: pairs.length })}
          confirmLabel={tr('Merge all')}
          busy={busy}
          body={
            <>
              <p>{tr('This cannot be undone. Progress, bookmarks, ratings and tracker links move to the kept copy.')}</p>
              <ul className="mt-3 space-y-2">
                {pairs.map((p, i) => (
                  <li key={i} className="rounded-lg border border-ink-700 px-3 py-2">
                    {(p.titles || []).map((t, j) => (
                      <p key={j} className="flex min-w-0 items-center gap-2 text-sm">
                        <span className={`truncate ${j === keptIndex(p) ? 'text-fog-100' : 'text-fog-500'}`}>{t}</span>
                        {j === keptIndex(p) && (
                          <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-fog-300">{tr('kept')}</span>
                        )}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          }
          onConfirm={() => { void mergeAll(); }}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
