// walk49's "hiddenchapters" phase (#240 by @Squeaks72, rebuilt to hide only): Hide chapter N on the series page and
// Show hidden chapters, through the browser on the real routes, at 1280, 390 and 390 in Arabic.
//
// Needs a plain up.sh stack, and LIB naming its library folder (up.sh prints it with KEEP=1):
//   KEEP=1 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-hc E2E_PORT=18171 E2E_SUBNET=10.222.71.0/24 \
//     bash web/test/e2e/up.sh
//   cd web && LIB=<the library folder> BASE=http://127.0.0.1:18171 PHASES=hiddenchapters npm run test:e2e:v049
//
// A series collected by hand, chapters 1 to 5, its own copy per pass. Each pass:
//   1. a chapter row's ⋯ -> Hide chapter 3, asked first in a dialog that is not the red one, and the row is gone -- for
//      the series page, its count and the Library card alike -- while its file is still on the server;
//   2. Select -> tick 1 and 5 -> Hide 2 chapters, asked first, and they go too;
//   3. More -> Show hidden chapters (3): the three, with Restore on each; Restore 3, then Restore all, and the list
//      closes itself with every chapter back.
//
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// hiddenchapters-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { kit, writeShelf } from './filenamesWalk.mjs';
import { pressSeriesMoreItem } from './seriesMore.mjs';

const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;
const SERIES = (t) => `Hide Walk ${t}`;
const FILES = { 'Chapter 1.cbz': 4, 'Chapter 2.cbz': 4, 'Chapter 3.cbz': 4, 'Chapter 4.cbz': 4, 'Chapter 5.cbz': 4 };

export async function hiddenChaptersWalk(ctx) {
  const { page, check, waitFor, sleep, lib } = ctx;
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, rowLabels, lang } = kit(ctx);
  if (!lib) { check('hiddenchapters: LIB names the instance\'s library folder (up.sh prints it with KEEP=1)', false); return; }
  const numberOf = (label) => parseFloat(label.match(/\d+(?:\.\d+)?/)?.[0] ?? 'NaN');
  /** The series page's chapter numbers, ascending, once at least `n` rows are drawn (or what there is). */
  const rows = async (n) => {
    const r = await waitFor(async () => { const x = await rowLabels(); return x.length === n ? x : null; }, 10_000, 300) ?? await rowLabels();
    return r.map(numberOf).sort((a, b) => a - b);
  };
  /** The open dialog: its title, whether it is modal, and its buttons' words and classes. */
  const dialog = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop();
    if (!d) return null;
    return { title: d.getAttribute('aria-label'), buttons: [...d.querySelectorAll('button')].map((b) => ({ text: b.textContent?.trim() ?? '', cls: b.className })) };
  });
  const pressInDialog = (text) => page.evaluate((t) => {
    const d = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop();
    const b = d && [...d.querySelectorAll('button')].find((x) => x.textContent?.trim() === t);
    b?.click();
    return !!b;
  }, text);
  const notice = (text) => waitFor(() => page.evaluate((t) => document.body.innerText.includes(t), text), 8000, 200);

  try {
    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  hiddenchapters @${w}${l === 'ar' ? ' ar' : ''}`);
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });
      writeShelf(lib, `Hand Collected/${SERIES(t)}`, FILES);
      await scan();
      const s = await waitFor(() => seriesNamed(SERIES(t)), 15_000, 500);
      check(`hiddenchapters @${t}: the folder is a series`, !!s);
      if (!s) continue;
      const count = async () => (await call(`/api/series/${s.id}`)).booksCount;

      // 1. A row's ⋯ -> Hide chapter 3.
      await visit(`/series/?id=${s.id}`, 3500);
      check(`hiddenchapters @${t}: the series page lists 1 to 5`, JSON.stringify(await rows(5)) === '[1,2,3,4,5]');
      await page.evaluate(() => document.getElementById('ch-3')?.scrollIntoView({ block: 'center' }));
      await sleep(500);
      const opened = await page.evaluate((label) => {
        const b = document.getElementById('ch-3')?.querySelector(`button[aria-label="${label}"]`);
        b?.click();
        return !!b;
      }, say('Chapter actions'));
      check(`hiddenchapters @${t}: chapter 3's ⋯ opens`, opened);
      const item = await waitFor(() => page.evaluate(() => document.querySelector('[role="menu"] [data-menu-item="hide-chapter"]')?.textContent?.trim() ?? null), 5000, 200);
      check(`hiddenchapters @${t}: its menu says "${say('Hide chapter {n}', { n: 3 })}"`, item === say('Hide chapter {n}', { n: 3 }), String(item));
      await shot(`hiddenchapters-${t}-1-menu`);
      await page.evaluate(() => document.querySelector('[role="menu"] [data-menu-item="hide-chapter"]')?.click());
      const ask = await waitFor(dialog, 5000, 200);
      check(`hiddenchapters @${t}: it asks first, "${say('Hide chapter {n}?', { n: 3 })}"`, ask?.title === say('Hide chapter {n}?', { n: 3 }), JSON.stringify(ask?.title));
      const confirm = ask?.buttons.find((b) => b.text === say('Hide chapter {n}', { n: 3 }));
      check(`hiddenchapters @${t}: ...with a confirm key that is not the red one`, !!confirm && !/rose/.test(confirm.cls), JSON.stringify(confirm));
      check(`hiddenchapters @${t}: no sideways scroll under the dialog`, await noSideScroll());
      await shot(`hiddenchapters-${t}-2-confirm`);
      await pressInDialog(say('Hide chapter {n}', { n: 3 }));
      check(`hiddenchapters @${t}: it says "${say('1 chapter is hidden.')}"`, !!(await notice(say('1 chapter is hidden.'))));
      check(`hiddenchapters @${t}: chapter 3 leaves the series page`, JSON.stringify(await rows(4)) === '[1,2,4,5]');
      check(`hiddenchapters @${t}: ...and the count`, (await count()) === 4);
      check(`hiddenchapters @${t}: its file is still on the server`, existsSync(join(lib, 'Hand Collected', SERIES(t), 'Chapter 3.cbz')));
      await shot(`hiddenchapters-${t}-3-hidden`);

      // 2. Select -> 1 and 5 -> Hide 2 chapters.
      const selecting = await page.evaluate((label) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === label && x.getClientRects().length);
        b?.click();
        return !!b;
      }, say('Select'));
      check(`hiddenchapters @${t}: Select`, selecting);
      await sleep(500);
      for (const n of [1, 5]) {
        await page.evaluate((id) => { const r = document.getElementById(id); r?.scrollIntoView({ block: 'center' }); r?.querySelector('button[aria-pressed]')?.click(); }, `ch-${n}`);
        await sleep(300);
      }
      const key = await waitFor(() => page.evaluate(() => {
        const b = document.querySelector('[data-hide-chapters]');
        return b && !b.disabled ? { text: b.textContent?.trim(), cls: b.className } : null;
      }), 5000, 200);
      check(`hiddenchapters @${t}: the bar says "${say('Hide {n} chapters', { n: 2 })}", not in red`, key?.text === say('Hide {n} chapters', { n: 2 }) && !/danger|rose/.test(key.cls), JSON.stringify(key));
      check(`hiddenchapters @${t}: no sideways scroll with the bar up`, await noSideScroll());
      await shot(`hiddenchapters-${t}-4-select-bar`);
      await page.evaluate(() => document.querySelector('[data-hide-chapters]')?.click());
      const ask2 = await waitFor(dialog, 5000, 200);
      check(`hiddenchapters @${t}: it asks "${say('Hide {n} chapters?', { n: 2 })}"`, ask2?.title === say('Hide {n} chapters?', { n: 2 }), JSON.stringify(ask2?.title));
      await pressInDialog(say('Hide {n} chapters', { n: 2 }));
      check(`hiddenchapters @${t}: it says "${say('{n} chapters are hidden.', { n: 2 })}"`, !!(await notice(say('{n} chapters are hidden.', { n: 2 }))));
      check(`hiddenchapters @${t}: 1 and 5 leave the series page too`, JSON.stringify(await rows(2)) === '[2,4]');
      check(`hiddenchapters @${t}: the server says three are hidden`, (await call(`/api/series/${s.id}`)).hiddenChapters === 3);

      // 3. More -> Show hidden chapters (3), Restore one, Restore all.
      await visit(`/series/?id=${s.id}`, 3500);
      check(`hiddenchapters @${t}: More has Show hidden chapters`, await pressSeriesMoreItem(page, 'hidden-chapters'));
      const list = await waitFor(() => page.evaluate(() => {
        const d = document.querySelector('[data-hidden-chapters]');
        return d ? [...d.querySelectorAll('[data-hidden-number]')].map((li) => Number(li.getAttribute('data-hidden-number'))) : null;
      }), 8000, 200);
      check(`hiddenchapters @${t}: it lists 1, 3 and 5`, JSON.stringify(list) === '[1,3,5]', JSON.stringify(list));
      const head = await dialog();
      check(`hiddenchapters @${t}: ...in a modal dialog, "${say('Hidden chapters')}"`, head?.title === say('Hidden chapters'), JSON.stringify(head?.title));
      const caption = await page.evaluate(() => document.querySelector('[data-hidden-number="3"] p.text-xs')?.textContent?.trim() ?? '');
      check(`hiddenchapters @${t}: ...each says what it is ("${say('1 copy on the server')}")`, caption === say('1 copy on the server'), caption);
      check(`hiddenchapters @${t}: no sideways scroll in the list`, await noSideScroll());
      await shot(`hiddenchapters-${t}-5-show-hidden`);
      await page.evaluate((label) => document.querySelector(`[data-hidden-number="3"] button[aria-label="${label}"]`)?.click(), say('Restore chapter {n}', { n: 3 }));
      check(`hiddenchapters @${t}: Restore says "${say('1 chapter is back.')}"`, !!(await notice(say('1 chapter is back.'))));
      const left = await waitFor(() => page.evaluate(() => {
        const ns = [...document.querySelectorAll('[data-hidden-number]')].map((li) => Number(li.getAttribute('data-hidden-number')));
        return ns.length === 2 ? ns : null;
      }), 5000, 200);
      check(`hiddenchapters @${t}: ...and the list keeps 1 and 5`, JSON.stringify(left) === '[1,5]', JSON.stringify(left));
      await page.evaluate(() => document.querySelector('[data-restore-all]')?.click());
      check(`hiddenchapters @${t}: Restore all says "${say('{n} chapters are back.', { n: 2 })}"`, !!(await notice(say('{n} chapters are back.', { n: 2 }))));
      const closed = await waitFor(() => page.evaluate(() => !document.querySelector('[data-hidden-chapters]')), 5000, 200);
      check(`hiddenchapters @${t}: the list closes itself once nothing is hidden`, !!closed);
      check(`hiddenchapters @${t}: every chapter is back`, JSON.stringify(await rows(5)) === '[1,2,3,4,5]');
      check(`hiddenchapters @${t}: ...and counted`, (await count()) === 5);
      await shot(`hiddenchapters-${t}-6-restored`);
    }
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
