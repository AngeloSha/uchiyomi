// Pages at the size this screen shows them (#234, Reader → Fit pages to my screen: this device, off by default).
//
// A phone was sent the 4,000 px scan to show at 400 px. With the switch on, the reader asks for each page at the width
// it is DRAWN at -- the webtoon column or the slide, the zoom, a wide page split in two or turned on its side, Crop page
// borders -- in device pixels, rounded UP to a few widths the server keeps a copy of (bff routes/images.ts
// pageForScreen). Never softer than the screen: a width is never below what is drawn, past the last one the page comes
// as scanned, and a page once asked for sharper is never asked for again at less (a zoom out keeps what the zoom in
// fetched, from the browser's cache).
//
// ⚠️ The width is of the page's WHOLE width, however it is drawn. A wide page split in two shows each half as wide as
// the slide, so the page is drawn twice that; a page turned on its side lays its width down the screen's height; a page
// with its borders cropped is drawn wider than its box by what is cropped. The PR this came from asked for the column's
// width before the zoom, and every one of those looked soft (the 10-15 review).
import { MAX_TRIM } from './readerCrop';
import type { WidePages } from './readerSpread';

/** The widths a page is asked for at. The server keeps a copy of a page per width, so screens of a size share them. */
export const FIT_WIDTHS = [720, 1080, 1440, 2000] as const;
/** Device pixels per CSS pixel counted at most: past 3x the eye cannot tell, and a 4x phone would always get the scan. */
const MAX_DPR = 3;
/**
 * How much wider than its box a cropped page can be drawn: Crop page borders trims up to MAX_TRIM a side, so a page's
 * width can be stretched by 1 / (1 - 2 × MAX_TRIM). The trim is measured from the page's own pixels once it has LOADED,
 * so the width asked for cannot wait for it: the most it can be is asked for from the start.
 */
export const CROP_GROWS = 1 / (1 - 2 * MAX_TRIM);

/**
 * The width to ask for: `cssWidth` in device pixels (at most 3x), rounded UP to a width of FIT_WIDTHS. 0 -- the page as
 * scanned -- past the last one, or when nothing is measured yet.
 */
export function fitWidth(cssWidth: number, dpr: number): number {
  if (!(cssWidth > 0) || !Number.isFinite(cssWidth)) return 0;
  const want = cssWidth * Math.min(MAX_DPR, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
  return FIT_WIDTHS.find((w) => w >= want) ?? 0;
}

/** How a page is laid out, as far as the width it is drawn at goes. */
export type FitLayout =
  /** The webtoon column, `colW` wide (the zoom and the column width in it); `wide` is what this page is drawn as. */
  | { mode: 'column'; colW: number; wide: WidePages; crop: boolean }
  /**
   * A slide of the paged track, `w` x `h`: the page on its own, one of a `pair`, one `half` of a wide page split in two,
   * or `rotate`d on its side; scaled by `zoom`.
   */
  | { mode: 'slide'; w: number; h: number; zoom: number; pair: boolean; half: boolean; rotate: boolean; crop: boolean };

type Dims = { width?: number | null; height?: number | null };
const known = (p: Dims): p is { width: number; height: number } =>
  typeof p.width === 'number' && typeof p.height === 'number' && p.width > 0 && p.height > 0;

/** The width a page `pw` x `ph` is drawn at, fitted whole into a box `bw` x `bh` (object-contain). */
export const containWidth = (pw: number, ph: number, bw: number, bh: number): number => Math.min(bw, bh * (pw / ph));

/** The CSS width a page's WHOLE width is drawn at, laid out as `l`. A page whose size is unknown: as wide as it may be. */
export function drawnWidth(page: Dims, l: FitLayout): number {
  const grow = l.crop ? CROP_GROWS : 1;
  if (l.mode === 'column') {
    if (!known(page) || l.wide === 'whole') return l.colW * grow;
    // A wide page split in two is two halves one above the other, each as wide as the column; turned on its side, its
    // width runs down the column, as tall as lib/readerSpread.ts pageHeight makes the row.
    return l.wide === 'split' ? 2 * l.colW : l.colW * (page.width / page.height);
  }
  const box = l.pair ? l.w / 2 : l.w;
  if (!known(page)) return box * l.zoom * grow;
  const pw = page.width, ph = page.height;
  const shown = l.half
    ? 2 * containWidth(pw / 2, ph, l.w, l.h)
    : l.rotate
      ? containWidth(ph, pw, l.w, l.h) * (pw / ph)
      : containWidth(pw, ph, box, l.h);
  return shown * l.zoom * grow;
}

/**
 * The width to ask for now, given the one asked for this page before (undefined: never): never less, so a page drawn
 * smaller again -- a zoom out, a phone turned back -- keeps the copy it has rather than fetching a softer one. 0 is the
 * page as scanned, which is more than any width.
 */
export function neverSofter(before: number | undefined, now: number): number {
  if (before === undefined) return now;
  if (before === 0 || now === 0) return 0;
  return Math.max(before, now);
}
