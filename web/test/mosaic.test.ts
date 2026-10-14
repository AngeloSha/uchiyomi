// The automatic banner as whole strips (lib/mosaic.ts, UI refresh): the geometry, held to the server's.
//
// The frame is drawn by the bff (lib/autoHero.ts) and tiled here, so the two must agree on every number: a strip one
// pixel off would show a sliver of the seam, or of the next panel, down a tile's edge. This reads the server's source
// rather than importing it, because the web build cannot import bff code. Reintroduce by changing MOSAIC_GAP to 5, or
// MOSAIC_RANK to [0, 1, 2, 3]: "agrees with the server" fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MOSAIC_FRAMES, MOSAIC_GAP, MOSAIC_RANK, mosaicTiles, stripCount, isMosaicFrame } from '../lib/mosaic';

const BFF = readFileSync(join(__dirname, '..', '..', 'bff', 'src', 'lib', 'autoHero.ts'), 'utf8');

test("the tiling agrees with the server's frames, seam and order", () => {
  assert.equal(Number(/export const HERO_GAP = (\d+);/.exec(BFF)?.[1]), MOSAIC_GAP, 'the seam between crops');
  assert.match(BFF, /const STRIP_W = Math\.floor\(\(1920 - 3 \* HERO_GAP\) \/ 4\);/, 'the wide frame is four strips across 1920');
  assert.match(BFF, /const STRIP_H = 640;/, 'the wide frame is 640 tall');
  assert.match(BFF, /wide: \{ w: 1920, h: STRIP_H, cols: 4 \}/, 'the wide frame');
  assert.match(BFF, /tall: \{ w: 2 \* 538 \+ HERO_GAP, h: 2 \* 718 \+ HERO_GAP, cols: 2 \}/, 'the tall frame');
  assert.deepEqual([MOSAIC_FRAMES.wide.w, MOSAIC_FRAMES.wide.h], [1920, 640]);
  assert.deepEqual([MOSAIC_FRAMES.tall.w, MOSAIC_FRAMES.tall.h], [2 * 538 + 4, 2 * 718 + 4]);
  // Floor, as the server's STRIP_W: (1920 - 12) / 4 is exactly 477, so the integer the server cuts is the same.
  assert.equal(MOSAIC_FRAMES.wide.cells[1].x, 477 + 4);
  // LAYOUT[place] is the rank of the crop drawn there (0 = best). The best-first list of places is its inverse.
  const layout = JSON.parse(/const LAYOUT = (\[[\d, ]+\]);/.exec(BFF)![1]) as number[];
  assert.deepEqual([...MOSAIC_RANK], [0, 1, 2, 3].map((rank) => layout.indexOf(rank)), 'which places hold the best crops');
});

test('a box gets as many whole strips as suit its shape: 4 on a wide screen, 3 at 1024-1366, 2 on a phone banner', () => {
  // The heroes' boxes: 64vh at 1920x1080, 2560x1440, 1366x860 and 1024x800 (the bleed reaches the window's width).
  assert.equal(mosaicTiles('wide', { w: 1920, h: 691 }, 6).length, 4);
  assert.equal(mosaicTiles('wide', { w: 2560, h: 922 }, 6).length, 4);
  assert.equal(mosaicTiles('wide', { w: 1366, h: 550 }, 6).length, 3);
  assert.equal(mosaicTiles('wide', { w: 1024, h: 512 }, 6).length, 3);
  // A phone's series banner (h-72) is a wide frame in a 390 x 288 box: the best two.
  const phone = mosaicTiles('wide', { w: 390, h: 288 }, 4);
  assert.deepEqual(phone.map((t) => t.place), [1, 2], 'the best two crops, in their own order');
  // Three keep the best three in the frame's order: places 0, 1 and 2, the fourth (place 3) dropped.
  assert.deepEqual(mosaicTiles('wide', { w: 1366, h: 550 }, 6).map((t) => t.place), [0, 1, 2]);
  // The tall frame is always its 2 x 2.
  assert.deepEqual(mosaicTiles('tall', { w: 390, h: 490 }, 4).map((t) => t.place), [0, 1, 2, 3]);
  assert.equal(stripCount({ w: 1920, h: 691 }, 6), 4);
});

test('the tiles fill the box, gap apart, and each shows only its own crop', () => {
  // Reintroduce `contain` (Math.min) for `cover` in mosaicTiles: "shows the seam" fails -- the crop no longer covers
  // its tile, and the frame around it shows.
  for (const frame of ['wide', 'tall'] as const) {
    for (const [w, h, gap] of [[1920, 691, 6], [1366, 550, 6], [1024, 512, 6], [390, 490, 4], [390, 288, 4], [2560, 922, 8], [700, 700, 6]]) {
      const tiles = mosaicTiles(frame, { w, h }, gap);
      const f = MOSAIC_FRAMES[frame];
      const last = tiles[tiles.length - 1];
      assert.ok(Math.abs(last.left + last.width - w) < 0.01, `${frame} ${w}x${h}: the tiles do not reach the box's end`);
      assert.ok(Math.abs(last.top + last.height - h) < 0.01, `${frame} ${w}x${h}: the tiles do not reach the box's bottom`);
      for (let i = 1; i < tiles.length; i++) {
        const a = tiles[i - 1], b = tiles[i];
        if (a.top === b.top) assert.ok(Math.abs(b.left - (a.left + a.width) - gap) < 0.01, `${frame} ${w}x${h}: tiles ${i - 1}/${i} are not ${gap} px apart`);
      }
      for (const t of tiles) {
        const [sw] = t.backgroundSize.split(' ').map(parseFloat);
        const [bx, by] = t.backgroundPosition.split(' ').map(parseFloat);
        const s = sw / f.w;
        const c = f.cells[t.place];
        // The window the tile shows, in frame pixels: [-bx, -bx + width] / s, the same for y.
        const x0 = -bx / s, x1 = (-bx + t.width) / s, y0 = -by / s, y1 = (-by + t.height) / s;
        const inside = x0 >= c.x - 0.01 && x1 <= c.x + c.w + 0.01 && y0 >= c.y - 0.01 && y1 <= c.y + c.h + 0.01;
        assert.ok(inside, `${frame} ${w}x${h} place ${t.place}: shows the seam or a neighbour (${x0.toFixed(1)}..${x1.toFixed(1)} of ${c.x}..${c.x + c.w})`);
      }
    }
  }
});

test('only the exact frame is tiled: anything else falls back to the old picture', () => {
  assert.equal(isMosaicFrame('wide', 1920, 640), true);
  assert.equal(isMosaicFrame('tall', 1080, 1440), true);
  assert.equal(isMosaicFrame('wide', 1600, 900), false, 'an AniList banner or a cover is not a mosaic frame');
});
