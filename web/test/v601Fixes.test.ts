// v0.60.1, small things found in Squeaks72's fork (discussion #176) that v0.60.0 still had: a heart that leaned left,
// a phone title that slid under the banner, and a library list that stayed stale after an admin changed the libraries.
// Every guard names the edit that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IcHeart } from '../components/icons';

// The components are compiled with the classic JSX runtime here, as in v580Ratings.test.ts.
(globalThis as { React?: unknown }).React = React;

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Every point a path names, absolute: the ends and both control points of each curve, an `s`'s implied one too. */
function pathPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MmCcSsZz]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const pts: Array<[number, number]> = [];
  let i = 0, cmd = '', x = 0, y = 0, lastC2: [number, number] | null = null;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const at = (dx: number, dy: number): [number, number] => (rel ? [x + dx, y + dy] : [dx, dy]);
    switch (cmd.toUpperCase()) {
      case 'M': { [x, y] = at(num(), num()); pts.push([x, y]); lastC2 = null; break; }
      case 'C': {
        const c1 = at(num(), num()), c2 = at(num(), num()), e = at(num(), num());
        pts.push(c1, c2, e); [x, y] = e; lastC2 = c2; break;
      }
      case 'S': {
        const c1: [number, number] = lastC2 ? [2 * x - lastC2[0], 2 * y - lastC2[1]] : [x, y];
        const c2 = at(num(), num()), e = at(num(), num());
        pts.push(c1, c2, e); [x, y] = e; lastC2 = c2; break;
      }
      case 'Z': { lastC2 = null; break; }
      default: throw new Error(`unexpected path command ${cmd}`);
    }
  }
  return pts;
}

test('the heart is mirrored about its tip, x = 12', () => {
  // Reintroduce the v0.60.0 path (lobes meeting at x = 10, tip at x = 12): points without a mirror image fail this.
  const d = /\bd="([^"]+)"/.exec(renderToStaticMarkup(createElement(IcHeart)))?.[1] ?? '';
  const pts = pathPoints(d);
  assert.ok(pts.length > 8, `PREMISE: the heart's path was read (${d})`);
  for (const [px, py] of pts) {
    const mirrored = pts.some(([qx, qy]) => Math.abs(qx - (24 - px)) < 0.01 && Math.abs(qy - py) < 0.01);
    assert.ok(mirrored, `(${px.toFixed(2)}, ${py.toFixed(2)}) has no mirror image about x = 12`);
  }
  // The dip between the lobes and the tip sit on that line.
  const top = pts.filter(([, py]) => py > 6 && py < 9).find(([px]) => Math.abs(px - 12) < 0.01);
  assert.ok(top, 'the dip between the lobes is at x = 12');
});

test("the phone title is on the cover, whole: never behind the art, never past the screen's edge", () => {
  // v0.60.1: the cover-and-title row rose into the banner, which painted over a long title's first lines. Since the UI
  // refresh's phone pass the title is IN the hero, on the cover's foot, so nothing can paint over it. Reintroduce the old
  // row, or take the title out of the hero: this fails; drop `break-words` or `line-clamp-3`: a long word overflows, or a
  // long title climbs up the art.
  const page = src('app/series/page.tsx');
  const hero = page.slice(page.indexOf('<div data-series-hero'), page.indexOf('{/* content */}'));
  assert.ok(hero.length > 0, 'the hero is not where this test looks');
  assert.match(hero, /<h1 ref=\{heroTitleRef\} dir="auto" className="line-clamp-3 break-words [^"]*"/, 'the phone title is not on the cover');
  assert.doesNotMatch(page, /<div className="relative z-10 min-w-0 pb-1 lg:hidden">/, 'the old row beside a small cover is back');
});

test('changing libraries in Admin refreshes the library list the Library page and the 18+ toggle read', () => {
  // useLibraries() (components/AdultToggle.tsx) keeps ['libraries'] for five minutes. Reintroduce by dropping
  // ['libraries'] from LibrariesSection's refresh: this fails.
  const admin = src('app/admin/page.tsx');
  const refresh = /const refresh = \(\) => \{ for \(const k of \[([^\n]*)\]\) qc\.invalidateQueries/.exec(admin.slice(admin.indexOf('function LibrariesSection')))?.[1] ?? '';
  assert.ok(refresh, 'PREMISE: LibrariesSection has a refresh');
  assert.match(refresh, /\['libraries'\]/);
});
