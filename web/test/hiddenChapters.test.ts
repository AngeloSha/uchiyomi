// Show hidden chapters (#240, components/HiddenChapters.tsx): what each hidden number is, in a few words, and the
// list itself drawn from what the server answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenCaption } from '../components/HiddenChapters';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';

setActiveLocale('en');
setActiveDict({});

test('a hidden number says what it is: its copies on the server, a source listing it, both, or neither', () => {
  // Reintroduce one caption for every case: a stray only a source lists reads like a chapter on the server, and the
  // number nothing holds any more -- the one Restore brings back as nothing -- is not told apart.
  assert.equal(hiddenCaption({ onServer: 1, listed: false }), '1 copy on the server');
  assert.equal(hiddenCaption({ onServer: 1, listed: true }), '1 copy on the server, listed by a source');
  assert.equal(hiddenCaption({ onServer: 3, listed: false }), '3 copies on the server');
  assert.equal(hiddenCaption({ onServer: 2, listed: true }), '2 copies on the server, listed by a source');
  assert.equal(hiddenCaption({ onServer: 0, listed: true }), 'Listed by a source');
  assert.equal(hiddenCaption({ onServer: 0, listed: false }), 'Not listed any more');
});
