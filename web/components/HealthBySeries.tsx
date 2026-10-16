'use client';
// Health turned around (v0.72.0, @Squeaks72's idea in #254): one card per series with everything Health found wrong with
// it, beside the one card per check. Each finding is its card's own row -- the same words, the same keys, the same status
// line (components/HealthActions.tsx HealthRow) -- so a series' gap, short chapter and unreadable file are fixed from one
// place. Tick several to remove them from the library together: hidden, never a file deleted (POST
// /api/admin/series/bulk/hide, the Library's own route), and only the ticked series on the screen (lib/healthBySeries.ts
// chosenOf). A finding about no single series -- a source, a folder, the solver -- and a duplicate pair stay By check.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { checkTitle } from '@/lib/healthCopy';
import { healthLinks, seriesHref } from '@/lib/healthLinks';
import { itemKey } from '@/lib/healthKeys';
import { itemDetail } from '@/lib/said';
import { healthMark } from '@/lib/status';
import { selectedText } from '@/lib/counted';
import { SERIES_PAGE, allChosen, chosenOf, findingsText, removedText, seriesCountText, toggleAll } from '@/lib/healthBySeries';
import { HealthRow } from '@/components/HealthActions';
import { StatusEdge, StatusMark } from '@/components/StatusMark';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { OnBody } from '@/components/ui';
import { useToast } from '@/components/Toast';
import type { HealthCheck, SeriesFindings } from '@/lib/types';

/** The titles a Remove's confirmation names before "and 3 more". */
const NAMED = 8;

export function HealthBySeries({ rows, checks }: { rows: SeriesFindings[]; checks: HealthCheck[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [count, setCount] = useState(SERIES_PAGE);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // The series a confirmation is open for: one card's Remove, or the ticked ones.
  const [asking, setAsking] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(checks.map((c) => [c.id, c])), [checks]);
  const shown = rows.slice(0, count);
  const chosen = chosenOf(picked, shown);
  const titleOf = useMemo(() => new Map(rows.map((r) => [r.seriesId, r.title])), [rows]);

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const remove = async (ids: string[]) => {
    setBusy(true);
    try {
      const r = await api<{ hidden: number; skipped: Array<{ id: string; reason: string }> }>('/api/admin/series/bulk/hide', { json: { ids } });
      const said = removedText(r);
      toast(said.text, said.ok ? 'success' : 'error');
      if (said.ok) {
        setPicked((p) => new Set([...p].filter((id) => !ids.includes(id))));
        for (const k of [['admin-health'], ['health-summary'], ['home'], ['library']]) void qc.invalidateQueries({ queryKey: k });
      }
    } catch (e) {
      toast(msgOf(e, tr('Could not remove those')), 'error');
    }
    setBusy(false);
    setAsking(null);
  };

  if (!rows.length) {
    return <p role="status" data-health-by-series className="full py-8 text-center text-sm text-fog-500">{tr('No series has a finding right now.')}</p>;
  }
  return (
    <>
      <div data-health-by-series className="full flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fog-500">
          {seriesCountText(rows.length)}
          {chosen.length > 0 && <> · {selectedText(chosen.length)}</>}
        </p>
        <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="btn-key" onClick={() => setPicked(toggleAll(picked, shown))}>
            {allChosen(picked, shown) ? tr('Select none') : tr('Select all')}
          </button>
          {chosen.length > 0 && (
            <button type="button" className="btn-key btn-key-danger" data-health-remove onClick={() => setAsking(chosen)}>
              {chosen.length === 1 ? tr('Remove 1 series') : tr('Remove {n} series', { n: chosen.length })}
            </button>
          )}
        </div>
      </div>

      {shown.map((r) => {
        const mark = healthMark(r.status);
        const ticked = picked.has(r.seriesId);
        return (
          <div key={r.seriesId} data-health-series={r.seriesId} className="card grad-border full relative overflow-hidden">
            <StatusEdge tone={mark.tone} />
            {/* Wraps: on a phone the keys go under the title rather than squeezing it to a few letters. */}
            <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3.5">
              <input type="checkbox" checked={ticked} onChange={() => toggle(r.seriesId)} aria-label={r.title}
                className="mt-1 size-4 shrink-0 accent-accent" />
              <div className="min-w-[12rem] flex-1">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span dir="auto" className="min-w-0 break-words text-sm text-fog-100">{r.title}</span>
                  <StatusMark {...mark} size="xs" />
                </p>
                <p className="mt-0.5 text-[11px] text-fog-500">{findingsText(r.findings.length)}</p>
              </div>
              <div className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
                {/* Goes somewhere: a text link, as on every row. Does something: a key. */}
                <Link href={seriesHref(r.seriesId)} className="text-xs text-accent hover:underline">{tr('Open')}{' '}›</Link>
                <button type="button" className="btn-key btn-key-danger" onClick={() => setAsking([r.seriesId])}>{tr('Remove from library')}</button>
              </div>
            </div>
            <div className="divide-y divide-ink-800/70 border-t border-ink-800/70">
              {r.findings.map((f) => {
                const check = byId.get(f.check);
                if (!check) return null;
                // Keyed as on its card (lib/healthKeys.ts), so a key's state stays with its finding through a re-check.
                const key = `${f.check}:${itemKey(f.check, f.item)}`;
                return (
                  <HealthRow key={key} rowKey={itemKey(f.check, f.item)} check={check} item={f.item}
                    links={healthLinks(f.check, f.item).map((l) => (
                      <Link key={l.href} href={l.href} className="line-clamp-2 max-w-[11rem] break-words text-end text-xs text-accent hover:underline"
                        title={l.label} aria-label={l.label ? `${tr('Open')}: ${l.label}` : undefined}
                        {...(/^https?:\/\//.test(l.href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                        {l.label ? `${tr('Open')} · ${l.label}` : tr('Open')}{' '}›
                      </Link>
                    ))}>
                    {/* The card it comes from, then the row's own words (a downloads row's title is its folder). */}
                    <p className="text-xs text-fog-300">{checkTitle(check)}</p>
                    <p dir="auto" className="text-[11px] text-fog-500">{itemDetail(f.item)}</p>
                  </HealthRow>
                );
              })}
            </div>
          </div>
        );
      })}

      {rows.length > shown.length && (
        <div className="full flex justify-center">
          <button type="button" className="btn-key" onClick={() => setCount((n) => n + SERIES_PAGE)}>
            {tr('Show {n} more', { n: Math.min(SERIES_PAGE, rows.length - shown.length) })}
          </button>
        </div>
      )}

      {asking && (
        <OnBody>
          <ConfirmDialog
            title={asking.length === 1 ? tr('Remove 1 series from the library?') : tr('Remove {n} series from the library?', { n: asking.length })}
            danger
            busy={busy}
            confirmLabel={tr('Remove')}
            body={
              <>
                <ul className="mb-3 space-y-1 text-sm">
                  {asking.slice(0, NAMED).map((id) => <li key={id} dir="auto" className="truncate text-fog-100">{titleOf.get(id) ?? id}</li>)}
                  {asking.length > NAMED && <li className="text-fog-500">{tr('and {n} more', { n: asking.length - NAMED })}</li>}
                </ul>
                <p><strong className="text-fog-100">{tr('No files are deleted.')}</strong> {tr('The chapters stay exactly where they are on disk, and nothing in your library folder is touched.')}</p>
                <p className="mt-2">{tr("Everyone's reading progress, history, favourites and ratings are kept, so you can put them back at any time from Admin → Library.")}</p>
              </>
            }
            onConfirm={() => remove(asking)}
            onClose={() => setAsking(null)}
          />
        </OnBody>
      )}
    </>
  );
}
