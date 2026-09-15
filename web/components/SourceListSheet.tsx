'use client';
// The list behind Discover's one source chip: every source the wall is asking, in the wall's own order, with
// the health the chips used to wear as a ring and the server's one-line reason under the name.
//
// This replaced a wall of up to twelve chips plus two note lines sitting above the covers -- more words than
// the covers they introduced, and every chip a decision nobody had asked to make. One chip now says how many
// sources and whether any is unwell; this sheet is where you go when you want to browse one alone.
//
// ⚠️ Presentation only. The parent's bookkeeping (`states`, `settled`, `onSettled`, the `${listMode}:${id}`
// keys) is untouched: a row reads `stateOf(id)` exactly as the chips did, and a tap calls the same `onSelect`
// the chips called. Filtering is display-only there, and nothing here may change that -- see the stall
// warning on SourceLatest.
import { Sheet } from '@/components/ui';
import { IcCheck, IcInfo } from '@/components/icons';
import { SourceIcon } from '@/components/SourcePicker';
import { noteFor, retryIn, type Src, type SrcState } from '@/lib/sourceGroups';
import { t as tr } from '@/lib/i18n';

// The chips' RING colours as dots, keyed on what `noteFor` decided. `ok` stays empty on purpose: a working
// source needs no decoration, and lighting every healthy row green would make the one amber row harder to
// find, not easier. `idle` is a source not asked yet, `quiet` one that answered with nothing.
const DOT: Record<ReturnType<typeof noteFor>['dot'], string> = {
  ok: '',
  warn: 'bg-amber-400',
  quiet: 'bg-fog-600/60',
  idle: 'bg-ink-600',
};

export function SourceListSheet({ sources, total, stateOf, selected, onSelect, onExplain, onClose }: {
  /** In the picker's order, which is the wall's order. */
  sources: Src[];
  /**
   * How many sources could answer this listing -- the chip's number. The rows here are only the ones being
   * asked (six, widening to ten as sources answer empty), so with the chip saying "14 sources" and the sheet
   * listing nine, the footer has to say "Asking 9 of 14" or the reader is left to reconcile two numbers
   * that both look like "how many sources".
   */
  total: number;
  stateOf: (id: string) => SrcState;
  selected: string | null;
  onSelect: (id: string) => void;
  /** The (i) in the header: opens the explainer. The picker swaps this sheet for it, so one Escape closes one. */
  onExplain: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title={tr('Sources')}
      onClose={onClose}
      overBottomNav
      action={
        <button type="button" onClick={onExplain} aria-label={tr('What are sources and extensions?')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-800/80 text-fog-300">
          <IcInfo width={16} height={16} />
        </button>
      }
      footer={
        <p className="text-[11px] text-fog-500">
          {/* A small install asks every source it has; "Asking 4 of 4" would be a puzzle, not a fact. */}
          {sources.length < total
            ? tr('Asking {n} of {m} · tap a source to browse it alone', { n: sources.length, m: total })
            : tr('Tap a source to browse it alone.')}
        </p>
      }
    >
      <div className="-mx-1 divide-y divide-ink-800/70">
        {sources.map((s) => {
          const st = stateOf(s.id);
          const { dot, note } = noteFor(s, st);
          // `title` is invisible on a touchscreen, which is most of this app's use, so the reason has to
          // exist as text under the name -- and the wait beside it, or the amber dot is one more colour
          // nobody can interpret.
          const when = note ? retryIn(s) : null;
          const on = selected === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => { onSelect(s.id); onClose(); }}
              aria-current={on ? 'true' : undefined}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-start transition
                ${on ? 'text-accent' : 'text-fog-200 hover:text-fog-50'} ${st === 'idle' && !on ? 'opacity-55' : ''}`}
            >
              <SourceIcon id={s.id} name={s.name} size={24} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm">
                  <span className="truncate">{s.name}</span>
                  {DOT[dot] && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[dot]}`} />}
                </span>
                {note && (
                  <span className="block text-[11px] leading-relaxed text-fog-500">
                    {note}{when ? ` · ${when}` : ''}
                  </span>
                )}
              </span>
              {on && <IcCheck width={15} height={15} className="shrink-0" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
