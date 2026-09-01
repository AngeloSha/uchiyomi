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

// ---- extension updates -------------------------------------------------------
//
// The bug this guards: `updateExtensions` used to end every attempt with `.catch(() => false)`. A 404 from
// the repository -- the common failure, and the one the household hit -- left the extension on its old
// version permanently while producing exactly the same observable result as having no update available:
// nothing logged, nothing returned, nothing shown. The only trace was a Java stack trace in the extension
// server's own log, which nobody reads.
//
// Reintroduce by replacing the try/catch in updateExtensions with `.catch(() => false)`: `failed` comes back
// empty and both of the first two tests below fail.

/** Fake extension server. `outcome` decides what each pkgName does. */
function extHarness(
  list: Array<{ pkgName: string; name: string; installed: boolean; hasUpdate: boolean }>,
  outcome: (pkg: string) => boolean | Error,
) {
  const audits: Array<{ event: string; detail: any }> = [];
  const tried: string[] = [];
  const deps = {
    listExtensions: async () => list as any,
    setExtensionState: (async (pkg: string) => {
      tried.push(pkg);
      const r = outcome(pkg);
      if (r instanceof Error) throw r;
      return r;
    }) as any,
    logAudit: (async (event: string, opts: any) => { audits.push({ event, detail: opts?.detail }); }) as any,
  };
  return { deps, audits, tried };
}

const ext = (pkgName: string, name: string, hasUpdate = true) => ({ pkgName, name, installed: true, hasUpdate });

test('a repository 404 is reported, not swallowed', async () => {
  const { updateExtensions } = await load();
  const h = extHarness([ext('org.x.argos', 'Argos Scan')], () => new Error('HTTP error 404'));

  const r = await updateExtensions(h.deps);

  assert.deepEqual(r.updated, [], 'nothing was actually updated');
  assert.equal(r.failed.length, 1, 'the failure must survive to the caller');
  assert.equal(r.failed[0].name, 'Argos Scan');
  assert.match(
    r.failed[0].reason,
    /repository no longer offers/,
    'a 404 means the repository moved the download, which is not something "HTTP error 404" conveys',
  );
  assert.ok(
    h.audits.some((a) => a.event === 'extension.auto_update_failed'),
    'a failure nobody can read afterwards is the bug being fixed',
  );
});

test('one broken extension does not hide the ones that worked', async () => {
  const { updateExtensions } = await load();
  const h = extHarness(
    [ext('org.x.a', 'Alpha'), ext('org.x.dead', 'Dead One'), ext('org.x.b', 'Beta')],
    (pkg) => (pkg === 'org.x.dead' ? new Error('HTTP error 404') : true),
  );

  const r = await updateExtensions(h.deps);

  assert.deepEqual(r.updated, ['Alpha', 'Beta'], 'the run continues past a failure');
  assert.deepEqual(r.failed.map((f) => f.name), ['Dead One']);
  assert.ok(r.failed[0].reason.length > 0, 'a failure with no reason is barely better than no failure at all');
  assert.equal(h.tried.length, 3, 'every candidate is still attempted');
});

test('accepted-but-not-installed counts as a failure', async () => {
  // Suwayomi answers this mutation with a null extension rather than an error when it declines the work.
  // Treating a falsy return as success is how an update silently does nothing.
  const { updateExtensions } = await load();
  const h = extHarness([ext('org.x.quiet', 'Quiet Failure')], () => false);

  const r = await updateExtensions(h.deps);

  assert.deepEqual(r.updated, []);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /did not install it/);
});

test('extensions without an update are left alone', async () => {
  const { updateExtensions } = await load();
  const h = extHarness(
    [ext('org.x.current', 'Current', false), { pkgName: 'org.x.gone', name: 'Not Installed', installed: false, hasUpdate: true }],
    () => true,
  );

  const r = await updateExtensions(h.deps);

  assert.deepEqual(h.tried, [], 'neither an up-to-date nor an uninstalled extension is touched');
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.failed, []);
});

test('a timeout reads as a timeout rather than as a missing download', async () => {
  const { updateExtensions } = await load();
  const h = extHarness([ext('org.x.slow', 'Slow One')], () => new Error('request timed out after 180000ms'));

  const r = await updateExtensions(h.deps);

  assert.match(r.failed[0].reason, /did not answer in time/);
});
