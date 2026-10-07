// Automatic hero banners (v0.51.0): a wide banner made from a series' own pages, for every series without one.
//
// The hero art is AniList's `bannerImage` (series_art.banner, lib/anilist.ts) or an admin's override
// (series_overrides.banner), and only 84 of the owner's 283 series had either: the other 199 showed their cover over
// a blur of itself. The idea is the owner's: take the most striking crops from pages across the series and set four
// of them side by side, a panel collage. Built here from the chapter files the library already holds, through the
// readers the page server uses (library.ts cbzPages / cbzEntry), so every format the reader opens works here too.
//
// Three choices, each pure so it can be tested on pixels:
//   - WHICH PAGES (samplePlan, pagePlan): up to eight chapters spread over the series and a few pages from the
//     middle of each -- never a chapter's first or last two, where the credits, the recruitment page and the
//     "read it at" plug sit. A seed picks them: the same seed always picks the same pages, and Shuffle (a new seed)
//     picks others.
//   - WHICH CROP OF A PAGE (bestWindow): every strip-shaped window of a small copy of the page is scored on colour
//     and detail, minus paper white, flat fills, lettering and deep black (scoreFeatures). A window more than 12 %
//     white is refused outright -- a gutter, a speech bubble -- and so is one whose edge runs along paper, a bubble
//     cut in half; the outer 8 % of a page top and bottom, where the watermarks and credits sit, is never used. A
//     black-and-white page is scored as one: its paper and ink are the drawing, its lettering still is not.
//   - WHICH FOUR (chooseCrops): the best, from four different chapters while there are good ones to choose from.
//
// What is never made (heroEligible): anything for 18+ content -- rated 18+ by the scan or by an admin, in an 18+
// library, carrying one of the admin's 18+ genres, or from an adult source -- because an explicit panel must never
// become a banner; and anything for a series with a banner of its own, which always wins. Nor for a series whose
// AniList lookup has not happened yet: that lookup runs when the backdrop is first asked for (routes/images.ts
// backdropRecipe), and offering this instead would mean it never ran.
//
// Where it lives. The two frames (4 x 1 wide; 2 x 2 tall, for a phone's portrait hero) are entries in the image
// cache, CACHE_DIR, beside the covers, keyed by series and seed. What must outlive that cache's sweeper is a row in
// series_hero: the seed (a Shuffle must not quietly revert when the sweeper evicts the file), when the current one
// was made, and when the last try failed -- so a series whose pages cannot make one is not tried again on every view
// of it (FAIL_RETRY_MS). A column set rather than the cache alone: every series list carries `autoHero` (the web
// needs the seed for its URL and the admin's New banner), and a file per series per list would not do.
//
// Making one costs a few seconds of decoding, so ONE is made at a time, server-wide (withHeroSlot), with a time
// limit, and never because someone opened a page: a payload offers a banner (`autoHero`) only once it is MADE, so the
// web never asks for one that is not there -- each such ask was a 404 and a console error on every page that showed
// the series. The background warm-up (warmHeroes) makes them, paced, and stands aside for a sweep, a repair or the
// daily source check, as the slow archive and Find other sources do; a series someone looks at meanwhile -- its
// backdrop asked for with no banner of its own, routes/images.ts -- is queued to be made the same way (queueHero), and
// Shuffle makes one on an admin's press. The image route itself still makes one on a miss (a cache file the sweeper
// evicted, or a direct request).
import { join } from 'node:path';
import sharp from 'sharp';
import { q } from './db';
import { cbzPages, cbzEntry, LIBRARY_ROOT } from './library';
import { getSource } from './sources';
import { runtime } from './runtime';
import { checkRunning } from './sourceWatchdog';
import { getOrFetch, type FetchedImage } from './imageCache';
import { firstRunFloor } from './desktop';
import { ADULT_RATING, visibleToAll } from './visibility';
import { FIRST_PAGE } from './seriesArt';

// ── the frames ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The dark between two panels, as the prototype the owner chose had it. */
export const HERO_GAP = 4;
const BG = '#0b0b10';
/** One strip of the wide frame: four of them and three gaps are exactly 1920 wide. Every crop is cut to its shape. */
const STRIP_W = Math.floor((1920 - 3 * HERO_GAP) / 4);
const STRIP_H = 640;
export const CROP_ASPECT = STRIP_W / STRIP_H;
/**
 * The wide frame is the desktop hero; the tall one is a phone's, whose hero is taller than it is wide: a 3:1 strip
 * there shows the gap between the middle two panels and a half of each. Both hold the same four crops.
 */
export const AUTO_HERO_FRAMES = {
  wide: { w: 1920, h: STRIP_H, cols: 4 },
  tall: { w: 2 * 538 + HERO_GAP, h: 2 * 718 + HERO_GAP, cols: 2 },
} as const;
export type AutoHeroAr = keyof typeof AUTO_HERO_FRAMES;

// ── which pages ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Chapters sampled per series. */
export const SAMPLE_CHAPTERS = 8;
/** A chapter's first and last pages skipped: the credits, the recruitment page, the "read it at" plug. */
export const SKIP_EDGE_PAGES = 2;

/**
 * mulberry32: a small generator whose sequence depends on the seed alone, on every platform and Node version.
 * `Math.random` cannot be seeded, and "the same seed picks the same pages" is what makes a banner stable.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `k` distinct integers in [lo, hi], one per equal stratum of it: the middle of each for seed 0 (the banner every
 * series starts with), somewhere inside each for any other seed. Fewer when the range holds fewer than `k`.
 */
export function spread(lo: number, hi: number, k: number, rand: (() => number) | null): number[] {
  const size = hi - lo + 1;
  if (size <= 0 || k <= 0) return [];
  if (size <= k) return Array.from({ length: size }, (_, i) => lo + i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const at = (i + (rand ? rand() : 0.5)) / k;
    const v = lo + Math.min(size - 1, Math.floor(at * size));
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Which chapters (indexes into the series' chapters in reading order) a seed samples. */
export function samplePlan(chapters: number, seed: number): number[] {
  // The first and last few percent stay out: a first chapter is mostly introductions, a last one may be a notice.
  const lo = chapters > 10 ? Math.floor(chapters * 0.05) : 0;
  const hi = chapters > 10 ? Math.ceil(chapters * 0.95) - 1 : chapters - 1;
  return spread(lo, hi, SAMPLE_CHAPTERS, seed ? rng(seed) : null);
}

/** Which pages of one chapter: `k` of the middle, never one of the first or last SKIP_EDGE_PAGES. */
export function pagePlan(total: number, k: number, rand: (() => number) | null): number[] {
  return spread(SKIP_EDGE_PAGES, total - 1 - SKIP_EDGE_PAGES, k, rand);
}

// ── which crop of a page ─────────────────────────────────────────────────────────────────────────────────────────

/** The width a page is scored at, and the side of the square cells its sums are kept per. */
export const ANALYSIS_W = 256;
const BLOCK = 8;
/**
 * The scoring's thresholds and weights, in one place. Tuned by eye against the owner's library (five series, colour
 * webtoons and a black-and-white manga) until text boxes, speech bubbles and white gutters became rare.
 */
export const TUNE = {
  /** A window more than this much paper white is a gutter or a speech bubble, never a banner. */
  whiteCap: 0.12,
  /**
   * A window one of whose sides runs along this much paper is cut through a bubble or sits on a gutter: never used,
   * so the scan slides the window off it instead. Colour pages only -- on a printed page gutters are everywhere.
   */
  gutterCap: 0.2,
  /** A crop scoring under this is not used at all: no banner beats a banner with a text box in it. */
  minScore: 0.6,
  /**
   * Crops within this much of each other are near-equal, and a seed chooses among them (choiceOf, chooseCrops) --
   * about ten points of colourfulness. Seed 0 takes the best, as every banner did before v0.52.0.
   */
  near: 0.25,
  // Pixel classes, on 0..255 luma (L) and chroma (max - min of R, G, B).
  whiteL: 225, whiteC: 30, // paper: gutters, bubbles, blank margins
  blackL: 24, // ink-black fill
  hard: 70, // a luma step this sharp between neighbours is a stroke
  greyC: 28, // both sides this grey: black on white, white on black -- lettering
  glareL: 212, glareC: 40, // one side this white: lettering on any fill, the white text of a coloured box
  flatVar: 6, // a cell whose luma varies less than this has no texture at all
  // A lettering cell: this many colour steps (|dR| + |dG| + |dB|) across it AND down it, on a fill this much of the
  // cell shares. Both directions, because a line of text is crossed both ways while hair or hatching runs one way.
  strokeStep: 120, letterStrokes: 12, letterFill: 0.4,
  // A paper cell is this much white; a window side whose band of cells is mostly paper sits on a gutter.
  paperShare: 0.6, gutterBand: 2,
  // The weights. Colour counts up to colorCap only, so a flat field of red cannot outbid a face.
  wColor: 1 / 40, colorCap: 90, wEdge: 1 / 12, wWhite: 4.5, wFlat: 2.5, wInk: 15, wBlack: 0.8,
  wGlare: 80, glareFree: 0.015, wLetter: 40, letterFree: 0.02, wGutter: 3,
  /** Taking a narrower window than the page costs this much per step: a page's own framing beats a zoomed detail. */
  wZoom: 0.25,
  /** A page whose colour varies less than this is black and white, and is scored by `bw` instead. */
  greyPage: 6,
  /**
   * Black and white: paper and ink ARE the drawing there, so more white is allowed, ink is no penalty and glare a
   * smaller one; lettering stays the tell of text (a manga page's bubbles hold far more of it than its art).
   */
  bw: { whiteCap: 0.3, wWhite: 3, wGlare: 40, glareFree: 0.03, letterFree: 0.04 },
};
/** The outer part of a page, top and bottom, that no crop may reach into: watermarks and credits sit there. */
export const EDGE_FRAC = 0.08;
/** A crop narrower than this in the page's own pixels would be blown up past what the strip can hold. */
const MIN_CROP_PX = 360;

export interface Pixels { data: Uint8Array; width: number; height: number; channels: number }

/** What one window of a page is made of. Colour and edge are magnitudes; the rest are fractions of the window. */
export interface WindowFeatures {
  /** Hasler-Süsstrunk colourfulness: 0 for grey, around 40 for an ordinary colour page, 100 and up for vivid art. */
  color: number;
  /** Mean luma gradient: how much is drawn there. */
  edge: number;
  /** Paper white: gutters, speech bubbles, margins. */
  white: number;
  /** Ink-black fill. */
  black: number;
  /** Cells with no texture: gutters, a box's flat fill, empty sky. Fraction of cells, not pixels. */
  flat: number;
  /** Hard achromatic steps (black on white, white on black): lettering, and a black-and-white page's ink. */
  ink: number;
  /** Hard steps against near-white: lettering on any fill, the white text of a coloured box. */
  glare: number;
  /**
   * Cells that look like lettering in any colour: many sharp steps on a fill most of the cell shares. A drawn line
   * crosses a cell once or twice; a line of text crosses it a dozen times. Fraction of cells.
   */
  letter: number;
  /** The largest share of paper among the window's four sides (a band of cells along each): a gutter it sits on. */
  gutter: number;
  /** The spread part of `color` alone: how much the colour varies, whatever its cast (a yellowed scan is still grey). */
  spread: number;
}

const SAT_KEYS = ['white', 'black', 'edge', 'ink', 'glare', 'flat', 'letter', 'paper', 'rg', 'yb', 'rg2', 'yb2'] as const;
type SatKey = (typeof SAT_KEYS)[number];

/** A page's per-cell sums as summed-area tables, so any window's sums cost four reads. */
export interface Grid {
  cols: number; rows: number; block: number; sat: Record<SatKey, Float64Array>;
  /** The page is black and white (TUNE.greyPage). */
  grey: boolean;
}

export function pageGrid(px: Pixels, block = BLOCK): Grid {
  const T = TUNE;
  const { data, width: w, height: h, channels: ch } = px;
  const cols = Math.floor(w / block), rows = Math.floor(h / block);
  const L = new Float32Array(w * h), C = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    C[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const cells = cols * rows;
  const per = Object.fromEntries(SAT_KEYS.map((k) => [k, new Float64Array(cells)])) as Record<SatKey, Float64Array>;
  const sumL = new Float64Array(cells), sumL2 = new Float64Array(cells);
  const across = new Float64Array(cells), down = new Float64Array(cells);
  // The fill: how many of a cell's pixels share its most common luma (16 levels wide), for the lettering test.
  const hist = new Uint16Array(cells * 16);
  for (let y = 0; y < rows * block; y++) {
    const row = ((y / block) | 0) * cols, below = Math.min(y + 1, h - 1) * w;
    for (let x = 0; x < cols * block; x++) {
      const cell = row + ((x / block) | 0);
      const i = y * w + x, p = i * ch, j = y * w + Math.min(x + 1, w - 1), q = j * ch, v = (below + x) * ch;
      const l = L[i], c = C[i];
      if (l >= T.whiteL && c <= T.whiteC) per.white[cell]++;
      if (l <= T.blackL) per.black[cell]++;
      const dx = Math.abs(l - L[j]);
      per.edge[cell] += dx + Math.abs(l - L[below + x]);
      if (dx >= T.hard) {
        if (c <= T.greyC && C[j] <= T.greyC) per.ink[cell]++;
        if ((l >= T.glareL && c <= T.glareC) || (L[j] >= T.glareL && C[j] <= T.glareC)) per.glare[cell]++;
      }
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (Math.abs(r - data[q]) + Math.abs(g - data[q + 1]) + Math.abs(b - data[q + 2]) >= T.strokeStep) across[cell]++;
      if (Math.abs(r - data[v]) + Math.abs(g - data[v + 1]) + Math.abs(b - data[v + 2]) >= T.strokeStep) down[cell]++;
      hist[cell * 16 + Math.min(15, l >> 4)]++;
      const rg = r - g, yb = 0.5 * (r + g) - b;
      per.rg[cell] += rg; per.yb[cell] += yb; per.rg2[cell] += rg * rg; per.yb2[cell] += yb * yb;
      sumL[cell] += l; sumL2[cell] += l * l;
    }
  }
  const n = block * block;
  for (let i = 0; i < cells; i++) {
    const m = sumL[i] / n;
    per.flat[i] = sumL2[i] / n - m * m < T.flatVar ? 1 : 0;
    let mode = 0;
    for (let k = 0; k < 16; k++) mode = Math.max(mode, hist[i * 16 + k]);
    per.letter[i] = Math.min(across[i], down[i]) >= T.letterStrokes && mode >= T.letterFill * n ? 1 : 0;
    per.paper[i] = per.white[i] >= T.paperShare * n ? 1 : 0;
  }
  const sat = {} as Record<SatKey, Float64Array>;
  for (const k of SAT_KEYS) {
    const t = new Float64Array((cols + 1) * (rows + 1)), src = per[k];
    for (let r = 0; r < rows; r++) {
      let run = 0;
      for (let c = 0; c < cols; c++) {
        run += src[r * cols + c];
        t[(r + 1) * (cols + 1) + c + 1] = t[r * (cols + 1) + c + 1] + run;
      }
    }
    sat[k] = t;
  }
  const all = { cols, rows, block, sat, grey: false };
  const whole = rows && cols ? windowFeatures(all, 0, 0, cols, rows) : null;
  return { ...all, grey: !!whole && whole.spread < T.greyPage };
}

/** The features of the window of cells [c0, c0 + cw) x [r0, r0 + rh). */
export function windowFeatures(g: Grid, c0: number, r0: number, cw: number, rh: number): WindowFeatures {
  const W = g.cols + 1;
  const sum = (k: SatKey) => {
    const t = g.sat[k];
    return t[(r0 + rh) * W + c0 + cw] - t[r0 * W + c0 + cw] - t[(r0 + rh) * W + c0] + t[r0 * W + c0];
  };
  const cells = cw * rh, n = cells * g.block * g.block;
  const box = (k: SatKey, cc: number, rr: number, w: number, h: number) => {
    const t = g.sat[k];
    return t[(rr + h) * W + cc + w] - t[rr * W + cc + w] - t[(rr + h) * W + cc] + t[rr * W + cc];
  };
  const b = Math.min(TUNE.gutterBand, Math.floor(cw / 2), Math.floor(rh / 2));
  const gutter = b ? Math.max(
    box('paper', c0, r0, cw, b) / (cw * b), box('paper', c0, r0 + rh - b, cw, b) / (cw * b),
    box('paper', c0, r0, b, rh) / (b * rh), box('paper', c0 + cw - b, r0, b, rh) / (b * rh),
  ) : 0;
  const mrg = sum('rg') / n, myb = sum('yb') / n;
  const vrg = Math.max(0, sum('rg2') / n - mrg * mrg), vyb = Math.max(0, sum('yb2') / n - myb * myb);
  return {
    color: Math.sqrt(vrg + vyb) + 0.3 * Math.sqrt(mrg * mrg + myb * myb),
    spread: Math.sqrt(vrg + vyb),
    edge: sum('edge') / n,
    white: sum('white') / n,
    black: sum('black') / n,
    flat: sum('flat') / cells,
    ink: sum('ink') / n,
    glare: sum('glare') / n,
    letter: sum('letter') / cells,
    gutter,
  };
}

/** How good a window is as a panel of the banner; -Infinity for one that may never be. `grey`: a black and white page. */
export function scoreFeatures(f: WindowFeatures, grey = false): number {
  const T = TUNE;
  if (grey) {
    if (f.white > T.bw.whiteCap) return -Infinity;
    return T.wEdge * f.edge - T.bw.wWhite * f.white - T.wFlat * f.flat - T.wGutter * f.gutter
      - T.bw.wGlare * Math.max(0, f.glare - T.bw.glareFree) - T.wLetter * Math.max(0, f.letter - T.bw.letterFree)
      - T.wBlack * Math.max(0, f.black - 0.45);
  }
  if (f.white > T.whiteCap || f.gutter > T.gutterCap) return -Infinity;
  return T.wColor * Math.min(f.color, T.colorCap) + T.wEdge * f.edge
    - T.wWhite * f.white - T.wFlat * f.flat - T.wInk * f.ink - T.wGutter * f.gutter
    // A little glare and a few lettering-like cells are what a drawn page has anyway; above that, it is text.
    - T.wGlare * Math.max(0, f.glare - T.glareFree) - T.wLetter * Math.max(0, f.letter - T.letterFree)
    - T.wBlack * Math.max(0, f.black - 0.45);
}

/** A crop as fractions of the page, so it lands on the full-size page whatever size it was scored at. */
export interface Crop { x: number; y: number; w: number; h: number; score: number; f: WindowFeatures }

/**
 * The best strip-shaped window of a page, or null when none is allowed. A webtoon's panels span its width, so a tall
 * strip of a page is tried at its full width only -- a narrower window there is a zoomed detail, not a panel. A page
 * shaped like a printed one holds panels side by side, so narrower windows are tried too, to take one without its
 * gutter.
 */
export function bestWindow(g: Grid, pageW: number): Crop | null {
  const top = Math.ceil(g.rows * EDGE_FRAC), bottom = Math.floor(g.rows * (1 - EDGE_FRAC));
  const usable = bottom - top;
  const minCols = Math.ceil((MIN_CROP_PX / pageW) * g.cols);
  const shares = g.rows >= 1.8 * g.cols ? [1] : [1, 0.8, 0.66, 0.5];
  let best: Crop | null = null;
  const tried = new Set<number>();
  for (const [step, share] of shares.entries()) {
    let cw = Math.round(g.cols * share);
    let rh = Math.round(cw / CROP_ASPECT);
    if (rh > usable) { rh = usable; cw = Math.floor(rh * CROP_ASPECT); }
    if (cw < Math.max(4, minCols) || rh < 4 || tried.has(cw)) continue;
    tried.add(cw);
    for (let r0 = top; r0 + rh <= bottom; r0++) {
      for (let c0 = 0; c0 + cw <= g.cols; c0++) {
        const f = windowFeatures(g, c0, r0, cw, rh);
        const score = scoreFeatures(f, g.grey) - TUNE.wZoom * step;
        if (score > (best?.score ?? -Infinity)) {
          best = { x: c0 / g.cols, y: r0 / g.rows, w: cw / g.cols, h: rh / g.rows, score, f };
        }
      }
    }
  }
  return best;
}

/** A scored crop and where it came from. `chapter` is the chapter's index in reading order. */
export interface Candidate { chapter: number; page: number; crop: Crop }

/** How a seed chooses among crops: its draws, and how far below a better crop it reaches (chooseCrops). */
export interface Choice { rand: () => number; reach: number }

/**
 * A seed's choice (v0.52.0), or null for seed 0, which takes the best crops. Its first draw says how far it reaches:
 * TUNE.near for most seeds and rarely up to 64 times that, `near / (1 - u)`. Shuffle weighs new seeds from the nearest
 * reach outwards, so it changes the banner by a near-equal crop where it can, and reaches further down only on a
 * series whose pages give nothing near-equal. The seed alone decides, so a banner made again from its seed is the
 * same banner. A stream of its own (the salt), so the pages a seed samples are what they always were.
 */
export function choiceOf(seed: number): Choice | null {
  if (!seed) return null;
  const rand = rng(seed ^ 0x2c1b3c6d);
  return { rand, reach: TUNE.near / Math.max(1 / 64, 1 - rand()) };
}

/**
 * The `n` crops the banner is made of, best first: only ones scoring at least TUNE.minScore, never two of one page,
 * and from different chapters while the candidates allow it -- four moments of one chapter read as one scene, four
 * chapters as the series.
 *
 * A seed's `choice` (v0.52.0) ranks each crop by its score plus a draw of up to `reach`: one within reach of a
 * better crop may pass it, one further below never does. A short series (eight chapters or fewer, ten pages or
 * fewer each) has every page read whatever the seed, and without this its Shuffle always drew the same four. Reintroduce
 * by ranking on the score alone: "the seed chooses among near-equal crops" in autoHero.test.ts finds every seed's
 * four the same.
 */
export function chooseCrops<T extends Candidate>(cands: T[], n = 4, choice: Choice | null = null): T[] {
  const ok = cands.filter((c) => c.crop.score >= TUNE.minScore);
  const key = new Map(ok.map((c) => [c, c.crop.score + (choice ? choice.rand() * choice.reach : 0)]));
  const ranked = ok.sort((a, b) => key.get(b)! - key.get(a)!);
  const picked: T[] = [];
  const chapters = new Set<number>();
  for (const c of ranked) {
    if (picked.length === n) break;
    if (chapters.has(c.chapter)) continue;
    picked.push(c);
    chapters.add(c.chapter);
  }
  for (const c of ranked) {
    if (picked.length === n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

/** Strip order across the frame: the best two in the middle, which is what a narrow screen shows of it. */
const LAYOUT = [2, 0, 1, 3];

// ── making one ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Why no banner was made. Only `busy` is not a failure of the series: nothing is recorded for it. */
export type HeroFailure = 'no_chapters' | 'not_enough_art' | 'timeout' | 'unreadable' | 'busy';
export class HeroUnavailable extends Error {
  constructor(readonly reason: HeroFailure) { super(`no automatic banner: ${reason}`); }
}

export interface HeroImages { wide: Buffer; tall: Buffer }

/** Score one page, or null when it cannot hold a crop (too narrow, or not an image sharp can read). */
export async function scorePage(bytes: Buffer): Promise<{ crop: Crop; width: number; height: number } | null> {
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  if (width < MIN_CROP_PX || height < MIN_CROP_PX / CROP_ASPECT) return null;
  const { data, info } = await sharp(bytes).resize({ width: Math.min(ANALYSIS_W, width) }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const crop = bestWindow(pageGrid({ data, width: info.width, height: info.height, channels: info.channels }), width);
  return crop ? { crop, width, height } : null;
}

/** A candidate and the page it came from. */
type Sourced = Candidate & { path: string; name: string };

/** Pages tried per sampled chapter at most, one per round; the order a round takes them in, middle ones first. */
const PAGES_PER_CHAPTER = 6;
const ROUND_ORDER = [2, 4, 1, 3, 5, 0];
/** Rounds stop once this many usable crops from four chapters are in hand: most series never need a second. */
const ENOUGH = 8;

/** A page's best crop by `path` and entry name, or null for a page that holds none: what Shuffle reads once. */
type Scored = Map<string, Crop | null>;

/**
 * The crops a banner of these chapters (absolute paths, in reading order) is made of with this seed, scored and
 * chosen but not drawn. `read` counts the pages that could be read; `fresh` those scored now rather than found in
 * `scored`, which Shuffle passes to weigh many seeds over one reading of a short series' pages.
 *
 * Pages are read in rounds, one more page of every sampled chapter each round, until there are enough good crops:
 * a series drawn on white needs more of its pages read than one drawn edge to edge, and most need a single round.
 * `deadline` is checked between pages, so a run over its limit stops at the next one.
 */
async function heroPicks(
  chapters: string[], seed: number, deadline: number, scored: Scored = new Map(),
): Promise<{ picks: Sourced[]; cands: Sourced[]; read: number; fresh: number }> {
  if (!chapters.length) throw new HeroUnavailable('no_chapters');
  const rand = seed ? rng(seed ^ 0x5bd1e995) : null;
  const sampled: Array<{ chapter: number; path: string; names: string[]; pages: number[] }> = [];
  for (const chapter of samplePlan(chapters.length, seed)) {
    const path = chapters[chapter];
    const names = await cbzPages(path).catch(() => [] as string[]);
    const spread = pagePlan(names.length, PAGES_PER_CHAPTER, rand);
    sampled.push({ chapter, path, names, pages: ROUND_ORDER.filter((i) => i < spread.length).map((i) => spread[i]) });
  }
  const cands: Sourced[] = [];
  let read = 0, fresh = 0;
  for (let round = 0; round < PAGES_PER_CHAPTER; round++) {
    for (const s of sampled) {
      const page = s.pages[round];
      if (page === undefined) continue;
      if (Date.now() > deadline) throw new HeroUnavailable('timeout');
      const key = `${s.path}\u0000${s.names[page]}`;
      let crop = scored.get(key);
      if (crop === undefined) {
        const bytes = await cbzEntry(s.path, s.names[page]).catch(() => null);
        if (!bytes) continue;
        fresh++;
        crop = (await scorePage(bytes).catch(() => null))?.crop ?? null;
        scored.set(key, crop);
      }
      read++;
      if (crop) cands.push({ chapter: s.chapter, page, path: s.path, name: s.names[page], crop });
    }
    const good = cands.filter((c) => c.crop.score >= TUNE.minScore);
    if (good.length >= ENOUGH && new Set(good.map((c) => c.chapter)).size >= LAYOUT.length) break;
  }
  return { picks: chooseCrops(cands, LAYOUT.length, choiceOf(seed)), cands, read, fresh };
}

/**
 * Make the banner of these chapters (absolute paths, in reading order) with this seed: both frames.
 */
export async function composeHero(chapters: string[], seed: number, deadline = Infinity): Promise<HeroImages & { picks: Sourced[]; cands: Sourced[] }> {
  const { picks, cands, read } = await heroPicks(chapters, seed, deadline);
  if (picks.length < LAYOUT.length) throw new HeroUnavailable(read ? 'not_enough_art' : 'unreadable');
  return { ...(await drawHero(picks, deadline)), picks, cands };
}

/** Both frames of a banner from its four crops, cut from the full-size pages. */
async function drawHero(picks: Sourced[], deadline: number): Promise<HeroImages> {
  // Cut at the tall frame's cell size, the larger of the two, and scaled down again for the wide strips.
  const cellW = (AUTO_HERO_FRAMES.tall.w - HERO_GAP) / 2, cellH = (AUTO_HERO_FRAMES.tall.h - HERO_GAP) / 2;
  const cells: Buffer[] = [];
  for (const p of picks) {
    if (Date.now() > deadline) throw new HeroUnavailable('timeout');
    const bytes = await cbzEntry(p.path, p.name);
    const m = await sharp(bytes).metadata();
    const W = m.width ?? 0, H = m.height ?? 0;
    const left = Math.round(p.crop.x * W), top = Math.round(p.crop.y * H);
    cells.push(await sharp(bytes)
      .extract({ left, top, width: Math.min(W - left, Math.max(1, Math.round(p.crop.w * W))), height: Math.min(H - top, Math.max(1, Math.round(p.crop.h * H))) })
      .resize(cellW, cellH, { fit: 'cover' }).toBuffer());
  }
  const ordered = LAYOUT.map((i) => cells[i]);
  const frame = async (ar: AutoHeroAr): Promise<Buffer> => {
    const f = AUTO_HERO_FRAMES[ar];
    const cw = (f.w - HERO_GAP * (f.cols - 1)) / f.cols;
    const ch = ar === 'wide' ? f.h : (f.h - HERO_GAP) / 2;
    const parts = await Promise.all(ordered.map(async (cell, i) => ({
      input: ar === 'wide' ? await sharp(cell).resize(cw, ch, { fit: 'cover' }).toBuffer() : cell,
      left: (i % f.cols) * (cw + HERO_GAP),
      top: Math.floor(i / f.cols) * (ch + HERO_GAP),
    })));
    return sharp({ create: { width: f.w, height: f.h, channels: 3, background: BG } })
      .composite(parts).modulate({ saturation: 1.06 }).jpeg({ quality: 82, progressive: true }).toBuffer();
  };
  return { wide: await frame('wide'), tall: await frame('tall') };
}

// ── which series ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * SQL: the series under `alias` may have an automatic banner. Every 18+ rule counts on its own -- the series' own
 * rating or an admin's, its library's, one of the admin's 18+ genres in its own genres or an admin's, its source
 * named adult by the admin -- unlike `visible()`, where an admin's lower rating lets one series out of an 18+
 * library: a banner is shown to everyone who can open the series, unasked, and an explicit panel must never become
 * one. "Always show" (adult_exempt) is a shelf switch and lifts nothing here either. An extension that declares
 * itself adult is checked in code (adultSource), since only the source registry knows.
 *
 * And no banner of its own: an admin's override, or AniList's -- which only counts as absent once it has been looked
 * up (a series_art row), because that lookup happens when the backdrop is first asked for. A series an admin set to
 * Use the first page (v0.55.7, lib/seriesArt.ts FIRST_PAGE) shows no online art at all, so whatever series_art holds is
 * no banner of its own: its banner is made from its pages. Reintroduce by dropping that half: "the first page, chosen,
 * keeps online art away" in onlineMatch.int.test.ts finds no banner offered for it.
 *
 * Interpolates only code constants, so it can be dropped into any query without renumbering its parameters.
 */
export function heroEligible(alias: string): string {
  const s = alias;
  return `${s}.books_count > 0
    AND (EXISTS (SELECT 1 FROM series_art ha WHERE ha.series_id = ${s}.id AND COALESCE(ha.banner, '') = '')
         OR EXISTS (SELECT 1 FROM series_overrides hf WHERE hf.series_id = ${s}.id AND hf.cover = '${FIRST_PAGE}'))
    AND NOT EXISTS (SELECT 1 FROM series_overrides ho WHERE ho.series_id = ${s}.id
                     AND (ho.banner IS NOT NULL OR ho.age_rating >= ${ADULT_RATING}))
    AND COALESCE(${s}.age_rating, 0) < ${ADULT_RATING}
    AND NOT EXISTS (SELECT 1 FROM libraries hl WHERE hl.id = ${s}.library_id AND hl.age_rating >= ${ADULT_RATING})
    AND NOT EXISTS (
      SELECT 1 FROM server_settings hs, jsonb_array_elements_text(hs.adult_genres) AS hg
       WHERE hs.id = 1 AND jsonb_typeof(hs.adult_genres) = 'array'
         AND lower(btrim(hg)) IN (SELECT lower(btrim(g)) FROM unnest(${s}.genres || COALESCE(
               (SELECT ho2.genres FROM series_overrides ho2 WHERE ho2.series_id = ${s}.id), '{}'::text[])) AS g))
    AND NOT EXISTS (SELECT 1 FROM server_settings hs3 WHERE hs3.id = 1 AND jsonb_typeof(hs3.adult_sources) = 'array'
                     AND hs3.adult_sources ? lower(COALESCE(${s}.source_id, '')))`;
}

/** An extension that declares itself adult: its series never get a banner made from their pages. */
const adultSource = (id: string | null) => !!id && !!getSource(id)?.isNsfw;

/** How long a series whose pages made no banner is left alone before it is tried again. */
export const FAIL_RETRY_MS = 7 * 24 * 3600_000;

interface HeroRow { id: string; source_id: string | null; seed: number; made_at: Date | null; failed_at: Date | null }

async function heroRows(ids: string[]): Promise<HeroRow[]> {
  const rows = await q<HeroRow>(
    `SELECT s.id, s.source_id, COALESCE(h.seed, 0) AS seed, h.made_at, h.failed_at
       FROM lib_series s LEFT JOIN series_hero h ON h.series_id = s.id
      WHERE s.id = ANY($1) AND ${heroEligible('s')}`, [ids]);
  return rows.filter((r) => !adultSource(r.source_id));
}

const failedLately = (r: HeroRow) => !!r.failed_at && Date.now() - new Date(r.failed_at).getTime() < FAIL_RETRY_MS;

/** Made, and no try has failed since: the banner is there to show. */
const isMade = (r: HeroRow) => !!r.made_at && (!r.failed_at || new Date(r.failed_at) < new Date(r.made_at));

/**
 * The series of these that may have an automatic banner now, made or not, with its seed: what the image route
 * serves (making it on a miss) and what the warm-up and the queue make. A series whose last try failed is left out
 * until it may be tried again. Never throws.
 */
export async function heroServable(ids: string[]): Promise<Map<string, { seed: number; made: boolean }>> {
  if (!ids.length) return new Map();
  const rows = await heroRows(ids).catch(() => [] as HeroRow[]);
  return new Map(rows.filter((r) => !failedLately(r)).map((r) => [r.id, { seed: Number(r.seed) || 0, made: isMade(r) }]));
}

/**
 * The series of these whose automatic banner is MADE, with its seed: the `autoHero` of every series payload
 * (lib/enrich.ts). Not one that could be made on request: the web asks for what the payload offers, and a banner that
 * is not there was a 404 -- a console error on every page that showed the series (the e2e gate counts each) -- after a
 * page view had waited on a make. Never throws: a payload without the field is today's look.
 * Reintroduce by offering every heroServable series: "a payload offers a banner only once it is made" in
 * autoHero.int.test.ts finds one offered before anything was made.
 */
export async function autoHeroFor(ids: string[]): Promise<Map<string, { seed: number }>> {
  const all = await heroServable(ids);
  return new Map([...all].filter(([, h]) => h.made).map(([id, h]) => [id, { seed: h.seed }]));
}

/** The chapter files of a series, one per number, in reading order. */
async function heroChapters(seriesId: string): Promise<string[]> {
  const rows = await q<{ file: string; root: string | null }>(
    `SELECT DISTINCT ON (b.number) b.file, b.root
       FROM lib_books b JOIN lib_series s ON s.id = b.series_id
      WHERE b.series_id = $1 AND b.pruned_at IS NULL AND ${visibleToAll('s')}
      ORDER BY b.number, b.id`, [seriesId]);
  return rows.map((r) => join(r.root || LIBRARY_ROOT, r.file));
}

/**
 * What a try came to, for the seed it was made with. The guard on `seed` matters: a Shuffle that lands while the
 * old seed's banner is being made must not have its new seed overwritten by the old one's outcome.
 */
async function recordHero(id: string, seed: number, failure: HeroFailure | null): Promise<void> {
  await q(
    `INSERT INTO series_hero (series_id, seed, made_at, failed_at, fail_reason)
     VALUES ($1, $2, CASE WHEN $3::text IS NULL THEN now() END, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, $3)
     ON CONFLICT (series_id) DO UPDATE
       SET made_at = EXCLUDED.made_at, failed_at = EXCLUDED.failed_at, fail_reason = EXCLUDED.fail_reason
     WHERE series_hero.seed = EXCLUDED.seed`, [id, seed, failure]);
}

// ── one at a time ────────────────────────────────────────────────────────────────────────────────────────────────

/** How long one banner may take to make, and how long a view waits for its turn before keeping today's look. */
export const HERO_LIMIT_MS = 30_000;
export const HERO_WAIT_MS = 15_000;

let running: Promise<unknown> | null = null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` when no other banner is being made, server-wide; HeroUnavailable('busy') after `waitMs` of waiting. Making
 * one decodes dozens of full-size pages, and two at once would only take twice as long as each other.
 */
export async function withHeroSlot<T>(fn: () => Promise<T>, waitMs = HERO_WAIT_MS): Promise<T> {
  const until = Date.now() + waitMs;
  while (running) {
    const left = until - Date.now();
    if (left <= 0) throw new HeroUnavailable('busy');
    await Promise.race([running.catch(() => {}), sleep(left)]);
  }
  const mine = fn();
  running = mine;
  try { return await mine; } finally { if (running === mine) running = null; }
}

type Made = { ok: true; images: HeroImages } | { ok: false; reason: HeroFailure };
/** A banner being made, or made a moment ago, by series and seed: the wide and the tall frame are asked for together. */
const making = new Map<string, Promise<Made>>();

/** Both frames of a series' banner for this seed, made at most once at a time. Records what the try came to. */
export function heroImages(id: string, seed: number, opts: { waitMs?: number; record?: boolean } = {}): Promise<Made> {
  const key = `${id}:${seed}`;
  const known = making.get(key);
  if (known) return known;
  const p = (async (): Promise<Made> => {
    try {
      const images = await withHeroSlot(async () => composeHero(await heroChapters(id), seed, Date.now() + HERO_LIMIT_MS), opts.waitMs);
      if (opts.record !== false) await recordHero(id, seed, null).catch(() => {});
      return { ok: true, images: { wide: images.wide, tall: images.tall } };
    } catch (e) {
      const reason: HeroFailure = e instanceof HeroUnavailable ? e.reason : 'unreadable';
      // Waiting for the slot says nothing about the series: nothing is recorded, and the next view tries again.
      if (reason !== 'busy' && opts.record !== false) await recordHero(id, seed, reason).catch(() => {});
      return { ok: false, reason };
    }
  })();
  making.set(key, p);
  // Kept a minute after it settles, for the other frame; a wait that timed out is forgotten at once.
  void p.then((r) => setTimeout(() => { if (making.get(key) === p) making.delete(key); }, !r.ok && r.reason === 'busy' ? 0 : 60_000).unref());
  return p;
}

/** The image-cache key of one frame: series, seed and frame, so a new seed is a new image. */
export const heroVariant = (id: string, seed: number, ar: AutoHeroAr) => `autohero1:${id}:${seed}:${ar}`;

/** One frame for the image cache's producer; a 404 when no banner could be made, so the web keeps today's look. */
export async function heroFrame(id: string, seed: number, ar: AutoHeroAr, waitMs?: number): Promise<FetchedImage> {
  const made = await heroImages(id, seed, { waitMs });
  if (!made.ok) throw Object.assign(new Error('no automatic banner'), { statusCode: 404 });
  return { buffer: made.images[ar], contentType: 'image/jpeg' };
}

/** How many new seeds one Shuffle weighs, and how many of them may read pages the ones before did not. */
export const SHUFFLE_SEEDS = 64;
const SHUFFLE_READS = 3;

/** New seeds for a Shuffle away from `old`, the nearest-reaching first (choiceOf). */
function shuffleSeeds(old: number): number[] {
  const seeds = new Set<number>();
  while (seeds.size < SHUFFLE_SEEDS) {
    const seed = 1 + Math.floor(Math.random() * 0x7ffffffe);
    if (seed !== old) seeds.add(seed);
  }
  return [...seeds].sort((a, b) => choiceOf(a)!.reach - choiceOf(b)!.reach);
}

/**
 * Shuffle: a new seed, so other chapters and other pages -- and a different banner, or the plain word that there is
 * none. The banner is made BEFORE the seed is switched, so a series whose new pages make nothing keeps the one it had.
 * Null when the series may not have one at all.
 *
 * v0.52.0: a short series (eight chapters or fewer, ten pages or fewer each) has every page read whatever the seed,
 * and the same four crops came back while the page said "Banner changed". Now the four crops of the banner shown are
 * worked out first, and new seeds are weighed from the nearest reach outwards (shuffleSeeds) until one gives another
 * four: a near-equal crop where there is one, a further one only where there is not. A short series' pages are read
 * once for all of them; a seed that reads new pages (a longer series) is charged, and at most SHUFFLE_READS are. When
 * every seed gives the same four, the pages give no other banner: `same`, and nothing changes. Reintroduce by taking the
 * first new seed: "Shuffle on a short series" in autoHero.int.test.ts reads no `same` for the series of four crops.
 */
export async function shuffleHero(id: string): Promise<{ ok: true; seed: number; same?: true } | { ok: false; error: 'not_made' } | null> {
  const [row] = await heroRows([id]).catch(() => [] as HeroRow[]);
  if (!row) return null;
  const old = Number(row.seed) || 0;
  const four = (picks: Sourced[]) => picks.map((p) => `${p.path}\u0000${p.name}`).sort().join('\n');
  const made = await withHeroSlot(async () => {
    const chapters = await heroChapters(id);
    const deadline = Date.now() + HERO_LIMIT_MS;
    const scored: Scored = new Map();
    const shown = await heroPicks(chapters, old, deadline, scored)
      .then((p) => (p.picks.length === LAYOUT.length ? four(p.picks) : null), () => null);
    let reads = 0, cut = false;
    for (const seed of shuffleSeeds(old)) {
      if (Date.now() > deadline || reads >= SHUFFLE_READS) { cut = true; break; }
      const p = await heroPicks(chapters, seed, deadline, scored).catch(() => null);
      if (p?.fresh) reads++;
      if (p?.picks.length === LAYOUT.length && four(p.picks) !== shown) return { seed, images: await drawHero(p.picks, deadline) };
    }
    // Every seed weighed gave the four on screen: the pages give no other banner. Cut short by the clock or the reading
    // budget, it is only that none was found in time, which is `not_made`.
    return shown && !cut ? 'same' as const : null;
  }, HERO_LIMIT_MS).catch(() => null);
  if (made === 'same') return { ok: true, seed: old, same: true };
  if (!made) return { ok: false, error: 'not_made' };
  const { seed } = made;
  for (const ar of ['wide', 'tall'] as const) {
    await getOrFetch(heroVariant(id, seed, ar), async () => ({ buffer: made.images[ar], contentType: 'image/jpeg' })).catch(() => {});
  }
  await q(
    `INSERT INTO series_hero (series_id, seed, made_at) VALUES ($1, $2, now())
     ON CONFLICT (series_id) DO UPDATE SET seed = EXCLUDED.seed, made_at = now(), failed_at = NULL, fail_reason = NULL`,
    [id, seed]);
  return { ok: true, seed };
}

// ── the warm-up ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Series made per run at most, and the pause between two: background work, behind everything else. */
export const HERO_WARM_MAX = 60;
export const HERO_PACE_MS = 10_000;
const QUIET_POLL_MS = 30_000;

/** What the warm-up stands aside for: a sweep, a repair or the daily source check -- the jobs that own the disk. */
export const heroWaitsFor = (): 'sweep' | 'repair' | 'check' | null =>
  runtime.updating ? 'sweep' : runtime.repairing ? 'repair' : checkRunning() ? 'check' : null;

let warming = false;

/**
 * Make the banners nobody has asked for yet, a series at a time, HERO_PACE_MS apart, standing aside while a sweep,
 * a repair or the daily source check runs. A view of a series makes its own on demand; this is for the series that
 * reach the home carousel before anyone opens them.
 */
export async function warmHeroes(opts: { max?: number; paceMs?: number; quietMs?: number } = {}): Promise<{ made: number; failed: number }> {
  const out = { made: 0, failed: 0 };
  if (warming) return out;
  warming = true;
  try {
    const ids = (await q<{ id: string }>(
      `SELECT s.id FROM lib_series s LEFT JOIN series_hero h ON h.series_id = s.id
        WHERE ${visibleToAll('s')} AND ${heroEligible('s')} AND h.made_at IS NULL
          AND (h.failed_at IS NULL OR h.failed_at < now() - make_interval(secs => $1))
        ORDER BY s.latest_mtime DESC, s.id LIMIT $2`, [FAIL_RETRY_MS / 1000, opts.max ?? HERO_WARM_MAX])).map((r) => r.id);
    for (const [i, id] of ids.entries()) {
      while (heroWaitsFor() && !runtime.stopping) await sleep(opts.quietMs ?? QUIET_POLL_MS);
      if (runtime.stopping) break;
      const ok = await makeOne(id);
      if (ok === null) continue;
      if (ok) out.made++; else out.failed++;
      if (i < ids.length - 1) await sleep(opts.paceMs ?? HERO_PACE_MS);
    }
  } finally {
    warming = false;
  }
  return out;
}

/**
 * Make one series' banner, both frames, unless it may not have one or it is made already (null). Under the single slot
 * like every make, and recorded (heroImages): true when it is made, false when its pages made none.
 */
async function makeOne(id: string): Promise<boolean | null> {
  const hero = (await heroServable([id])).get(id);
  if (!hero || hero.made) return null;
  for (const ar of ['wide', 'tall'] as const) {
    const ok = await getOrFetch(heroVariant(id, hero.seed, ar), () => heroFrame(id, hero.seed, ar, HERO_LIMIT_MS)).then(() => true, () => false);
    if (!ok) return false;
  }
  return true;
}

// ── a series that just became eligible ───────────────────────────────────────────────────────────────────────────

/** Where the warm-up runs (startHeroWarmup: the server, owned mode), so does the queue; elsewhere it is a no-op. */
let queueOn = false;
const queued = new Set<string>();
let draining: Promise<void> | null = null;
/** The queue's waits never hold a process open: it is background work, and a test or a shutdown does not wait for it. */
const idle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * Make this series' banner soon, in the background (v0.51.0): called whenever someone looks at a series with no
 * banner of its own (routes/images.ts backdropRecipe, after its AniList lookup), so a series added today -- or one the
 * daily warm-up has not reached -- need not wait for the next run. The warm-up's manners: one at a time under the same
 * slot, HERO_PACE_MS between two makes, standing aside while a sweep, a repair or the source check runs; a series
 * made already, tried lately or not eligible is a query and nothing else. Nothing waits on it; the payload offers the
 * banner once it is made.
 * Reintroduce by not calling it from backdropRecipe: "a series looked at with no banner gets one made in the
 * background" in autoHero.int.test.ts never sees it made.
 */
export function queueHero(id: string): void {
  if (!queueOn) return;
  queued.add(id);
  // Started a microtask later, so the drain's own `draining = null` always lands after this assignment.
  if (!draining) draining = Promise.resolve().then(drainHeroQueue);
}

/** Resolves once the queue is empty (tests). */
export const heroQueueSettled = (): Promise<void> => draining ?? Promise.resolve();

async function drainHeroQueue(): Promise<void> {
  try {
    while (queued.size && !runtime.stopping) {
      const id: string = queued.values().next().value!;
      queued.delete(id);
      try {
        while (heroWaitsFor() && !runtime.stopping) await idle(QUIET_POLL_MS);
        if (runtime.stopping) break;
        if ((await makeOne(id)) === null) continue;
      } catch { /* a database gone away mid-make (a shutdown): the warm-up tries again */ }
      if (queued.size) await idle(HERO_PACE_MS);
    }
  } finally {
    // In the same turn as the loop's last look at the queue, so an id added after it starts a new drain.
    draining = null;
  }
}

/** The warm-up's schedule: a first run a while after boot, then daily. Owned mode only (server.ts). */
export function startHeroWarmup(log: { info(msg: string): void; warn(msg: string): void }): void {
  queueOn = true;
  const tick = async () => {
    try {
      const r = await warmHeroes();
      if (r.made || r.failed) log.info(`hero: ${r.made} banner(s) made from series pages, ${r.failed} could not be`);
    } catch (e) {
      log.warn(`hero: ${(e as Error)?.message || e}`);
    }
    setTimeout(tick, 24 * 3600_000).unref();
  };
  setTimeout(tick, firstRunFloor(20 * 60_000, 'autoHero')).unref();
}
