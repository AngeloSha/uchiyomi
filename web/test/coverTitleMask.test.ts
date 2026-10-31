import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverTitleMaskEditor } from '../components/CoverTitleMaskEditor';
import { appendMaskPoint, cropTitleMask, maskCanvasPoint, maskKeyboardPoint, maskRgba, sameMaskStrokes } from '../lib/coverTitleMask';
import { applyTitleMaskStrokes, type TitleMaskStroke } from '../lib/titleMaskRaster';
import { extractionPreviewDecoded, extractionPreviewPath, type TitleExtractionJob } from '../lib/titleExtraction';
(globalThis as { React?: unknown }).React = React;

test('scrolling and zoom change the view but not normalized full-source brush coordinates', () => {
  assert.deepEqual(maskCanvasPoint(75, 140, { left: 25, top: 40, width: 100, height: 200 }), { x: .5, y: .5 });
  assert.deepEqual(maskCanvasPoint(220, 450, { left: 20, top: 50, width: 400, height: 800 }), { x: .5, y: .5 });
  assert.deepEqual(maskCanvasPoint(-10, 999, { left: 0, top: 0, width: 100, height: 100 }), { x: 0, y: 1 });
  assert.equal(maskCanvasPoint(1, 2, { left: 0, top: 0, width: 0, height: 5 }), null);
});

test('the smallest keyboard brush paints a real pixel and arrow steps preserve its centre', () => {
  const width = 460, height = 702;
  const point = maskKeyboardPoint({ x: .5, y: .5 }, 0, 0, width, height);
  const next = maskKeyboardPoint(point, 1, -1, width, height);
  assert.ok(Math.abs(point.x * width - 230.5) < 1e-10); assert.ok(Math.abs(point.y * height - 351.5) < 1e-10);
  assert.ok(Math.abs(next.x * width - 231.5) < 1e-10); assert.ok(Math.abs(next.y * height - 350.5) < 1e-10);
  const alpha = applyTitleMaskStrokes(new Uint8Array(width * height), width, height, [{ mode: 'restore', radius: .0005, points: [point] }]);
  assert.equal(alpha[351 * width + 230], 255);
  assert.equal(alpha.filter(Boolean).length, 1);
});

test('pointer sampling reduces duplicate/collinear samples while preserving corners and the final position', () => {
  const first = [{ x: .1, y: .1 }];
  assert.deepEqual(appendMaskPoint(first, { x: .10001, y: .1 }, 1000, 1000, .01), first);
  assert.deepEqual(appendMaskPoint(first, { x: .10001, y: .1 }, 1000, 1000, .01, true).at(-1), { x: .10001, y: .1 });
  assert.equal(appendMaskPoint([{ x: .1, y: .1 }, { x: .2, y: .2 }], { x: .3, y: .3 }, 100, 100, .01).length, 2);
  assert.equal(appendMaskPoint([{ x: .1, y: .1 }, { x: .2, y: .2 }], { x: .3, y: .25 }, 100, 100, .01).length, 3);
});

test('erasing and restoring never invent RGB, and a cropped live preview uses the correct source pixels', () => {
  const width = 20, height = 20;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) source.set([i % 251, 47, 203, 255], i * 4);
  const strokes: TitleMaskStroke[] = [{ mode: 'restore', radius: .05, points: [{ x: .525, y: .525 }] }];
  const alpha = applyTitleMaskStrokes(new Uint8Array(width * height), width, height, strokes);
  const preview = maskRgba(source, alpha);
  for (let i = 0; i < alpha.length; i++) assert.deepEqual([...preview.slice(i * 4, i * 4 + 3)], [...source.slice(i * 4, i * 4 + 3)]);
  const crop = cropTitleMask(source, alpha, width, height)!;
  assert.ok(crop.width < width && crop.height < height);
  assert.deepEqual([...crop.pixels.slice(0, 3)], [...source.slice((crop.top * width + crop.left) * 4, (crop.top * width + crop.left) * 4 + 3)]);
  assert.equal(cropTitleMask(source, new Uint8Array(width * height), width, height), null);
  assert.equal(source[3], 255, 'source RGB/alpha stays immutable');
});

test('saved stroke equality ignores JSON key order and detects a changed mode or radius', () => {
  const strokes: TitleMaskStroke[] = [{ mode: 'restore', radius: .01, points: [{ x: .2, y: .3 }] }];
  assert.equal(sameMaskStrokes(strokes, [{ points: [{ y: .3, x: .2 }], radius: .01, mode: 'restore' }]), true);
  assert.equal(sameMaskStrokes(strokes, [{ ...strokes[0], mode: 'erase' }]), false);
  assert.equal(sameMaskStrokes(strokes, [{ ...strokes[0], radius: .02 }]), false);
});

test('Apply cannot use a previously decoded blob after the mask revision advances', () => {
  const base: TitleExtractionJob = { id: 'j_1', seriesId: 's_1', previewUrl: '/api/admin/series/s_1/title-extraction/j_1/preview',
    automatic: false, status: 'ready', createdAt: '', expiresAt: '', coverPreviewUrl: null, region: null, exclusions: [], reasons: [], error: null, quality: null,
    mask: { revision: 0, strokes: [], canvas: { width: 20, height: 20, sourceUrl: '', baselineUrl: '' } } };
  const old = extractionPreviewPath('s_1', base)!;
  assert.match(old, /\?revision=0$/);
  assert.equal(extractionPreviewDecoded('s_1', base, old), true);
  const updated = { ...base, mask: { ...base.mask!, revision: 1 } };
  assert.equal(extractionPreviewDecoded('s_1', updated, old), false);
  assert.equal(extractionPreviewDecoded('s_1', updated, extractionPreviewPath('s_1', updated)), true);
  assert.equal(extractionPreviewPath('other', updated), null);
});

test('the correction editor offers named tools, bounded brush/zoom inputs and a keyboard reachable canvas', () => {
  const html = renderToStaticMarkup(React.createElement(CoverTitleMaskEditor, { jobId: 'j_1', sourceUrl: 'blob:source', baselinePath: '/api/admin/baseline',
    mask: { revision: 0, strokes: [], canvas: { width: 460, height: 702, sourceUrl: '', baselineUrl: '' } },
    onDraft: () => {}, onReset: async () => {}, onDone: () => {} }));
  assert.match(html, /data-mask-tool="restore"/); assert.match(html, /data-mask-tool="erase"/); assert.match(html, /data-mask-tool="move"/);
  assert.match(html, /role="group" tabindex="0" aria-label="Title correction canvas"/);
  assert.match(html, /min="0.0005" max="0.05"/);
  assert.match(html, /data-lenis-prevent/);
  assert.match(html, /The faint cover is a guide/);
});
