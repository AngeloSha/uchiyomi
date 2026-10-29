import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitleLogoScanProgress } from '../components/TitleLogoScan';
import { titleLogoNextAttempt, titleLogoScanPoll, type TitleLogoScanStatus } from '../lib/titleLogoScan';

(globalThis as { React?: unknown }).React = React;
const overview = (extra: Partial<TitleLogoScanStatus> = {}): TitleLogoScanStatus => ({
  enabled: true, running: false, checked: 7, nextRetryAt: null, providerRetryAt: null, lastScanAt: null,
  counts: { total: 120, ready: 4, missing: 2, error: 3, unchecked: 106, custom: 2, text: 3,
    eligible: 100, needsLink: 6, libraryOptOut: 5, firstPage: 2, pending: 0, due: 100 },
  ...extra,
});
const render = (extra: Partial<Parameters<typeof TitleLogoScanProgress>[0]> = {}) => renderToStaticMarkup(
  React.createElement(TitleLogoScanProgress, { enabled: true, status: overview(), onScan: () => {}, onRefresh: () => {}, ...extra }),
);
const count = (html: string, key: string) => Number(html.match(new RegExp(`data-title-logo-count="${key}"[\\s\\S]*?<dd[^>]*>(\\d+)</dd>`))?.[1]);

test('unsearched titles are distinct from completed no matches and cannot offer a retry for invented misses', () => {
  const status = overview({ checked: 0 });
  status.counts = { ...status.counts, ready: 0, missing: 0, error: 0, unchecked: 115 };
  const html = render({ status });
  assert.equal(count(html, 'unchecked'), 115);
  assert.equal(count(html, 'missing'), 0);
  assert.equal(count(html, 'checked'), 0);
  assert.doesNotMatch(html, /data-title-logo-action="retry"/);
  assert.doesNotMatch(html, /No match means the search finished/);
});

test('completed results, temporary failures and eligibility problems retain their separate meanings', () => {
  const html = render();
  for (const [key, expected] of Object.entries({ checked: 7, ready: 4, missing: 2, error: 3, unchecked: 106, needsLink: 6 })) {
    assert.equal(count(html, key), expected, key);
  }
  assert.match(html, /Automatic logos ready/);
  assert.match(html, /Waiting to retry/);
  assert.match(html, /Online lookups off/);
  assert.match(html, /Own pages only/);
  assert.match(html, /No match means the search finished without suitable artwork/);
  assert.match(html, /Your uploaded artwork and styled-title choices are kept/);
  assert.match(html, /data-title-logo-action="retry"/);
  assert.doesNotMatch(html, /role="progressbar"/, 'overlapping summary counts must not be added into a made-up progress percentage');
});

test('scan actions are disabled when off, loading, already running or the current overview could not be read', () => {
  for (const extra of [
    { enabled: false }, { status: undefined, loading: true }, { starting: true },
    { status: overview({ running: true }) }, { status: overview({ enabled: false }) }, { failed: true },
  ]) {
    const html = render(extra);
    assert.match(html, /data-title-logo-action="scan" disabled=""/);
    for (const button of html.matchAll(/<button[^>]*data-title-logo-action="retry"[^>]*>/g)) assert.match(button[0], /disabled=""/);
  }
  const idle = render();
  assert.match(idle, /data-title-logo-action="scan">Scan library/);
  assert.doesNotMatch(idle, /role="status"/);
  assert.match(render({ status: overview({ running: true }) }), /role="status">Checking title artwork…/);
  assert.match(render({ enabled: false }), /Turn on automatic title logos to scan the library/);
});

test('only an enabled in-progress scan is polled; off, idle, unavailable and failed status reads stop', () => {
  assert.equal(titleLogoScanPoll(overview({ running: true }), true), 2500);
  assert.equal(titleLogoScanPoll(overview({ running: true }), false), false);
  assert.equal(titleLogoScanPoll(overview({ running: true, enabled: false }), true), false);
  assert.equal(titleLogoScanPoll(overview(), true), false);
  assert.equal(titleLogoScanPoll(undefined, true), false);
  assert.equal(titleLogoScanPoll(overview({ running: true }), true, true), false);
});

test('the displayed next attempt respects both an artwork retry and the site’s requested pause', () => {
  const now = Date.UTC(2026, 9, 29, 12);
  const short = new Date(now + 60_000).toISOString();
  const long = new Date(now + 180_000).toISOString();
  assert.equal(titleLogoNextAttempt(overview({ nextRetryAt: short, providerRetryAt: long }), now), now + 180_000);
  assert.equal(titleLogoNextAttempt(overview({ nextRetryAt: long, providerRetryAt: short }), now), now + 180_000);
  assert.equal(titleLogoNextAttempt(overview({ nextRetryAt: new Date(now - 1).toISOString(), providerRetryAt: 'bad-date' }), now), null);
});

test('a failed read or start has a readable inline error and a failed read can be tried again', () => {
  const html = render({ failed: true, startError: true });
  assert.match(html, /role="alert"[^>]*>Could not load title artwork progress\./);
  assert.match(html, />Try again<\/button>/);
  assert.match(html, /role="alert"[^>]*>Could not start the title artwork scan\./);
});
