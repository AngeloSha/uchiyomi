import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MESH, MESH_FADE, MESH_LOOK } from '../lib/meshBake';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

// The baked picture is the CSS rule drawn by hand, so the two must say the same thing. Change a gradient, the blur, the
// opacity or the size in app/globals.css and forget lib/meshBake.ts: phones draw the old mesh, and this fails.
test('the baked mesh draws the same gradients, blur, opacity and size as the .fx-mesh rule', () => {
  const css = read('app/globals.css');
  const rule = css.slice(css.indexOf('.fx-mesh {'), css.indexOf('}', css.indexOf('.fx-mesh {')));
  assert.ok(rule.length > 20, 'no .fx-mesh rule in app/globals.css');
  const grads = [...rule.matchAll(/radial-gradient\((\d+)% (\d+)% at (\d+)% (\d+)%, (rgb\(var\(--accent\) \/ ([\d.]+)\)|rgba\((\d+), (\d+), (\d+), ([\d.]+)\)), transparent (\d+)%\)/g)];
  assert.equal(grads.length, MESH.length, 'the rule has a different number of gradients');
  grads.forEach((m, i) => {
    const l = MESH[i];
    assert.deepEqual([+m[1], +m[2], +m[3], +m[4]].map((n) => n / 100), [l.rx, l.ry, l.x, l.y], `gradient ${i + 1}'s shape or place`);
    if (m[6]) assert.deepEqual([l.rgb, l.alpha], ['accent', +m[6]], `gradient ${i + 1}'s colour`);
    else assert.deepEqual([l.rgb, l.alpha], [`${m[7]} ${m[8]} ${m[9]}`, +m[10]], `gradient ${i + 1}'s colour`);
    assert.equal(+m[11] / 100, MESH_FADE, `gradient ${i + 1}'s fade`);
  });
  assert.match(rule, new RegExp(`filter: blur\\(${MESH_LOOK.blur}px\\) saturate\\(${MESH_LOOK.saturate}\\);`), 'the filter');
  assert.match(rule, new RegExp(`opacity: ${MESH_LOOK.opacity};`), 'the opacity');
  assert.match(rule, new RegExp(`inset: -${(MESH_LOOK.size - 1) / 2 * 100}%;`), 'the size');
});

test('only a touch screen gets the picture, and it hands the layer back', () => {
  const src = read('lib/meshBake.ts');
  assert.match(src, /matchMedia\('\(hover: none\)'\)/, 'the picture is no longer limited to touch screens');
  assert.match(src, /if \(!touch\.matches\) \{ restore\(\); return; \}/, 'a hover pointer keeps the baked layer');
  assert.match(src, /if \(!url\) \{ restore\(\); return; \}/, 'a canvas that cannot filter leaves a half-baked layer');
  // The banners above the page are in the normal flow: without a position they would paint under an opaque mesh.
  assert.match(read('app/globals.css'), /\.banner-stack \{ position: relative; \}/, 'the banners can sit under the opaque mesh');
});
