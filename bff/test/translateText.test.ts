// Translated pages (v0.85.0), the text half: the arithmetic around the OCR models (lib/translate/ocrCore.ts), lines
// grouped into speech bubbles in reading order (bubbles.ts), and what the translation model is told and how its answer
// is checked (prompt.ts). Pure; no model, no database. Each case names the edit that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alphabet, ctcDecode, dbBoxes, detSize, isTall, recWidth, REC_HEIGHT, type OcrLine } from '../src/lib/translate/ocrCore';
import { bubblesOf, ocrLooksUnreliable } from '../src/lib/translate/bubbles';
import { answerSchema, pageText, parseAnswer, systemPrompt } from '../src/lib/translate/prompt';

// ---- OCR arithmetic ----

test('the detector reads a page with its short side at least 736 px, both sides multiples of 32', () => {
  // Reintroduce by dropping the upscale (ratio 1): a 600 px page goes in at 608 and small lettering is missed.
  for (const [W, H] of [[600, 900], [800, 30000], [1400, 2000], [2000, 1400]]) {
    const { w, h } = detSize(W, H);
    assert.equal(w % 32, 0, `${W}x${H}`);
    assert.equal(h % 32, 0, `${W}x${H}`);
    assert.ok(Math.min(w, h) >= 736 - 16, `${W}x${H} -> ${w}x${h}`);
    assert.ok(Math.abs(w / h - W / H) < 0.05, 'the aspect is kept');
  }
});

/** A probability map w x h, 0 everywhere but the given rectangles (inclusive), at p. */
function map(w: number, h: number, rects: [number, number, number, number][], p = 0.9): Float32Array {
  const m = new Float32Array(w * h);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = p;
  return m;
}

test('each blob of text in the probability map is one box, grown around the text, in the page\'s pixels', () => {
  // Two lines and a speck, on a map half the page's size.
  const pred = map(100, 60, [[10, 10, 39, 19], [60, 30, 89, 44], [95, 55, 96, 56]]);
  const boxes = dbBoxes(pred, 100, 60, 200, 120).sort((a, b) => a.x0 - b.x0);
  // Reintroduce by keeping every region (no size or score check): the 2 x 2 speck is a third box.
  assert.equal(boxes.length, 2);
  const [a, b] = boxes;
  // Reintroduce by dropping the unclip distance: the box sits exactly on the text's pixels and its edges are cut off.
  assert.ok(a.x0 < 20 && a.y0 < 20 && a.x1 > 80 && a.y1 > 40, JSON.stringify(a));
  assert.ok(b.x0 < 120 && b.y0 < 60 && b.x1 > 180 && b.y1 > 90, JSON.stringify(b));
  assert.ok(a.x1 <= 200 && b.y1 <= 120, 'inside the page');
  assert.ok(a.score > 0.5 && a.score <= 0.9);
});

test('a faint blob is not text', () => {
  // Reintroduce by dropping the box threshold: the 0.4 smudge (over the 0.3 line, under 0.5) is read as a line.
  assert.deepEqual(dbBoxes(map(50, 50, [[5, 5, 30, 15]], 0.4), 50, 50, 50, 50), []);
});

test('a line at least 1.5 times taller than wide is vertical; its width at 48 px high keeps its aspect, capped', () => {
  assert.equal(isTall({ x0: 0, y0: 0, x1: 20, y1: 30 }), true);
  assert.equal(isTall({ x0: 0, y0: 0, x1: 30, y1: 30 }), false);
  assert.equal(recWidth(100, REC_HEIGHT), 100);
  assert.equal(recWidth(200, 24), 400);
  // Reintroduce by removing the cap: one 10,000 px banner becomes a 20,000-wide batch for every line beside it.
  assert.equal(recWidth(10000, 48), REC_HEIGHT * 40);
});

test('CTC decoding merges repeats, drops blanks, and keeps a letter that repeats across a blank', () => {
  const chars = alphabet('a\nb\nc\n');
  assert.deepEqual(chars, ['blank', 'a', 'b', 'c', ' ']);
  // Six steps, the best class each: a a _ a b ' '
  const best = [1, 1, 0, 1, 2, 4];
  const C = chars.length;
  const data = new Float32Array(best.length * C);
  best.forEach((c, t) => { data[t * C + c] = 0.8; });
  const [r] = ctcDecode(data, 1, best.length, C, chars);
  // Reintroduce by not merging repeats: "aaab ". By merging across the blank: "ab ".
  assert.equal(r.text, 'aab ');
  assert.ok(Math.abs(r.score - 0.8) < 1e-6);
});

// ---- bubbles ----

const line = (box: [number, number, number, number], text: string, score = 0.97): OcrLine => ({ box, text, score, tall: (box[3] - box[1]) / (box[2] - box[0]) >= 1.5 });

test('lines a line apart are one bubble, read top to bottom; a bubble across the page is another', () => {
  const bubbles = bubblesOf([
    line([100, 124, 280, 144], 'are you'),
    line([600, 500, 800, 520], 'Over here!'),
    line([100, 100, 300, 120], 'Hey,'),
    line([100, 148, 260, 168], 'listening?'),
  ], 'en');
  // Reintroduce by joining every line on the page into one text: one bubble with all four lines.
  assert.deepEqual(bubbles.map((b) => b.text), ['Hey, are you listening?', 'Over here!']);
  assert.deepEqual(bubbles[0].box, [100, 100, 300, 168]);
  assert.equal(bubbles[0].vertical, false);
});

test('a vertical Japanese bubble reads its columns right to left, and Japanese bubbles go right to left across the page', () => {
  const lines = [
    // left bubble: two columns
    line([100, 100, 130, 300], 'いや', 0.95), line([140, 100, 170, 260], 'ちがう', 0.95),
    // right bubble, same height on the page
    line([500, 100, 530, 300], 'こんにちは', 0.95),
  ];
  const ja = bubblesOf(lines, 'ja');
  // Reintroduce left-to-right order for Japanese: the left bubble comes first, and its right column second.
  assert.deepEqual(ja.map((b) => b.text), ['こんにちは', 'ちがういや']);
  assert.ok(ja.every((b) => b.vertical));
  // Chinese pages read left to right, with the same no-space join.
  assert.deepEqual(bubblesOf(lines, 'zh').map((b) => b.text), ['ちがういや', 'こんにちは']);
});

test('the page itself goes to the model when the OCR looks unreliable, with a stricter bar for Korean', () => {
  const b = (text: string, score: number) => ({ box: [0, 0, 10, 10] as [number, number, number, number], vertical: false, text, score, lines: [] });
  const clean = [b('What are you doing here?', 0.96), b('Nothing much.', 0.95)];
  assert.equal(ocrLooksUnreliable(clean, 'ja'), false);
  // Reintroduce by checking only the scores: a page of two-letter scraps read with confidence is sent without the picture.
  assert.equal(ocrLooksUnreliable([b('ㅋ', 0.97), b('ㅎㅎ', 0.98), b('Wait, what?', 0.97)], 'en'), true);
  assert.equal(ocrLooksUnreliable([b('뭐야 이거', 0.9), b('진짜?', 0.9)], 'ko'), true, 'Korean at 0.90');
  assert.equal(ocrLooksUnreliable([b('なんだと', 0.9), b('本当に?', 0.9)], 'ja'), false, 'Japanese at 0.90');
  assert.equal(ocrLooksUnreliable([], 'ko'), false);
});

// ---- the prompt and the answer ----

test('the answer must hold exactly one line per bubble', () => {
  const s = answerSchema(3) as any;
  // Reintroduce by dropping minItems/maxItems: the grammar lets the model merge two bubbles into one line.
  assert.equal(s.properties.lines.minItems, 3);
  assert.equal(s.properties.lines.maxItems, 3);
  assert.throws(() => parseAnswer(JSON.stringify({ lines: ['a', 'b'], names: [] }), 3), /2 lines for 3 bubbles/);
  assert.throws(() => parseAnswer('{"lines": [1, 2, 3]}', 3));
  const ok = parseAnswer(JSON.stringify({ lines: [' Hey! ', '', 'Fine.'], names: [] }), 3);
  assert.deepEqual(ok.lines, ['Hey!', '', 'Fine.']);
});

test('only names that are names are kept for the next pages', () => {
  const { names } = parseAnswer(JSON.stringify({
    lines: ['x'],
    names: [
      { source: '笛子', target: 'Fueko' },
      { source: 'Tokyo', target: 'Tokyo' }, // the same both ways: nothing to keep
      { source: '長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い長い', target: 'Long' },
      { source: '  ', target: 'Blank' },
      { source: 'ミカ' },
      'Rin',
    ],
  }), 1);
  // Reintroduce by keeping the list as given: the sentence-length "name" is told to every later page.
  assert.deepEqual(names, [{ source: '笛子', target: 'Fueko' }]);
});

test('the model is told the target language, the names and the lines before, and the bubbles numbered in order', () => {
  assert.match(systemPrompt('pt-BR'), /natural Brazilian Portuguese/);
  assert.match(systemPrompt('en'), /Hepburn for Japanese/);
  // Romanization is advice for Latin-script readers only.
  assert.doesNotMatch(systemPrompt('ja'), /Hepburn/);
  const bubbles = bubblesOf([line([100, 100, 300, 120], 'Fueko!'), line([100, 400, 300, 420], 'Over here')], 'en');
  const text = pageText(bubbles, {
    title: 'Ribbon', sourceLang: 'ja', names: [{ source: '笛子', target: 'Fueko' }],
    previous: [{ source: 'どこ?', target: 'Where?' }],
  }, false);
  assert.match(text, /Comic: Ribbon \(Japanese\)/);
  assert.match(text, /Known names: 笛子 = Fueko/);
  assert.match(text, /- どこ\? => Where\?/);
  assert.match(text, /1\. Fueko!\n2\. Over here/);
  assert.match(text, /exactly 2 strings/);
  assert.doesNotMatch(text, /The image is this page/);
  assert.match(pageText(bubbles, { sourceLang: 'ja', names: [], previous: [] }, true), /^The image is this page\./m);
});
