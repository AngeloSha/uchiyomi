import sharp from 'sharp';

/**
 * Finding spreads that a source cut in two. A double-page spread scanned as two portrait images has one picture
 * running across the seam: the inner edge of one page and the inner edge of the next carry the same lines at the
 * same heights. Two unrelated pages almost never do, and a blank or solid edge says nothing either way, so only
 * edges with something drawn on them count.
 *
 * Calibrated on 40 One Piece chapters (the old 160-row, mean-abs-difference test found 5% of neighbouring
 * pairs and missed spreads a reader can see: One Piece 1154 had three, it found none). Two things were wrong with it:
 *  - it shrank the width along with the height, to 160 rows, so the "edge" was an average of ~7 px of picture and the seam was
 *    blurred away; the edge is now read at its own columns of a page scaled to ROWS tall;
 *  - it also demanded that the edges match in BRIGHTNESS (mad <= 14), which a spread's two halves do not: halftone and
 *    JPEG put a tone offset between pages. Correlation is what survives that.
 * The bar is set from a null: a page's edge scored against the edge of every NON-neighbour in its chapter clears
 * 0.65 about 0.03% of the time, while 18% of true neighbours clear it (and it is flat from 0.6 to 0.7: a clean split). The cut is sometimes a
 * pixel or two off, so a few column offsets are tried and the best one counts.
 */

const ROWS = 1000;
/** Rows averaged into one profile value: 1000 / 4 = 250 values down an edge. Coarser and the thin panel borders that carry a match wash out. */
const BIN = 4;
/** Columns in from the edge that are tried as "the edge", for a cut that took a pixel or two of the picture. */
const DEPTH = 3;
const OFFSETS: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2]];

/** Bumped whenever the answer changes, so lib_books.page_dims rows measured by an older detector are measured again. */
export const JOIN_VERSION = 2;

export interface EdgeProfile {
  width: number;
  height: number;
  /** Per column in from the edge (0..DEPTH-1): ROWS / BIN grey values down the page's left / right edge, 0 to 255. */
  left: Float32Array[];
  right: Float32Array[];
}

export async function edgeProfile(bytes: Buffer): Promise<EdgeProfile | null> {
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height) return null;
    // Only a manga-shaped portrait can be half of a spread; skip the (costly, for a webtoon strip) resize for the rest.
    if (meta.width >= meta.height || meta.height / meta.width > SEAM.maxAspect) {
      return { width: meta.width, height: meta.height, left: [], right: [] };
    }
    const w = Math.max(2 * DEPTH, Math.round((meta.width / meta.height) * ROWS));
    const { data } = await sharp(bytes).greyscale().resize(w, ROWS, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const column = (x: number) => {
      const out = new Float32Array(ROWS / BIN);
      for (let r = 0; r < out.length; r++) {
        let sum = 0;
        for (let y = r * BIN; y < (r + 1) * BIN; y++) sum += data[y * w + x];
        out[r] = sum / BIN;
      }
      return out;
    };
    const left: Float32Array[] = [], right: Float32Array[] = [];
    for (let k = 0; k < DEPTH; k++) { left.push(column(k)); right.push(column(w - 1 - k)); }
    return { width: meta.width, height: meta.height, left, right };
  } catch { return null; }
}

const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: Float32Array) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

/** How well two edges continue one picture: their correlation down the page. 0 when either has nothing drawn on it. */
export function seam(a: Float32Array, b: Float32Array): number {
  const sdA = sd(a), sdB = sd(b);
  if (sdA < SEAM.minSd || sdB < SEAM.minSd) return 0;
  const ma = mean(a), mb = mean(b);
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += (a[i] - ma) * (b[i] - mb);
  return cov / a.length / (sdA * sdB);
}

/** The best seam over the column offsets of the cut: `a` and `b` are the profiles' per-depth columns. */
function bestSeam(a: Float32Array[], b: Float32Array[]): number {
  let best = 0;
  for (const [i, j] of OFFSETS) if (a[i] && b[j]) best = Math.max(best, seam(a[i], b[j]));
  return best;
}

export const SEAM = { minSd: 8, minCorr: 0.65, sizeTol: 0.02, maxAspect: 2.0, stripAspect: 1.8 };

/**
 * Which way the picture runs across the seam from page `a` to the page after it: 'rtl' when a's LEFT edge meets
 * b's RIGHT edge (b sits on the left of the spread), 'ltr' when a's right edge meets b's left. null when neither,
 * or when both do (an edge that matches everything proves nothing).
 */
export function joinDirection(a: EdgeProfile, b: EdgeProfile): 'rtl' | 'ltr' | null {
  if (Math.abs(a.height - b.height) / Math.max(a.height, b.height) > SEAM.sizeTol) return null;
  if (Math.abs(a.width - b.width) / Math.max(a.width, b.width) > SEAM.sizeTol) return null;
  // Manga pages run about 1.4-1.5 tall to wide; a webtoon strip is far taller and its panels butt together by design.
  if (a.width >= a.height || b.width >= b.height) return null;
  if (a.height / a.width > SEAM.maxAspect || b.height / b.width > SEAM.maxAspect) return null;
  if (!a.left.length || !b.left.length) return null;
  const rtl = bestSeam(a.left, b.right) >= SEAM.minCorr, ltr = bestSeam(a.right, b.left) >= SEAM.minCorr;
  return rtl === ltr ? null : rtl ? 'rtl' : 'ltr';
}

/**
 * Never in a webtoon chapter (a fifth of its pages are taller than a manga page). For each page, whether it and the page after it are one split spread, and which way. A page that seems to join
 * BOTH its neighbours is a repeating background (the grid behind a Q&A page) or a gradient, not a spread: a page is in
 * at most one spread, so any run of consecutive matches is dropped whole.
 */
export function joinsFor(profiles: Array<EdgeProfile | null>): Array<'rtl' | 'ltr' | null> {
  // A webtoon chapter reads as one column and has nothing to join: when a good share of its pages are strips, none are.
  const known = profiles.filter((p): p is EdgeProfile => !!p);
  if (known.filter((p) => p.height / p.width > SEAM.stripAspect).length >= known.length * 0.2) return profiles.map(() => null);
  const raw = profiles.map((p, i) => {
    const n = profiles[i + 1];
    return p && n ? joinDirection(p, n) : null;
  });
  return raw.map((d, i) => (d && !raw[i - 1] && !raw[i + 1] ? d : null));
}

/** Both halves, side by side at the first one's height, as one JPEG. `dir` is joinDirection's: 'rtl' puts `second` on the left. */
export async function stitchSpread(first: Buffer, second: Buffer, dir: 'rtl' | 'ltr'): Promise<Buffer> {
  const [left, right] = dir === 'rtl' ? [second, first] : [first, second];
  const h = (await sharp(first).metadata()).height!;
  const l = await sharp(left).resize({ height: h, fit: 'fill' }).toBuffer({ resolveWithObject: true });
  const r = await sharp(right).resize({ height: h, fit: 'fill' }).toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: l.info.width + r.info.width, height: h, channels: 3, background: '#ffffff' } })
    .composite([{ input: l.data, left: 0, top: 0 }, { input: r.data, left: l.info.width, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
