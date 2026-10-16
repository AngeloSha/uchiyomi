import sharp from 'sharp';

/**
 * Finding spreads that a source cut in two (#229, @Squeaks72's detector). A double-page spread scanned as two portrait
 * images has one picture running across the seam: the inner edge of one page and the inner edge of the next carry the
 * same lines at the same heights. Two unrelated pages almost never do, and a blank or solid edge says nothing either way,
 * so only edges with something drawn on them count.
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
 *
 * ⚠️ Correlation alone joined two separate pages far more often than it found a spread on a wider library (v0.77.0's
 * calibration: 375 chapters across 171 series, read-only, every join looked at by eye: 12 true spreads of 80 joins). Two
 * facing pages whose page borders line up -- a black bleed on both, a white gutter crossed by panel borders at the same
 * heights -- have edges that are the same few bands, and correlate at 0.95 and more. Neither is one picture. Three
 * tests, each true of every spread there, removed every one of those (JOIN_VERSION 3):
 *  - **the same texture** on both sides of the cut (`sameTexture`): two neighbouring columns of one drawing have the same
 *    share of mid-tones and of still stretches, where a border is all black or white and still;
 *  - **the small changes line up** (`detail`), not just the bands: the steps down one edge correlate with the other's;
 *  - **nothing else fits** (joinsFor): neither edge meets the facing edge of any other page of its chapter at RIVAL --
 *    an edge that fits other pages as well is a layout the pages share, not a seam.
 *
 * Run only by the background measure (lib/spreadMeasure.ts), never on a request: reading the edges decodes and resizes
 * every portrait page of a chapter, tens of milliseconds a page.
 */

const ROWS = 1000;
/** Rows averaged into one profile value: 1000 / 4 = 250 values down an edge. Coarser and the thin panel borders that carry a match wash out. */
const BIN = 4;
/** Columns in from the edge that are tried as "the edge", for a cut that took a pixel or two of the picture. */
const DEPTH = 3;
const OFFSETS: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2]];

/** Bumped whenever the answer changes, so a chapter an older detector measured is measured again (lib/spreadMeasure.ts). */
export const JOIN_VERSION = 3;

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

/** The best seam over the column offsets of the cut: `a` and `b` are the profiles' per-depth columns, and the two that met. */
function bestSeam(a: Float32Array[], b: Float32Array[]): { score: number; a: Float32Array | null; b: Float32Array | null } {
  let best = { score: 0, a: null as Float32Array | null, b: null as Float32Array | null };
  for (const [i, j] of OFFSETS) {
    if (!a[i] || !b[j]) continue;
    const s = seam(a[i], b[j]);
    if (s > best.score) best = { score: s, a: a[i], b: b[j] };
  }
  return best;
}

/** How much of an edge is mid-tone, and how much of it stands still from one value down to the next. */
function texture(a: Float32Array): { mid: number; still: number } {
  let mid = 0, still = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > SEAM.dark && a[i] < SEAM.light) mid++;
    if (i && Math.abs(a[i] - a[i - 1]) < SEAM.stillStep) still++;
  }
  return { mid: mid / a.length, still: still / (a.length - 1) };
}

/**
 * Two edges of one picture cut down the middle look alike: the same share of mid-tones and of still stretches. And they
 * are drawn: an edge nearly all black or white and still is a page's border, which no spread is cut through.
 */
export function sameTexture(a: Float32Array, b: Float32Array): boolean {
  const ta = texture(a), tb = texture(b);
  const border = (t: { mid: number; still: number }) => t.still >= SEAM.borderStill && t.mid <= SEAM.borderMid;
  if (border(ta) || border(tb)) return false;
  return Math.abs(ta.mid - tb.mid) <= SEAM.textureTol && Math.abs(ta.still - tb.still) <= SEAM.textureTol;
}

/** How well the small changes down two edges line up: the correlation of their steps from one value to the next. */
export function detail(a: Float32Array, b: Float32Array): number {
  const n = a.length - 1;
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i + 1] - a[i]; mb += b[i + 1] - b[i]; }
  ma /= n; mb /= n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i + 1] - a[i] - ma, db = b[i + 1] - b[i] - mb;
    c += da * db; va += da * da; vb += db * db;
  }
  return va && vb ? c / Math.sqrt(va * vb) : 0;
}

/**
 * The detector's bars. minCorr, sizeTol, maxAspect, stripAspect and minSd are #229's; textureTol (with dark, light and
 * stillStep, what texture() counts), borderStill/borderMid, minDetail, rival and edgeMidTol are v0.77.0's, from its
 * calibration (the note at the top): every true spread there had at most 0.55 of its edge still, at least 0.13 in
 * mid-tones, and outermost columns within 0.07 of each other in mid-tones.
 */
export const SEAM = {
  minSd: 8, minCorr: 0.65, sizeTol: 0.02, maxAspect: 2.0, stripAspect: 1.8,
  dark: 40, light: 215, stillStep: 2, textureTol: 0.1, borderStill: 0.75, borderMid: 0.15, minDetail: 0.25, rival: 0.6,
  edgeMidTol: 0.2,
};

/** Both ways across the seam from page `a` to the page after it, as joinDirection weighs them (for a calibration's numbers). */
export function seamScores(a: EdgeProfile, b: EdgeProfile): { rtl: number; ltr: number } {
  return { rtl: bestSeam(a.left, b.right).score, ltr: bestSeam(a.right, b.left).score };
}

/** The edge of `p` that faces the next page across a seam running `dir`, and the edge of that next page facing back. */
const facing = (p: EdgeProfile, dir: 'rtl' | 'ltr', side: 'first' | 'second'): Float32Array[] =>
  (dir === 'rtl') === (side === 'first') ? p.left : p.right;

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
  const r = bestSeam(a.left, b.right), l = bestSeam(a.right, b.left);
  const rtl = r.score >= SEAM.minCorr, ltr = l.score >= SEAM.minCorr;
  if (rtl === ltr) return null;
  // One picture across the seam, not two borders that line up (the note at the top).
  const m = rtl ? r : l;
  if (!m.a || !m.b || !sameTexture(m.a, m.b) || detail(m.a, m.b) < SEAM.minDetail) return null;
  // And the very edges are the same kind of thing. The offsets let a cut that took a pixel or two of the picture meet
  // a little way in, but a page whose outermost column is blank paper beside one drawn to the edge is two pages, however
  // well their insides line up (the one false join v0.77.0's second, unseen sample found).
  const ea = rtl ? a.left[0] : a.right[0], eb = rtl ? b.right[0] : b.left[0];
  if (Math.abs(texture(ea).mid - texture(eb).mid) > SEAM.edgeMidTol) return null;
  return rtl ? 'rtl' : 'ltr';
}

/**
 * Whether the seam from page `i` to the next (running `dir`) fits nothing else: neither edge meets the facing edge of any
 * other page of the chapter at SEAM.rival. Two facing pages built on one layout meet a dozen other pages as well as each other.
 */
function onlyFit(profiles: Array<EdgeProfile | null>, i: number, dir: 'rtl' | 'ltr'): boolean {
  const a = profiles[i]!, b = profiles[i + 1]!;
  const ea = facing(a, dir, 'first'), eb = facing(b, dir, 'second');
  for (let j = 0; j < profiles.length; j++) {
    const p = profiles[j];
    if (j === i || j === i + 1 || !p?.left.length) continue;
    if (bestSeam(ea, facing(p, dir, 'second')).score >= SEAM.rival || bestSeam(eb, facing(p, dir, 'first')).score >= SEAM.rival) return false;
  }
  return true;
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
    const d = p && n ? joinDirection(p, n) : null;
    return d && onlyFit(profiles, i, d) ? d : null;
  });
  return raw.map((d, i) => (d && !raw[i - 1] && !raw[i + 1] ? d : null));
}
