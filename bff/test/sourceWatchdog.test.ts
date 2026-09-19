// The one thing the watchdog is allowed to change by itself: following a site to a new address.
//
// This is worth guarding hard, because on the install it was built for BOTH of the sites that redirected
// were traps. aquareader.net redirected to a chat community, and coffeemanga.io redirected twice to a page
// that serves "404 Not Found" with an HTTP 200. A watchdog that trusted the redirect would have written
// both of those into the config and broken a working setup while nobody was looking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { MoveDeps } from '../src/lib/sourceWatchdog';
import { diagnose } from '../src/lib/sourceDiagnosis';

// The watchdog's import graph reaches the db module, which validates its environment on load. Nothing here
// ever runs a query -- every dependency is injected -- so a placeholder DSN is enough, and importing
// dynamically keeps it set before the graph is pulled in.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const load = () => import('../src/lib/sourceWatchdog');
// sourceProbe reaches env (and so the DSN check) the same way; sourceDiagnosis is pure and stays static.
const loadProbe = () => import('../src/lib/sourceProbe');

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

// ---- one scheduler, not two --------------------------------------------------

test('the watchdog does not update extensions', () => {
  // It used to, and that was the bug. Suwayomi only recomputes "an update is available" when its
  // repositories are re-read, and the watchdog never asked for that -- so it installed updates it could
  // never see. Extension updates now live in lib/extensionMonitor.ts, which refreshes first.
  //
  // They must not both do it. Each keeps its own busy flag, so two schedulers overlapping would run the
  // install mutation for the same APK twice at once, and a "fallback" here reading the stale catalogue is
  // exactly the behaviour that was removed.
  //
  // Reintroduce by importing from './sources/suwayomi/extensions' in sourceWatchdog.ts again.
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'sourceWatchdog.ts'), 'utf8');
  assert.ok(!/suwayomi\/extensions/.test(src),
    'sourceWatchdog imports the extension API again — there must be exactly one scheduler for extension updates');
  assert.ok(!/updateExtensions/.test(src),
    'sourceWatchdog still updates extensions; that belongs to lib/extensionMonitor.ts');
});

// ---- one probe builder, not two ---------------------------------------------

test('buildProbe keeps the live result when there was no homepage to ask, and does not invent a status', async () => {
  // The helper both callers go through. For a source with no `base` (every extension source) `bare` is
  // undefined; the adapter's own pass must still reach diagnose(), and the missing homepage must show as
  // no `httpStatus` rather than PR #56's 0, which the Probe type reserves for "asked, no answer came back".
  //
  // Reintroduce by returning `bare && {...}` from buildProbe: `adapterOk` is lost and the diagnosis below
  // reads `cf_challenge` from the stored string. Or by spreading `{ httpStatus: 0 }` first: the status
  // assertion fails.
  const { buildProbe } = await loadProbe();
  const probe = buildProbe(undefined, { ok: true }, {});
  assert.equal(probe.adapterOk, true, 'the live result must survive having no homepage to probe');
  assert.equal(probe.httpStatus, undefined, 'no request was made, so there is no status to report; not 0');
  assert.equal(probe.needsSolver, false);
  // The engine's own words, as an extension source stores them (suwayomi/client.ts prefix + issue #54's text).
  const stale = { status: 'blocked' as const, lastError: 'suwayomi: java.io.IOException: Cloudflare bypass currently disabled', consecutive: 3, lastOkAt: null, emptyStreak: 0, blockedUntil: null, disabled: false };
  assert.equal(diagnose(stale, probe).code, 'ok', 'four live checks just passed; the stored string is history');
  // A real bare probe is carried through untouched, and a solver-fronted source says so.
  const withBare = buildProbe({ httpStatus: 403, finalUrl: 'https://x.example/' }, { ok: false }, { requiresCloudflare: true });
  assert.deepEqual(withBare, { httpStatus: 403, finalUrl: 'https://x.example/', adapterOk: false, needsSolver: true });
});

test('THE DROPPED VERDICT: both the sweep and the Test button hand diagnose() the live result through buildProbe', () => {
  // Before PR #56 both callers built the Probe as `bare && {...}`. `bare` is undefined for every source
  // with no `base` to probe -- all Suwayomi/extension sources -- so for those the adapter's own live result
  // never reached `diagnose`, which fell through to the stale `last_error` that `reportOk` never clears. A
  // source that had passed all four live checks kept reporting "protected by a check we could not get
  // past" on every sweep and every click (issue #54's second half). PR #56's own test could not catch a
  // return to that: it called diagnose() with a hand-built Probe, so the callers were never exercised.
  //
  // sweep() has no dependency seam (only followMove does) and the route needs a server, so this guards the
  // callers the way the scheduler test above does: by reading them. Both must build the probe through the
  // ONE helper in sourceProbe.ts, whose behaviour sourceDiagnosis.test.ts pins ('THE BASELESS ADAPTER').
  //
  // Reintroduce by rewriting either caller's probe line as `bare && { ...bare, adapterOk: smoke.ok, ... }`
  // (or as PR #56's `{ httpStatus: 0, ...bare, ... }` literal): the assertion names the file.
  const lib = join(__dirname, '..', 'src');
  for (const file of ['lib/sourceWatchdog.ts', 'routes/admin.ts']) {
    // Code only: the comment next to the call names the wrong shape as a warning, and a guard that greps
    // the prose would flag the warning and pass the bug (deployCompose.test.ts learned the same thing).
    const src = readFileSync(join(lib, file), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(src.includes('buildProbe(bare, smoke, src)'),
      `${file} no longer builds diagnose()'s Probe through buildProbe -- the sweep and the Test button can disagree again`);
    assert.ok(!/bare && \{/.test(src),
      `${file} builds the Probe only when a bare probe ran, which drops adapterOk for every extension source`);
    assert.ok(!/httpStatus: 0, \.\.\.bare/.test(src),
      `${file} encodes "no request was made" as httpStatus 0, which the Probe type reserves for "no answer came back"`);
  }
});

test('the Test button can see a slow streak', () => {
  // diagnose() reads `slowStreak` before any stored-error rule; that branch is the `too_slow` verdict written
  // for the source that answered correctly in 11.5s against an 8s wall and vanished from Discover for a day.
  // Both the sweep's `healthOf` and the Test button's SELECT enumerate their columns by hand, and for two
  // releases neither listed `slow_streak`, so `h.slow_streak` was undefined, `?? 0` made it a clean 0, and the
  // one verdict with a specific fix was unreachable from the two places an admin actually looks. Only
  // Discover, which reads healthAll() from sourceHealth.ts, ever said it. TypeScript cannot catch this: the
  // row is cast to SourceHealth whatever the SELECT lists.
  //
  // Same shape as THE DROPPED VERDICT above: neither caller has a seam, so the callers are read. Code only,
  // because the warning comment beside each SELECT names the column.
  //
  // Reintroduce by dropping slow_streak from the SELECT in either file: the assertion names the file. Or by
  // dropping `budgetMs` from the facts: the fix sentence goes back to "the time allowed" instead of the
  // number of seconds the admin has to raise.
  const lib = join(__dirname, '..', 'src');
  for (const file of ['lib/sourceWatchdog.ts', 'routes/admin.ts']) {
    const src = readFileSync(join(lib, file), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // The per-source read, not healthAll()'s: `SELECT <columns> FROM source_health WHERE source_id = $1`.
    const selects = [...src.matchAll(/SELECT([\s\S]*?)FROM source_health WHERE source_id = \$1/g)].map((m) => m[1]);
    assert.ok(selects.length >= 1, `${file} no longer reads source_health per source; this guard needs re-aiming`);
    for (const cols of selects) {
      assert.ok(/\bslow_streak\b/.test(cols),
        `${file} reads source_health without slow_streak, so diagnose() never sees a slow streak and too_slow is unreachable from it`);
    }
    assert.ok(/budgetMs: env\.SOURCE_LATEST_TIMEOUT_MS/.test(src),
      `${file} hands diagnose() no budget, so a too_slow fix cannot say how many seconds the source keeps running out of`);
  }
});
