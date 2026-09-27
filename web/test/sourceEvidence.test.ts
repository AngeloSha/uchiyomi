// #115: one verdict about a source, said the same way on Providers and on Health (lib/sourceEvidence.ts, and the
// component that draws it, components/SourceEvidence.tsx).
//
// The reporter's screenshots are the fixtures: Test on "Manga Ball (EN)" failed at Search with the extension's own
// Java exception, and the card said "Working normally." under the ✗ -- `d.reason || 'Working normally.'` for a
// diagnosis that had no reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  answerView, evidenceView, testClock, checkAllLabel, sweepToast, STAGE_LABELS, BY_LABELS, GLYPH_WORDS,
  type StageLine, type TestAnswer,
} from '../lib/sourceEvidence';
import { SourceEvidence } from '../components/SourceEvidence';

// Under tsx the components compile to the classic `React.createElement`, looked up as a global.
(globalThis as any).React = React;
const ROOT = join(__dirname, '..');

const ENGINE = 'suwayomi: Exception while fetching data (/fetchSourceManga) : java.lang.Exception: HTTP error 403';
/** Manga Ball's Test: the engine answered, with the extension's exception, at Search. */
const ballTest = (over: Partial<TestAnswer> = {}): TestAnswer => ({
  ok: false,
  checks: [{ name: 'Search', ok: false, detail: ENGINE.slice(0, 80), stage: 'search', kind: 'error', error: ENGINE }],
  diagnosis: { code: 'extension_error', reason: 'This source\'s extension reported an error.', fix: 'Update the extension under Extensions.' },
  state: 'fail', stage: 'search', ...over,
});
const passing: TestAnswer = {
  ok: true, state: 'pass',
  checks: [
    { name: 'Search', ok: true, detail: '12 result(s)', stage: 'search' },
    { name: 'Series page', ok: true, detail: 'Walk Tale', stage: 'chapters' },
    { name: 'Chapters', ok: true, detail: '14 chapter(s)', stage: 'chapters' },
    { name: 'Pages', ok: true, detail: '12 page(s) (chapter 14)', stage: 'pages' },
  ],
  diagnosis: { code: 'ok', reason: '', fix: '' },
};

test('a failed Test leads with its reason, names the failing stage, and never says "Working normally."', () => {
  const v = answerView(ballTest());
  assert.deepEqual(v.head, { tone: 'problem', text: 'This source\'s extension reported an error.' });
  assert.deepEqual(v.rows.map((r) => [r.key, r.glyph, r.label]), [
    ['search', 'fail', 'Search'], ['chapters', 'none', 'Chapter list'], ['pages', 'none', 'Page list'], ['images', 'none', 'Images'],
  ]);
  assert.equal(v.rows[0].error, ENGINE, 'the engine\'s own words, in full (the row clamps them)');
  assert.equal(v.rows[1].detail, 'not reached');
  assert.equal(v.fix, 'Update the extension under Extensions.');
});

test('#115 itself: a failed Test whose diagnosis has no reason is still not "Working normally."', () => {
  // Reintroduce `d?.reason || 'Working normally.'` as the failing head: the head reads "Working normally.".
  const v = answerView(ballTest({ diagnosis: { code: 'unknown' } }));
  assert.equal(v.head?.text, 'That source is still failing');
  assert.equal(v.head?.tone, 'problem');
});

test('"Working normally." only under a pass with no ✗ on screen', () => {
  assert.deepEqual(answerView(passing).head, { tone: 'ok', text: 'Working normally.' });
  assert.equal(answerView(passing).fix, null, 'a pass carries no fix');
  assert.deepEqual(answerView(passing).rows[1], { key: 'chapters', glyph: 'ok', label: 'Chapter list', detail: 'Walk Tale · 14 chapter(s)', error: null, when: null });
  // Covers do not vote, so the Test passes -- but a ✗ Covers line under "Working normally." is the same lie.
  // Reintroduce by checking only `t.ok` for the head: this reads "Working normally.".
  const covers = answerView({ ...passing, checks: [...passing.checks, { name: 'Covers', ok: false, detail: '0 of 3 covers load' }] });
  assert.equal(covers.head?.tone, 'warn');
  assert.notEqual(covers.head?.text, 'Working normally.');
  assert.deepEqual(covers.rows.find((r) => r.key === 'check:Covers'), { key: 'check:Covers', glyph: 'fail', label: 'Covers', detail: null, error: '0 of 3 covers load', when: null });
});

test('running out of OUR time is its own glyph and never a failure', () => {
  const v = answerView({
    ok: false, timedOut: true, state: 'inconclusive', stage: 'chapters',
    checks: [
      { name: 'Search', ok: true, detail: '3 result(s)', stage: 'search' },
      { name: 'Chapters', ok: false, detail: 'did not finish in time', stage: 'chapters', kind: 'timeout' },
    ],
    diagnosis: { code: 'too_slow', reason: 'The live test ran out of time while listing chapters.', fix: '' },
  });
  assert.equal(v.head?.tone, 'warn');
  assert.deepEqual(v.rows.slice(0, 3).map((r) => r.glyph), ['ok', 'timeout', 'none']);
  assert.ok(!v.rows.some((r) => r.glyph === 'fail'), 'our deadline was drawn as a ✗');
});

const stored: StageLine[] = [
  { stage: 'search', state: 'fail', at: new Date(Date.now() - 120_000).toISOString(), by: 'test', kind: 'error', error: ENGINE },
  { stage: 'chapters', state: 'unknown', at: null, by: null, kind: null, error: null },
  { stage: 'pages', state: 'ok', at: new Date(Date.now() - 3 * 3600_000).toISOString(), by: 'traffic', kind: null, error: null },
  { stage: 'images', state: 'ok', at: new Date(Date.now() - 26 * 3600_000).toISOString(), by: 'sweep', kind: null, error: null },
];

test('stored evidence: one line per stage, with when and by what', () => {
  const v = evidenceView(stored, { at: new Date(Date.now() - 120_000).toISOString(), by: 'test', state: 'fail', stage: 'search' }, 'Update the extension.');
  assert.deepEqual(v.rows.map((r) => [r.label, r.glyph]), [['Search', 'fail'], ['Chapter list', 'none'], ['Page list', 'ok'], ['Images', 'ok']]);
  assert.equal(v.rows[0].when, '2m ago · with the Test button');
  assert.equal(v.rows[0].error, ENGINE);
  assert.equal(v.rows[1].detail, 'nothing recorded yet');
  assert.equal(v.rows[2].when, '3h ago · in normal use');
  assert.equal(v.rows[3].when, '1d ago · by the daily check');
  assert.deepEqual(v.head, { tone: 'problem', text: 'Last tested 2m ago with the Test button' });
  assert.equal(v.fix, 'Update the extension.');
  assert.equal(evidenceView(stored, { at: new Date().toISOString(), by: 'sweep', state: 'pass', stage: null }).head?.text, 'Last tested just now by the daily check');
  assert.equal(evidenceView(stored).head, null, 'no live check, no "Last tested" line');
});

test('the running Test\'s clock, Check all\'s progress and its toast', () => {
  assert.equal(testClock(12_400, 53_000), 'Testing… 0:12 of up to 0:53');
  assert.equal(testClock(12_400), 'Testing… 0:12');
  assert.equal(checkAllLabel({ total: 40, done: 6, current: { name: 'Manga Ball (EN)' } }), 'Checking 7 of 40 · Manga Ball (EN)');
  assert.equal(checkAllLabel({ total: 40, done: 40, current: null }), 'Checking 40 of 40');
  assert.equal(checkAllLabel(null), 'Checking…');
  assert.deepEqual(sweepToast({ needsAttention: [1], inconclusive: [] }), { text: '1 source needs attention', type: 'error' });
  assert.deepEqual(sweepToast({ needsAttention: [1, 2], inconclusive: [1] }), { text: '2 sources need attention · 1 could not finish in time', type: 'error' });
  assert.deepEqual(sweepToast({ needsAttention: [], inconclusive: [1, 2] }), { text: '2 could not finish in time', type: 'info' });
  assert.deepEqual(sweepToast({ needsAttention: [], inconclusive: [] }), { text: 'All sources healthy', type: 'success' });
});

test('SourceEvidence draws one line per stage, tagged, and the error clamped with all of it in the title', () => {
  const html = renderToStaticMarkup(createElement(SourceEvidence, { lines: stored }));
  const stages = [...html.matchAll(/data-evidence-stage="([a-z:]+)" data-evidence-state="([a-z]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(stages, [['search', 'fail'], ['chapters', 'none'], ['pages', 'ok'], ['images', 'ok']]);
  for (const label of STAGE_LABELS) assert.ok(html.includes(`>${label}<`), `no ${label} line`);
  assert.match(html, /class="line-clamp-2[^"]*" title="suwayomi: Exception/);
  // A failed live answer renders its ✗ and never the words that sat under it in #115.
  const failed = renderToStaticMarkup(createElement(SourceEvidence, { answer: ballTest({ diagnosis: { code: 'unknown' } }) }));
  assert.match(failed, /data-evidence-state="fail"/);
  assert.doesNotMatch(failed, /Working normally/);
  // No capsule: the component carries no rounded-full anywhere.
  assert.doesNotMatch(failed + html, /rounded-full/);
  // Update address appears for a moved site only, and only where the caller can act on it.
  const moved = ballTest({ diagnosis: { code: 'moved', reason: 'The site moved.', fix: '' } });
  assert.match(renderToStaticMarkup(createElement(SourceEvidence, { answer: moved, onMove: () => {} })), />Update address</);
  assert.doesNotMatch(renderToStaticMarkup(createElement(SourceEvidence, { answer: moved })), /Update address/);
  assert.equal(renderToStaticMarkup(createElement(SourceEvidence, { lines: [], tested: null })), '', 'nothing to say renders nothing');
});

test('every word this says is in all eight languages, the counted pairs included', () => {
  // Reintroduce by deleting "Chapter list" from one locale: that language fails by name.
  const words = [
    ...STAGE_LABELS, ...BY_LABELS, ...GLYPH_WORDS, 'Failing',
    '1 source needs attention', '{n} sources need attention', '1 could not finish in time', '{n} could not finish in time',
    'Testing… {elapsed} of up to {max}', 'Checking {done} of {total}', 'Last tested {when} with the Test button',
  ];
  for (const lang of ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']) {
    const dict = JSON.parse(readFileSync(join(ROOT, 'public/locales', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const w of words) {
      assert.ok(dict[w]?.trim(), `${lang} has no "${w}"`);
      for (const ph of w.match(/\{[a-z]+\}/g) ?? []) assert.ok(dict[w].includes(ph), `${lang} "${w}" lost ${ph}`);
    }
  }
});
