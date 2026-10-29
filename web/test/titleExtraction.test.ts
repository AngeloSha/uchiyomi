import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CoverTitleRegions } from '../components/CoverTitleRegions';
import { AutomaticCoverTitles, TitleExtractionButton } from '../components/TitleExtraction';
import { coverPoint, coverRect, editCoverRect, sameCoverSelection } from '../lib/coverTitleRegions';
import { EXTRACTION_CAPABILITIES_KEY, extractionCanApply, extractionPoll, extractionProblem, extractionSelectionChanged, extractionJobSelection, type TitleExtractionJob } from '../lib/titleExtraction';
import type { Series } from '../lib/types';

(globalThis as { React?: unknown }).React = React;
const job = (extra: Partial<TitleExtractionJob> = {}): TitleExtractionJob => ({ id: 'j_1', seriesId: 's_1', automatic: false,
  status: 'ready', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  previewUrl: '/api/admin/series/s_1/title-extraction/j_1/preview', coverPreviewUrl: '/api/admin/series/s_1/title-extraction/j_1/cover',
  region: null, exclusions: [], reasons: [], error: null, quality: null, ...extra });

test('cover coordinates use the actual displayed image, clip pointer travel, and reject unusable layouts', () => {
  assert.deepEqual(coverPoint(200, 400, { left: 100, top: 200, width: 400, height: 500 }), { x: .25, y: .4 });
  assert.deepEqual(coverPoint(-10, 900, { left: 100, top: 200, width: 400, height: 500 }), { x: 0, y: 1 });
  for (const width of [0, -1, NaN, Infinity]) assert.equal(coverPoint(0, 0, { left: 0, top: 0, width, height: 100 }), null);
});

test('reverse touch drags make the same normalized area and no drag can escape the cover or have an empty size', () => {
  const a = { x: .8, y: .9 }, b = { x: .2, y: .1 };
  assert.deepEqual(coverRect(a, b), coverRect(b, a));
  assert.deepEqual(coverRect(a, b), { left: .2, top: .1, width: .6, height: .8 });
  for (const [start, end] of [[{ x: 1, y: 1 }, { x: 1, y: 1 }], [{ x: -1, y: -1 }, { x: 2, y: 2 }], [{ x: NaN, y: Infinity }, { x: NaN, y: -Infinity }]]) {
    const rect = coverRect(start, end);
    assert.ok(Object.values(rect).every(Number.isFinite));
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.width >= .01 && rect.height >= .01);
    assert.ok(rect.left + rect.width <= 1 && rect.top + rect.height <= 1);
  }
});

test('keyboard edits preserve the rest of the selection and cannot shrink it away or move it outside the cover', () => {
  const rect = { left: .1, top: .2, width: .5, height: .3 };
  assert.deepEqual(editCoverRect(rect, 'left', 1), { ...rect, left: .5 });
  assert.deepEqual(editCoverRect(rect, 'top', -4), { ...rect, top: 0 });
  assert.deepEqual(editCoverRect(rect, 'width', 4), { ...rect, width: .9 });
  assert.deepEqual(editCoverRect(rect, 'height', 0), { ...rect, height: .01 });
  assert.equal(editCoverRect(rect, 'left', NaN), rect);
  assert.deepEqual(rect, { left: .1, top: .2, width: .5, height: .3 }, 'the source selection is not mutated');
});

test('regions have labelled keyboard controls alongside pointer drawing and removable exclusions', () => {
  const html = renderToStaticMarkup(React.createElement(CoverTitleRegions, { src: 'blob:cover', onChange: () => {},
    selection: { region: { left: .1, top: .1, width: .8, height: .3 }, exclusions: [{ left: .8, top: .8, width: .1, height: .1 }] } }));
  for (const label of ['From left (%)', 'From top (%)', 'Width (%)', 'Height (%)']) assert.ok(html.includes(label));
  assert.equal((html.match(/type="number"/g) ?? []).length, 8);
  assert.match(html, /aria-label="Remove excluded area 1"/);
  assert.match(html, /alt="Cover used to extract the title"/);
  assert.doesNotMatch(html, /role="application"/);
  assert.match(html, /touch-pan-y/, 'ordinary cover browsing leaves touch scrolling available');
});

test('polling stops on terminal jobs, unavailable reads and a paused long-running request', () => {
  assert.equal(extractionPoll(job({ status: 'running' })), 1500);
  assert.equal(extractionPoll(job({ status: 'queued' })), 1500);
  for (const status of ['ready', 'error', 'rejected', 'expired', 'applied'] as const) assert.equal(extractionPoll(job({ status })), false);
  assert.equal(extractionPoll(job({ status: 'running' }), true), false);
  assert.equal(extractionPoll(job({ status: 'running' }), false, true), false);
});

test('Apply requires a decoded, current, unchanged ready preview and never accepts a machine score alone', () => {
  assert.equal(extractionCanApply(job(), false, false, true, false), true);
  for (const args of [[true, false, true, false], [false, true, true, false], [false, false, false, false], [false, false, true, true]] as const) {
    assert.equal(extractionCanApply(job(), args[0], args[1], args[2], args[3]), false);
  }
  assert.equal(extractionCanApply(job({ expiresAt: new Date(Date.now() - 10).toISOString() }), false, false, true, false), false);
  assert.equal(extractionCanApply(job({ status: 'rejected', quality: { modelMaskScore: 1 } }), false, false, true, false), false);
  assert.equal(sameCoverSelection({ region: null, exclusions: [] }, { region: null, exclusions: [] }), true);
  assert.equal(sameCoverSelection({ region: null, exclusions: [] }, { region: { left: 0, top: 0, width: 1, height: 1 }, exclusions: [] }), false);
  assert.equal(sameCoverSelection({ region: { left: 0, top: .1, width: 1, height: .8 }, exclusions: [] },
    { region: { height: .8, width: 1, top: .1, left: 0 }, exclusions: [] }), true, 'PostgreSQL JSON key order cannot make a fresh preview stale');
});

test('worker and stale errors are plain sentences rather than raw internals', () => {
  assert.match(extractionProblem('stale_cover'), /changed.*new preview/);
  assert.match(extractionProblem('stale_candidate'), /changed.*new preview/);
  assert.match(extractionProblem('worker_unavailable'), /not available/);
  assert.match(extractionProblem('extract_timeout'), /too long/);
  assert.doesNotMatch(extractionProblem('Traceback: model failed'), /Traceback|model/);
});

test('a preview becomes out of date when its title box or exclusions change, and exact undo may reuse it', () => {
  const region = { left: .1, top: .2, width: .7, height: .3 };
  const excluded = { left: .8, top: .8, width: .1, height: .1 };
  const saved = job({ region, exclusions: [excluded] });
  assert.equal(extractionSelectionChanged(saved, { region: { ...region }, exclusions: [{ ...excluded }] }), false);
  assert.equal(extractionSelectionChanged(saved, { region: { ...region, left: .15 }, exclusions: [excluded] }), true);
  assert.equal(extractionSelectionChanged(saved, { region, exclusions: [] }), true);
  assert.equal(extractionSelectionChanged(saved, { region, exclusions: [{ ...excluded, top: .75 }] }), true);
  assert.equal(extractionSelectionChanged(saved, { region: null, exclusions: [excluded] }), true);
  assert.equal(extractionSelectionChanged(saved, { region, exclusions: [excluded] }), false, 'undoing the selection restores exactly the saved preview');
  assert.equal(extractionSelectionChanged(null, { region, exclusions: [] }), false);
});

test('detected and tight cutout boxes never replace the requested manual area or invent one for automatic/legacy jobs', () => {
  const requested = { left: .07, top: .12, width: .83, height: .52 };
  const detected = { left: .11, top: .14, width: .7, height: .31 };
  const tight = { left: .17, top: .16, width: .6, height: .28 };
  const manual = job({ selectionMode: 'manual', region: requested, resultRegion: detected, candidateRegion: tight });
  assert.deepEqual(extractionJobSelection(manual).region, requested);
  assert.equal(extractionSelectionChanged(manual, { region: requested, exclusions: [] }), false);
  assert.equal(extractionSelectionChanged(manual, { region: detected, exclusions: [] }), true);
  for (const selectionMode of ['automatic', 'legacy'] as const) {
    const saved = job({ selectionMode, region: null, resultRegion: detected, candidateRegion: tight });
    assert.deepEqual(extractionJobSelection(saved), { region: null, exclusions: [] });
    assert.equal(extractionSelectionChanged(saved, { region: null, exclusions: [] }), false);
    assert.equal(extractionSelectionChanged(saved, { region: detected, exclusions: [] }), true);
  }
  assert.deepEqual(extractionJobSelection(job({ region: requested })).region, requested, 'older servers remain compatible');
});

test('unavailable capabilities disable extraction and automatic opt-in starts off until full checks are available', () => {
  const qc = new QueryClient();
  qc.setQueryData(EXTRACTION_CAPABILITIES_KEY, { available: false, reason: 'worker_unavailable', automaticAvailable: false, automaticApplyAvailable: false, maxExclusions: 8, timeoutSeconds: 90 });
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(React.Fragment, null,
    React.createElement(TitleExtractionButton, { series: { id: 's_1', name: 'Title' } as Series, onSaved: () => {} }),
    React.createElement(AutomaticCoverTitles, { enabled: false, save: async () => {} }))));
  assert.match(html, /data-art-extract-cover="true" disabled=""/);
  assert.match(html, /role="switch"[^>]*aria-checked="false"[^>]*disabled=""/);
  assert.match(html, /Other results wait for review/);
  assert.match(html, /Your manual choices and existing title logos are kept/);
});
