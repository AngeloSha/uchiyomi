// The browser walk's deliberate network cuts (test/e2e/networkCut.mjs, v0.55.1): what run.mjs notes and what it counts.
//
// PR #152's "Browser end-to-end" went red on a green run over one console error, `Failed to load resource:
// net::ERR_INTERNET_DISCONNECTED` for /auth/refresh: raised in the cold boot's cut, reported after the walk had brought
// the network back, and so counted -- while every other request that failed in the cut was noted. A request the cut
// failed is noted whenever the console gets round to reporting it; nothing else is, at any time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CUT_DRAIN_MS, networkCuts } from './e2e/networkCut.mjs';

const DISCONNECTED = 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED';
const STATUS = 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)';
const SCRIPT = "TypeError: Cannot read properties of undefined (reading 'id')";

test('a request the cut failed is noted whenever the console reports it: in the cut, or a moment either side', () => {
  // Reintroduce by closing the window as the network comes back (`to = now()` in back()): "reported after the network
  // is back" counts -- PR #152's red run.
  let t = 1_000;
  const c = networkCuts(() => t);
  assert.equal(c.noted(DISCONNECTED), false, 'before any cut it counts');
  c.asking();
  t += 5;
  assert.equal(c.noted(DISCONNECTED), true, 'reported before setOfflineMode(true) answered');
  c.cut();
  t += 100;
  assert.equal(c.noted(DISCONNECTED), true, 'reported in the cut');
  assert.equal(c.noted(STATUS), true, 'inside the cut every resource that cannot load is noted, as before');
  c.back();
  t += 50;
  assert.equal(c.noted(DISCONNECTED), true, 'reported after the network is back');
  t += CUT_DRAIN_MS;
  assert.equal(c.noted(DISCONNECTED), false, 'once the window has closed it counts again');
});

test('nothing else is noted: not at the edges of a cut, not in it, not after it', () => {
  let t = 1_000;
  const c = networkCuts(() => t);
  c.asking();
  assert.equal(c.noted(STATUS), false, 'a status error before the browser is offline counts');
  c.cut();
  assert.equal(c.noted(SCRIPT), false, 'a script error inside the cut counts');
  c.back();
  t += 10;
  assert.equal(c.noted(STATUS), false, 'a status error after the network is back counts');
  assert.equal(c.noted(SCRIPT), false, 'and so does a script error');
});

test('each cut has its own window', () => {
  let t = 1_000;
  const c = networkCuts(() => t);
  c.asking(); c.cut(); c.back();
  t += CUT_DRAIN_MS + 1_000;
  assert.equal(c.noted(DISCONNECTED), false, 'between cuts it counts');
  c.asking();
  assert.equal(c.noted(DISCONNECTED), true, 'the next cut opens its own');
  c.cut(); c.back();
  t += 1;
  assert.equal(c.noted(DISCONNECTED), true);
});

test('run.mjs cuts the network only through holdOffline, and its console reads the cuts', () => {
  // A cut made by a bare page.setOfflineMode would have no window at all. Reintroduce v0.55.0's flag
  // (`networkCut && /Failed to load resource/`): the console line no longer asks the cuts.
  const run = readFileSync(join(__dirname, 'e2e', 'run.mjs'), 'utf8');
  assert.equal([...run.matchAll(/page\.setOfflineMode\(/g)].length, 2, 'page.setOfflineMode is called only inside holdOffline');
  assert.match(run, /if \(on\) \{ cuts\.asking\(\); await page\.setOfflineMode\(true\); cuts\.cut\(\); \}/, 'the window opens before the cut');
  assert.match(run, /else \{ await page\.setOfflineMode\(false\); cuts\.back\(\); \}/, 'and closes after the network is back');
  assert.match(run, /else if \(cuts\.noted\(m\.text\(\)\)\) offlineNotes\.push\(/, 'the console asks the cuts');
});
