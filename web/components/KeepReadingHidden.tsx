'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useToast } from './Toast';
import { useContextMenu } from './ContextMenu';

/** Series a reader took out of Keep reading and has not read since (GET /api/keep-reading/hidden). */
interface Hidden { seriesId: string; title: string; hiddenAt: string }

/**
 * Keep reading's "Hidden" key: lists what the reader removed from the row, and puts one back with a click. It is drawn
 * only when Home says there is something hidden (`keepReadingHidden`), and the list is asked for only when it opens.
 */
export function KeepReadingHidden({ count }: { count: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { status } = useAuth();
  const offline = status === 'offline';
  const list = useQuery({
    queryKey: ['keep-reading-hidden', count], enabled: count > 0, staleTime: 30_000,
    queryFn: () => api<{ content: Hidden[] }>('/api/keep-reading/hidden').then((r) => r.content),
  });
  const putBack = async (h: Hidden) => {
    try {
      await api(`/api/keep-reading/${encodeURIComponent(h.seriesId)}`, { method: 'PUT', json: { hidden: false } });
      toast(tr('Back in Keep reading'), 'success');
      qc.invalidateQueries({ queryKey: ['home'] });
      qc.invalidateQueries({ queryKey: ['keep-reading-hidden'] });
    } catch { toast(tr('Could not do that'), 'error'); }
  };
  const menu = useContextMenu(() => (list.data ?? []).map((h, i) => ({
    label: h.title, disabled: offline, hook: 'keep-reading-show',
    ...(i === 0 ? { heading: tr('Put back in Keep reading') } : {}),
    onSelect: () => putBack(h),
  })), { label: tr('Hidden from Keep reading') });
  if (count <= 0) return null;
  return (
    <>
      <button type="button" data-keep-reading-hidden onClick={(e) => menu.openFrom(e.currentTarget)}
        aria-haspopup="menu" aria-expanded={menu.open} className="text-xs text-fog-400 hover:text-fog-100">
        {tr('Hidden ({n})', { n: count })}
      </button>
      {menu.element}
    </>
  );
}
