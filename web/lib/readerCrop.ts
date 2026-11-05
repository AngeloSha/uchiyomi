// Drawing PART of a page (v0.61.0): one half of a wide page (Reader → Wide pages → Split), and a page with its blank
// margins cropped away (Reader → Crop page borders).
//
// Both are the same geometry: a region of the image, given as the fractions trimmed off each side, drawn into a box
// of the region's own shape -- the box clips, and the image inside is scaled up and shifted so the region fills it.
// Nothing is cut on the server: the originals are served as they are, a downloaded chapter is blobs on the device,
// and the webtoon column needs a page's height before its image has loaded, so the crop is decided here, from the
// pixels, and drawn with CSS.

/** A region of an image as the fraction trimmed off each side: left, top, right, bottom. All zero is the whole page. */
export interface Region { l: number; t: number; r: number; b: number }

export const WHOLE: Region = { l: 0, t: 0, r: 0, b: 0 };
/** The left and right halves of a wide page. */
export const LEFT_HALF: Region = { l: 0, t: 0, r: 0.5, b: 0 };
export const RIGHT_HALF: Region = { l: 0.5, t: 0, r: 0, b: 0 };

/**
 * How to draw `region` of an image: the box's aspect relative to the whole image's (`sx`, `sy`: the share of its
 * width and height the region keeps), and the image's style inside that box -- sized so the region fills it, and
 * shifted so the region is what shows. The box must clip (`overflow: hidden`) and the image must not be capped
 * (`max-width: none`).
 */
export function cropStyle(region: Region): { sx: number; sy: number; img: { width: string; height: string; transform: string } } {
  const sx = Math.max(1e-6, 1 - region.l - region.r);
  const sy = Math.max(1e-6, 1 - region.t - region.b);
  const pct = (n: number) => `${+(n * 100).toFixed(4)}%`;
  return {
    sx,
    sy,
    img: {
      width: pct(1 / sx),
      height: pct(1 / sy),
      // Percentages of the IMAGE's own size, which is what a translate is measured in: a left trim of l moves the
      // image l of its own width to the left.
      transform: region.l || region.t ? `translate(-${pct(region.l)}, -${pct(region.t)})` : 'none',
    },
  };
}

/** The largest box of aspect `aw` : `ah` that fits inside `w` x `h`. Zero for an empty or unmeasured box. */
export function fitBox(aw: number, ah: number, w: number, h: number): { width: number; height: number } {
  if (!(aw > 0 && ah > 0 && w > 0 && h > 0)) return { width: 0, height: 0 };
  const s = Math.min(w / aw, h / ah);
  return { width: aw * s, height: ah * s };
}

// ---- finding the margins (Reader → Crop page borders) ----

/** A corner counts as paper when every channel is at least this light, or as a black border when none is above DARK. */
const LIGHT = 220;
const DARK = 35;
/** How far from the paper's brightness a pixel must be to be ink. */
const INK = 40;
/** A row or column is content when more than this share of it is ink: a speck of dust or a JPEG ring is not. */
const CONTENT = 0.01;
/** A trim smaller than this is not worth the jump it makes. */
const MIN_TRIM = 0.01;
/** No side is ever trimmed by more than this: past it, it is not a margin, it is the page. */
export const MAX_TRIM = 0.15;

const lum = (p: ArrayLike<number>, i: number) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

/**
 * The blank margins of a page, from its pixels (`rgba`, `w` x `h`, as a canvas's getImageData gives them): the share
 * of each side that is paper. WHOLE -- nothing to trim -- when the page has no clear paper to find, or is mostly blank.
 *
 * The paper is what the corners are, when at least three of them agree on near-white or near-black: a page whose art
 * runs off one corner still has paper at the other three. A row or a column is content when more than 1 % of it is ink
 * -- anything that far from the paper's brightness -- so a speck is not content and a thin rule is. Each side is
 * trimmed to its first row or column of content; a trim under 1 % is not made, none passes 15 %, and a page with more
 * than half of either dimension blank (a title page, a blank) is not trimmed at all. `sidesOnly` looks at the left
 * and right only, for the webtoon column, where a strip's top and bottom are where it joins its neighbours.
 */
export function contentBox(rgba: ArrayLike<number>, w: number, h: number, opts: { sidesOnly?: boolean } = {}): Region {
  if (!(w > 0 && h > 0) || rgba.length < w * h * 4) return WHOLE;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  const light = corners.filter((i) => rgba[i] >= LIGHT && rgba[i + 1] >= LIGHT && rgba[i + 2] >= LIGHT);
  const dark = corners.filter((i) => rgba[i] <= DARK && rgba[i + 1] <= DARK && rgba[i + 2] <= DARK);
  const paperAt = light.length >= 3 ? light : dark.length >= 3 ? dark : null;
  if (!paperAt) return WHOLE;
  const paper = paperAt.reduce((sum, i) => sum + lum(rgba, i), 0) / paperAt.length;
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(lum(rgba, (y * w + x) * 4) - paper) > INK) { rows[y]++; cols[x]++; }
    }
  }
  const colIsContent = (x: number) => cols[x] > h * CONTENT;
  const rowIsContent = (y: number) => rows[y] > w * CONTENT;
  let left = 0;
  while (left < w && !colIsContent(left)) left++;
  if (left === w) return WHOLE; // not a single column of content: a blank page
  let right = w - 1;
  while (right > left && !colIsContent(right)) right--;
  let l = left / w;
  let r = (w - 1 - right) / w;
  let t = 0;
  let b = 0;
  if (!opts.sidesOnly) {
    let top = 0;
    while (top < h && !rowIsContent(top)) top++;
    if (top === h) return WHOLE;
    let bottom = h - 1;
    while (bottom > top && !rowIsContent(bottom)) bottom--;
    t = top / h;
    b = (h - 1 - bottom) / h;
  }
  if (l + r > 0.5 || t + b > 0.5) return WHOLE; // mostly blank: whatever is on it is not what the margins frame
  const trim = (v: number) => (v < MIN_TRIM ? 0 : Math.min(MAX_TRIM, v));
  [l, r, t, b] = [trim(l), trim(r), trim(t), trim(b)];
  return l || r || t || b ? { l, t, r, b } : WHOLE;
}

/** Pages whose margins must agree, in the webtoon column, before a chapter is trimmed at all. */
export const CHAPTER_SAMPLE = 3;
/** How far apart, as a share of the width, those pages' margins may be and still count as the same. */
const AGREE = 0.02;

/**
 * One trim for a whole chapter of the webtoon column, from the margins of its first measured story pages (`boxes`, in
 * order; at least `need` of them, which the reader makes CHAPTER_SAMPLE or the chapter's story pages if fewer): each
 * side the smallest of them, and nothing at all on a side where they differ by more than 2 %. One trim, so the strips
 * keep one scale and their joins line up. null until there are enough to decide; the reader then keeps the answer
 * for the rest of the session, so the column never changes scale twice.
 */
export function chapterSideCrop(boxes: readonly Region[], need = CHAPTER_SAMPLE): { l: number; r: number } | null {
  if (need < 1 || boxes.length < need) return null;
  const sample = boxes.slice(0, Math.min(CHAPTER_SAMPLE, Math.max(need, 1)));
  const side = (k: 'l' | 'r') => {
    const v = sample.map((x) => x[k]);
    return Math.max(...v) - Math.min(...v) <= AGREE ? Math.min(...v) : 0;
  };
  return { l: side('l'), r: side('r') };
}

/**
 * The trims of a double spread's two pages, left page first: one top and one bottom for both (the smaller of each), so
 * the pair stays the same height, and nothing off the gutter between them -- a drawing that runs across it must join.
 */
export function pairCrop(left: Region, right: Region): [Region, Region] {
  const t = Math.min(left.t, right.t);
  const b = Math.min(left.b, right.b);
  return [{ l: left.l, t, r: 0, b }, { l: 0, t, r: right.r, b }];
}

/** One half of a wide page with the page's trims: its outer side, its top and its bottom -- never the middle. */
export function halfCrop(half: 'left' | 'right', c: Region): Region {
  return half === 'left' ? { l: c.l, t: c.t, r: 0.5, b: c.b } : { l: 0.5, t: c.t, r: c.r, b: c.b };
}
