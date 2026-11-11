import test from 'node:test';
import assert from 'node:assert/strict';
import { importContainsDiverges, importMatchNeedsReview } from '../src/lib/importMatchReview';

test('automatic import review distinguishes other works from ordinary edition suffixes', () => {
  for (const [a,b] of [
    ['Fire Force', 'Fire!'], ['Berserk', 'Berserk of Gluttony'], ['Naruto', 'Boruto Naruto Next Generations'],
    ['Solo Leveling', 'Solo Leveling Ragnarok'], ['Tower of God', 'Tower of God Season 2'], ['Title', 'Title II'],
  ]) {
    assert.equal(importContainsDiverges(a,b), true, `${a} / ${b}`);
    assert.equal(importContainsDiverges(b,a), true, `reverse: ${a} / ${b}`);
  }
  for (const title of ['Naruto (Official Colored)', 'Naruto: Digital Colored Comics', 'Naruto (Full Color)', 'Naruto English Edition'])
    assert.equal(importContainsDiverges('Naruto', title), false, title);
});

test('a recognized alternate keeps an edition match ready, while fuzzy suggestions always need confirmation', () => {
  const row = { backup_title: 'Attack on Titan', alt_titles: ['Shingeki no Kyojin'], match_title: 'Shingeki no Kyojin (Official)', confidence: 'contains' };
  assert.equal(importMatchNeedsReview(row), false);
  assert.equal(importMatchNeedsReview({ ...row, confidence: 'fuzzy' }), true);
  assert.equal(importMatchNeedsReview({ ...row, backup_title: 'Fire Force', alt_titles: [], match_title: 'Fire!' }), true);
  assert.equal(importMatchNeedsReview({ ...row, confidence: 'same_source', match_title: 'Renamed Work' }), false);
  const backup = { ...row, backup_title: 'Title', match_title: 'Title', confidence: 'exact', backup_url: '/manga/title', backup_source_id_unsigned: '9223372036854775807', match_source: 'sw:9223372036854775807' };
  assert.equal(importMatchNeedsReview(backup), true, 'a legacy home-source title match does not prove its saved path');
  assert.equal(importMatchNeedsReview({ ...backup, confidence: 'same_source' }), false);
  assert.equal(importMatchNeedsReview({ ...backup, backup_url: null }), false);
  assert.equal(importMatchNeedsReview({ ...backup, match_source: 'another-source' }), false);
});
