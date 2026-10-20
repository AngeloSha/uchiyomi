// Open site and the quiet check visit (v0.91.0, #314; lib/sources/suwayomi/siteSessions.ts), with a fake engine browser.
//
// What this holds to:
// - one page at a time, because the engine has one browser and a second client closes the first: another admin's page
//   in use refuses, the same admin's earlier page is left for the new one, and a quiet visit never takes an admin's page;
// - a page is its admin's alone: another admin's id names nothing;
// - the sheet gets at most five pictures a second, the newest one;
// - Done leaves the page (the engine saves its cookies then) and says which source it was for;
// - an extension's "Open in WebView…" answer gets one quiet visit and one more try; callers at the same moment share the
//   visit, and a source is visited at most once in half an hour.
//
// Pure unit tests: no database, no engine.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';

type Sent = Record<string, unknown>;
interface FakeBrowser {
  sent: Sent[];
  closed: number;
  events: import('../src/lib/sources/suwayomi/engineBrowser').BrowserEvents;
}

/** A fake engine browser: records what it is sent and lets the test play the page's side. */
function fakeOpener(opts: { refuse?: boolean } = {}) {
  const opened: FakeBrowser[] = [];
  const opener = async (events: FakeBrowser['events']) => {
    if (opts.refuse) throw new Error('no browser');
    const b: FakeBrowser = { sent: [], closed: 0, events };
    opened.push(b);
    let open = true;
    return {
      get open() { return open; },
      send: (m: Sent) => { b.sent.push(m); },
      close: async () => { open = false; b.closed++; },
    };
  };
  return { opener, opened };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Open site: one page at a time, its admin\'s alone', async (t) => {
  const site = await import('../src/lib/sources/suwayomi/siteSessions');
  const { opener, opened } = fakeOpener();
  site.setBrowserOpener(opener as never);
  try {
    await t.test('it opens the source\'s home page at the sheet\'s size, kept within the engine\'s limits', async () => {
      const { id } = await site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 390, height: 9000 });
      assert.ok(id.length >= 20, 'an id nobody can guess');
      assert.deepEqual(opened[0].sent[0], { type: 'loadUrl', url: 'https://batcave.biz', width: 390, height: 1600 });
      assert.equal(site.siteSessionActive(), true);
      assert.equal(site.siteOpen(id, 'alice'), true);
      assert.equal(site.siteOpen(id, 'bob'), false, 'another admin\'s id names nothing');
      assert.equal(site.sendInput(id, 'bob', [{ type: 'home' }]), false, 'nor takes input');
      assert.equal(await site.stopSite(id, 'bob'), null, 'nor closes it');
      assert.equal(await site.stopSite(id, 'alice'), '42', 'Done says which source it was for');
      assert.equal(opened[0].closed, 1, 'and leaves the page, which is when the engine saves its cookies');
      assert.equal(site.siteSessionActive(), false);
    });

    await t.test('another admin\'s page in use refuses; the same admin\'s earlier page is left for the new one', async () => {
      const a = await site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 800, height: 600 });
      await assert.rejects(site.startSite({ uid: 'bob', sourceId: '7', home: 'https://example.org', width: 800, height: 600 }),
        site.SiteBusyError, 'Bob may not close Alice\'s page');
      const lines: string[] = [];
      site.subscribe(a.id, 'alice', (l) => lines.push(l.type === 'closed' ? `closed:${l.reason}` : l.type));
      const b = await site.startSite({ uid: 'alice', sourceId: '7', home: 'https://example.org', width: 800, height: 600 });
      assert.deepEqual(lines, ['closed:replaced'], 'her first sheet is told');
      assert.equal(opened.at(-2)!.closed, 1, 'and the first page was left');
      assert.equal(await site.stopSite(b.id, 'alice'), '7');
    });

    await t.test('the sheet gets the newest picture, at most five a second, and what the page shows when it joins', async () => {
      const { id } = await site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 800, height: 600 });
      const page = opened.at(-1)!;
      const got: Array<{ type: string; seq?: number; png?: string; url?: string }> = [];
      page.events.address?.('https://batcave.biz/', 'BatCave');
      for (let i = 1; i <= 5; i++) page.events.frame?.(Buffer.from([i]));
      site.subscribe(id, 'alice', (l) => got.push(l as never));
      assert.deepEqual(got.map((l) => l.type), ['address'], 'the address at once; no picture has been sent yet');
      await sleep(260);
      const frames = got.filter((l) => l.type === 'frame');
      assert.equal(frames.length, 1, 'five pictures inside 200 ms are one');
      assert.equal(frames[0].png, Buffer.from([5]).toString('base64'), 'the newest');
      page.events.frame?.(Buffer.from([6]));
      await sleep(260);
      assert.equal(got.filter((l) => l.type === 'frame').length, 2);
      const late: string[] = [];
      site.subscribe(id, 'alice', (l) => late.push(l.type));
      assert.deepEqual(late, ['address', 'frame'], 'a sheet that joins late sees the page at once');
      await site.stopSite(id, 'alice');
    });

    await t.test('input reaches the page; `home` opens the source\'s home page again; a new size is kept within limits', async () => {
      const { id } = await site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 800, height: 600 });
      const page = opened.at(-1)!;
      assert.equal(site.sendInput(id, 'alice', [
        { type: 'event', eventType: 'mousedown', clickX: 10, clickY: 20, button: 0 },
        { type: 'paste', data: 'reader@example.org' },
        { type: 'resize', width: 100, height: 700 },
        { type: 'home' },
      ]), true);
      assert.deepEqual(page.sent.slice(1), [
        { type: 'event', eventType: 'mousedown', clickX: 10, clickY: 20, button: 0 },
        { type: 'paste', data: 'reader@example.org' },
        { type: 'resize', width: 320, height: 700 },
        { type: 'loadUrl', url: 'https://batcave.biz', width: 320, height: 700 },
      ]);
      await site.stopSite(id, 'alice');
    });

    await t.test('the engine closing the browser closes the sheet', async () => {
      const { id } = await site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 800, height: 600 });
      const lines: string[] = [];
      site.subscribe(id, 'alice', (l) => lines.push(l.type === 'closed' ? `closed:${l.reason}` : l.type));
      opened.at(-1)!.events.closed?.(1001, 'Other client connected');
      await sleep(10);
      assert.deepEqual(lines, ['closed:engine']);
      assert.equal(site.siteSessionActive(), false);
    });

    await t.test('an engine without a browser is an error, and nothing is left open', async () => {
      site.setBrowserOpener(fakeOpener({ refuse: true }).opener as never);
      await assert.rejects(site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 800, height: 600 }));
      assert.equal(site.siteSessionActive(), false);
      site.setBrowserOpener(opener as never);
    });
  } finally {
    site.setBrowserOpener();
  }
});

test('an Open in WebView answer gets one quiet visit and one more try', async (t) => {
  const site = await import('../src/lib/sources/suwayomi/siteSessions');
  const { makeSuwayomiAdapter } = await import('../src/lib/sources/suwayomi/sources');
  const saved = { ...site.visitTiming };
  Object.assign(site.visitTiming, { settleMs: 30, minMs: 40, maxMs: 400, tickMs: 10 });
  const { opener, opened } = fakeOpener();
  site.setBrowserOpener(opener as never);
  const GUARD = 'Exception while fetching data (/fetchSourceManga) : Open in WebView to bypass site protection';
  const remote = { id: '7422', name: 'BatCave', lang: 'en', homeUrl: 'https://batcave.biz', supportsLatest: true };
  const answer = { fetchSourceManga: { mangas: [{ id: 1, title: 'Batman', sourceId: '7422' }] } };
  try {
    await t.test('which words count: keiyoushi\'s "Open in WebView", not any failure', () => {
      assert.equal(site.needsBrowserCheck(new Error(GUARD)), true);
      assert.equal(site.needsBrowserCheck(new Error('Please open the site in WebView first')), true);
      assert.equal(site.needsBrowserCheck(new Error('HTTP error 401')), false, 'a sign-in wall is the admin\'s Open site, not a visit');
      assert.equal(site.needsBrowserCheck(null), false);
    });

    await t.test('the visit opens the source\'s home page, waits for it to settle, leaves it, and the call is tried again', async () => {
      site.resetSiteChecks();
      let calls = 0;
      const gql = (async () => { calls++; if (calls === 1) throw new Error(GUARD); return answer; }) as never;
      const adapter = makeSuwayomiAdapter(remote, gql);
      const list = await adapter.popular!(1);
      assert.equal(list.length, 1, 'the second try answers');
      assert.equal(calls, 2, 'tried once more, not again and again');
      const visit = opened.at(-1)!;
      assert.equal((visit.sent[0] as { url: string }).url, 'https://batcave.biz', 'the source\'s own home page');
      assert.equal(visit.closed, 1, 'left, so the engine saves the cookies');
      assert.equal(site.siteSessionActive(), false);
    });

    await t.test('once in half an hour per source, and callers at the same moment share one visit', async () => {
      site.resetSiteChecks();
      const before = opened.length;
      const gql = (async () => { throw new Error(GUARD); }) as never;
      const adapter = makeSuwayomiAdapter(remote, gql);
      const both = await Promise.allSettled([adapter.popular!(1), adapter.search('batman')]);
      assert.equal(opened.length - before, 1, 'two failures at once, one visit');
      assert.ok(both.every((r) => r.status === 'rejected'), 'a site that still refuses after the visit is still an error');
      await assert.rejects(adapter.popular!(1), /WebView/);
      assert.equal(opened.length - before, 1, 'and no second visit within half an hour');
    });

    await t.test('no visit while an admin has a page open, for a source with no site, or for another error', async () => {
      site.resetSiteChecks();
      const before = opened.length;
      const { id } = await site.startSite({ uid: 'alice', sourceId: '1', home: 'https://example.org', width: 800, height: 600 });
      const guard = (async () => { throw new Error(GUARD); }) as never;
      await assert.rejects(makeSuwayomiAdapter(remote, guard).popular!(1), /WebView/);
      assert.equal(opened.length - before, 1, 'Alice\'s page only: the visit would have closed it');
      await site.stopSite(id, 'alice');
      await assert.rejects(makeSuwayomiAdapter({ ...remote, homeUrl: null }, guard).popular!(1), /WebView/);
      const wall = (async () => { throw new Error('HTTP error 401'); }) as never;
      await assert.rejects(makeSuwayomiAdapter(remote, wall).popular!(1), /401/);
      assert.equal(opened.length - before, 1, 'neither opened a page');
    });

    await t.test('a source whose site an admin opened gets a visit on ANY failure: BatCave\'s guard, run out, is a plain 404', async () => {
      site.resetSiteChecks();
      site.setSitesOpened(['7422']);
      const before = opened.length;
      let calls = 0;
      const gql = (async () => { calls++; if (calls === 1) throw new Error('HTTP error 404'); return answer; }) as never;
      assert.equal((await makeSuwayomiAdapter(remote, gql).popular!(1)).length, 1, 'visited, then answered');
      assert.equal(opened.length - before, 1);
      site.resetSiteChecks();
      const other = (async () => { throw new Error('HTTP error 404'); }) as never;
      await assert.rejects(makeSuwayomiAdapter({ ...remote, id: '9999' }, other).popular!(1), /404/);
      assert.equal(opened.length - before, 1, 'a source never opened is not visited for a 404');
      site.noteSiteOpened('9999');
      assert.equal(site.siteWasOpened('9999'), true, 'Done adds the source at once');
    });
  } finally {
    Object.assign(site.visitTiming, saved);
    site.resetSiteChecks();
    site.setSitesOpened([]);
    site.setBrowserOpener();
  }
});
