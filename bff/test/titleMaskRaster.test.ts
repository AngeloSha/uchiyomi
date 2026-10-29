import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeTitleMask, TitleMaskRasterError, type MaskStroke } from '../src/lib/titleMaskRaster';

test('browser and server use identical raster code', () => {
  assert.equal(readFileSync(resolve('src/lib/titleMaskRaster.ts'), 'utf8'), readFileSync(resolve('../web/lib/titleMaskRaster.ts'), 'utf8'));
});
test('round dots use pixel centers, preserve baseline alpha and never mutate it', () => {
  const original = new Uint8Array(10000); original[0] = 127;
  const output = rasterizeTitleMask(original, 100, 100, [{ mode: 'restore', radius: .01, points: [{ x: .505, y: .505 }] }]);
  assert.equal(output[50 * 100 + 50], 255);
  assert.equal(output[50 * 100 + 51], 255);
  assert.equal(output[51 * 100 + 51], 0);
  assert.equal(output[0], 127); assert.equal(original[50 * 100 + 50], 0);
});
test('continuous capsules have no gaps and straight-line sampling does not change the result', () => {
  const original = new Uint8Array(10000);
  const stroke: MaskStroke = { mode: 'restore', radius: .015, points: [{ x: .1, y: .505 }, { x: .9, y: .505 }] };
  const output = rasterizeTitleMask(original, 100, 100, [stroke]);
  for (let x = 10; x < 90; x++) assert.equal(output[50 * 100 + x], 255);
  assert.deepEqual(output, rasterizeTitleMask(original, 100, 100, [{ ...stroke, points: [stroke.points[0], { x: .5, y: .505 }, stroke.points[1]] }]));
});
test('erase and restore replay in order; undo replays the immutable baseline', () => {
  const original = new Uint8Array(10000).fill(255);
  const erase: MaskStroke = { mode: 'erase', radius: .04, points: [{ x: .505, y: .505 }] };
  const restore: MaskStroke = { mode: 'restore', radius: .01, points: [{ x: .505, y: .505 }] };
  const output = rasterizeTitleMask(original, 100, 100, [erase, restore]);
  assert.equal(output[50 * 100 + 50], 255); assert.equal(output[50 * 100 + 53], 0);
  assert.equal(rasterizeTitleMask(original, 100, 100, [erase])[50 * 100 + 50], 0);
  assert.deepEqual(rasterizeTitleMask(original, 100, 100, []), original);
});
test('brushes clip at the image edge and radius uses the shorter image side', () => {
  const output = rasterizeTitleMask(new Uint8Array(20000), 200, 100, [{ mode: 'restore', radius: .02, points: [{ x: 0, y: 0 }] }]);
  assert.equal(output[0], 255); assert.equal(output[1], 255); assert.equal(output[200], 255);
  assert.equal(output[2], 0); assert.equal(output[400], 0);
});
test('invalid geometry, nonfinite coordinates, excessive input and expensive paths fail before painting', () => {
  const stroke: MaskStroke = { mode: 'restore', radius: .01, points: [{ x: .5, y: .5 }] };
  for (const value of [NaN, Infinity, -.1, 1.01]) assert.throws(() => rasterizeTitleMask(new Uint8Array(10000), 100, 100,
    [{ ...stroke, points: [{ x: value, y: .5 }] }]), TitleMaskRasterError);
  assert.throws(() => rasterizeTitleMask(new Uint8Array(10000), 100, 100, Array(129).fill(stroke)), TitleMaskRasterError);
  assert.throws(() => rasterizeTitleMask(new Uint8Array(10000), 100, 100, [{ ...stroke, points: Array(8193).fill({ x: .5, y: .5 }) }]), TitleMaskRasterError);
  assert.throws(() => rasterizeTitleMask(new Uint8Array(2400 * 1800), 2400, 1800, [{ mode: 'erase', radius: .05,
    points: Array.from({ length: 20 }, (_, index) => ({ x: index % 2, y: index % 2 })) }]), /mask_too_complex/);
  assert.throws(() => rasterizeTitleMask(new Uint8Array(1), 2401, 1, []), TitleMaskRasterError);
});
