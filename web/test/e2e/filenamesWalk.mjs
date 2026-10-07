// walk49's "filenames" phase (v0.55.2, #150): chapter numbers from the names of a library collected by hand. Through
// the browser on the real routes, at 1280, 390 and 390 in Arabic.
//
// Needs a plain up.sh stack, and LIB naming its library folder (up.sh prints it with KEEP=1):
//   KEEP=1 E2E_MIN_FREE_GB=0 E2E_NO_WALK=1 E2E_NET=uchi-e2e-fn E2E_PORT=18158 E2E_SUBNET=10.222.58.0/24 \
//     bash web/test/e2e/up.sh
//   cd web && LIB=<the library folder> BASE=http://127.0.0.1:18158 PHASES=filenames npm run test:e2e:v049
//
// The folder Kedryn's question (#150) described, one series: `Batman #12 (1987).cbz`, `Vol 3 Chapter 12.cbz`,
// `Watchmen (1986).cbz`, `Batman 01-07.cbz` and `Chapter 12 - Episode #5.cbz`, scanned by Scan library now -- one copy
// of the folder per pass, so each pass reads its own series from the start. By the first number in the name -- every
// release before v0.55.2 -- those were chapters 12, 3, 1986, 1 and 12. Now: 12, 12, none (0: a year is not a
// chapter), 1 to 7 and 12. Each pass then checks, in the browser:
//   1. the series page says each number, the range as "Ch. 1–7", in order;
//   2. Health's Chapter gaps names the series for 8 to 11 and never for anything the range holds;
//   3. reading from the year-only file through the range in the reader -- scrolled page by page, as a person reads:
//      landing on a page is not reading it (app/reader/page.tsx) -- marks both read, and Mihon's read-up-to is then
//      7, the range's end (Watchmen, chapter 0, comes first, so it is read too: an unread number 0 holds the run at 0);
//   4. a rescan changes nothing: every file keeps its number, its range and its id.
//
// Every view: no sideways scroll. walk49 counts the console errors and 5xx of the whole walk. Screenshots:
// filenames-<pass>-<n>-<what>.png in walk49's OUT. LOOK at them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AR = JSON.parse(readFileSync(new URL('../../public/locales/ar.json', import.meta.url), 'utf8'));
const PASSES = [[1280, 'en'], [390, 'en'], [390, 'ar']];
const tag = (w, l) => `${w}${l === 'ar' ? 'ar' : ''}`;
const E2E_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Write CBZs into the instance's library: `files` maps a file name to its page count. Pages are seed.py's page-shaped
 * PNGs (its `bands`), every one different -- the same page in three chapters of one series is a credit page to the
 * junk-page skipper, which would hide it. `genre` writes a ComicInfo.xml naming it, as a tagger would.
 */
export function writeShelf(lib, folder, files, genre = null) {
  execFileSync('python3', ['-c', String.raw`
import json, os, sys, zipfile
sys.path.insert(0, sys.argv[1])
import seed
root, folder, files, genre = sys.argv[2], sys.argv[3], json.loads(sys.argv[4]), sys.argv[5]
d = os.path.join(root, folder)
os.makedirs(d, exist_ok=True)
n = sum(ord(c) for c in folder)
for name, pages in files.items():
    with zipfile.ZipFile(os.path.join(d, name), 'w') as z:
        if genre:
            z.writestr('ComicInfo.xml', '<?xml version="1.0" encoding="utf-8"?><ComicInfo><Genre>%s</Genre></ComicInfo>' % genre)
        for i in range(pages):
            n += 1
            z.writestr('%03d.png' % (i + 1), seed.bands(240, 340, n))
`, E2E_DIR, lib, folder, JSON.stringify(files), genre ?? '']);
}

/** The walk's API session, the page's language and the little each phase shares (as librariesWalk.mjs's kit). */
export function kit({ page, go, check, base, token }) {
  const call = async (path, o = {}) => {
    const r = await fetch(base + path, {
      method: o.method ?? (o.json ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, ...(o.json ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) },
      body: o.json ? JSON.stringify(o.json) : undefined,
    });
    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    if (r.status >= 400 && !o.allow?.includes(r.status)) throw new Error(`${o.method ?? (o.json ? 'POST' : 'GET')} ${path} -> ${r.status} ${raw.slice(0, 200)}`);
    return o.status ? { status: r.status, body } : body;
  };
  let lang = 'en';
  const say = (key, vars = {}) => {
    const s = lang === 'ar' ? AR[key] : key;
    if (typeof s !== 'string') { check(`ar.json has "${key}"`, false); return '\u0000'; }
    return Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), s);
  };
  const setLang = async (l) => {
    lang = l;
    await call('/api/settings', { method: 'PUT', json: { lang: l } });
    await page.evaluate((x) => localStorage.setItem('uchiyomi.lang', x), l);
  };
  const visit = async (path, wait = 3000) => {
    await go(path, wait);
    await page.evaluate(() => document.querySelector('[data-health-banner] button')?.click());
    if (await page.$('input[type=password]')) throw new Error(`${path} opened on the sign-in page`);
  };
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const seriesNamed = async (name) => ((await call('/api/series/search', { json: { query: '', size: 100 } })).content ?? []).find((s) => s.name === name);
  /** Scan library now, as Admin -> Tasks presses it: no once-a-minute rule, and it answers when the scan is done. */
  const scan = () => call('/api/admin/library/scan', { json: {} });
  /** The labels of the chapter rows on the series page, top to bottom. */
  const rowLabels = () => page.evaluate(() => [...document.querySelectorAll('[id^="ch-"] p.truncate')]
    .map((p) => p.childNodes[0]?.textContent?.trim() ?? ''));
  /** The reader's chapter sheet, opened from its top bar (the bar shows on a tap when it has hidden itself). */
  const readerChapters = async (label) => {
    const open = () => page.evaluate((l) => { const b = document.querySelector(`button[aria-label="${l}"]`); b?.click(); return !!b; }, label);
    if (!(await open())) {
      await page.mouse.click(page.viewport().width / 2, page.viewport().height / 2);
      await new Promise((r) => setTimeout(r, 700));
      await open();
    }
    await new Promise((r) => setTimeout(r, 800));
    return page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button span.truncate')].map((s) => s.textContent?.trim() ?? ''));
  };
  return { call, say, setLang, visit, noSideScroll, seriesNamed, scan, rowLabels, readerChapters, lang: () => lang };
}

/** Each pass's own copy of the folder, and so its own series. */
const SERIES = (t) => `Kedryn Shelf ${t}`;
/** Each file, its pages, and what rule 2 reads it as: [number, end of its range or null]. */
const FILES = {
  'Batman #12 (1987).cbz': [3, 12, null],
  'Vol 3 Chapter 12.cbz': [3, 12, null],
  'Watchmen (1986).cbz': [3, 0, null],
  'Batman 01-07.cbz': [4, 1, 7],
  'Chapter 12 - Episode #5.cbz': [3, 12, null],
};
const stem = (f) => f.replace(/\.cbz$/, '');

export async function filenamesWalk(ctx) {
  const { page, check, waitFor, sleep, lib } = ctx;
  // A beat before each picture: a sheet eases into place.
  const shot = async (name) => { await sleep(700); await ctx.shot(name); };
  const { call, say, setLang, visit, noSideScroll, seriesNamed, scan, rowLabels, readerChapters, lang } = kit(ctx);
  if (!lib) { check('filenames: LIB names the instance\'s library folder (up.sh prints it with KEEP=1)', false); return; }
  try {
    console.log('\n  filenames: the folders');
    for (const [w, l] of PASSES) {
      writeShelf(lib, `Hand Collected/${SERIES(tag(w, l))}`, Object.fromEntries(Object.entries(FILES).map(([f, [pages]]) => [f, pages])));
    }
    const scanned = await scan();
    check('filenames: Scan library now ran', typeof scanned?.books === 'number', JSON.stringify(scanned));
    // Mihon, as a reader's phone reads it: a key of its own (Settings -> API tokens).
    const { token: apiKey } = await call('/api/tokens', { json: { name: 'filenames walk', scopes: ['read'] } });

    for (const [w, l] of PASSES) {
      const t = tag(w, l);
      console.log(`\n  filenames @${w}${l === 'ar' ? ' ar' : ''}`);
      const s = await waitFor(() => seriesNamed(SERIES(t)), 15_000, 500);
      check(`filenames @${t}: the folder is a series, ${SERIES(t)}`, !!s);
      if (!s) continue;
      /** Every file of the series as the API lists it: name -> [number, numberEnd, metadata.number, id]. */
      const files = async () => Object.fromEntries(((await call(`/api/series/${s.id}/books?size=100`)).content ?? [])
        .map((b) => [b.name, [b.number, b.numberEnd ?? null, b.metadata?.number, b.id]]));
      const first = await files();
      for (const [f, [, n, end]] of Object.entries(FILES)) {
        const got = first[stem(f)];
        check(`filenames @${t}: ${f} is ${end == null ? `chapter ${n}` : `chapters ${n} to ${end}`}`,
          !!got && got[0] === n && got[1] === end && got[2] === (end == null ? String(n) : `${n}–${end}`), JSON.stringify(got));
      }
      const id = (f) => first[stem(f)]?.[3];
      const mihon = () => call(`/api/v2/series/${s.id}/read-progress/tachiyomi`, { headers: { 'x-api-key': apiKey } });
      if (l !== lang()) await setLang(l);
      await page.setViewport({ width: w, height: w < 1024 ? 844 : 900 });

      // 1. The series page: each number, the range as one row, in order.
      await visit(`/series/?id=${s.id}`, 3500);
      const chapterLabel = (n) => say('Ch. {n}', { n });
      const want = [chapterLabel('0'), chapterLabel('1–7'), chapterLabel('12'), chapterLabel('12'), chapterLabel('12')];
      const rows = await waitFor(async () => { const r = await rowLabels(); return r.length >= 5 ? r : null; }, 15_000, 400) ?? await rowLabels();
      const numberOf = (label) => parseFloat(label.match(/\d+(?:\.\d+)?/)?.[0] ?? 'NaN');
      const asc = [...rows].sort((a, b) => numberOf(a) - numberOf(b));
      check(`filenames @${t}: the series page says Ch. 0, Ch. 1–7 and Ch. 12 three times`,
        JSON.stringify(asc) === JSON.stringify(want) && (JSON.stringify(rows) === JSON.stringify(want) || JSON.stringify(rows) === JSON.stringify([...want].reverse())),
        JSON.stringify(rows));
      check(`filenames @${t}: no sideways scroll`, await noSideScroll());
      await page.evaluate(() => document.getElementById('ch-0')?.scrollIntoView({ block: 'center' }));
      await shot(`filenames-${t}-1-series`);

      // 2. Health: the gap is 8 to 11, nothing the range holds.
      const gaps = (await call('/api/admin/health')).checks.find((c) => c.id === 'chapter-gaps');
      const item = gaps?.items?.find((i) => i.seriesId === s.id);
      check(`filenames @${t}: Health's Chapter gaps names ${SERIES(t)} for 8 to 11 alone, never 2 to 6`,
        JSON.stringify(item?.numbers) === JSON.stringify([8, 9, 10, 11]), JSON.stringify(item && { numbers: item.numbers, detail: item.detail }));
      await visit('/admin/?tab=Health', 4000);
      // The cards open on a press (app/admin/page.tsx): the first button inside the card.
      await page.evaluate(() => document.querySelector('[data-health-check="chapter-gaps"] button')?.click());
      const row = await waitFor(() => page.evaluate((sid) => {
        const r = document.querySelector(`[data-health-check="chapter-gaps"] [data-health-item="series:${sid}"]`);
        if (!r) return null;
        r.scrollIntoView({ block: 'center' });
        return r.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      }, s.id), 15_000, 500);
      check(`filenames @${t}: ...and the Health page shows it so`, !!row && row.includes('8-11') && !/(^|[^\d])[1-7][-–]\d/.test(row), String(row));
      await shot(`filenames-${t}-2-health`);

      // 3. Reading: from the year-only file's first page down through the range, a screen at a time, stopping once the
      // range is finished -- before the first Ch. 12 is.
      await visit(`/reader/?book=${encodeURIComponent(id('Watchmen (1986).cbz'))}`, 3500);
      const doneOf = async (f) => (await call(`/api/books/${id(f)}`)).readProgress?.completed === true;
      let steps = 0;
      while (steps < 60 && !(await doneOf('Batman 01-07.cbz'))) {
        await page.evaluate(() => {
          // The reader's own scroller: the tallest element that scrolls.
          const el = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 10
            && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
          (el ?? document.scrollingElement)?.scrollBy(0, Math.round(innerHeight * 0.6));
        });
        await sleep(450);
        steps++;
      }
      for (const f of ['Watchmen (1986).cbz', 'Batman 01-07.cbz']) {
        check(`filenames @${t}: reading on past ${f} marks it read`, await waitFor(async () => ((await doneOf(f)) ? true : null), 8000, 400) === true,
          `${steps} screens scrolled`);
      }
      const chapters = await readerChapters(say('Chapters'));
      check(`filenames @${t}: the reader's chapter list says Ch. 1–7 too`, chapters.includes(chapterLabel('1–7')) && chapters.includes(chapterLabel('0')), JSON.stringify(chapters));
      await shot(`filenames-${t}-3-reader`);
      await page.keyboard.press('Escape');
      const run = await mihon();
      check(`filenames @${t}: Mihon's read-up-to is 7, the range's end, and the series runs to 12`,
        run?.lastReadContinuousNumberSort === 7 && run?.maxNumberSort === 12, JSON.stringify(run));
      await visit(`/series/?id=${s.id}`, 3500);
      const read = await page.evaluate(() => [...document.querySelectorAll('[id^="ch-"] p.truncate')]
        .filter((p) => p.className.includes('text-fog-500')).map((p) => p.childNodes[0]?.textContent?.trim()));
      check(`filenames @${t}: the series page shows Ch. 0 and Ch. 1–7 read, and only those`,
        JSON.stringify([...read].sort()) === JSON.stringify([chapterLabel('0'), chapterLabel('1–7')].sort()), JSON.stringify(read));

      // 4. A rescan changes nothing.
      await scan();
      const again = await files();
      check(`filenames @${t}: a rescan changes no number, no range and no id`, JSON.stringify(again) === JSON.stringify(first),
        JSON.stringify({ first, again }));
    }
  } finally {
    if (lang() !== 'en') await setLang('en').catch(() => {});
  }
}
