// Status as a mark and a word (v0.49.0, "no more pills"): the vocabulary in lib/status.ts and the marks
// components/StatusMark.tsx draws from it, rendered to markup with react-dom/server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HEALTH_LABELS, SOURCE_STATUSES, engineMark, healthMark, sourceMark, TONE_TEXT, type Tone } from '../lib/status';
import { StatusEdge, StatusGlyph, StatusMark } from '../components/StatusMark';

// Under tsx the components compile to the classic `React.createElement` (tsconfig's `jsx: preserve` is for
// Next), which they look up as a global when they render.
(globalThis as any).React = React;

const ROOT = join(__dirname, '..');
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const TONES: Tone[] = ['ok', 'warn', 'problem', 'info', 'off', 'accent'];

test('every source status the server can send has a mark, read from the Src type itself', () => {
  // The union in lib/sourceGroups.ts is the list the server's statuses are typed by. A status added there
  // and not here would render as "Healthy". TypeScript refuses a missing Record entry; this holds the list
  // at run time too. Reintroduce by deleting `quiet` from SOURCE_MARK: "quiet has no mark" fails.
  const src = readFileSync(join(ROOT, 'lib/sourceGroups.ts'), 'utf8');
  const union = src.match(/\n\s*status\?: ((?:'[a-z_]+'\s*\|?\s*)+);/);
  assert.ok(union, 'the Src status union moved');
  const statuses = [...union![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...SOURCE_STATUSES].sort(), statuses, `${statuses.filter((s) => !SOURCE_STATUSES.includes(s as any)).join(', ') || 'a status'} has no mark`);
});

test('the source marks: a quiet source is not red, and the words are specific', () => {
  // Answers without error and returns nothing: maybe a redesign, maybe a failure -- nobody knows until it
  // is tested, which is why the Providers card never made it red. Reintroduce by mapping quiet to
  // 'problem': this fails.
  assert.notEqual(sourceMark('quiet').tone, 'problem', 'a quiet source reads as broken');
  assert.deepEqual(sourceMark('ok'), { tone: 'ok', label: 'Healthy' });
  assert.deepEqual(sourceMark('blocked'), { tone: 'problem', label: 'Blocked' });
  assert.deepEqual(sourceMark('rate_limited'), { tone: 'warn', label: 'Rate-limited' });
  assert.deepEqual(sourceMark('down'), { tone: 'problem', label: 'Not answering' });
  assert.deepEqual(sourceMark('disabled'), { tone: 'off', label: 'Turned off' });
  assert.deepEqual(sourceMark(undefined), { tone: 'ok', label: 'Healthy' }, 'a source without a status is not healthy, as the card reads it');
  assert.deepEqual(sourceMark('new_thing' as any), { tone: 'ok', label: 'Healthy' });
});

test('the Health and engine marks', () => {
  assert.deepEqual(healthMark('problem'), { tone: 'problem', label: 'Needs attention' });
  assert.deepEqual(healthMark('warn'), { tone: 'warn', label: 'Worth a look' });
  assert.deepEqual(healthMark('ok'), { tone: 'ok', label: 'All good' });
  assert.deepEqual([...HEALTH_LABELS], ['Needs attention', 'Worth a look', 'All good']);
  assert.deepEqual(engineMark(true, 'v2.3.2243'), { tone: 'ok', label: 'Engine ready · v2.3.2243' });
  assert.deepEqual(engineMark(true), { tone: 'ok', label: 'Engine ready' });
  assert.deepEqual(engineMark(false, 'v2'), { tone: 'problem', label: 'Engine unreachable' });
});

test('a mark is a glyph and coloured words: no fill, no border, no rounding', () => {
  // The whole point of the owner's decision. Reintroduce the capsule (`rounded-full border px-2 …` on the
  // outer span): "the mark is a capsule" fails.
  for (const tone of TONES) {
    const out = html(createElement(StatusMark, { tone, label: 'Word' }));
    const outer = out.match(/^<span data-status="[a-z]+"[^>]*class="([^"]*)"/);
    assert.ok(outer, `${tone}: no mark`);
    assert.doesNotMatch(outer![1], /\b(bg-|border|rounded)/, `${tone}: the mark is a capsule (${outer![1]})`);
    assert.ok(outer![1].includes(TONE_TEXT[tone]), `${tone}: the words are not in the tone's colour`);
    assert.match(out, /<span>Word<\/span>/);
  }
  // Without words it is an image with a name, not an unlabelled glyph.
  assert.match(html(createElement(StatusMark, { tone: 'problem', title: 'Needs attention' })), /role="img" aria-label="Needs attention"/);
});

test('the shapes differ, so the status reads without its colour', () => {
  // A colour-blind admin read the old capsules as three identical badges. Reintroduce by drawing warn with
  // the ok check: "warn and ok share a shape" fails.
  const shape = (tone: Tone) => html(createElement(StatusGlyph, { tone })).replace(/class="[^"]*"/g, '');
  const seen = new Map<string, Tone>();
  for (const tone of TONES) {
    const s = shape(tone);
    assert.ok(!seen.has(s), `${tone} and ${seen.get(s)} share a shape`);
    seen.set(s, tone);
  }
  assert.match(html(createElement(StatusGlyph, { tone: 'accent' })), /data-ring=/, 'working is not a small ring');
});

test('the start-edge bar: at the logical start, and absent from a healthy or switched-off card', () => {
  // Reintroduce `left-0` for `start-0`: the bar stays on the left in Arabic, where the card starts on the
  // right, and "not at the start edge" fails.
  assert.equal(html(createElement(StatusEdge, { tone: 'ok' })), '', 'a healthy card wears an edge');
  assert.equal(html(createElement(StatusEdge, { tone: 'off' })), '');
  const edge = html(createElement(StatusEdge, { tone: 'problem' }));
  assert.match(edge, /class="pointer-events-none absolute start-0 inset-y-4 w-\[3px\] rounded-e-\[3px\] bg-red-400"/, 'not at the start edge');
  assert.match(edge, /aria-hidden="true"/);
  assert.match(html(createElement(StatusEdge, { tone: 'warn', inset: 'inset-y-0' })), /inset-y-0/);
});
