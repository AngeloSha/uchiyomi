// Polling a search until every source has answered (#353): Discover did, the import review's manual search and Add more
// sources did not, so a source slower than the server's grace never showed in either sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchPoll, searchProgressLine, searchWait, SEARCH_FIRST_WAIT_MS, SEARCH_POLL_MS, SEARCH_POLL_WAIT_MS } from '../lib/searchPoll';

const line = (name: string, state: string) => ({ name, state });

test('only the first request waits the long wait; every poll asks for the short one', () => {
  assert.equal(searchWait(0), SEARCH_FIRST_WAIT_MS);
  assert.equal(searchWait(1), SEARCH_POLL_WAIT_MS);
  assert.equal(searchWait(7), SEARCH_POLL_WAIT_MS);
});

test('a search polls while sources are pending, and stops once they have all answered', () => {
  assert.equal(searchPoll({ pending: 3 }), SEARCH_POLL_MS);
  assert.equal(searchPoll({ pending: 0 }), false);
  assert.equal(searchPoll({}), false, "an older server's answer, with no pending, is final");
  assert.equal(searchPoll(undefined), false);
});

test('the progress line names who is still being asked, three names then a count', () => {
  const sources = [line('A', 'ok'), line('B', 'pending'), line('C', 'pending'), line('D', 'pending'), line('E', 'pending'), line('F', 'pending'), line('G', 'skipped')];
  assert.equal(searchProgressLine({ sources, pending: 5, asked: 6 }), '1 of 6 sources answered · still asking B, C, D and 2 more');
  assert.equal(searchProgressLine({ sources: sources.slice(0, 5), pending: 4 }), '1 of 5 sources answered · still asking B, C, D and 1 more');
  assert.equal(searchProgressLine({ sources: [line('A', 'ok'), line('B', 'pending')], pending: 1, asked: 2 }), '1 of 2 sources answered · still asking B');
  assert.equal(searchProgressLine({ sources: [line('A', 'ok')], pending: 0, asked: 1 }), null);
  assert.equal(searchProgressLine(undefined), null);
});

test('both manual-search sheets poll the search and show who it is still asking', () => {
  // Reintroduce by dropping the polling from a sheet: its answer stops at the sources that beat the server's grace.
  for (const f of ['ImportMatchSheet.tsx', 'MigrateSourceSheet.tsx']) {
    const src = readFileSync(join(__dirname, '..', 'components', f), 'utf8');
    assert.match(src, /refetchInterval: \(qy\) => searchPoll\(qy\.state\.data\)/, `${f} polls while sources are pending`);
    assert.match(src, /&wait=\$\{searchWait\(/, `${f} asks the short wait on a poll`);
    assert.match(src, /searchProgressLine\(data\)/, `${f} shows the progress line`);
  }
});
