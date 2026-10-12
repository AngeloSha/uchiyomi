// The reader's settings that belong to ONE DEVICE, not to the account (v0.61.0).
//
// A colour filter is a property of the screen it is read on -- an e-ink tablet wants e-ink, the phone beside it does
// not -- and so is how a hand reaches it. These are kept in this browser only and never synced: the account's reader
// settings (lib/readerPrefs.ts) follow you; these stay where they were set.
//
// ⚠️ The key must never start with `yomi_rs_` or `yomi_rp_`: lib/readerPrefs.ts collects every key under those
// prefixes and pushes it to the account as a series' or a source's reader memory.
import { TAP_LAYOUTS, type TapLayout } from './readerGesture';
import { cleanKeyOverrides, type KeyOverrides } from './readerKeys';
import { cleanPadOverrides, type PadOverrides } from './readerPad';

/** A filter over the page images (never the reader's own cards): none, light-for-dark, grey, or e-ink. */
export type ColorFilter = 'none' | 'invert' | 'grayscale' | 'eink';
export const COLOR_FILTERS: readonly ColorFilter[] = ['none', 'invert', 'grayscale', 'eink'];

export interface DevicePrefs {
  colorFilter: ColorFilter;
  /** Where taps turn the page (lib/readerGesture.ts). `auto` is the reader as it always was. */
  tapLayout: TapLayout;
  /** This device's own keys and controller buttons, per action; an action not here keeps its defaults. */
  keys: KeyOverrides;
  pad: PadOverrides;
}

export const DEFAULT_DEVICE: DevicePrefs = {
  colorFilter: 'none',
  tapLayout: 'auto',
  keys: {},
  pad: {},
};

export const DEVICE_KEY = 'yomi_reader_device';

/** A stored object made whole: every key a known value, anything unknown the default (which is today's reader). */
export function migrateDevicePrefs(raw: unknown): DevicePrefs {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<DevicePrefs>;
  return {
    colorFilter: COLOR_FILTERS.includes(r.colorFilter as ColorFilter) ? r.colorFilter! : DEFAULT_DEVICE.colorFilter,
    tapLayout: TAP_LAYOUTS.includes(r.tapLayout as TapLayout) ? r.tapLayout! : DEFAULT_DEVICE.tapLayout,
    // A binding that is reserved (Escape, Tab), carries Ctrl/Alt/Meta, or is not a key at all is dropped; so is a
    // button index that is not one.
    keys: cleanKeyOverrides(r.keys),
    pad: cleanPadOverrides(r.pad),
  };
}

export function loadDevicePrefs(): DevicePrefs {
  if (typeof window === 'undefined') return DEFAULT_DEVICE;
  try {
    return migrateDevicePrefs(JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}'));
  } catch {
    return DEFAULT_DEVICE;
  }
}

export function saveDevicePrefs(p: DevicePrefs) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(p)); } catch { /* private mode: this session only */ }
}

/**
 * The CSS filter each colour filter lays over a page IMAGE. On the image, not on the column or the track: the theme's
 * filter (THEME_FILTER) stays where it is, so the reader's own cards -- Up Next, a failure -- look as they always have,
 * and inverting a page never inverts the buttons beside it. `invert` turns the hues back after inverting, so a red
 * stays red; `eink` is grey with more contrast, as an e-ink screen draws it. `none` sets nothing at all.
 */
export const COLOR_FILTER: Record<ColorFilter, string | undefined> = {
  none: undefined,
  invert: 'invert(1) hue-rotate(180deg)',
  grayscale: 'grayscale(1)',
  eink: 'grayscale(1) contrast(1.3)',
};

/**
 * How a page turn or a step down the column moves. An e-ink screen cannot draw a glide -- it smears it into a dozen
 * ghosted refreshes -- so under E-ink every move is a jump. Everywhere else, as before, a glide.
 */
export function glide(f: ColorFilter): ScrollBehavior {
  return f === 'eink' ? 'auto' : 'smooth';
}
