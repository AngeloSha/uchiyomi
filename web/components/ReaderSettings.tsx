'use client';
import { motion } from 'framer-motion';
import { useRef } from 'react';
import { ReaderPrefs } from '@/lib/readerPrefs';
import type { ColorFilter, DevicePrefs } from '@/lib/readerDevice';
import type { AutoGuess } from '@/lib/readerAuto';
import { seriesTypeKey } from '@/lib/seriesTypes';
import { tapZone, type TapLayout } from '@/lib/readerGesture';
import { Disclosure } from './settings';
import { ReaderKeys } from './ReaderKeys';
import { IcX } from './icons';
import { Switch } from './Switch';
import { t as tr } from '@/lib/i18n';
import { useLayer } from '@/lib/layers';

/**
 * A tap layout drawn as the 3 x 3 grid it divides the page into (v0.61.0): shaded where a tap goes back, lit where it
 * goes on, plain where it shows the controls. Still -- a picture of the zones, not a demonstration of them. Paged mode's
 * zones; Automatic in the webtoon column turns nothing, as the help line under them says.
 * ⚠️ `dir="ltr"`, and `rtlTrack`: the edges are PHYSICAL -- the left of the screen is the left under the Arabic
 * interface too -- and on a right-to-left track the left edge goes ON, so the picture says what a tap will do here.
 */
function TapSketch({ layout, rtlTrack }: { layout: TapLayout; rtlTrack: boolean }) {
  return (
    <span aria-hidden dir="ltr" className="grid grid-cols-3 gap-px overflow-hidden rounded-[3px] border border-ink-600">
      {Array.from({ length: 9 }, (_, i) => {
        const z = tapZone((i % 3) * 10 + 5, Math.floor(i / 3) * 10 + 5, 30, 30, layout, 'paged');
        const back = z === 'prev' || (z === 'back' && !rtlTrack) || (z === 'forward' && rtlTrack);
        const on = z === 'next' || (z === 'forward' && !rtlTrack) || (z === 'back' && rtlTrack);
        return <span key={i} className={`h-2.5 w-3 ${back ? 'bg-fog-500' : on ? 'bg-accent' : 'bg-ink-800'}`} />;
      })}
    </span>
  );
}

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
  device,
  setDevice,
  autoApplied,
  padConnected = false,
  rtlTrack = false,
  onClose,
  sourceName,
  sourceDefault,
  onSourceDefault,
}: {
  prefs: ReaderPrefs;
  set: (p: Partial<ReaderPrefs>) => void;
  /** This device's own settings (v0.61.0, lib/readerDevice.ts): kept in this browser, never synced. */
  device: DevicePrefs;
  setDevice: (p: Partial<DevicePrefs>) => void;
  /** The mode the automatic pick chose for this title, and why; null when the mode is not the pick's. */
  autoApplied?: AutoGuess | null;
  /** Whether a game controller is connected now (lib/useGamepad.ts), for the controller's bindings. */
  padConnected?: boolean;
  /** Whether the paged track runs right to left now: its left edge then turns ON (the tap sketches say so). */
  rtlTrack?: boolean;
  onClose: () => void;
  /** The source this chapter came from, named for the button. Absent for a copy with no source on record. */
  sourceName?: string;
  /** Whether that source already has a default saved, which decides what the button offers. */
  sourceDefault?: boolean;
  /** Save the current mode/theme/spread as that source's default, or clear it when `false` is passed. */
  onSourceDefault?: (save: boolean) => void;
}) {
  // A sheet on the notices' layer stack (lib/layers.ts). It runs to the bottom edge, so it does not leave the
  // nav band free -- the reader has no nav there anyway -- and its panel is measured, so a notice rises above
  // it rather than covering its last rows.
  const panelRef = useRef<HTMLDivElement>(null);
  useLayer('dialog', true, { ref: panelRef });
  return (
    <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* Capped and scrollable: with the reading-direction and this-source rows, the sheet outgrew a short
          phone and pushed its first rows off the top. */}
      <motion.div
        ref={panelRef}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 36 }}
        role="dialog" aria-modal="true" aria-label={tr('Reader')}
        data-lenis-prevent
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-4xl border-t border-ink-700 bg-ink-900/95 px-5 pt-4 backdrop-blur-xl pb-[max(1.5rem,calc(env(safe-area-inset-bottom)+1rem))]"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink-600" />
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold">{tr('Reader')}</h3>
          <button onClick={onClose} className="text-fog-500"><IcX width={20} height={20} /></button>
        </div>

        <Row label={tr('Mode')}>
          <div className="grid grid-cols-2 gap-2">
            {(['vertical', 'paged'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set({ mode: m })}
                className={`rounded-2xl border py-3 text-sm ${prefs.mode === m ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}
              >
                {m === 'vertical' ? tr('Webtoon (scroll)') : tr('Paged (swipe)')}
              </button>
            ))}
          </div>
        </Row>

        {/* v0.61.0: Webtoon or Paged picked for each series from its pages and its type, where neither the series nor its
            source has a mode of its own. Every title, synced. Says what it picked for this one, and why. */}
        <div className="flex items-center justify-between gap-3 pb-3">
          <span className="text-sm font-medium text-fog-200">{tr('Pick the mode for each series')}</span>
          <Switch on={prefs.autoMode} onChange={(autoMode) => set({ autoMode })} label={tr('Pick the mode for each series')} />
        </div>
        {autoApplied && (
          <p data-auto-mode={autoApplied.mode} className="-mt-1 pb-3 text-[11px] leading-snug text-fog-500">
            {(() => {
              const mode = autoApplied.mode === 'vertical' ? tr('Webtoon (scroll)') : tr('Paged (swipe)');
              if (autoApplied.reason === 'strips') return tr('Picked for this series: {mode} · long strips', { mode });
              if (autoApplied.reason === 'rtl') return tr('Picked for this series: {mode} · right to left', { mode });
              return tr('Picked for this series: {mode} · {type}', { mode, type: tr(seriesTypeKey(autoApplied.reason)) });
            })()}
          </p>
        )}

        <Row label={tr('Theme')}>
          <div className="grid grid-cols-3 gap-2">
            {(['amoled', 'sepia', 'gray'] as const).map((t) => (
              <button key={t} onClick={() => set({ theme: t })}
                className={`rounded-2xl border py-3 text-sm ${prefs.theme === t ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>
                {t === 'amoled' ? tr('AMOLED') : t === 'sepia' ? tr('Sepia') : tr('Gray')}
              </button>
            ))}
          </div>
        </Row>

        {/* v0.61.0: a filter over the page images only -- the theme above still tints the reader as it did. This device
            only: an e-ink tablet wants E-ink, the phone beside it does not. */}
        <Row label={`${tr('Colour filter')} · ${tr('This device')}`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([['none', tr('None')], ['invert', tr('Invert')], ['grayscale', tr('Grayscale')], ['eink', tr('E-ink')]] as [ColorFilter, string][]).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={device.colorFilter === v} onClick={() => setDevice({ colorFilter: v })}
                className={`rounded-2xl border px-1 py-3 text-sm ${device.colorFilter === v ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{label}</button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-fog-500">{tr('Over the pages only. E-ink also turns pages without sliding.')}</p>
        </Row>

        {/* #170: the cover's colour across the top and bottom of the screen. A switch on one line, the only boolean here:
            on by default, and the same setting as Profile → Settings → Reading -- every title, not this one. */}
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="text-sm font-medium text-fog-200">{tr('Cover colour at the edges')}</span>
          <Switch on={prefs.coverEdges} onChange={(coverEdges) => set({ coverEdges })} label={tr('Cover colour at the edges')} />
        </div>

        <Row label={`${tr('Brightness')} · ${Math.round(prefs.brightness * 100)}%`}>
          <input type="range" min={0.25} max={1} step={0.05} value={prefs.brightness}
            onChange={(e) => set({ brightness: Number(e.target.value) })}
            className="w-full accent-[rgb(var(--accent))]" />
        </Row>

        {prefs.mode === 'paged' && (
          <Row label={tr('Pages per view')}>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => set({ spread: false })}
                className={`rounded-2xl border py-3 text-sm ${!prefs.spread ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Single')}</button>
              <button onClick={() => set({ spread: true })}
                className={`rounded-2xl border py-3 text-sm ${prefs.spread ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Double spread')}</button>
            </div>
          </Row>
        )}

        {prefs.mode === 'paged' && (
          <Row label={tr('Reading direction')}>
            <div className="grid grid-cols-3 gap-2">
              {([['series', tr('Series default')], ['ltr', tr('Left to right')], ['rtl', tr('Right to left')]] as const).map(([v, label]) => (
                <button key={v} onClick={() => set({ pagedDirection: v })}
                  className={`rounded-2xl border px-1 py-3 text-sm ${prefs.pagedDirection === v ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{label}</button>
              ))}
            </div>
          </Row>
        )}

        {/* v0.61.0. Both modes, every title (synced with the account, like the edges above). On a screen held upright
            only: a spread on a phone held sideways, or on a computer, fits as it is. */}
        <Row label={tr('Wide pages')}>
          <div className="grid grid-cols-3 gap-2">
            {([['whole', tr('Whole')], ['split', tr('Split')], ['rotate', tr('Rotate')]] as const).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={prefs.widePages === v} onClick={() => set({ widePages: v })}
                className={`rounded-2xl border py-3 text-sm ${prefs.widePages === v ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{label}</button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-fog-500">
            {tr('On a screen held upright, a double-page spread can be split into its two pages, or turned on its side to fill the screen.')}
          </p>
        </Row>

        {/* v0.61.0. Off by default; every title, synced. The margins are measured from each page's own pixels. */}
        <div className="py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-fog-200">{tr('Crop page borders')}</span>
            <Switch on={prefs.cropBorders} onChange={(cropBorders) => set({ cropBorders })} label={tr('Crop page borders')} />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-fog-500">
            {tr('Trims the blank margins around scanned pages. In Webtoon mode only the sides are trimmed, by the same amount for a whole chapter.')}
          </p>
        </div>

        {/* Set in both modes. ⚠️ It cannot LOOK the same in both: a page-by-page view has no thin slide --
            every slide is exactly one viewport wide -- so under Collapse a repeated page is shown there like
            any other, where it costs one swipe rather than a scroll. (Not removed: that would give the two modes
            different page orders, and switching mode mid-chapter would land on another page. Hide removes.) */}
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
            <Row label={`${tr('Page gap')} · ${prefs.gap}px`}>
              <input type="range" min={0} max={40} step={2} value={prefs.gap}
                onChange={(e) => set({ gap: Number(e.target.value) })}
                className="w-full accent-[rgb(var(--accent))]" />
            </Row>
            <Row label={`${tr('Auto-scroll')} · ${prefs.autoScroll === 0 ? tr('off') : prefs.autoScroll.toFixed(1)}`}>
              <input type="range" min={0} max={6} step={0.5} value={prefs.autoScroll}
                onChange={(e) => set({ autoScroll: Number(e.target.value) })}
                className="w-full accent-[rgb(var(--accent))]" />
            </Row>
          </>
        )}

        <Row label={tr('Fit')}>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => set({ fitWidth: true })}
              className={`rounded-2xl border py-3 text-sm ${prefs.fitWidth ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Fit width')}</button>
            <button onClick={() => set({ fitWidth: false })}
              className={`rounded-2xl border py-3 text-sm ${!prefs.fitWidth ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>{tr('Original')}</button>
          </div>
        </Row>

        {/* v0.61.0: where a tap turns the page, on this device. Automatic is the reader as it always was. */}
        <Row label={`${tr('Tap zones')} · ${tr('This device')}`}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {([['auto', tr('Automatic')], ['edges', tr('Edges')], ['lshape', tr('L shape')], ['kindle', tr('Kindle-style')], ['off', tr('Off')]] as [TapLayout, string][]).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={device.tapLayout === v} onClick={() => setDevice({ tapLayout: v })}
                className={`flex flex-col items-center gap-1.5 rounded-2xl border px-1 py-2.5 text-xs ${device.tapLayout === v ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300'}`}>
                <TapSketch layout={v} rtlTrack={rtlTrack} />
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-fog-500">
            {tr('Where a tap turns the page: the shaded part goes back, the lit part goes on, the rest shows the controls. Automatic turns pages in Paged mode only.')}
          </p>
        </Row>

        {/* v0.61.0: the keys and a game controller, on this device. Folded: most readers never change them. */}
        <div className="py-3">
          <Disclosure label={`${tr('Keys and controller')} · ${tr('This device')}`}>
            <ReaderKeys mode={prefs.mode} keys={device.keys} pad={device.pad} padConnected={padConnected}
              onKeys={(keys) => setDevice({ keys })} onPad={(pad) => setDevice({ pad })} />
          </Disclosure>
        </div>

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
