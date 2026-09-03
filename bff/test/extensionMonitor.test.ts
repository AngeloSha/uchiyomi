// The scheduled extension check.
//
// THE BUG THIS FILE IS NAMED FOR. An auto-updater already existed inside the daily source watchdog and had
// almost certainly never updated anything, on any install. Suwayomi does not poll: it recomputes
// "an update is available" only when its repositories are re-read (the fetchExtensions mutation). The
// watchdog never called that, so it read a catalogue whose freshness depended on a human having pressed
// Refresh, saw hasUpdate:false on everything, and reported success. Measured on the install this was written
// for: 1394 extensions known, 15 installed, 0 flagged, while upstream pushed roughly every fifteen hours.
//
// So the fake extension server below models the ONE behaviour that matters: hasUpdate is false until a
// refresh has been performed. A test that hands back a ready-made hasUpdate:true row proves nothing, because
// that is precisely the state the real server never reached on its own.
//
// Everything is injected at the GraphQL transport, so the real listExtensions/refreshExtensions/
// setExtensionState/getRepos/setRepos code runs here -- only the network is fake. No database.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';
process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://unused/unused';

const load = () => import('../src/lib/extensionMonitor');

interface FakeExt {
  pkgName: string; name: string; lang?: string;
  installedVersion: string | null;   // null = not installed
  upstreamVersion: string | null;    // null = no repository offers it any more
  nsfw?: boolean;
}

/**
 * A stand-in for Suwayomi.
 *
 * The important rule: `hasUpdate` and `isObsolete` are computed from what the last refresh learned, not from
 * what the repositories currently hold. Before any refresh, the server reports every extension as current --
 * which is exactly how the real one behaved and exactly why the old auto-updater did nothing.
 */
function engine(exts: FakeExt[], opts: {
  repos?: string[];
  refreshThrows?: Error;
  onUpdate?: (pkg: string) => boolean | Error;
  onInstall?: (pkg: string) => boolean;
} = {}) {
  const state = exts.map((e) => ({ ...e }));
  let repos = opts.repos ? [...opts.repos] : [];
  let refreshed = false;                 // has fetchExtensions ever run?
  const ops: string[] = [];
  const calls: Array<{ op: string; vars: any }> = [];

  const node = (e: FakeExt) => ({
    pkgName: e.pkgName,
    name: e.name,
    lang: e.lang ?? 'en',
    versionName: e.installedVersion ?? e.upstreamVersion,
    iconUrl: null,
    isInstalled: e.installedVersion !== null,
    // Only knowable after a refresh. This single line is the whole bug.
    hasUpdate: refreshed && e.installedVersion !== null && e.upstreamVersion !== null
      && e.upstreamVersion !== e.installedVersion,
    isObsolete: refreshed && e.installedVersion !== null && e.upstreamVersion === null,
    isNsfw: !!e.nsfw,
    repo: repos[0] ?? null,
  });

  const gql = (async (query: string, variables: Record<string, any> = {}) => {
    if (/fetchExtensions/.test(query)) {
      ops.push('refresh'); calls.push({ op: 'refresh', vars: variables });
      if (opts.refreshThrows) throw opts.refreshThrows;
      refreshed = true;
      return { fetchExtensions: { extensions: state.map((e) => ({ pkgName: e.pkgName })) } };
    }
    if (/updateExtension\(/.test(query)) {
      const pkg = variables.id as string;
      const e = state.find((x) => x.pkgName === pkg)!;
      if (/install:true/.test(query)) {
        ops.push(`install:${pkg}`); calls.push({ op: 'install', vars: variables });
        const ok = opts.onInstall ? opts.onInstall(pkg) : true;
        if (ok) e.installedVersion = e.upstreamVersion;
        return { updateExtension: { extension: ok ? { pkgName: pkg, isInstalled: true } : null } };
      }
      if (/uninstall:true/.test(query)) {
        ops.push(`uninstall:${pkg}`); calls.push({ op: 'uninstall', vars: variables });
        e.installedVersion = null;
        return { updateExtension: { extension: { pkgName: pkg, isInstalled: false } } };
      }
      ops.push(`update:${pkg}`); calls.push({ op: 'update', vars: variables });
      const r = opts.onUpdate ? opts.onUpdate(pkg) : true;
      if (r instanceof Error) throw r;
      if (r) e.installedVersion = e.upstreamVersion;
      return { updateExtension: { extension: r ? { pkgName: pkg, isInstalled: true } : null } };
    }
    if (/setSettings/.test(query)) {
      ops.push('setRepos'); calls.push({ op: 'setRepos', vars: variables });
      repos = [...(variables.r as string[])];
      return { setSettings: { settings: { extensionRepos: repos } } };
    }
    if (/extensionRepos/.test(query)) {
      ops.push('getRepos');
      return { settings: { extensionRepos: repos } };
    }
    ops.push('list'); calls.push({ op: 'list', vars: variables });
    return { extensions: { nodes: state.map(node) } };
  }) as never;

  return { gql, ops, calls, state, get repos() { return repos; } };
}

/** The database seam, in memory. */
function store(init: Partial<{ hours: number; autoUpdate: boolean; repos: string[]; last: any; snapshot: any[] }> = {}) {
  const s = {
    hours: init.hours ?? 6,
    autoUpdate: init.autoUpdate ?? true,
    repos: init.repos ?? [],
    last: init.last ?? null,
    snapshot: init.snapshot ?? [],
    results: [] as any[],
    saved: [] as any[][],
  };
  const api = {
    settings: async () => ({ hours: s.hours, autoUpdate: s.autoUpdate, repos: [...s.repos], last: s.last }),
    saveRepos: async (u: string[]) => { s.repos = [...u]; },
    snapshot: async () => s.snapshot,
    saveSnapshot: async (rows: any[]) => {
      s.saved.push(rows);
      s.snapshot = rows.map((e) => ({ pkgName: e.pkgName, name: e.name, installed: e.installed, versionName: e.versionName }));
    },
    saveResult: async (r: any) => { s.results.push(r); s.last = r; },
  };
  return { api, s };
}

function deps(e: ReturnType<typeof engine>, st: ReturnType<typeof store>, over: any = {}) {
  const audits: Array<{ event: string; detail: any }> = [];
  const pushes: Array<{ title: string; body: string }> = [];
  let reloads = 0;
  return {
    audits, pushes, reloadCount: () => reloads,
    deps: {
      gql: e.gql,
      store: st.api,
      reloadAll: (async () => { reloads++; return { loaded: 0, files: 0, suwayomi: 0 }; }) as any,
      logAudit: (async (event: string, o: any) => { audits.push({ event, detail: o?.detail }); }) as any,
      notifyAdmins: (async (title: string, body: string) => { pushes.push({ title, body }); }) as any,
      sweepRunning: () => false,
      ...over,
    },
  };
}

const upToDate = (p: string, n: string, v = '1.0'): FakeExt => ({ pkgName: p, name: n, installedVersion: v, upstreamVersion: v });
const hasNewer = (p: string, n: string, from = '1.0', to = '1.1'): FakeExt => ({ pkgName: p, name: n, installedVersion: from, upstreamVersion: to });

// ---- the bug ---------------------------------------------------------------------------------------

test('THE BUG: the repositories are re-read before anything asks what needs updating', async () => {
  // Reintroduce by deleting the refreshExtensions call from runExtensionCheck: the fake reports
  // hasUpdate:false for everything, exactly as the real server did, and `updated` comes back empty.
  const { runExtensionCheck } = await load();
  const e = engine([hasNewer('org.x.a', 'Alpha', '1.4.8', '1.4.9')], { repos: ['https://r/i.json'] });
  const d = deps(e, store({ repos: ['https://r/i.json'] }));

  const r = await runExtensionCheck({}, d.deps as any);

  assert.equal(r.refreshed, true, 'the check did not refresh the repositories');
  assert.deepEqual(r.updated.map((u) => u.name), ['Alpha'], 'nothing was updated — the catalogue was read stale');
  const refreshAt = e.ops.indexOf('refresh');
  const listAt = e.ops.indexOf('list');
  const updateAt = e.ops.indexOf('update:org.x.a');
  assert.ok(refreshAt >= 0 && refreshAt < listAt, 'the catalogue was listed before it was refreshed');
  assert.ok(listAt < updateAt, 'an update was attempted before the list it came from');
});

test('a refresh that fails stops the run instead of passing off a stale catalogue as up to date', async () => {
  // Reintroduce by wrapping the refresh in .catch(() => 0): the run continues against yesterday's answer
  // and reports a healthy check that updated nothing.
  const { runExtensionCheck } = await load();
  const e = engine([hasNewer('org.x.a', 'Alpha')], { repos: ['https://r/i.json'], refreshThrows: new Error('suwayomi 502') });
  const st = store({ repos: ['https://r/i.json'] });
  const d = deps(e, st);

  const r = await runExtensionCheck({}, d.deps as any);

  assert.equal(r.refreshed, false);
  assert.match(r.refreshError!, /502/);
  assert.ok(!e.ops.some((o) => o.startsWith('update:')), 'it tried to update from a catalogue it could not refresh');
  assert.equal(d.pushes.length, 1, 'an unreachable repository is worth telling an admin about, once');
  // The failed run has to be recorded, or the panel goes on showing the last good check as if it were this
  // one -- the same rule the sweep and the backup follow.
  assert.equal(st.s.results.length, 1, 'a failed check saved no result');
  assert.equal(st.s.results[0].refreshed, false);
});

test('an engine that stays down is reported once, not on every check', async () => {
  // Reintroduce by dropping the comparison with settings.last: a down engine pushes four times a day.
  const { runExtensionCheck } = await load();
  const boom = new Error('suwayomi 502');
  const e = engine([upToDate('org.x.a', 'Alpha')], { refreshThrows: boom });
  const st = store({ repos: ['https://r/i.json'] });
  const d = deps(e, st);

  await runExtensionCheck({}, d.deps as any);
  await runExtensionCheck({}, d.deps as any);

  assert.equal(d.pushes.length, 1, 'the second consecutive failure notified again');
});

// ---- installing updates (moved from sourceWatchdog.test.ts) ----------------------------------------
//
// The bug these guard: updateExtensions used to end every attempt with `.catch(() => false)`. A 404 from the
// repository -- the common failure -- left the extension on its old version permanently while producing
// exactly the same observable result as having no update available.
//
// Reintroduce by replacing the try/catch in updateExtensions with `.catch(() => false)`: `failed` comes back
// empty and the first two below fail.

function extList(rows: Array<{ pkgName: string; name: string; installed?: boolean; hasUpdate?: boolean }>) {
  return rows.map((r) => ({
    pkgName: r.pkgName, name: r.name, lang: 'en', versionName: '1.0', iconUrl: null,
    installed: r.installed ?? true, hasUpdate: r.hasUpdate ?? true, obsolete: false, nsfw: false, repo: null,
  })) as any;
}
function updDeps(outcome: (pkg: string) => boolean | Error) {
  const audits: Array<{ event: string; detail: any }> = [];
  const tried: string[] = [];
  return {
    audits, tried,
    deps: {
      setExtensionState: (async (pkg: string) => {
        tried.push(pkg);
        const r = outcome(pkg);
        if (r instanceof Error) throw r;
        return r;
      }) as any,
      logAudit: (async (event: string, o: any) => { audits.push({ event, detail: o?.detail }); }) as any,
    },
  };
}

test('a repository 404 is reported, not swallowed', async () => {
  const { updateExtensions } = await load();
  const h = updDeps(() => new Error('HTTP error 404'));
  const r = await updateExtensions(extList([{ pkgName: 'org.x.argos', name: 'Argos Scan' }]), h.deps);

  assert.deepEqual(r.updated, [], 'nothing was actually updated');
  assert.equal(r.failed.length, 1, 'the failure must survive to the caller');
  assert.equal(r.failed[0].name, 'Argos Scan');
  assert.match(r.failed[0].reason, /repository no longer offers/,
    'a 404 means the repository moved the download, which is not something "HTTP error 404" conveys');
  assert.ok(h.audits.some((a) => a.event === 'extension.auto_update_failed'),
    'a failure nobody can read afterwards is the bug being fixed');
});

test('one broken extension does not hide the ones that worked', async () => {
  const { updateExtensions } = await load();
  const h = updDeps((pkg) => (pkg === 'org.x.dead' ? new Error('HTTP error 404') : true));
  const r = await updateExtensions(extList([
    { pkgName: 'org.x.a', name: 'Alpha' }, { pkgName: 'org.x.dead', name: 'Dead One' }, { pkgName: 'org.x.b', name: 'Beta' },
  ]), h.deps);

  assert.deepEqual(r.updated, ['Alpha', 'Beta'], 'the run continues past a failure');
  assert.deepEqual(r.failed.map((f) => f.name), ['Dead One']);
  assert.equal(h.tried.length, 3, 'every candidate is still attempted');
});

test('accepted-but-not-installed counts as a failure', async () => {
  // Suwayomi answers this mutation with a null extension rather than an error when it declines the work.
  const { updateExtensions } = await load();
  const h = updDeps(() => false);
  const r = await updateExtensions(extList([{ pkgName: 'org.x.quiet', name: 'Quiet Failure' }]), h.deps);

  assert.deepEqual(r.updated, []);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /did not install it/);
});

test('extensions without an update are left alone', async () => {
  const { updateExtensions } = await load();
  const h = updDeps(() => true);
  const r = await updateExtensions(extList([
    { pkgName: 'org.x.current', name: 'Current', hasUpdate: false },
    { pkgName: 'org.x.gone', name: 'Not Installed', installed: false },
  ]), h.deps);

  assert.deepEqual(h.tried, [], 'neither an up-to-date nor an uninstalled extension is touched');
  assert.deepEqual(r.updated, []);
  assert.deepEqual(r.failed, []);
});

test('a timeout reads as a timeout rather than as a missing download', async () => {
  const { updateExtensions } = await load();
  const h = updDeps(() => new Error('request timed out after 180000ms'));
  const r = await updateExtensions(extList([{ pkgName: 'org.x.slow', name: 'Slow One' }]), h.deps);
  assert.match(r.failed[0].reason, /did not answer in time/);
});

// ---- the rest of the check -------------------------------------------------------------------------

test('sources are re-registered after an update, and not after a quiet check', async () => {
  // reloadAll is what re-reads each extension's sources into suwayomi_sources (name, language, adult flag).
  // Skipping it leaves a renamed source showing its old name until something else happens to reload.
  // Reintroduce by making the reloadAll call unconditional: the second assertion fails.
  const { runExtensionCheck } = await load();

  const busy = deps(engine([hasNewer('org.x.a', 'Alpha')], { repos: ['https://r/i.json'] }), store({ repos: ['https://r/i.json'] }));
  await runExtensionCheck({}, busy.deps as any);
  assert.equal(busy.reloadCount(), 1, 'an update did not re-register its sources');

  const quiet = deps(engine([upToDate('org.x.a', 'Alpha')], { repos: ['https://r/i.json'] }), store({ repos: ['https://r/i.json'] }));
  await runExtensionCheck({}, quiet.deps as any);
  assert.equal(quiet.reloadCount(), 0, 'a check that changed nothing still reloaded every source');
});

test('the digest says which version each extension moved from and to', async () => {
  // Reintroduce by reading versions only from the pre-update list: `to` comes back as the OLD version and
  // the notification reads "1.4.8 to 1.4.8".
  const { runExtensionCheck } = await load();
  const e = engine([hasNewer('org.x.a', 'Alpha', '1.4.8', '1.4.9')], { repos: ['https://r/i.json'] });
  const d = deps(e, store({ repos: ['https://r/i.json'] }));

  const r = await runExtensionCheck({}, d.deps as any);

  assert.deepEqual(r.updated, [{ name: 'Alpha', from: '1.4.8', to: '1.4.9' }]);
  assert.match(d.pushes[0].body, /1\.4\.8 → 1\.4\.9/);
});

test('with automatic updates off, updates are counted and named but never applied', async () => {
  // Reintroduce by dropping the autoUpdate branch: the kill switch stops killing anything.
  const { runExtensionCheck } = await load();
  const e = engine([hasNewer('org.x.a', 'Alpha')], { repos: ['https://r/i.json'] });
  const st = store({ autoUpdate: false, repos: ['https://r/i.json'] });
  const d = deps(e, st);

  const r = await runExtensionCheck({}, d.deps as any);

  assert.deepEqual(r.updatesAvailable, ['Alpha']);
  assert.deepEqual(r.updated, []);
  assert.ok(!e.ops.some((o) => o.startsWith('update:')), 'the kill switch did not stop the install');
  assert.equal(d.pushes.length, 1);
  assert.match(d.pushes[0].title, /waiting/);

  // Reintroduce by removing the comparison with settings.last: the same waiting set nags on every check.
  const before = d.pushes.length;
  await runExtensionCheck({}, d.deps as any);
  assert.equal(d.pushes.length, before, 'the same set of waiting updates notified twice');
});

test('"Update all" overrides the kill switch, because a person just asked for it', async () => {
  const { runExtensionCheck } = await load();
  const e = engine([hasNewer('org.x.a', 'Alpha')], { repos: ['https://r/i.json'] });
  const d = deps(e, store({ autoUpdate: false, repos: ['https://r/i.json'] }));

  const r = await runExtensionCheck({ forceUpdate: true }, d.deps as any);
  assert.deepEqual(r.updated.map((u) => u.name), ['Alpha']);
});

test('an installed extension no repository offers any more is reported, never uninstalled', async () => {
  // Uninstalling would delete its rows from suwayomi_sources and orphan every series routed through it.
  // Reintroduce by removing the obsolete classification, or by acting on it.
  const { runExtensionCheck } = await load();
  const e = engine([{ pkgName: 'org.x.old', name: 'Abandoned', installedVersion: '1.0', upstreamVersion: null }],
    { repos: ['https://r/i.json'] });
  const d = deps(e, store({ repos: ['https://r/i.json'] }));

  const r = await runExtensionCheck({}, d.deps as any);

  assert.deepEqual(r.obsolete, ['Abandoned']);
  assert.ok(!e.ops.some((o) => o.startsWith('uninstall:')), 'an obsolete extension was uninstalled');
  assert.ok(d.pushes.some((p) => /no longer offered/.test(p.title)));
});

test('repository urls are adopted from the engine, and put back when it loses them', async () => {
  const { runExtensionCheck } = await load();

  // First run after upgrade: we hold none, the engine holds one. Adopt it, do not write to the engine.
  // Reintroduce by writing repos to the engine unconditionally: setRepos appears in ops.
  const adopt = engine([upToDate('org.x.a', 'Alpha')], { repos: ['https://r/i.json'] });
  const stA = store({ repos: [] });
  await runExtensionCheck({}, deps(adopt, stA).deps as any);
  assert.deepEqual(stA.s.repos, ['https://r/i.json'], 'the engine\'s repositories were not adopted');
  assert.ok(!adopt.ops.includes('setRepos'), 'adopting should not write back to the engine');

  // Its volume was wiped: the engine has none, we still know them. Put them back.
  // Reintroduce by removing the restore branch: the feature stays silently unconfigured.
  const healed = engine([upToDate('org.x.a', 'Alpha')], { repos: [] });
  const stB = store({ repos: ['https://r/i.json'] });
  const dB = deps(healed, stB);
  const r = await runExtensionCheck({}, dB.deps as any);
  assert.deepEqual(r.reposRestored, ['https://r/i.json']);
  assert.deepEqual(healed.repos, ['https://r/i.json'], 'the engine did not get its repositories back');
  assert.ok(dB.audits.some((a) => a.event === 'extension.repo_restored'));
});

test('a wiped engine gets its extensions back; an admin uninstalling one does not', async () => {
  // The signature of a wiped volume is BOTH the repositories and the extensions being gone. With the
  // repositories intact, an extension disappearing is a person having uninstalled it, and reinstalling it
  // behind their back would be wrong twice over.
  // Reintroduce by dropping the `wiped &&` guard: the second half reinstalls what someone just removed.
  const { runExtensionCheck } = await load();
  const snapshot = [{ pkgName: 'org.x.a', name: 'Alpha', installed: true, versionName: '1.0' }];

  const wiped = engine([{ pkgName: 'org.x.a', name: 'Alpha', installedVersion: null, upstreamVersion: '1.0' }], { repos: [] });
  const rW = await runExtensionCheck({}, deps(wiped, store({ repos: ['https://r/i.json'], snapshot })).deps as any);
  assert.deepEqual(rW.reinstalled, ['Alpha'], 'a wiped engine did not get its extensions back');

  const removed = engine([{ pkgName: 'org.x.a', name: 'Alpha', installedVersion: null, upstreamVersion: '1.0' }],
    { repos: ['https://r/i.json'] });
  const rR = await runExtensionCheck({}, deps(removed, store({ repos: ['https://r/i.json'], snapshot })).deps as any);
  assert.deepEqual(rR.reinstalled, [], 'it reinstalled an extension an admin had removed');
  assert.deepEqual(rR.removedOutside, ['Alpha'], 'the removal should still be reported');
});

test('repairing a wiped engine re-registers its sources even with automatic updates off', async () => {
  // The reload is keyed on "did anything install", not on "did the updater run". Reinstalling after a wiped
  // volume is repair, not a new version, so it deliberately ignores the kill switch -- and an earlier
  // version of this tied reloadAll to the update branch, which meant those extensions came back on the
  // engine and stayed absent from suwayomi_sources until something else happened to reload.
  //
  // Reintroduce by moving the reload back inside the `else if (mayUpdate)` branch: reloaded is false here.
  const { runExtensionCheck } = await load();
  const e = engine([{ pkgName: 'org.x.a', name: 'Alpha', installedVersion: null, upstreamVersion: '1.0' }], { repos: [] });
  const d = deps(e, store({
    autoUpdate: false, repos: ['https://r/i.json'],
    snapshot: [{ pkgName: 'org.x.a', name: 'Alpha', installed: true, versionName: '1.0' }],
  }));

  const r = await runExtensionCheck({}, d.deps as any);

  assert.deepEqual(r.reinstalled, ['Alpha'], 'the kill switch blocked a repair, which is not an update');
  assert.equal(r.reloaded, true, 'the reinstalled extension was never re-registered as a source');
  assert.equal(d.reloadCount(), 1);
});

test('what the repositories gained and lost since last time is counted', async () => {
  // Reintroduce by not storing a snapshot: both counts are always zero and "dropped upstream" is unsayable.
  const { runExtensionCheck } = await load();
  const e = engine([upToDate('org.x.a', 'Alpha'), upToDate('org.x.new', 'Newcomer')], { repos: ['https://r/i.json'] });
  const st = store({
    repos: ['https://r/i.json'],
    snapshot: [
      { pkgName: 'org.x.a', name: 'Alpha', installed: true, versionName: '1.0' },
      { pkgName: 'org.x.gone', name: 'Departed', installed: false, versionName: '1.0' },
    ],
  });

  const r = await runExtensionCheck({}, deps(e, st).deps as any);

  assert.equal(r.newUpstream, 1, 'a newly offered extension was not counted');
  assert.equal(r.removedUpstream, 1, 'an extension the repositories dropped was not counted');
  assert.equal(st.s.snapshot.length, 2, 'the snapshot was not written for next time');
});

test('updates wait rather than swapping an extension out from under a running library sweep', async () => {
  // Updating an extension replaces classes the engine is using to serve the sweep's page fetches.
  // Reintroduce by removing the sweepRunning check: the update lands mid-sweep.
  const { runExtensionCheck } = await load();
  const e = engine([hasNewer('org.x.a', 'Alpha')], { repos: ['https://r/i.json'] });
  const d = deps(e, store({ repos: ['https://r/i.json'] }), { sweepRunning: () => true });

  const r = await runExtensionCheck({}, d.deps as any);

  assert.equal(r.deferred, true);
  assert.deepEqual(r.updatesAvailable, ['Alpha'], 'it still reports what is waiting');
  assert.ok(!e.ops.some((o) => o.startsWith('update:')), 'it updated during a sweep');
});

test('a second check is refused while one is running, synchronously', async () => {
  // runtime.updating is the only overlap guard the sweep has, and this is the same contract: two starts in
  // one turn of the event loop must not both get through, or the same APK installs twice at once.
  // Reintroduce by setting extState.running after the first await instead of before it.
  const { runExtensionMonitor, extState } = await load();
  const log = { info() {}, warn() {}, error() {} };

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = runExtensionMonitor(log, (async () => { await gate; return { refreshed: true, known: 0, installed: 0, updated: [], failed: [], obsolete: [], updatesAvailable: [] } as any; }) as any);
  assert.notEqual(first, false, 'the first call should have started');
  assert.equal(extState.running, true, 'the flag is not set before the first await');
  assert.equal(runExtensionMonitor(log), false, 'a second check started on top of the first');

  release();
  await first;
  assert.equal(extState.running, false, 'the flag was not released');
});

test('a check that throws clears the last result rather than leaving the last good one on display', async () => {
  // The rule the sweep and the backup already follow.
  // Reintroduce by returning the old result on error: the panel reports yesterday's success as today's.
  const { runExtensionMonitor, extState } = await load();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (e: unknown) => lines.push(String(e)) };

  const r = await runExtensionMonitor(log, (async () => { throw new Error('boom'); }) as any);

  assert.equal(r, null, 'a thrown check should resolve null, not reject');
  assert.equal(extState.lastResult, null);
  assert.equal(extState.running, false);
  assert.ok(lines.some((l) => /boom/.test(l)), 'the reason has to reach the log');
});
