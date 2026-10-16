// The Reading studio's "All time" heatmap (#265, CheetahDoesStuff): fixed cells in a sideways scroller, with the year and
// the month over the first week of each, opened on the newest weeks -- while every other heatmap (the Studio's 90/180/365
// days, Wrapped's year) draws exactly as it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Heatmap } from '../components/charts/Heatmap';

(globalThis as any).React = React;

const texts = (html: string) => [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test('All time: a strip of fixed cells in a sideways scroller, with the years and the months over their first weeks', () => {
  // 2025-11-20 is a Thursday, so its week is column 0 and December 1st falls in column 2 -- too close for "Nov" to fit
  // before "Dec", so the strip's own first month is left out. Its year is not: the next year starts in column 6.
  const html = renderToStaticMarkup(createElement(Heatmap, { values: Array(400).fill(0).map((_, i) => i % 3), start: '2025-11-20', scroll: true }));
  assert.match(html, /<div[^>]*data-heatmap-scroll[^>]*data-lenis-prevent-horizontal[^>]*class="[^"]*overflow-x-auto/,
    'not a sideways scroller that leaves the page\'s vertical wheel to Lenis');
  const weeks = Math.ceil((4 + 400) / 7);
  assert.match(html, new RegExp(`<svg width="${weeks * 15 - 3}" height="${7 * 15 - 3 + 28}"`), 'the cells are not a fixed size');
  assert.deepEqual(texts(html), ['2025', '2026', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  // A strip that opens on a month's first week keeps that month.
  assert.deepEqual(texts(renderToStaticMarkup(createElement(Heatmap, { values: Array(40).fill(1), start: '2026-03-01', scroll: true }))),
    ['2026', 'Mar', 'Apr']);
});

test('every other heatmap is drawn as before: the card\'s width, no ticks, no scroller', () => {
  const html = renderToStaticMarkup(createElement(Heatmap, { values: Array(90).fill(1), start: '2026-07-01' }));
  assert.match(html, /^<svg width="100%" viewBox="0 0 /);
  assert.equal(texts(html).length, 0);
  assert.doesNotMatch(html, /data-heatmap-scroll/);
});

test('the strip opens on the newest weeks, at the left in Arabic, and only the Studio\'s All time scrolls', () => {
  const src = readFileSync(join(__dirname, '../components/charts/Heatmap.tsx'), 'utf8');
  // An RTL scroller counts scrollLeft down from 0 at its right edge, and the weeks run from the right in Arabic.
  // Reintroduce `el.scrollLeft = el.scrollWidth` alone: an Arabic reader opens on the oldest weeks.
  assert.match(src, /el\.scrollLeft = rtl \? -el\.scrollWidth : el\.scrollWidth;/);
  assert.match(src, /\}, \[rtl, weeks\]\);/, 'the strip scrolls back to the end on every refetch, or never after the language changes');
  const you = readFileSync(join(__dirname, '../components/ProfileYou.tsx'), 'utf8');
  assert.match(you, /<Heatmap values=\{counts\} start=\{series\[0\]\.day\} scroll \/>/);
  assert.equal((you.match(/<Heatmap /g) ?? []).length, 2, 'the Studio draws one heatmap per range');
  assert.match(you, /enabled: !all,/, 'All time still asks for the reading time it does not show');
});
