// A card's direct-URL fallback for a cover is only ever a public https address (v0.59.0, lib/coverFallback.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicCoverFallback } from '../lib/coverFallback';

test("an extension's engine thumbnail is never a browser's fallback", () => {
  assert.equal(publicCoverFallback('http://yomi-suwayomi:4567/api/v1/manga/123/thumbnail'), undefined);
  assert.equal(publicCoverFallback('http://localhost:4567/x.png'), undefined);
  assert.equal(publicCoverFallback('http://img.example.com/x.png'), undefined, 'plain http would be mixed content');
  assert.equal(publicCoverFallback('not a url'), undefined);
  assert.equal(publicCoverFallback(''), undefined);
  assert.equal(publicCoverFallback('https://cdn.example.com/covers/1.webp'), 'https://cdn.example.com/covers/1.webp');
});

test('the Discover card falls back through it', () => {
  const cards = readFileSync(join(__dirname, '..', 'components', 'cards.tsx'), 'utf8');
  assert.match(cards, /fallbackSrc=\{publicCoverFallback\(item\.coverUrl\)\}/);
});
