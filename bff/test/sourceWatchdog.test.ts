// The one thing the watchdog is allowed to change by itself: following a site to a new address.
//
// This is worth guarding hard, because on the install it was built for BOTH of the sites that redirected
// were traps. aquareader.net redirected to a chat community, and coffeemanga.io redirected twice to a page
// that serves "404 Not Found" with an HTTP 200. A watchdog that trusted the redirect would have written
// both of those into the config and broken a working setup while nobody was looking.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MoveDeps } from '../src/lib/sourceWatchdog';

// The watchdog's import graph reaches the db module, which validates its environment on load. Nothing here
// ever runs a query -- every dependency is injected -- so a placeholder DSN is enough, and importing
// dynamically keeps it set before the graph is pulled in.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const load = () => import('../src/lib/sourceWatchdog');

/** A fake site list plus a record of every write, so a revert is visible rather than inferred. */
function harness(opts: { base: string; smokeOk: boolean }) {
  let list = [{ engine: 'madara', id: 'aqua', name: 'Aqua Manga', base: opts.base, order: 0 }];
  const writes: string[] = [];
  const deps: MoveDeps = {
    readSites: async () => list as any,
    writeSites: async (l: any) => { list = JSON.parse(JSON.stringify(l)); writes.push(list[0].base); },
    reloadAll: async () => undefined,
    getSource: (() => ({ id: 'aqua', name: 'Aqua Manga' })) as any,
    smokeTest: async () => ({ ok: opts.smokeOk }),
  };
  return { deps, writes, current: () => list[0].base };
}

test('a move is taken only once the new address proves it works', async () => {
  const { followMove } = await load();
  const h = harness({ base: 'https://aquareader.net', smokeOk: true });
  assert.equal(await followMove('aqua', 'https://aquareader.org/some/path', h.deps), true);
  assert.equal(h.current(), 'https://aquareader.org', 'the origin should be stored, not the probed path');
});

test('THE TRAP: a redirect that does not actually work is rolled back', async () => {
  // aquareader.net -> animechat.gg (a chat site) and coffeemanga.io -> a 404 body behind a 200 both look
  // exactly like a legitimate move until you try to read a series from them.
  //
  // Reintroduce by dropping the revert branch in followMove: `current()` stays on the new host and the
  // config has been silently broken.
  const { followMove } = await load();
  const h = harness({ base: 'https://aquareader.net', smokeOk: false });
  assert.equal(await followMove('aqua', 'https://animechat.gg/', h.deps), false);
  assert.equal(h.current(), 'https://aquareader.net', 'a failed move must leave the config exactly as it was');
  assert.deepEqual(h.writes, ['https://animechat.gg', 'https://aquareader.net'], 'it should write, test, then put it back');
});

test('a redirect that goes nowhere new is not a move', async () => {
  const { followMove } = await load();
  // Plenty of sites redirect / -> /home or http -> https. Rewriting the config for that would churn the
  // file daily and clear a legitimate cooldown every time.
  const h = harness({ base: 'https://aquareader.net', smokeOk: true });
  assert.equal(await followMove('aqua', 'https://aquareader.net/home', h.deps), false);
  assert.deepEqual(h.writes, [], 'nothing should have been written');
});

test('an unknown source or an unparseable url changes nothing', async () => {
  const { followMove } = await load();
  const h = harness({ base: 'https://aquareader.net', smokeOk: true });
  assert.equal(await followMove('not-a-source', 'https://elsewhere.example/', h.deps), false);
  assert.equal(await followMove('aqua', 'not a url', h.deps), false);
  assert.deepEqual(h.writes, []);
});
