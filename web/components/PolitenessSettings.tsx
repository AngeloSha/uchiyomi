'use client';
// Admin -> Settings -> Downloads -> Downloads & politeness: what keeps the server gentle with sites, in one place. The numbers
// that can only be set by environment variables, shown read-only with the value this server is running on (GET /api/admin/limits,
// which returns nothing but those numbers); and every source that is blocked right now, with the one control that lifts it.
//
// The blocked list is the Sources tab's own overview, so it lists a source the moment the Sources tab would, and Unblock is the same
// POST the Sources sheet and Health use (`/api/admin/sources/:id/unblock`). A summary row that opens a sheet, like its neighbours
// (v0.86.0's settings layout).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { EditorSheet, Row, SummaryRow, useEditor } from '@/components/settings';
import { t as tr } from '@/lib/i18n';
import { OVERVIEW_KEY, OVERVIEW_URL, isBlocked, sourceSays, type SourcesOverview } from '@/lib/sourcesPanel';
import { limitParts, type Limit } from '@/lib/politeness';

/** What each environment knob does, in a few words: the key itself is the label, because that is what is typed in the compose file. */
const LIMIT_HELP: Record<string, () => string> = {
  SUWAYOMI_PAGE_CONCURRENCY: () => tr('Pages of one chapter fetched at the same time.'),
  SOURCE_LATEST_TIMEOUT_MS: () => tr('How long a source gets to answer the latest-chapters check.'),
  SOURCE_TEST_TIMEOUT_MS: () => tr('How long a source gets to answer a test.'),
  SCAN_CONCURRENCY: () => tr('Library folders scanned at the same time.'),
  BACKUP_KEEP: () => tr('Nightly backups kept before the oldest is deleted.'),
  CACHE_MAX_BYTES: () => tr('Size cap for the image cache; 0 means no cap.'),
};

/** A limit in the reader's words: seconds and gigabytes instead of milliseconds and bytes. */
function limitText(l: Limit): string {
  const { kind, n } = limitParts(l);
  if (kind === 's') return n === '1' ? tr('1 second') : tr('{n} seconds', { n });
  if (kind === 'gb') return l.value === 0 ? tr('No cap') : tr('{n} GB', { n });
  return n;
}

export function PolitenessRow() {
  const toast = useToast();
  const qc = useQueryClient();
  const editor = useEditor('politeness');
  const { data: lim } = useQuery({
    queryKey: ['admin-limits'], queryFn: () => api<{ limits: Limit[]; note: string }>('/api/admin/limits'), staleTime: 60_000,
  });
  const { data: overview } = useQuery({
    queryKey: OVERVIEW_KEY, queryFn: () => api<SourcesOverview>(OVERVIEW_URL), staleTime: 30_000,
  });
  const blocked = (overview?.sources ?? []).filter(isBlocked);
  const unblock = async (id: string) => {
    try {
      await api(`/api/admin/sources/${encodeURIComponent(id)}/unblock`, { method: 'POST' });
      toast(tr('Block cleared'), 'success');
      await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      void qc.invalidateQueries({ queryKey: ['admin-sources'] });
    } catch {
      toast(tr('Could not clear the block'), 'error');
    }
  };
  return (
    <>
      <SummaryRow id="politeness" ref={editor.row} label={tr('Downloads & politeness')} onClick={editor.show}
        value={blocked.length ? (blocked.length === 1 ? tr('1 source blocked') : tr('{n} sources blocked', { n: blocked.length })) : tr('Nothing blocked')} />
      <EditorSheet title={tr('Downloads & politeness')} open={editor.open} onClose={editor.close}>
        <p className="max-w-prose py-3 text-[12px] leading-relaxed text-fog-400 first:pt-1">
          {tr('How hard this server leans on sites, and which sources are being left alone right now.')}
        </p>
        <div className="py-3 first:pt-1">
          <h3 className="text-sm font-semibold text-fog-100">{tr('Limits set by the server')}</h3>
          <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-fog-500">
            {tr('Set by environment variables. You can see them here but not change them.')}
          </p>
        </div>
        {(lim?.limits ?? []).map((l) => (
          <Row key={l.key} label={l.key} help={LIMIT_HELP[l.key]?.()}>
            <span className="text-sm tabular-nums text-fog-200">{limitText(l)}</span>
          </Row>
        ))}
        <div className="py-3 last:pb-0" id="blocked-sources">
          <h3 className="text-sm font-semibold text-fog-100">{tr('Blocked sources')}</h3>
          <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-fog-500">
            {tr('A source that refuses requests is paused for a while. Unblock tries it again now.')}
          </p>
          {overview && blocked.length === 0 && (
            <p className="mt-2 text-sm text-fog-400">{tr('No sources are blocked right now.')}</p>
          )}
          <ul className="mt-2 divide-y divide-ink-800/80">
            {blocked.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-blocked-source={x.id}>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm text-fog-100" title={x.id}>{x.name}</p>
                  <p className="text-[11px] text-fog-500">{sourceSays(x).reason}</p>
                </div>
                <button type="button" className="btn-key" onClick={() => void unblock(x.id)}>{tr('Unblock')}</button>
              </li>
            ))}
          </ul>
        </div>
      </EditorSheet>
    </>
  );
}
