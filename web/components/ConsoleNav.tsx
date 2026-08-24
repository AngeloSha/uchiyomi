'use client';
import { useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { t as tr } from '@/lib/i18n';

export interface NavGroup<T extends string> {
  id: string;
  label: string;
  tabs: readonly T[];
}

/**
 * The console shell: a grouped sticky rail on a desktop, a group sheet plus a pill row on a phone, and one
 * animated panel between them.
 *
 * Lifted verbatim out of `app/admin/page.tsx`, which had grown the only good answer in the app to "eleven
 * panels, one screen" -- and profile now needs the same answer for its own seventeen sections. Two shells
 * that look alike but drift apart is exactly how admin ended up with two independent max-widths, so this
 * exists to make sure there is one.
 *
 * The caller owns the panel; this owns where it sits and how it swaps.
 */
export function ConsoleNav<T extends string>({
  groups,
  tab,
  onTab,
  ariaLabel,
  flat,
  footer,
  children,
}: {
  groups: ReadonlyArray<NavGroup<T>>;
  tab: T;
  onTab: (t: T) => void;
  ariaLabel: string;
  /** True when every group holds one entry: suppresses the group eyebrows and the phone group sheet. */
  flat?: boolean;
  /**
   * Actions that belong to the rail rather than to any one panel, pinned under the tab list and repeated at
   * the bottom of the phone sheet. Profile puts Admin and Sign out here: both were reachable only by picking
   * the right tab and scrolling a board of eight cards to the end, which is a long way for the two things
   * people go to that page to do.
   */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [sheet, setSheet] = useState(false);
  const group = groups.find((g) => (g.tabs as readonly string[]).includes(tab)) ?? groups[0];

  return (
    <div>
      <div className="lg:flex lg:gap-8 xl:gap-10">
        {/* ---- desktop: a sticky sidebar, grouped ---- */}
        <nav className="hidden shrink-0 lg:block lg:w-52 xl:w-56" aria-label={ariaLabel}>
          <div className="sticky top-6 space-y-5">
            {groups.map((g) => (
              <div key={g.id}>
                {!flat && (
                  <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-fog-600">{tr(g.label)}</p>
                )}
                <div className="space-y-0.5">
                  {g.tabs.map((t) => (
                    <button key={t} onClick={() => onTab(t)}
                      aria-current={tab === t ? 'page' : undefined}
                      className={`relative flex w-full items-center rounded-lg px-3 py-1.5 text-start text-sm transition ${
                        tab === t ? 'bg-accent-soft font-medium text-accent' : 'text-fog-400 hover:bg-ink-800/60 hover:text-fog-100'
                      }`}>
                      {/* the accent rail the rest of the app marks "you are here" with */}
                      {tab === t && <span aria-hidden className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-accent" />}
                      {tr(t)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {footer && (
              <div className="space-y-1 border-t border-ink-800/80 pt-4">{footer}</div>
            )}
          </div>
        </nav>

        {/* ---- phone: the group is a sheet, its panels stay a pill row ---- */}
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center gap-2 lg:hidden">
            {!flat && (
              <button onClick={() => setSheet(true)}
                className="chip shrink-0 gap-1 text-xs" aria-haspopup="dialog">
                {tr(group.label)}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </button>
            )}
            <div className="-me-4 flex gap-1.5 overflow-x-auto pe-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {group.tabs.map((t) => (
                <button key={t} onClick={() => onTab(t)}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                    tab === t ? 'bg-accent text-white' : 'bg-ink-800 text-fog-300'
                  }`}>{tr(t)}</button>
              ))}
            </div>
          </div>
          {/* A flat nav has no group sheet, so on a phone the footer would have nowhere to live. */}
          {footer && flat && <div className="mb-4 flex flex-wrap gap-2 lg:hidden">{footer}</div>}

          {/* Keyed on the tab so each panel animates in rather than snapping. */}
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }} className="pb-10">
            {children}
          </motion.div>
        </div>
      </div>

      {sheet && (
        <GroupSheet groups={groups} ariaLabel={ariaLabel} current={tab} footer={footer}
          onPick={(t) => { onTab(t); setSheet(false); }} onClose={() => setSheet(false)} />
      )}
    </div>
  );
}

/**
 * The group switcher on a phone.
 *
 * A bottom sheet rather than a dropdown, matching the library's Filters drawer -- an idiom this app already
 * has, so it is one pattern rather than two.
 */
function GroupSheet<T extends string>({ groups, ariaLabel, current, footer, onPick, onClose }: {
  groups: ReadonlyArray<NavGroup<T>>;
  ariaLabel: string;
  current: T;
  footer?: ReactNode;
  onPick: (t: T) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/70 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="glass max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border border-ink-700 p-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-md sm:rounded-2xl"
        role="dialog" aria-modal="true" aria-label={ariaLabel} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-semibold leading-tight">{ariaLabel}</h3>
          <button onClick={onClose} aria-label={tr('Close')} className="shrink-0 text-fog-500 hover:text-fog-200">✕</button>
        </div>
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.id}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fog-600">{tr(g.label)}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.tabs.map((t) => (
                  <button key={t} onClick={() => onPick(t)}
                    className={`chip text-xs ${current === t ? 'chip-active' : ''}`}>{tr(t)}</button>
                ))}
              </div>
            </div>
          ))}
          {footer && <div className="space-y-1 border-t border-ink-800/80 pt-4">{footer}</div>}
        </div>
      </div>
    </div>
  );
}
