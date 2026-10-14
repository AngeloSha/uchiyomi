// The automatic banner, laid out as whole strips (UI refresh).
//
// The server makes a series with no banner of its own a banner from four crops of its pages (bff lib/autoHero.ts):
// a WIDE frame, four portrait strips side by side, or a TALL one, a 2 x 2 grid, with a 4 px seam between crops. It
// used to be shown as one picture with `object-cover`, and a hero is rarely 3:1 -- at 1366 px about a third of each
// outer strip was cut away, at 1024 px nearly two thirds, so the banner read as two panels and two slivers. Here each
// crop is its own tile instead: as many whole strips as the box has room for, each one covering its tile, with the
// page showing between them. Nothing is cut mid-panel and nothing is stretched.
//
// The numbers are the server's: web/test/mosaic.test.ts reads bff/src/lib/autoHero.ts and holds these to it.

export type MosaicFrame = 'wide' | 'tall';

/** The frames the server draws: their size, and where each crop sits in them (in the order the server lays them). */
export const MOSAIC_GAP = 4;
const STRIP_W = (1920 - 3 * MOSAIC_GAP) / 4; // 477
const CELL_W = 538, CELL_H = 718;
export const MOSAIC_FRAMES: Record<MosaicFrame, { w: number; h: number; cells: { x: number; y: number; w: number; h: number }[] }> = {
  wide: {
    w: 1920, h: 640,
    cells: [0, 1, 2, 3].map((i) => ({ x: i * (STRIP_W + MOSAIC_GAP), y: 0, w: STRIP_W, h: 640 })),
  },
  tall: {
    w: 2 * CELL_W + MOSAIC_GAP, h: 2 * CELL_H + MOSAIC_GAP,
    cells: [0, 1, 2, 3].map((i) => ({ x: (i % 2) * (CELL_W + MOSAIC_GAP), y: Math.floor(i / 2) * (CELL_H + MOSAIC_GAP), w: CELL_W, h: CELL_H })),
  },
};

/**
 * The frame's places, best crop first. The server puts its best two in the middle (`LAYOUT = [2, 0, 1, 3]`: place 1
 * holds the best, place 2 the second, place 0 the third), so a box with room for fewer strips keeps those.
 */
export const MOSAIC_RANK = [1, 2, 0, 3] as const;

export interface MosaicTile {
  /** The frame place this tile shows. */
  place: number;
  left: number; top: number; width: number; height: number;
  /** CSS for the frame as this tile's background, the crop covering the tile and centred in it. */
  backgroundSize: string;
  backgroundPosition: string;
}

/**
 * How many strips a box of this shape shows: the count whose tiles are closest in shape to a strip, so a strip is
 * cropped as little as possible to cover its tile. Between two and four.
 */
export function stripCount(box: { w: number; h: number }, gap: number): number {
  const shape = STRIP_W / 640;
  let best = 4, err = Infinity;
  for (const n of [4, 3, 2]) {
    const w = (box.w - (n - 1) * gap) / n;
    if (w <= 0) continue;
    const e = Math.abs(Math.log(w / box.h / shape));
    if (e < err - 1e-9) { err = e; best = n; }
  }
  return best;
}

/**
 * The tiles for a frame in a box: absolute positions in px from the box's top-left, `gap` px apart, each with the
 * background size and position that show its crop, covering the tile, centred. A tile never shows a neighbour or a
 * seam: the window it shows lies inside its own crop.
 */
export function mosaicTiles(frame: MosaicFrame, box: { w: number; h: number }, gap: number): MosaicTile[] {
  if (box.w <= 0 || box.h <= 0) return [];
  const f = MOSAIC_FRAMES[frame];
  let places: number[];
  let cols: number, rows: number;
  if (frame === 'tall') {
    places = [0, 1, 2, 3];
    cols = 2; rows = 2;
  } else {
    const n = stripCount(box, gap);
    places = [...MOSAIC_RANK.slice(0, n)].sort((a, b) => a - b);
    cols = n; rows = 1;
  }
  const tw = (box.w - (cols - 1) * gap) / cols;
  const th = (box.h - (rows - 1) * gap) / rows;
  return places.map((place, k) => {
    const c = f.cells[place];
    const s = Math.max(tw / c.w, th / c.h); // cover
    const left = (k % cols) * (tw + gap), top = Math.floor(k / cols) * (th + gap);
    // The crop scaled by s, centred on the tile: its top-left lands at minus (its offset in the frame, plus half the
    // overflow).
    const bx = -(c.x * s + (c.w * s - tw) / 2);
    const by = -(c.y * s + (c.h * s - th) / 2);
    return {
      place, left, top, width: tw, height: th,
      backgroundSize: `${(f.w * s).toFixed(2)}px ${(f.h * s).toFixed(2)}px`,
      backgroundPosition: `${bx.toFixed(2)}px ${by.toFixed(2)}px`,
    };
  });
}

/** Whether a loaded picture is the frame it should be: anything else is shown the old way (components/MosaicArt.tsx). */
export const isMosaicFrame = (frame: MosaicFrame, w: number, h: number) => w === MOSAIC_FRAMES[frame].w && h === MOSAIC_FRAMES[frame].h;
