// Which pages of the webtoon column hold a full-size image, which are fetched ahead, when the next chapter is
// appended, and how the reader keeps its place when the layout moves (v0.61.0).
//
// The column used to keep a window of PAGES: two behind, six ahead. A chapter of thin slices filled two screens with
// that, and a chapter stitched into long strips (Eleceed 215 on the live server: two 689 x 54,000 images) put nine
// strips in it -- about 1.3 GB of decoded pixels for a phone. A window of SCREENS spends the same budget on what is
// actually near the reader: a strip chapter keeps at most three full-size images, a chapter of slices fills four
// screens ahead. Pages further on are fetched as bytes only (the server serves pages `private, max-age=31536000,
// immutable`, so the `<img>` that comes later is answered from the cache) and decoded when the window reaches them.
//
// Pure arithmetic over the reader's height model (`tops`, `heights`), which the reader computes and never measures
// back from the DOM, so every rule here is tested without a browser (test/readerWindow.test.ts).

/** Screens kept decoded behind the one in view. */
export const BEHIND_SCREENS = 1.5;
/** Screens kept decoded ahead of the one in view. */
export const AHEAD_SCREENS = 4;
/** How close to the end of what is loaded, in screens, the next chapter is appended. */
export const APPEND_SCREENS = 6;
/** How far, in screens, a downloaded page's image is kept in memory before it is released. */
export const KEEP_SCREENS = 6;
/** The most pages the window ever holds, however thin they are. */
export const MAX_WINDOW_PAGES = 40;

/** A span of the flow, by index, both ends included; `to < from` is empty. */
export interface IndexRange { from: number; to: number }
/** The part of the column on screen: its scroll offset and its height, in the height model's pixels. */
export interface View { top: number; height: number }

/** The last item whose top is at or above `y` -- the item `y` falls in, or in the gap after. 0 when `y` is above them all. */
export function indexAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** The items the screen in view touches, widened by `behind` screens above it and `ahead` screens below. */
export function screenRange(tops: readonly number[], heights: readonly number[], view: View, behind: number, ahead: number): IndexRange {
  if (!tops.length || heights.length !== tops.length) return { from: 0, to: -1 };
  const h = Math.max(1, view.height);
  return { from: indexAt(tops, view.top - behind * h), to: indexAt(tops, view.top + h + ahead * h) };
}

/**
 * The pages that hold a full-size image: those in `range`, the current page always, at most `max` of them.
 *
 * ⚠️ A collapsed page never counts and is never in: it is drawn from a thumbnail, so counting it shortened the real
 * lookahead by one page for every repeated page in range (lib/readerFlow.ts renderWindow says the same).
 * Under the cap the pages AHEAD are taken first, then those behind, nearest first: the reader is about to see the
 * former, and has already seen the latter.
 */
export function windowSet(flow: ReadonlyArray<{ collapsed?: boolean }>, range: IndexRange, current: number, max = MAX_WINDOW_PAGES): Set<number> {
  const s = new Set<number>();
  if (current >= 0 && current < flow.length && !flow[current].collapsed) s.add(current);
  for (let i = Math.max(current + 1, range.from, 0); i <= range.to && i < flow.length && s.size < max; i++) {
    if (!flow[i].collapsed) s.add(i);
  }
  for (let i = Math.min(current - 1, range.to, flow.length - 1); i >= range.from && i >= 0 && s.size < max; i--) {
    if (!flow[i].collapsed) s.add(i);
  }
  return s;
}

/** What a page of unknown size is counted as by the prefetch budget: a typical scanned page. */
const UNKNOWN_PIXELS = 2e6;

/**
 * The pages after `after` to fetch ahead, as bytes: at most `pages` of them, and no more pixels than `pixels`
 * together (the first one always, however large). Collapsed pages are drawn from a thumbnail and are skipped.
 */
export function prefetchList(
  flow: ReadonlyArray<{ collapsed?: boolean; width?: number | null; height?: number | null }>,
  after: number,
  budget: { pages: number; pixels: number } = { pages: 6, pixels: 48e6 },
): number[] {
  const out: number[] = [];
  let spent = 0;
  for (let i = Math.max(0, after + 1); i < flow.length && out.length < budget.pages; i++) {
    const it = flow[i];
    if (it.collapsed) continue;
    const px = it.width && it.height && it.width > 0 && it.height > 0 ? it.width * it.height : UNKNOWN_PIXELS;
    if (out.length && spent + px > budget.pixels) break;
    out.push(i);
    spent += px;
  }
  return out;
}

/** Whether the bottom of the screen in view is within `screens` screens of the end of what is loaded (`total` px). */
export function nearEnd(total: number, view: View, screens: number): boolean {
  return view.top + view.height >= total - screens * Math.max(1, view.height);
}

/** A place in the column that survives a change of layout: an item, and how far down it, as a fraction of its height. */
export interface Anchor { index: number; frac: number }

/** The item at `y` and how far down it `y` is (0 at its top, 1 at its bottom or in the gap after it). */
export function anchorAt(tops: readonly number[], heights: readonly number[], y: number): Anchor {
  const index = indexAt(tops, y);
  const h = heights[index] ?? 0;
  const frac = h > 0 ? Math.max(0, Math.min(1, (y - (tops[index] ?? 0)) / h)) : 0;
  return { index, frac };
}

/**
 * The scroll offset that puts `anchor` back under the probe -- the point `probe` px below the top of the screen it was
 * taken at -- once the layout has changed: a zoom, a page above it growing (a repeated page opened, a crop measured),
 * or the anchored page itself changing height.
 */
export function scrollTopFor(anchor: Anchor, tops: readonly number[], heights: readonly number[], probe: number): number {
  if (!tops.length) return 0;
  const i = Math.max(0, Math.min(tops.length - 1, anchor.index));
  return Math.max(0, tops[i] + anchor.frac * (heights[i] ?? 0) - probe);
}
