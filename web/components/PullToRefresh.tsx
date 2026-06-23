'use client';
import { useRef, useState, ReactNode } from 'react';

const THRESHOLD = 70;

/** Lightweight mobile pull-to-refresh. Wraps a page that scrolls the document. */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<any> | any; children: ReactNode }) {
  const startY = useRef(0);
  const pulling = useRef(false);
  const [dist, setDist] = useState(0);
  const [busy, setBusy] = useState(false);

  const onStart = (e: React.TouchEvent) => {
    if (window.scrollY <= 0 && !busy) {
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    }
  };
  const onMove = (e: React.TouchEvent) => {
    if (!pulling.current) return;
    const d = e.touches[0].clientY - startY.current;
    if (d > 0) setDist(Math.min(d * 0.5, 90));
  };
  const onEnd = async () => {
    if (!pulling.current) return;
    pulling.current = false;
    if (dist >= THRESHOLD) {
      setBusy(true);
      setDist(46);
      try {
        await onRefresh();
      } finally {
        setBusy(false);
      }
    }
    setDist(0);
  };

  return (
    <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd}>
      <div style={{ height: dist }} className="flex items-center justify-center overflow-hidden text-fog-500 transition-[height] duration-200">
        {dist > 0 && (
          <span className={`text-xs ${busy ? 'animate-pulse-soft text-accent' : ''}`}>
            {busy ? 'Refreshing…' : dist >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
