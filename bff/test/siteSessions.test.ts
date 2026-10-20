// Open site and the quiet check visit (v0.91.0, #314; lib/sources/suwayomi/siteSessions.ts), with a fake engine browser.
//
// What this holds to:
// - one page at a time, because the engine has one browser and a second client closes the first: another admin's page
//   in use refuses, the same admin's earlier page is left for the new one, and a quiet visit never takes an admin's page;
// - a page is its admin's alone: another admin's id names nothing;
// - the sheet gets at most five pictures a second, the newest one, as a JPEG (v0.91.1), and the next only once it says it
//   has the last (`seen`), or frameTiming.seenWaitMs on: a slow connection gets the newest picture, not a queue of them;
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

/** A real PNG, as the engine sends: a small picture of one shade of red. */
async function png(shade: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 8, height: 6, channels: 3, background: { r: shade, g: 0, b: 0 } } }).png().toBuffer();
}
/** The shade of red a frame's JPEG shows, and that it is a JPEG at all. */
async function shadeOf(jpeg: string): Promise<number> {
  const sharp = (await import('sharp')).default;
  const bytes = Buffer.from(jpeg, 'base64');
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', 'a JPEG, not the engine\'s PNG');
  return (await sharp(bytes).raw().toBuffer())[0];
}

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
      const got: Array<{ type: string; seq?: number; jpeg?: string; url?: string }> = [];
      page.events.address?.('https://batcave.biz/', 'BatCave');
      for (let i = 1; i <= 5; i++) page.events.frame?.(await png(i * 40));
      site.subscribe(id, 'alice', (l) => got.push(l as never));
      assert.deepEqual(got.map((l) => l.type), ['address'], 'the address at once; no picture has been sent yet');
      await sleep(300);
      const frames = () => got.filter((l) => l.type === 'frame');
      assert.equal(frames().length, 1, 'five pictures inside 200 ms are one');
      assert.ok(Math.abs((await shadeOf(frames()[0].jpeg!)) - 200) <= 4, 'the newest, as a JPEG');
      page.events.frame?.(await png(60));
      await sleep(300);
      assert.equal(frames().length, 1, 'the sheet has not said it has the last picture: the next one waits, not queued behind');
      page.events.frame?.(await png(80));
      assert.equal(site.sendInput(id, 'alice', [{ type: 'seen', seq: frames()[0].seq! }]), true);
      await sleep(300);
      assert.equal(frames().length, 2, 'until it does');
      assert.ok(Math.abs((await shadeOf(frames()[1].jpeg!)) - 80) <= 4, 'and then the newest, not the one that waited longest');
      assert.equal(page.sent.length, 1, '`seen` never reaches the page: only the opening loadUrl did');
      const late: string[] = [];
      site.subscribe(id, 'alice', (l) => late.push(l.type));
      assert.deepEqual(late, ['address', 'frame'], 'a sheet that joins late sees the page at once');
      await site.stopSite(id, 'alice');
    });

    await t.test('a sheet that never says it has a picture still gets the next, frameTiming.seenWaitMs on', async () => {
      const saved = site.frameTiming.seenWaitMs;
      site.frameTiming.seenWaitMs = 600;
      try {
        const { id } = await site.startSite({ uid: 'alice', sourceId: '42', home: 'https://batcave.biz', width: 800, height: 600 });
        const page = opened.at(-1)!;
        const frames: number[] = [];
        site.subscribe(id, 'alice', (l) => { if (l.type === 'frame') frames.push(l.seq); });
        page.events.frame?.(await png(100));
        await sleep(250);
        page.events.frame?.(await png(120));
        await sleep(250);
        assert.deepEqual(frames, [1], 'waiting for the sheet');
        await sleep(600);
        assert.deepEqual(frames, [1, 2], 'a `seen` lost on the way, or a sheet from before v0.91.1, holds nothing up for long');
        await site.stopSite(id, 'alice');
      } finally {
        site.frameTiming.seenWaitMs = saved;
      }
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
