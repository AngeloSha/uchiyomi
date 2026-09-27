'use client';
// What Uchiyomi did to a series' chapter numbers, or proposes to do (#116): one text block above the series'
// server downloads band and its chapter list.
//
// A source that gives many different posts one chapter number -- Webtoons numbers Istrevelia's 226 posts by the
// episode in their titles, 13 numbers in all -- is numbered by posting order instead, 1..226. A series added
// that way is numbered at once and the notice says why its numbers are not the source's. A series ALREADY in a
// library is never renamed unattended (the owner's rule for v0.49.0): it is held -- nothing downloads -- until an
// admin opens the plan (NumberingSheet) and confirms it, or keeps the source's numbers. The same hold follows an
// extension setting that moved the source's numbers under the files (`remap`).
//
// Members read the sentence; the keys are the admin's (the routes behind them are admin-only). A text block with
// a start-edge rule in the tone of what it says, rectangular keys -- no badge, no capsule.
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { noticeKind, numLabel, type NumberingAnswer, type NumberingSummary, type RenumberMode } from '@/lib/numbering';
import { extensionSettingsHref } from '@/lib/sourcePrefs';
import { activeLocale } from '@/lib/format';

const TONE = {
  amber: 'border-amber-400/70 bg-amber-500/10',
  accent: 'border-accent/60 bg-accent/5',
  neutral: 'border-ink-600 bg-ink-850/50',
} as const;

export function NumberingNotice({ seriesId, numbering, isAdmin, onReview }: {
  seriesId: string;
  numbering: NumberingSummary | null | undefined;
  isAdmin: boolean;
  /** Open the plan sheet for this change (the page owns the sheet, so the versions sheet can open it too). */
  onReview: (mode: RenumberMode) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const kind = noticeKind(numbering);
  if (!kind || !numbering) return null;
  const n = numbering;
  const source = n.sourceName || tr('This source');
  const big = n.note?.biggest;
  const posts = n.note?.posts ?? 0;

  /** "Keep the source's numbers" on a proposal: nothing to rename, so no plan and no confirm. */
  const keep = async () => {
    setBusy(true);
    try {
      await api<NumberingAnswer>(`/api/admin/series/${encodeURIComponent(seriesId)}/numbering`, { json: { mode: 'source' } });
      qc.invalidateQueries({ queryKey: ['series-listing', seriesId] });
      toast(tr('Kept the source’s numbers'), 'success');
    } catch (e) { toast(msgOf(e, tr('Could not do that')), 'error'); }
    setBusy(false);
  };

  let tone: keyof typeof TONE = 'neutral';
  let heading = '';
  let body = '';
  let keys: Array<{ label: string; run: () => void; primary?: boolean }> = [];
  const shared = big && big.posts > 1
    ? tr('{source} gives many different posts the same chapter number ({posts} posts are all numbered {number}).', { source, posts: big.posts, number: numLabel(big.number) })
    : tr('{source} gives many different posts the same chapter number.', { source });

  if (kind === 'review' && n.pending === 'source') {
    tone = 'amber';
    heading = tr('Going back to the source’s numbers');
    body = tr('New chapters wait until the renaming is reviewed.');
    keys = [{ label: tr('Review'), run: () => onReview('source'), primary: true }];
  } else if (kind === 'review') {
    tone = 'amber';
    heading = tr('Chapter numbers need a review');
    body = `${shared} ${tr('The chapters here still use the source’s numbers, and new ones wait until the renumbering is reviewed.')}`;
    keys = [
      { label: tr('Review renumbering'), run: () => onReview(n.pending ?? 'posting_order'), primary: true },
      { label: tr('Keep the source’s numbers'), run: () => void keep() },
    ];
  } else if (kind === 'remap') {
    tone = 'amber';
    heading = tr('The source’s numbers changed');
    body = tr('An extension setting changed how {source} numbers its chapters. The files here still carry the old numbers, and new chapters wait until the renumbering is reviewed.', { source });
    keys = [{ label: tr('Review renumbering'), run: () => onReview('remap'), primary: true }];
  } else if (kind === 'applied') {
    tone = 'accent';
    heading = n.changedAt
      // The app's language, with Western digits like every other number on screen (lib/format.ts).
      ? tr('Numbered by posting order since {date}', { date: new Date(n.changedAt).toLocaleDateString(`${activeLocale()}-u-nu-latn`, { dateStyle: 'medium' }) })
      : tr('Numbered by posting order');
    body = posts > 0
      ? `${shared} ${tr('Uchiyomi numbers this series 1–{last} in the order the posts came out.', { last: posts })}`
      : shared;
    keys = [{ label: tr('Use the source’s numbers'), run: () => onReview('source') }];
  } else {
    heading = tr('Some posts share a chapter number');
    body = tr('If they are different chapters rather than versions of one, number them by posting order.');
    keys = [{ label: tr('Number by posting order'), run: () => onReview('posting_order') }];
  }

  return (
    <div data-numbering-notice={kind} className={`mb-3 border-s-2 py-2.5 pe-3 ps-3 ${TONE[tone]}`}>
      <p className={`text-[13px] font-semibold ${tone === 'amber' ? 'text-amber-200' : 'text-fog-100'}`}>{heading}</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-fog-300">{body}</p>
      {isAdmin ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {keys.map((k) => (
            <button key={k.label} type="button" onClick={k.run} disabled={busy} className={`btn-key ${k.primary ? 'btn-key-primary' : ''}`}>{k.label}</button>
          ))}
          {n.extSourceId && (
            <Link href={extensionSettingsHref(n.extSourceId)} className="text-[12px] font-medium text-accent hover:underline">{tr('Source settings')}</Link>
          )}
        </div>
      ) : (kind === 'review' || kind === 'remap') && (
        <p className="mt-1 text-[11px] text-fog-500">{tr('An admin reviews this from the series page.')}</p>
      )}
    </div>
  );
}
