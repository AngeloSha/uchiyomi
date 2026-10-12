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
