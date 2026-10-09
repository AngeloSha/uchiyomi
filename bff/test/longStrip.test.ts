// Is a chapter of one or two images a failed download, or a whole chapter stitched into long strips? (v0.55.10)
import test from 'node:test';
import assert from 'node:assert/strict';
import { longStrip, STRIP_HEIGHT } from '../src/lib/longStrip';

const page = (width: number | null, height: number | null) => ({ width, height });

test("the live server's chapters read as what they are", () => {
  // Eleceed 215: two strips, 155 widths tall together. My Dragon System 335: two, 37. A banner and a strip, 16.6.
  assert.equal(longStrip([page(689, 53988), page(689, 53112)]), true);
  assert.equal(longStrip([page(798, 14930), page(798, 14820)]), true);
  assert.equal(longStrip([page(1200, 800), page(800, 12772)]), true);
  // Gachiakuta 95, one manga page; an ad banner; LMS 122's two season-break pages; a 720 x 3890 notice.
  assert.equal(longStrip([page(800, 1148)]), false);
  assert.equal(longStrip([page(2048, 1182)]), false);
  assert.equal(longStrip([page(940, 1405), page(940, 1404)]), false);
  assert.equal(longStrip([page(720, 3890)]), false);
});

test('the line is STRIP_HEIGHT widths, the pages together', () => {
  assert.equal(longStrip([page(100, STRIP_HEIGHT * 100)]), true);
  assert.equal(longStrip([page(100, STRIP_HEIGHT * 50), page(200, STRIP_HEIGHT * 100)]), true);
  assert.equal(longStrip([page(100, STRIP_HEIGHT * 100 - 1)]), false);
});

test('a page not measured answers no', () => {
  assert.equal(longStrip(null), false);
  assert.equal(longStrip([]), false);
  assert.equal(longStrip([page(null, 54000)]), false);
  assert.equal(longStrip([page(689, 53988), page(689, null)]), false, 'one unmeasured page leaves the chapter a finding');
  assert.equal(longStrip([page(0, 54000)]), false);
});
