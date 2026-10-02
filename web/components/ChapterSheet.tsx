'use client';
import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui';
import { IcCheck } from '@/components/icons';

export interface ChapterRow { id: string; label: string }

/**
 * The chapter list, at every width.
 *
 * It replaces a `<select className="hidden ... lg:block">` outright rather than sitting beside it. Two
 * reasons, and the first is the one that matters: the select was desktop-only, so on a phone -- which is
 * where this app is mostly read -- the only way through a series was prev/next, one chapter at a time. Two
 * mechanisms for one action is how that happened in the first place.
 *
 * The second is that a `<select>`'s options are rendered by the operating system and never pass through
 * `tr()`, so nothing inside it could ever be translated.
 */
export function ChapterSheet({ title, chapters, activeId, onPick, onClose, header }: {
  title: string;
  chapters: ChapterRow[];
  activeId?: string;
  onPick: (id: string) => void;
  onClose: () => void;
  /** Above the list (v0.52.0): the reader's language editions of the work, to read this chapter in another. */
  header?: ReactNode;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      {header}
      <div className="-mx-1 divide-y divide-ink-800/70">
        {chapters.map((c) => (
          <button
            key={c.id}
            onClick={() => { onPick(c.id); onClose(); }}
            aria-current={c.id === activeId ? 'true' : undefined}
            className={`flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm transition
              ${c.id === activeId ? 'text-accent' : 'text-fog-200 hover:text-fog-50'}`}
          >
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            {c.id === activeId && <IcCheck width={15} height={15} className="shrink-0" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
