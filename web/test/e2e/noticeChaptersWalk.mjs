// walk49's "noticechapters" phase (v0.55.2, #147, TIGamingTV's notice chapters with the owner's page rule): Admin ->
// Settings -> Notice chapters, through the browser on the real routes, at 1280, 390 and 390 in Arabic.
//
// Needs a plain up.sh stack, and LIB naming its library folder (up.sh prints it with KEEP=1):
//   KEEP=1 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-nc E2E_PORT=18159 E2E_SUBNET=10.222.59.0/24 \
//     bash web/test/e2e/up.sh
//   cd web && LIB=<the library folder> BASE=http://127.0.0.1:18159 PHASES=noticechapters npm run test:e2e:v049
//
// A manhwa collected by hand (its ComicInfo says Manhwa, which types the series): chapters 1, 2, a two-page 2.5 -- a
// notice -- 3, a twenty-page 3.5 -- a chapter posted in parts -- and 4, their pages counted as a reader opening them
// counts them. Each pass:
//   1. Admin -> Settings -> Notice chapters: Manhwa switched on;
//   2. the series page leaves the two-page 2.5 out and keeps the twenty-page 3.5, and every count agrees on five --
//      the series, its Library card, Mihon, the header's "5 chapters" -- with "Hidden now" at one;
//   3. the reader: its chapter list leaves 2.5 out, the next chapter after 2 is 3, and 2.5 is not there by id;
//   3b. v0.55.3 (#147, TIGamingTV's switch): "Only hide short ones (3 pages or fewer)" switched off -- its help says what
//      that hides -- and the twenty-page 3.5 leaves too, four counted and two hidden; switched on again, it is back;
//   4. switched off: every one of them is back, six.
// And the off state costs nothing: the Library grid's own request, timed before the switch was ever on and after it is
// off again, takes about as long (lib/noticeChapters.ts `active`: off, every query is the previous release's).
//
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// noticechapters-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { kit, writeShelf } from './filenamesWalk.mjs';

const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;
const FOLDER = 'Hand Collected/Notice Walk';
const SERIES = 'Notice Walk';
/** Each file and its pages. */
const FILES = {
  'Chapter 1.cbz': 4, 'Chapter 2.cbz': 4, 'Chapter 2.5.cbz': 2, 'Chapter 3.cbz': 4, 'Chapter 3.5.cbz': 20, 'Chapter 4.cbz': 4,
};
const ALL = ['Ch. 1', 'Ch. 2', 'Ch. 2.5', 'Ch. 3', 'Ch. 3.5', 'Ch. 4'];
const SHOWN = ALL.filter((l) => l !== 'Ch. 2.5');
/** "Only hide short ones" off (v0.55.3): every chapter numbered like 12.5 hides, the twenty-page 3.5 too. */
const WHOLE_ONLY = ALL.filter((l) => !/\.5$/.test(l));
/** Manhwa's switch: the second of Settings' notice switches, in the server's type order (web lib/seriesTypes.ts). */
const MANHWA = 1;

export async function noticeChaptersWalk(ctx) {
  const { page, check, waitFor, sleep, lib } = ctx;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, rowLabels, readerChapters, lang } = kit(ctx);
  if (!lib) { check('noticechapters: LIB names the instance\'s library folder (up.sh prints it with KEEP=1)', false); return; }
  const types = async () => (await call('/api/admin/settings')).hide_notice_types;
  try {
    console.log('\n  noticechapters: the series');
    writeShelf(lib, FOLDER, FILES, 'Manhwa');
    await scan();
    const s = await waitFor(() => seriesNamed(SERIES), 15_000, 500);
    check(`noticechapters: the folder is a series, ${SERIES}`, !!s);
    if (!s) return;
    const typed = await call(`/api/series/${s.id}`);
    check('noticechapters: its ComicInfo genre types it a manhwa, and nothing hides yet', typed.seriesType === 'manhwa'
      && typed.hideNoticesEffective === false && JSON.stringify(await types()) === '[]', JSON.stringify({ type: typed.seriesType, on: typed.hideNoticesEffective }));
    const books = async () => (await call(`/api/series/${s.id}/books?size=100`)).content ?? [];
    // Counted as the reader counts them, opening each: the rule reads a chapter's own pages once they are known.
    const ids = {};
    for (const b of await books()) {
      ids[b.metadata.number] = b.id;
      await call(`/api/books/${b.id}/pages`);
    }
    const pages = Object.fromEntries((await books()).map((b) => [b.metadata.number, b.media.pagesCount]));
    check('noticechapters: the pages are counted -- 2.5 has two, 3.5 twenty', pages['2.5'] === 2 && pages['3.5'] === 20, JSON.stringify(pages));

    // The Library grid's own request, as the page sends it, timed: the median of 25 after 5 to warm up.
    const bodies = [];
    const onReq = (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/series/search')) bodies.push(r.postData()); };
    page.on('request', onReq);
    await visit('/library', 3500);
    page.off('request', onReq);
    const grid = bodies.at(-1) ? JSON.parse(bodies.at(-1)) : { size: 40 };
    const gridTime = async () => {
      const ms = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        await call('/api/series/search', { json: grid });
        if (i >= 5) ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      return ms[Math.floor(ms.length / 2)];
    };
    const before = await gridTime();
    console.log(`         the Library grid's request, before any switch: ${before.toFixed(1)} ms (${JSON.stringify(grid)})`);

    /** Settings -> Notice chapters: flip Manhwa's switch through the page, and wait for the server to hold it. */
    const flip = async (to, t) => {
      await visit('/admin/?tab=Settings', 3500);
      const sw = await waitFor(() => page.evaluate((i) => {
        const b = document.querySelectorAll('[data-notice-types] [role="switch"]')[i];
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        return b.getAttribute('aria-checked');
      }, MANHWA), 15_000, 300);
      check(`noticechapters @${t}: Settings shows the Notice chapters switches, Manhwa ${to ? 'off' : 'on'}`, sw === String(!to), String(sw));
      const label = await page.evaluate((i) => document.querySelectorAll('[data-notice-types] [role="switch"]')[i]?.getAttribute('aria-label'), MANHWA);
      check(`noticechapters @${t}: ...the second of them is Manhwa's`, label === say('Manhwa'), String(label));
      await page.evaluate((i) => document.querySelectorAll('[data-notice-types] [role="switch"]')[i]?.click(), MANHWA);
      const held = await waitFor(async () => (JSON.stringify(await types()) === JSON.stringify(to ? ['manhwa'] : []) ? true : null), 10_000, 300);
      check(`noticechapters @${t}: switched ${to ? 'on' : 'off'}, the server holds it`, !!held, JSON.stringify(await types()));
      await waitFor(() => page.evaluate((i, want) => document.querySelectorAll('[data-notice-types] [role="switch"]')[i]?.getAttribute('aria-checked') === want, MANHWA, String(to)), 5000, 200);
      check(`noticechapters @${t}: no sideways scroll`, await noSideScroll());
    };
    /** v0.55.3 (#147): Settings -> Notice chapters -> "Only hide short ones", flipped through the page. */
    const flipShort = async (to, t) => {
      await visit('/admin/?tab=Settings', 3500);
      const sw = await waitFor(() => page.evaluate(() => {
        const b = document.querySelector('[data-notice-short-only] [role="switch"]');
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        return b.getAttribute('aria-checked');
      }), 15_000, 300);
      check(`noticechapters @${t}: Settings has "${say('Only hide short ones (3 pages or fewer)')}", ${to ? 'off' : 'on'}`, sw === String(!to), String(sw));
      const help = await page.evaluate(() => document.querySelector('[data-notice-short-only]')?.closest('section')?.textContent ?? '');
      check(`noticechapters @${t}: ...its help says what switching it off hides`,
        help.includes(say('Off hides every chapter numbered like 12.5 of the types switched on, including real chapters a site split into parts.')), help.slice(0, 300));
      await page.evaluate(() => document.querySelector('[data-notice-short-only] [role="switch"]')?.click());
      const held = await waitFor(async () => ((await call('/api/admin/settings')).hideNoticeShortOnly === to ? true : null), 10_000, 300);
      check(`noticechapters @${t}: switched ${to ? 'on' : 'off'}, the server holds it`, !!held, String((await call('/api/admin/settings')).hideNoticeShortOnly));
      await waitFor(() => page.evaluate((want) => document.querySelector('[data-notice-short-only] [role="switch"]')?.getAttribute('aria-checked') === want, String(to)), 5000, 200);
      check(`noticechapters @${t}: no sideways scroll`, await noSideScroll());
    };
    const { token: apiKey } = await call('/api/tokens', { json: { name: 'notice chapters walk', scopes: ['read'] } });
    /** What each surface counts: the series, its Library card, Mihon, and Hidden now. */
    const counts = async () => {
      const one = await call(`/api/series/${s.id}`);
      const card = ((await call('/api/series/search', { json: grid })).content ?? []).find((x) => x.id === s.id);
      const komga = await call(`/api/v1/series/${s.id}`, { headers: { 'x-api-key': apiKey } });
      return { series: one.booksCount, card: card?.booksCount ?? null, unread: card?.booksUnreadCount ?? null, mihon: komga.booksCount, hidden: one.hiddenNotices };
    };
    /** The series page: its rows, ascending, and whether the header says `n` chapters. */
    const seriesPage = async (n) => {
      await visit(`/series/?id=${s.id}`, 3500);
      const rows = await waitFor(async () => { const r = await rowLabels(); return r.length >= n ? r : null; }, 15_000, 400) ?? await rowLabels();
      const header = await page.evaluate(() => document.body.innerText);
      return { rows: [...rows].sort((a, b) => parseFloat(a.slice(4)) - parseFloat(b.slice(4))), says: header.includes(say('{n} chapters', { n })) };
    };
    const reader = async () => {
      await visit(`/reader/?book=${encodeURIComponent(ids['2'])}`, 3500);
      return readerChapters(say('Chapters'));
    };

    let on = null;
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  noticechapters @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });

      // 1. On.
      await flip(true, t);
      await shot(`noticechapters-${t}-1-settings-on`);

      // 2. The series page and every count.
      const p = await seriesPage(5);
      check(`noticechapters @${t}: the series page leaves out the two-page 2.5 and keeps the twenty-page 3.5`,
        JSON.stringify(p.rows) === JSON.stringify(SHOWN), JSON.stringify(p.rows));
      check(`noticechapters @${t}: ...and its header says "${say('{n} chapters', { n: 5 })}"`, p.says);
      check(`noticechapters @${t}: no sideways scroll`, await noSideScroll());
      await page.evaluate(() => document.getElementById('ch-3.5')?.scrollIntoView({ block: 'center' }));
      await shot(`noticechapters-${t}-2-series-hidden`);
      const c = await counts();
      check(`noticechapters @${t}: the series, its Library card, Mihon and the unread badge all count 5; Hidden now is 1`,
        JSON.stringify(c) === JSON.stringify({ series: 5, card: 5, unread: 5, mihon: 5, hidden: 1 }), JSON.stringify(c));

      // 3. The reader.
      const sheet = await reader();
      check(`noticechapters @${t}: the reader's chapter list leaves 2.5 out and keeps 3.5`, JSON.stringify(sheet) === JSON.stringify(SHOWN), JSON.stringify(sheet));
      await shot(`noticechapters-${t}-3-reader`);
      await page.keyboard.press('Escape');
      const next = await call(`/api/books/${ids['2']}/next`, { allow: [404] });
      check(`noticechapters @${t}: the chapter after 2 is 3`, next?.id === ids['3'], JSON.stringify(next && { id: next.id, n: next.metadata?.number }));
      const gone = await call(`/api/books/${ids['2.5']}`, { status: true, allow: [404] });
      check(`noticechapters @${t}: 2.5 is not there by id, for an admin either`, gone.status === 404, String(gone.status));
      if (!on) on = await (async () => {
        const ms = [];
        for (let i = 0; i < 15; i++) { const t0 = performance.now(); await call('/api/series/search', { json: grid }); if (i >= 5) ms.push(performance.now() - t0); }
        return ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)];
      })();

      // 3b. v0.55.3 (#147, TIGamingTV's switch): only short ones off -- the twenty-page 3.5 hides too -- and on again.
      await flipShort(false, t);
      await page.evaluate(() => document.querySelector('[data-notice-short-only]')?.scrollIntoView({ block: 'center' }));
      await shot(`noticechapters-${t}-3b-short-only-off`);
      const whole = await seriesPage(4);
      check(`noticechapters @${t}: "Only hide short ones" off, the twenty-page 3.5 leaves the series page too`,
        JSON.stringify(whole.rows) === JSON.stringify(WHOLE_ONLY), JSON.stringify(whole.rows));
      check(`noticechapters @${t}: ...and its header says "${say('{n} chapters', { n: 4 })}"`, whole.says);
      const c3 = await counts();
      check(`noticechapters @${t}: every count is 4, and Hidden now is 2`,
        JSON.stringify(c3) === JSON.stringify({ series: 4, card: 4, unread: 4, mihon: 4, hidden: 2 }), JSON.stringify(c3));
      check(`noticechapters @${t}: ...and the series says which rule hides them`, (await call(`/api/series/${s.id}`)).hideNoticeShortOnly === false);
      await shot(`noticechapters-${t}-3c-series-short-only-off`);
      await flipShort(true, t);
      const shortAgain = await seriesPage(5);
      check(`noticechapters @${t}: on again, the twenty-page 3.5 is back and only the two-page 2.5 stays hidden`,
        JSON.stringify(shortAgain.rows) === JSON.stringify(SHOWN), JSON.stringify(shortAgain.rows));
      const c4 = await counts();
      check(`noticechapters @${t}: ...every count is 5 again, Hidden now 1`,
        JSON.stringify(c4) === JSON.stringify({ series: 5, card: 5, unread: 5, mihon: 5, hidden: 1 }), JSON.stringify(c4));

      // 4. Off: every one of them back.
      await flip(false, t);
      await shot(`noticechapters-${t}-4-settings-off`);
      const back = await seriesPage(6);
      check(`noticechapters @${t}: switched off, the series page lists 2.5 again`, JSON.stringify(back.rows) === JSON.stringify(ALL), JSON.stringify(back.rows));
      check(`noticechapters @${t}: ...and says "${say('{n} chapters', { n: 6 })}"`, back.says);
      const c2 = await counts();
      check(`noticechapters @${t}: every count is 6 again, and nothing is hidden`,
        JSON.stringify(c2) === JSON.stringify({ series: 6, card: 6, unread: 6, mihon: 6, hidden: 0 }), JSON.stringify(c2));
      const sheet2 = await reader();
      check(`noticechapters @${t}: the reader lists 2.5 again`, JSON.stringify(sheet2) === JSON.stringify(ALL), JSON.stringify(sheet2));
      await page.keyboard.press('Escape');
      const there = await call(`/api/books/${ids['2.5']}`, { status: true, allow: [404] });
      check(`noticechapters @${t}: ...and opens it by id`, there.status === 200, String(there.status));
    }

    // Off costs nothing: the same request, the same time, give or take the noise of a small machine.
    const after = await gridTime();
    console.log(`         the Library grid's request: before ${before.toFixed(1)} ms, on ${on?.toFixed(1)} ms, off again ${after.toFixed(1)} ms`);
    check(`noticechapters: off again, the Library grid's request takes what it took before any switch (${before.toFixed(1)} -> ${after.toFixed(1)} ms)`,
      after <= Math.max(before * 1.5, before + 15));
  } finally {
    await call('/api/admin/settings', { method: 'PATCH', json: { hideNoticeTypes: [], hideNoticeShortOnly: true } }).catch(() => {});
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
