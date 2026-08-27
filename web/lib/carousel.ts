/**
 * Which position dots to draw when there are more slides than room for them.
 *
 * The Discover hero rendered one dot per slide, inline, on the same row as its call-to-action button, with
 * no wrap and no cap. At five slides that is about 72px and fine. At ten it is roughly 130px next to a
 * padded button inside a padded container, which overflows a phone -- and the browser end-to-end suite fails
 * the page on any horizontal overflow, so "add more slides" and "keep the dots" were in direct conflict.
 *
 * A sliding window resolves it: the row's width becomes a constant, so slide count and layout stop being
 * coupled at all. Tap-to-jump survives for every visible dot, which a bare "3 / 10" counter would lose.
 */
export interface DotWindow {
  /** Indices to render, in order. */
  items: number[];
  /** True when there are slides before the first / after the last shown, so those ends shrink as a hint. */
  moreBefore: boolean;
  moreAfter: boolean;
}

export function dotWindow(total: number, active: number, max = 5): DotWindow {
  if (total <= max) {
    return { items: Array.from({ length: Math.max(0, total) }, (_, i) => i), moreBefore: false, moreAfter: false };
  }
  // Centre on the active slide, then clamp so the window never runs off either end. Without the clamp the
  // first and last slides would sit against the edge of a half-empty row.
  const half = Math.floor(max / 2);
  const start = Math.min(Math.max(0, active - half), total - max);
  return {
    items: Array.from({ length: max }, (_, i) => start + i),
    moreBefore: start > 0,
    moreAfter: start + max < total,
  };
}
