'use client';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { canDownload, useAuth } from '@/lib/auth';
import { t as tr } from '@/lib/i18n';
import type { Series } from '@/lib/types';
import { useToast } from './Toast';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { useArchiveEnqueue } from './ArchiveQueue';

/**
 * A series card's menu (#100): the few things worth doing without opening the series, from wherever it is on
 * screen -- the library grid, Home's rails, the admin console, the reader's Up next.
 *
 * Deliberately short (the proposal's own instinct): the cards are links, so Open in a new tab and Copy link
 * stand in for what the browser's menu offered; then what the Library's Select mode already does for many
 * series, here for one; and for an admin, a check for new chapters; for anyone who may download, the slow
 * archive of the rest (#117). Offered by role, never offered and then refused, and greyed rather than hidden
 * while offline. Anything larger is the series page, one click away.
 */
export function useSeriesMenu(series: Series) {
  const qc = useQueryClient();
  const toast = useToast();
  const { isAdmin, status, user } = useAuth();
  const archive = useArchiveEnqueue();
  const offline = status === 'offline';
  const href = `/series/?id=${encodeURIComponent(series.id)}`;
  const favourite = !!series.yomi?.favorite;

  // ['collection']: a list's tiles carry the same badges since v0.55.7 (#164), and Mark all read from one of them must
  // move its count there too, not only on the Library.
  const settle = () => {
    for (const key of [['library'], ['home'], ['collection'], ['series', series.id], ['series-books', series.id]]) qc.invalidateQueries({ queryKey: key });
  };
  // The Library's bulk routes, for a selection of one: the same permission checks, and the same answer shape.
  const bulk = async (path: string, extra: Record<string, unknown>, done: string) => {
    try {
      const r = await api<{ applied: number }>(path, { json: { seriesIds: [series.id], ...extra } });
      toast(r.applied ? done : tr('That series is no longer in the library'), r.applied ? 'success' : 'error');
      settle();
    } catch { toast(tr('Could not do that'), 'error'); }
  };

  const items = (): MenuItem[] => [
    { label: tr('Open in a new tab'), onSelect: () => { window.open(href, '_blank', 'noopener'); } },
    {
      label: tr('Copy link'),
      onSelect: async () => {
        try { await navigator.clipboard.writeText(new URL(href, window.location.href).toString()); toast(tr('Link copied'), 'success'); }
        catch { toast(tr('Could not copy the link'), 'error'); }
      },
    },
    {
      label: favourite ? tr('Remove from favourites') : tr('Favourite'), divider: true, disabled: offline,
      onSelect: () => bulk('/api/favorites/bulk', { favorite: !favourite }, favourite ? tr('Removed from favourites') : tr('Added to favourites')),
    },
    { label: tr('Mark all read'), disabled: offline, onSelect: () => bulk('/api/library/bulk/read', { completed: true }, tr('Marked read')) },
    { label: tr('Mark all unread'), disabled: offline, onSelect: () => bulk('/api/library/bulk/read', { completed: false }, tr('Marked unread')) },
    ...(isAdmin ? [{
      label: tr('Check for new chapters'), divider: true, disabled: offline,
      onSelect: async () => {
        try {
          await api(`/api/admin/series/${encodeURIComponent(series.id)}/check`, { method: 'POST', json: {} });
          toast(tr('Checking for new chapters…'), 'info', { busy: true });
        } catch { toast(tr('Could not do that'), 'error'); }
      },
    }] : []),
    // What is missing is the server's to work out; the notice says when there was nothing older to fetch.
    ...(canDownload(user) ? [{
      label: tr('Archive slowly'), divider: !isAdmin, disabled: offline,
      onSelect: () => { void archive([series.id], series.metadata?.title || series.name); },
    }] : []),
  ];

  return useContextMenu(items, { label: series.metadata?.title || series.name });
}
