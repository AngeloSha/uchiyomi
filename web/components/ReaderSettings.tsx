'use client';
import { motion } from 'framer-motion';
import { ReaderPrefs } from '@/lib/readerPrefs';
import { IcX } from './icons';
import { t as tr } from '@/lib/i18n';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-fog-200">{label}</span>
      </div>
      {children}
    </div>
  );
}

export function ReaderSettings({
  prefs,
  set,
  onClose,
  sourceName,
  sourceDefault,
  onSourceDefault,
}: {
  prefs: ReaderPrefs;
  set: (p: Partial<ReaderPrefs>) => void;
  onClose: () => void;
  /** The source this chapter came from, named for the button. Absent for a copy with no source on record. */
  sourceName?: string;
  /** Whether that source already has a default saved, which decides what the button offers. */
  sourceDefault?: boolean;
  /** Save the current mode/theme/spread as that source's default, or clear it when `false` is passed. */
  onSourceDefault?: (save: boolean) => void;
}) {
  return (
    <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 36 }}
        className="absolute inset-x-0 bottom-0 rounded-t-4xl border-t border-ink-700 bg-ink-900/95 px-5 pt-4 backdrop-blur-xl pb-[max(1.5rem,calc(env(safe-area-inset-bottom)+1rem))]"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink-600" />
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold">{tr('Reader')}</h3>
          <button onClick={onClose} className="text-fog-500"><IcX width={20} height={20} /></button>
        </div>

        <Row label="Mode">
          <div className="grid grid-cols-2 gap-2">
            {(['vertical', 'paged'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set({ mode: m })}
                className={`rounded-2xl border py-3 text-sm capitalize ${prefs.mode === m ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}
              >
                {m === 'vertical' ? 'Webtoon (scroll)' : 'Paged (swipe)'}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Theme">
          <div className="grid grid-cols-3 gap-2">
            {(['amoled', 'sepia', 'gray'] as const).map((t) => (
              <button key={t} onClick={() => set({ theme: t })}
                className={`rounded-2xl border py-3 text-sm capitalize ${prefs.theme === t ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>
                {t === 'amoled' ? 'AMOLED' : t}
              </button>
            ))}
          </div>
        </Row>

        <Row label={`Brightness · ${Math.round(prefs.brightness * 100)}%`}>
          <input type="range" min={0.25} max={1} step={0.05} value={prefs.brightness}
            onChange={(e) => set({ brightness: Number(e.target.value) })}
            className="w-full accent-[rgb(var(--accent))]" />
        </Row>

        {prefs.mode === 'paged' && (
          <Row label="Pages per view">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => set({ spread: false })}
                className={`rounded-2xl border py-3 text-sm ${!prefs.spread ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Single')}</button>
              <button onClick={() => set({ spread: true })}
                className={`rounded-2xl border py-3 text-sm ${prefs.spread ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Double spread')}</button>
            </div>
          </Row>
        )}

        {/* Set in both modes. ⚠️ It cannot LOOK the same in both: a page-by-page view has no thin slide --
            every slide is exactly one viewport wide -- so Collapse falls back to removing there, where an
            unwanted page costs one swipe rather than a scroll and there is no flow to interrupt. */}
        <Row label={tr('Repeated pages')}>
          <div className="grid grid-cols-3 gap-2">
            <button onClick={() => set({ junkPages: 'show' })}
              className={`rounded-2xl border py-3 text-sm ${prefs.junkPages === 'show' ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Show all')}</button>
            <button onClick={() => set({ junkPages: 'collapse' })}
              className={`rounded-2xl border py-3 text-sm ${prefs.junkPages === 'collapse' ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Collapse')}</button>
            <button onClick={() => set({ junkPages: 'hide' })}
              className={`rounded-2xl border py-3 text-sm ${prefs.junkPages === 'hide' ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Hide')}</button>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-fog-500">
            {tr('Credit pages and adverts repeat in every chapter. Collapse folds them down to a line you can scroll past or tap to open; hide takes them out of the chapter altogether.')}
          </p>
        </Row>

        {prefs.mode === 'vertical' && (
          <>
            <Row label={`Page gap · ${prefs.gap}px`}>
              <input type="range" min={0} max={40} step={2} value={prefs.gap}
                onChange={(e) => set({ gap: Number(e.target.value) })}
                className="w-full accent-[rgb(var(--accent))]" />
            </Row>
            <Row label={`Auto-scroll · ${prefs.autoScroll === 0 ? 'off' : prefs.autoScroll.toFixed(1)}`}>
              <input type="range" min={0} max={6} step={0.5} value={prefs.autoScroll}
                onChange={(e) => set({ autoScroll: Number(e.target.value) })}
                className="w-full accent-[rgb(var(--accent))]" />
            </Row>
          </>
        )}

        <Row label="Fit">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => set({ fitWidth: true })}
              className={`rounded-2xl border py-3 text-sm ${prefs.fitWidth ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Fit width')}</button>
            <button onClick={() => set({ fitWidth: false })}
              className={`rounded-2xl border py-3 text-sm ${!prefs.fitWidth ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Original')}</button>
          </div>
        </Row>

        {/*
          One source is a good proxy for one FORMAT: a webtoon source wants continuous vertical scroll, a
          manga source wants paged right-to-left. Pinning the current look to the source fixes every title
          from it at once, instead of the global default being wrong for half the library or each series
          having to be corrected by hand. A series you have already adjusted still wins over this.
        */}
        {sourceName && onSourceDefault && (
          <Row label={tr('This source')}>
            <div className="grid gap-2">
              <button onClick={() => onSourceDefault(true)}
                className="rounded-2xl border border-ink-700 py-3 text-sm text-fog-300">
                {tr('Use this reader for everything from {source}', { source: sourceName })}
              </button>
              {sourceDefault && (
                <button onClick={() => onSourceDefault(false)}
                  className="rounded-2xl border border-ink-700 py-2 text-xs text-fog-500">
                  {tr('Forget the default for {source}', { source: sourceName })}
                </button>
              )}
            </div>
          </Row>
        )}
      </motion.div>
    </motion.div>
  );
}
