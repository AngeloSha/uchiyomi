'use client';
import { useEffect, useState } from 'react';
import { getPageBlob } from '@/lib/downloads';
import { img } from '@/lib/api';

/**
 * A series' cover on the Offline page (UI refresh), which must work with no network: the server's cover while it answers, and
 * else -- offline, or a cover that fails -- the first page of a chapter saved on this device, which always is. Decorative
 * (`alt=""`): the title is beside it. The caller keys it on `online`, so a sign-in that resolves after it mounted brings
 * the server's cover back.
 */
export function OfflineCover({ seriesId, bookId, online }: { seriesId: string; bookId: string; online: boolean }) {
  const [src, setSrc] = useState<string | null>(online ? img.seriesThumb(seriesId) : null);
  const [local, setLocal] = useState(!online);
  useEffect(() => {
    if (!local) return;
    let url: string | null = null;
    let live = true;
    getPageBlob(bookId, 1).then((b) => { if (live && b) { url = URL.createObjectURL(b); setSrc(url); } }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [local, bookId]);
  return (
    <div className="aspect-[2/3] w-14 shrink-0 overflow-hidden rounded-lg border border-ink-700/70 bg-ink-850 lg:w-16">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt="" className="h-full w-full object-cover" onError={() => { if (!local) { setSrc(null); setLocal(true); } }} />}
    </div>
  );
}
