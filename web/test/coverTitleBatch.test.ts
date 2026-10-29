import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CoverTitleBatchProgress } from '../components/CoverTitleBatch';
import { AutomaticCoverTitles } from '../components/TitleExtraction';
import { COVER_TITLE_BATCH_KEY, coverTitleBatchFinished, coverTitleBatchPoll, coverTitleBatchResumeDelay, requestCoverTitleBatch, type CoverTitleBatchStatus } from '../lib/coverTitleBatch';
import { EXTRACTION_CAPABILITIES_KEY } from '../lib/titleExtraction';
(globalThis as { React?: unknown }).React = React;
const overview = (extra: Partial<CoverTitleBatchStatus> = {}): CoverTitleBatchStatus => ({
  enabled: true, applyEnabled: false, available: true, checkedApplyAvailable: false, automaticApplyAvailable: false, running: false,
  schedule: { hour: 3, timezone: 'Europe/Berlin', nextRunAt: '2026-10-31T02:00:00.000Z' }, retentionDays: 14, reviewCount: 1,
  reviewSeries: [{ id: 's_1', title: 'Manga <one>', jobId: 'j_1' }],
  run: { id: 'r_1', origin: 'manual', status: 'completed', startedAt: '2026-10-30T12:00:00.000Z', finishedAt: '2026-10-30T12:10:00.000Z',
    counts: { total: 20, pending: 3, processing: 1, ready: 5, applied: 2, skipped: 4, failed: 3, cancelled: 2 }, currentSeries: null },
  ...extra,
});
const render = (extra: Partial<Parameters<typeof CoverTitleBatchProgress>[0]> = {}) => renderToStaticMarkup(React.createElement(CoverTitleBatchProgress, {
  enabled: true, status: overview(), onRun: () => {}, onStop: () => {}, onRefresh: () => {}, onReview: () => {}, ...extra,
}));
const count = (html: string, key: string) => Number(html.match(new RegExp(`data-cover-title-count="${key}"[\\s\\S]*?<dd[^>]*>(\\d+)</dd>`))?.[1]);

test('generation and checked applying are separate opt-ins; legacy calibration cannot disable preview generation', () => {
  const qc = new QueryClient();
  qc.setQueryData(EXTRACTION_CAPABILITIES_KEY, { available: true, automaticAvailable: false, automaticApplyAvailable: false, checkedApplyAvailable: false });
  qc.setQueryData(COVER_TITLE_BATCH_KEY, overview());
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(AutomaticCoverTitles, {
    enabled: false, applyEnabled: false, save: async () => {}, saveApply: async () => {},
  })));
  const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((match) => match[0]);
  assert.equal(switches.length, 2); assert.doesNotMatch(switches[0], / disabled=""/); assert.match(switches[1], / disabled=""/);
  assert.match(html, /No manga link is required to make a preview/);
  assert.match(html, /available title and image checks/);
  assert.match(html, /Title checks are not available/);
  assert.doesNotMatch(html, /full title and image pass checks|calibrat|confidence/i);
  qc.setQueryData(EXTRACTION_CAPABILITIES_KEY, { available: true, automaticApplyAvailable: false, checkedApplyAvailable: true });
  const ready = renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(AutomaticCoverTitles, {
    enabled: true, applyEnabled: false, save: async () => {}, saveApply: async () => {},
  })));
  assert.equal([...ready.matchAll(/<button[^>]*role="switch"[^>]* disabled=""/g)].length, 0, 'available checks do not need legacy calibration');
});

test('run counts stay distinct and review items point to their exact retained jobs', () => {
  const html = render();
  for (const [name, expected] of Object.entries({ pending: 3, processing: 1, ready: 5, applied: 2, skipped: 4, failed: 3, cancelled: 2 })) assert.equal(count(html, name), expected);
  assert.match(html, /Finished: 16 of 20/); assert.equal(coverTitleBatchFinished(overview().run!), 16);
  assert.match(html, /data-cover-title-review="j_1"/); assert.match(html, /Manga &lt;one&gt;/);
  assert.match(html, /Previews are kept for 14 days/); assert.match(html, /Every night at 03:00 \(Europe\/Berlin\)/);
  assert.doesNotMatch(html, /role="progressbar"/, 'the UI reports outcome counts rather than suggesting review means published');
});

test('an explicit one-off can run with nightly generation off and explains its preview-only behavior', () => {
  const html = render({ enabled: false, status: overview({ enabled: false }) });
  assert.match(html, /data-cover-title-action="run">Run now/);
  assert.match(html, /Run now prepares previews only/); assert.match(html, /Nightly runs are off/);
  assert.doesNotMatch(html, /Next nightly run:/);
});

test('active runs offer only a stop; failed or unavailable reads never start duplicate work', () => {
  const running = overview({ running: true }); running.run!.status = 'running'; running.run!.currentSeries = { id: 's 1', title: 'Title' };
  const html = render({ status: running });
  assert.match(html, /data-cover-title-action="run" disabled/); assert.match(html, /data-cover-title-action="stop">Stop this run/);
  assert.match(html, /Creating a preview for Title/); assert.match(html, /href="\/series\/?\?id=s%201"/);
  for (const props of [{ failed: true }, { status: undefined }, { operation: 'run' as const }, { status: overview({ available: false }) }]) assert.match(render(props), /data-cover-title-action="run" disabled/);
  const offline = render({ status: overview({ available: false }) });
  assert.match(offline, /data-cover-title-review="j_1">Review/); assert.doesNotMatch(offline, /data-cover-title-review="j_1" disabled/, 'saved previews remain reviewable without inference');
});

test('only active runs poll, including an explicitly requested run while nightly is off', () => {
  assert.equal(coverTitleBatchPoll(overview({ enabled: false, running: true })), 2500);
  assert.equal(coverTitleBatchPoll(overview()), false); assert.equal(coverTitleBatchPoll(undefined), false);
  assert.equal(coverTitleBatchPoll(overview({ running: true }), true), false);
});

test('idle pages wake once at the next nightly deadline and cleanly stop when disabled or failed', () => {
  const now = Date.UTC(2026, 9, 30, 12), status = overview({ schedule: { hour: 3, timezone: 'UTC', nextRunAt: new Date(now + 60_000).toISOString() } });
  assert.equal(coverTitleBatchResumeDelay(status, false, now), 91_000);
  assert.equal(coverTitleBatchResumeDelay(status, false, now + 100_000), 60_000);
  assert.equal(coverTitleBatchResumeDelay({ ...status, enabled: false }, false, now), null);
  assert.equal(coverTitleBatchResumeDelay({ ...status, running: true }, false, now), null);
  assert.equal(coverTitleBatchResumeDelay(status, true, now), null);
  assert.equal(coverTitleBatchResumeDelay(overview({ schedule: { hour: 3, timezone: 'UTC', nextRunAt: 'bad' } }), false, now), null);
  assert.equal(coverTitleBatchResumeDelay(overview({ schedule: { hour: 3, timezone: 'UTC', nextRunAt: new Date(now + 9_000_000_000).toISOString() } }), false, now), 2_147_483_647);
});

test('an offline worker with an overdue nightly schedule cannot cause an immediate status refetch loop', () => {
  const now = Date.UTC(2026, 9, 30, 12), status = overview({ available: false, running: false,
    schedule: { hour: 3, timezone: 'UTC', nextRunAt: new Date(now - 3_600_000).toISOString() } });
  assert.equal(coverTitleBatchResumeDelay(status, false, now), 60_000);
  assert.equal(coverTitleBatchResumeDelay(status, false, now + 60_000), 60_000, 'an unchanged overdue response keeps the same bounded backoff');
  assert.equal(coverTitleBatchResumeDelay(status, true, now), null, 'failed reads still wait for an explicit retry');
  const future = { ...status, schedule: { ...status.schedule, nextRunAt: new Date(now + 90_000).toISOString() } };
  assert.equal(coverTitleBatchResumeDelay(future, false, now), 121_000, 'future deadlines retain precise timing');
});

test('read/start/stop/review errors are actionable without claiming artwork changed', () => {
  assert.match(render({ failed: true }), /Could not load cover title progress/);
  assert.match(render({ failed: true }), />Try again<\/button>/);
  assert.match(render({ problem: 'run' }), /Could not start cover title generation/);
  assert.match(render({ problem: 'stop' }), /Could not stop cover title generation/);
  assert.match(render({ reviewError: true }), /Could not open this title preview/);
});

test('run and cancel each adopt the bare authoritative status from one POST, preserving their request contract', async (t) => {
  const calls: { path: string; method?: string; body: unknown }[] = [];
  const expected = overview();
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ path: new URL(String(input), 'http://fixture').pathname, method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json(expected);
  });
  assert.deepEqual(await requestCoverTitleBatch({ kind: 'run', retryErrors: true }), expected);
  assert.deepEqual(await requestCoverTitleBatch({ kind: 'stop', runId: 'r_1' }), expected);
  assert.deepEqual(calls, [
    { path: '/api/admin/title-extraction/batch/run', method: 'POST', body: { retryErrors: true } },
    { path: '/api/admin/title-extraction/batch/cancel', method: 'POST', body: { runId: 'r_1' } },
  ]);
});
