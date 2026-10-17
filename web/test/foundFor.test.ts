// Why a source Uchiyomi followed on its own is there (v0.81.0, components/SourcesSheet.tsx foundForText), in the reader's
// words: one short sentence per reason, said only for an automatic follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foundForText } from '../components/SourcesSheet';

test('each reason is one plain sentence with when', () => {
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  // Reintroduce by sending every reason to the default: the scout's row reads "Added with the series".
  assert.match(foundForText('scout', at), /^Added .+: the other sources could not get its chapters$/);
  assert.match(foundForText('failed_chapter', at), /^Added .+: a chapter failed on the other sources$/);
  assert.match(foundForText('short_chapter', at), /^Added .+: a chapter was incomplete on the other sources$/);
  assert.match(foundForText('gap', at), /^Added .+: it has chapters the other sources do not$/);
  assert.match(foundForText('add', at), /^Added with the series, /);
});

test('the sentence is said only under a source the server followed', () => {
  const src = readFileSync(join(__dirname, '..', 'components', 'SourcesSheet.tsx'), 'utf8');
  // Reintroduce by dropping `s.auto &&`: a person's own follow would carry a reason nobody gave.
  assert.match(src, /\{s\.auto && s\.foundFor && s\.followedAt && \(/);
});
