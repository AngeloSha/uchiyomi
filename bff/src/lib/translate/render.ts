import path from 'node:path';
import sharp from 'sharp';

/**
 * Translated pages, step 3: the translated copy of a page. Each translated bubble is painted over in the bubble's own
 * colour, in the bubble's own shape, and its translation set inside, fitted to the room there is. The copy keeps the
 * page's size and format, so every reader layout (spreads, split halves, crops, fit) shows it like the original.
 *
 * The shape: a flood fill from the text over pixels of the bubble's colour, stopped by the bubble's outline. What it
 * encloses (the fill plus the strokes of the text inside) is the area painted, which also covers any line the OCR
 * missed. Texts whose fills find the same bubble (a bubble with two lobes, or columns OCR kept apart) are one bubble:
 * painted once, their translations joined in reading order. When the fill runs out of its search window the text is
 * not in a closed bubble (a caption on the art, or a sound effect): a rounded box is painted instead, and a very short
 * one is left alone.
 */

/**
 * Bumped when the drawing changes: it is part of a translated page's image-cache key (routes/images.ts), so a copy drawn
 * by an older version is not served as current. The translations themselves are kept (pages.ts PIPELINE_VERSION).
 */
export const RENDER_VERSION = 1;

export interface Region {
  box: [number, number, number, number];
  /** The translation. */
  text: string;
  /** What OCR read there, and the height of its lettering (its lines' thickness, px). */
  source: string;
  letter: number;
}

/** Fonts in the download's fonts/ folder, by the target language's script. */
const FONTS = {
  latin: ['ComicNeue-Bold.ttf', 'Comic Neue Bold'],
  any: ['NotoSans.ttf', 'Noto Sans Bold'],
  arabic: ['NotoSansArabic.ttf', 'Noto Sans Arabic Bold'],
  cjk: ['NotoSansSC.ttf', 'Noto Sans SC Bold'],
} as const;
const fontFor = (lang: string) => {
  const b = lang.toLowerCase().split(/[-_]/)[0];
  if (b === 'ar') return FONTS.arabic;
  if (b === 'ja' || b === 'zh') return FONTS.cjk;
  if (b === 'ru') return FONTS.any;
  return FONTS.latin;
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Px { data: Buffer; W: number; H: number }
const lum = (d: Buffer, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** How far apart two colours are (summed over the channels); a bubble's own colour is within LIKE of itself. */
const LIKE = 60;
const dist = (d: Buffer, i: number, c: [number, number, number]) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);

/** The bubble's colour: the colour at the 80th percentile of brightness in the text's box (text is the minority there). */
function backgroundOf(px: Px, [x0, y0, x1, y1]: Region['box']): { rgb: [number, number, number]; dark: boolean } {
  const samples: [number, number][] = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * px.W + x) * 3; samples.push([lum(px.data, i), i]); }
  if (!samples.length) return { rgb: [255, 255, 255], dark: false };
  samples.sort((a, b) => a[0] - b[0]);
  const [l, i] = samples[Math.floor(samples.length * 0.8)];
  const mean = samples.reduce((s, v) => s + v[0], 0) / samples.length;
  return { rgb: [px.data[i], px.data[i + 1], px.data[i + 2]], dark: mean < 110 && l < 140 };
}

interface Mask {
  inside: Uint8Array;
  x0: number; y0: number; w: number; h: number;
  bounds: Region['box'];
  /** The middle of the bubble's area (not of its bounds, which a tail stretches). */
  cx: number; cy: number;
}

/**
 * The bubble's enclosed area: a mask over a search window around the text, or null when the fill leaks out of every
 * window (no closed bubble). The window starts at 1.5 times the text's longer side each way and doubles while the fill
 * reaches its edge: a vertical column of Japanese is a narrow strip of a bubble that can be four columns wide, and a
 * bubble with two lobes is wider still (10-19, a page of ja raws: a window the size of the column read three of seven
 * bubbles as open, and left them untranslated). Capped at 60% of the page.
 */
function bubbleMask(px: Px, box: Region['box'], bg: [number, number, number], texts: Region['box'][]): Mask | null {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const cap = Math.max(px.W, px.H) * 0.6;
  for (let g = Math.max(bw, bh) * 1.5; ; g *= 2) {
    const gg = Math.round(Math.min(g, cap));
    const m = maskIn(px, box, bg, Math.max(bw, gg), Math.max(bh, gg), texts);
    if (m !== 'leak') return m;
    if (gg >= cap) return null;
  }
}

function maskIn(px: Px, box: Region['box'], bg: [number, number, number], gx: number, gy: number, texts: Region['box'][]): Mask | 'leak' | null {
  const wx0 = Math.max(0, box[0] - gx), wy0 = Math.max(0, box[1] - gy), wx1 = Math.min(px.W, box[2] + gx), wy1 = Math.min(px.H, box[3] + gy);
  const w = wx1 - wx0, h = wy1 - wy0;
  const like = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) like[y * w + x] = dist(px.data, ((wy0 + y) * px.W + (wx0 + x)) * 3, bg) < LIKE ? 1 : 0;
  }
  // 1. the bubble's own colour, reached from the text's box
  const fill = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let y = box[1] - wy0; y < box[3] - wy0; y++) {
    for (let x = box[0] - wx0; x < box[2] - wx0; x++) {
      const k = y * w + x;
      if (like[k] && !fill[k]) { fill[k] = 1; stack.push(k); }
    }
  }
  let edge = 0;
  while (stack.length) {
    const k = stack.pop()!, x = k % w, y = (k / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge++;
    for (const n of [k - 1, k + 1, k - w, k + w]) {
      if (n < 0 || n >= w * h || fill[n] || !like[n]) continue;
      if ((n === k - 1 && x === 0) || (n === k + 1 && x === w - 1)) continue;
      fill[n] = 1; stack.push(n);
    }
  }
  if (edge > (w + h) * 0.05) return 'leak';
  // 2. everything the fill encloses: what the outside cannot reach without crossing it (the text's strokes)
  const outside = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const k = y * w + x; if (!fill[k] && !outside[k]) { outside[k] = 1; stack.push(k); } }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const k = y * w + x; if (!fill[k] && !outside[k]) { outside[k] = 1; stack.push(k); } }
  while (stack.length) {
    const k = stack.pop()!, x = k % w;
    for (const n of [k - 1, k + 1, k - w, k + w]) {
      if (n < 0 || n >= w * h || outside[n] || fill[n]) continue;
      if ((n === k - 1 && x === 0) || (n === k + 1 && x === w - 1)) continue;
      outside[n] = 1; stack.push(n);
    }
  }
  // 3. shrunk by a pixel so the outline stays crisp
  const inside = new Uint8Array(w * h);
  let mx0 = w, my0 = h, mx1 = -1, my1 = -1, sx = 0, sy = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (outside[k] || outside[k - 1] || outside[k + 1] || outside[k - w] || outside[k + w]) continue;
      inside[k] = 1;
      sx += x; sy += y; n++;
      if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y;
    }
  }
  if (mx1 < 0) return null;
  // 4. A speech bubble holds its text and nothing else, and is not many times the size of it. A panel's light background
  // closed off by the art (a white wall, a sky) passes the fill, and painting it as a bubble wiped the art from a whole
  // panel (10-19). Anything enclosed that is not near a text, or an area over 20 times the texts inside it, is the art.
  const pad = texts.map((t) => { const p = Math.min(t[2] - t[0], t[3] - t[1]) * 0.15; return [t[0] - p, t[1] - p, t[2] + p, t[3] + p]; });
  let stray = 0, textArea = 0;
  for (let y = my0; y <= my1; y++) {
    for (let x = mx0; x <= mx1; x++) {
      const k = y * w + x;
      if (!inside[k] || fill[k]) continue;
      const gx0 = wx0 + x, gy0 = wy0 + y;
      if (!pad.some((t) => gx0 >= t[0] && gx0 < t[2] && gy0 >= t[1] && gy0 < t[3])) stray++;
    }
  }
  for (const t of texts) {
    const tx = (t[0] + t[2]) / 2 - wx0, ty = (t[1] + t[3]) / 2 - wy0;
    if (tx >= 0 && ty >= 0 && tx < w && ty < h && inside[Math.floor(ty) * w + Math.floor(tx)]) textArea += (t[2] - t[0]) * (t[3] - t[1]);
  }
  if (stray > n * 0.02 || n > Math.max(1, textArea) * 20) return null;
  return { inside, x0: wx0, y0: wy0, w, h, bounds: [wx0 + mx0, wy0 + my0, wx0 + mx1 + 1, wy0 + my1 + 1] as Region['box'], cx: wx0 + sx / n, cy: wy0 + sy / n };
}

/**
 * Where the translation goes in a bubble: the largest rectangle shaped like the bubble's bounds, centred on its middle,
 * that lies wholly inside it. A fixed share of the bounds poked out of round and cloud-shaped bubbles at the corners,
 * and the first or last line ran into the outline.
 */
function innerRect(m: Mask): Region['box'] {
  const bw = m.bounds[2] - m.bounds[0], bh = m.bounds[3] - m.bounds[1];
  const at = (x: number, y: number) => {
    const lx = Math.round(x) - m.x0, ly = Math.round(y) - m.y0;
    return lx >= 0 && ly >= 0 && lx < m.w && ly < m.h && m.inside[ly * m.w + lx] === 1;
  };
  for (let s = 0.9; s > 0.25; s -= 0.05) {
    const x0 = m.cx - (bw * s) / 2, x1 = m.cx + (bw * s) / 2, y0 = m.cy - (bh * s) / 2, y1 = m.cy + (bh * s) / 2;
    const step = Math.max(1, Math.min(bw, bh) * s / 48);
    let ok = true;
    for (let x = x0; x <= x1 && ok; x += step) ok = at(x, y0) && at(x, y1);
    for (let y = y0; y <= y1 && ok; y += step) ok = at(x0, y) && at(x1, y);
    if (ok) return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
  }
  return [Math.round(m.cx - bw * 0.12), Math.round(m.cy - bh * 0.12), Math.round(m.cx + bw * 0.12), Math.round(m.cy + bh * 0.12)];
}

/**
 * The translation set in a w x h room: as big as the original lettering (never bigger, so a short "Ah..." does not fill
 * its bubble), smaller step by step until it fits, and scaled down as a last resort rather than spilling over.
 */
async function fitText(text: string, dark: boolean, font: string, fontfile: string, w: number, h: number, letter: number, cjk: boolean) {
  const markup = `<span foreground="${dark ? 'white' : 'black'}">${esc(text)}</span>`;
  let size = Math.max(9, Math.min(Math.round(letter * 0.9), Math.round(h * 0.6)));
  for (let i = 0; i < 10; i++) {
    const t = await sharp({ text: { text: markup, font: `${font} ${size}`, fontfile, width: w, dpi: 72, align: 'centre', wrap: cjk ? 'char' : 'word', rgba: true } })
      .png().toBuffer({ resolveWithObject: true });
    if (t.info.height <= h && t.info.width <= w) return t;
    if (size <= 9) {
      const fit = await sharp(t.data).resize({ width: w, height: h, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
      return fit;
    }
    size = Math.max(9, Math.floor(size * 0.85));
  }
  return null;
}

/** How much two boxes overlap: the shared area over the smaller one's. */
const overlap = (a: Region['box'], b: Region['box']) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
};
const middle = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];

/**
 * The translated copy of a page: `bytes` is the page as stored, `regions` the bubbles (in the page's pixels) with their
 * translations, in reading order. Returns bytes in the page's own format.
 */
export async function renderPage(bytes: Buffer, regions: Region[], lang: string, fontDir: string): Promise<{ buffer: Buffer; contentType: string }> {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const data = await sharp(bytes).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const px: Px = { data, W, H };
  const [file, font] = fontFor(lang);
  const fontfile = path.join(fontDir, file);
  const cjk = fontFor(lang) === FONTS.cjk;

  // Each translated text, its colour, and its bubble when it is in one.
  type Spot = { r: Region; text: string; box: Region['box']; bg: ReturnType<typeof backgroundOf>; mask: Mask | null };
  const spots: Spot[] = [];
  for (const r of regions) {
    const text = r.text.trim();
    if (!text) continue;
    const box = [Math.max(0, r.box[0]), Math.max(0, r.box[1]), Math.min(W, r.box[2]), Math.min(H, r.box[3])] as Region['box'];
    if (box[2] - box[0] < 6 || box[3] - box[1] < 6) continue;
    const bg = backgroundOf(px, box);
    spots.push({ r, text, box, bg, mask: bubbleMask(px, box, bg.rgb, regions.map((x) => x.box)) });
  }
  // Texts in one bubble are drawn as one, in reading order.
  const groups: Spot[][] = [];
  for (const s of spots) {
    const same = s.mask && groups.find((g) => g[0].mask && overlap(g[0].mask.bounds, s.mask!.bounds) > 0.9);
    if (same) same.push(s); else groups.push([s]);
  }

  const comps: sharp.OverlayOptions[] = [];
  for (const g of groups) {
    const first = g[0];
    const text = g.map((s) => s.text).join(cjk ? '' : ' ');
    const letter = middle(g.map((s) => s.r.letter));
    let area: Region['box'];
    if (first.mask) {
      const { mask, bg } = first;
      const ov = Buffer.alloc(mask.w * mask.h * 4);
      for (let k = 0; k < mask.w * mask.h; k++) {
        if (!mask.inside[k]) continue;
        ov[k * 4] = bg.rgb[0]; ov[k * 4 + 1] = bg.rgb[1]; ov[k * 4 + 2] = bg.rgb[2]; ov[k * 4 + 3] = 255;
      }
      comps.push({ input: ov, raw: { width: mask.w, height: mask.h, channels: 4 }, left: mask.x0, top: mask.y0 });
      area = innerRect(mask);
    } else {
      // Not in a closed bubble: a caption or a sound effect drawn on the art. A few characters (咚咚, ドン) are a sound
      // effect, left as drawn; anything longer is a caption, set in a rounded box.
      const { box, bg, r } = first;
      if ([...r.source.replace(/[\s.…!?！？。、~～-]/g, '')].length <= 3) continue;
      const pad = Math.round(Math.min(box[2] - box[0], box[3] - box[1]) * 0.12) + 4;
      area = [Math.max(0, box[0] - pad), Math.max(0, box[1] - pad), Math.min(W, box[2] + pad), Math.min(H, box[3] + pad)];
      const aw = area[2] - area[0], ah = area[3] - area[1], rad = Math.round(Math.min(aw, ah) * 0.18);
      comps.push({ input: Buffer.from(`<svg width="${aw}" height="${ah}"><rect width="${aw}" height="${ah}" rx="${rad}" ry="${rad}" fill="rgb(${bg.rgb.join(',')})"/></svg>`), left: area[0], top: area[1] });
    }
    const aw = area[2] - area[0], ah = area[3] - area[1];
    const inner = Math.max(2, Math.round(Math.min(aw, ah) * 0.06));
    if (aw - 2 * inner < 8 || ah - 2 * inner < 8) continue;
    const t = await fitText(text, first.bg.dark, font, fontfile, aw - 2 * inner, ah - 2 * inner, letter, cjk);
    if (!t) continue;
    comps.push({ input: t.data, left: area[0] + Math.round((aw - t.info.width) / 2), top: area[1] + Math.round((ah - t.info.height) / 2) });
  }
  const img = sharp(bytes).composite(comps);
  const fmt = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpeg';
  const buffer = await (fmt === 'png' ? img.png() : fmt === 'webp' ? img.webp({ quality: 88 }) : img.jpeg({ quality: 88, mozjpeg: true })).toBuffer();
  return { buffer, contentType: `image/${fmt}` };
}
