// The group avatar's letters and colour, tested away from React.
//
// The colour is the point: it has to be the same for every spelling the server treats as one group, or the
// sheet and the rows would show two circles for "Asura Scans" and "asura-scans" while the server shows one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupColor, groupHue, initialsOf } from '../lib/groupAvatar';

test('initials are the first letters of the first two words, upper-cased', () => {
  assert.equal(initialsOf('Asura Scans'), 'AS');
  assert.equal(initialsOf('flame comics'), 'FC');
  assert.equal(initialsOf('Reaper Scans & Co'), 'RS');
  assert.equal(initialsOf('Fuuscans'), 'F');
  assert.equal(initialsOf('  '), '?');
});

test('the colour follows the normalised name, so spellings the server merges share one circle', () => {
  // Reintroduce by hashing the raw name in groupHue: "asura-scans" and "Asura Scans" get different hues and
  // the same group wears two colours on one page.
  assert.equal(groupHue('Asura Scans'), groupHue('asura-scans'));
  assert.equal(groupColor('ASURA SCANS'), groupColor('Asura Scans'));
});

test('the colour is stable and different names differ', () => {
  assert.equal(groupHue('Flame Comics'), groupHue('Flame Comics'));
  assert.notEqual(groupHue('Flame Comics'), groupHue('Asura Scans'));
  assert.match(groupColor('Flame Comics'), /^hsl\(\d{1,3} 45% 32%\)$/);
});
