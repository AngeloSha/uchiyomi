/**
 * Translated pages, step 1: reading the text. The arithmetic around PaddleOCR's two models (PP-OCRv6 small detection and
 * recognition; Korean recognition from PP-OCRv5), ported from RapidOCR (Apache-2.0) so it runs as plain JavaScript
 * around onnxruntime-web in the OCR worker (ocrWorker.ts). Pure functions: no model, no I/O, tested on their own.
 *
 * ⚠️ The models were trained on BGR images normalised to (x / 255 - 0.5) / 0.5. Feeding RGB still "works" and quietly
 * reads worse. Both tensors below swap the channels.
 */

/** Detection runs on the page scaled so its short side is at least this (RapidOCR's limit_type "min"). */
export const DET_MIN_SIDE = 736;
/** Pages are read at most this big on their long side (RapidOCR's max_side_len): a 4,000 px scan took 19 s, not 1. */
export const OCR_MAX_SIDE = 2000;
/** Recognition input height, and the narrowest batch width (RapidOCR's rec_img_shape [3, 48, 320]). */
export const REC_HEIGHT = 48;
export const REC_MIN_WIDTH = 320;
/** Lines are recognised this many at a time, narrowest first so a batch pads little. */
export const REC_BATCH = 6;

export interface Box { x0: number; y0: number; x1: number; y1: number; score: number; contentBox?: [number, number, number, number] }
export interface OcrLine {
  box: [number, number, number, number]; text: string; score: number; tall: boolean;
  /** Detector content before recognition's unclip/context padding, in the same image coordinates as box. */
  contentBox?: [number, number, number, number];
}

/** The detector's input size for a W x H image: short side at least DET_MIN_SIDE, both sides multiples of 32. */
export function detSize(W: number, H: number): { w: number; h: number } {
  const ratio = Math.min(W, H) < DET_MIN_SIDE ? DET_MIN_SIDE / Math.min(W, H) : 1;
  const r32 = (v: number) => Math.max(32, Math.round(Math.trunc(v * ratio) / 32) * 32);
  return { w: r32(W), h: r32(H) };
}

/** An RGB pixel buffer as a [3, h, w] float tensor, BGR order, normalised. */
export function bgrPlanes(rgb: Uint8Array, w: number, h: number): Float32Array {
  const plane = w * h;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    t[i] = rgb[i * 3 + 2] / 127.5 - 1;
    t[plane + i] = rgb[i * 3 + 1] / 127.5 - 1;
    t[2 * plane + i] = rgb[i * 3] / 127.5 - 1;
  }
  return t;
}

/**
 * Differentiable Binarization's boxes from the detector's probability map (w x h), in the coordinates of the W x H image
 * it was made from. RapidOCR's DBPostProcess with two simplifications that suit comics: a region's box is its
 * axis-aligned bounds rather than the minimum-area rotated rectangle, and its score is the mean over that box.
 * Threshold 0.3, a 2x2 dilation, score at least 0.5, grown by the "unclip" distance area x 1.6 / perimeter.
 */
export function dbBoxes(pred: ArrayLike<number>, w: number, h: number, W: number, H: number,
  opts: { thresh?: number; boxThresh?: number; unclip?: number } = {}): Box[] {
  const thresh = opts.thresh ?? 0.3, boxThresh = opts.boxThresh ?? 0.5, unclip = opts.unclip ?? 1.6;
  const n = w * h;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = pred[i] > thresh ? 1 : 0;
  // cv2.dilate with a 2x2 kernel anchors at its bottom-right cell: a pixel is set when it or its left, upper or
  // upper-left neighbour is.
  const dil = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      dil[i] = bin[i] | (x > 0 ? bin[i - 1] : 0) | (y > 0 ? bin[i - w] : 0) | (x > 0 && y > 0 ? bin[i - w - 1] : 0);
    }
  }
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const out: Box[] = [];
  const sx = W / w, sy = H / h;
  for (let i = 0; i < n; i++) {
    if (!dil[i] || seen[i]) continue;
    let sp = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack[sp++] = i; seen[i] = 1;
    while (sp) {
      const j = stack[--sp], x = j % w, y = (j / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (dil[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
        }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3) continue;
    let sum = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += pred[y * w + x];
    const score = sum / (bw * bh);
    if (score < boxThresh) continue;
    const d = (bw * bh * unclip) / (2 * (bw + bh));
    if (Math.min(bw, bh) + 2 * d < 5) continue;
    const b: Box = {
      x0: Math.max(0, Math.round((x0 - d) * sx)), y0: Math.max(0, Math.round((y0 - d) * sy)),
      x1: Math.min(W, Math.round((x1 + 1 + d) * sx)), y1: Math.min(H, Math.round((y1 + 1 + d) * sy)), score,
      contentBox: [Math.max(0, Math.round(x0 * sx)), Math.max(0, Math.round(y0 * sy)),
        Math.min(W, Math.round((x1 + 1) * sx)), Math.min(H, Math.round((y1 + 1) * sy))],
    };
    if (b.x1 - b.x0 > 3 && b.y1 - b.y0 > 3) out.push(b);
  }
  return out;
}

/** A line is read rotated a quarter turn when it is at least 1.5 times taller than wide (vertical text). */
export const isTall = (b: { x0: number; y0: number; x1: number; y1: number }) => (b.y1 - b.y0) / Math.max(1, b.x1 - b.x0) >= 1.5;

/** A crop's recognition width at REC_HEIGHT, keeping its aspect (after the quarter turn when tall), capped. */
export function recWidth(cropW: number, cropH: number): number {
  return Math.max(1, Math.min(Math.ceil(REC_HEIGHT * (cropW / Math.max(1, cropH))), REC_HEIGHT * 40));
}

/**
 * One recognition batch: crops already resized to REC_HEIGHT (RGB, each `w` wide) into a [n, 3, 48, W] tensor, padded on
 * the right with zeros (mid grey once normalised), W the widest crop or REC_MIN_WIDTH.
 */
export function recBatch(crops: { buf: Uint8Array; w: number }[]): { data: Float32Array; width: number } {
  const width = Math.max(REC_MIN_WIDTH, ...crops.map((c) => c.w));
  const plane = REC_HEIGHT * width;
  const data = new Float32Array(crops.length * 3 * plane);
  crops.forEach((c, k) => {
    const base = k * 3 * plane;
    for (let y = 0; y < REC_HEIGHT; y++) {
      for (let x = 0; x < c.w; x++) {
        const p = (y * c.w + x) * 3, q = y * width + x;
        data[base + q] = c.buf[p + 2] / 127.5 - 1;
        data[base + plane + q] = c.buf[p + 1] / 127.5 - 1;
        data[base + 2 * plane + q] = c.buf[p] / 127.5 - 1;
      }
    }
  });
  return { data, width };
}

/** The recogniser's alphabet: "blank" first, then the dictionary, then a space (RapidOCR's CTCLabelDecode). */
export function alphabet(dict: string): string[] {
  const lines = dict.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return ['blank', ...lines, ' '];
}

/** Greedy CTC decoding of [n, T, C] scores: best class per step, repeats merged, blanks dropped; score = mean of kept. */
export function ctcDecode(data: ArrayLike<number>, n: number, T: number, C: number, chars: string[]): { text: string; score: number }[] {
  const out: { text: string; score: number }[] = [];
  for (let k = 0; k < n; k++) {
    let text = '', sum = 0, kept = 0, prev = -1;
    for (let t = 0; t < T; t++) {
      const off = (k * T + t) * C;
      let best = 0, bv = -Infinity;
      for (let c = 0; c < C; c++) if (data[off + c] > bv) { bv = data[off + c]; best = c; }
      if (best !== 0 && best !== prev) { text += chars[best] ?? ''; sum += bv; kept++; }
      prev = best;
    }
    out.push({ text, score: kept ? sum / kept : 0 });
  }
  return out;
}
