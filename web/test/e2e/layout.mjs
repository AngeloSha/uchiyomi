// Does the app actually use the display it is given, and does it fit the small one?
//
// Two failure modes, both invisible to every other test in this repo and both reported by a person rather
// than by CI:
//
//   1. DEAD WIDTH. A page capped at `lg:max-w-3xl` renders a 768px column in the middle of a 1920px window
//      with 576px of black on either side. Nothing errors, nothing overflows, and the page is 60% empty.
//   2. OVERFLOW. Something 3px too wide at 390px makes the whole page slide sideways under a thumb.
//
// So this measures both, per page, at a phone width and two desktop widths. It needs a running instance:
// `npm run test:e2e` brings one up, or point BASE at one.
import puppeteer from 'puppeteer';

const BASE = process.env.BASE || 'http://127.0.0.1:18140';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
// The four `?tab=` entries are the v0.39.0 settings grids (three profile tabs and the admin Settings tab):
// each is a new `SETTINGS_GRID` of sections that must fill 1920 without any container capping it at
// 700-1500 px -- the "768 px ribbon" the owner reported on the old admin console -- and must not overflow
// at 390. The tab row's first panel is what a bare `/profile` or `/admin` measures, so the other tabs
// were never measured at all before this.
// Admin → Extensions since its v0.53.0 redesign: its header, Installed | Browse and their rows at every width.
const PAGES = (process.env.PAGES || '/,/library,/library/?view=downloads,/collections,/discover,/profile,/admin,/admin/import,/moments,/profile/?tab=Settings,/profile/?tab=Connections,/profile/?tab=Account,/admin/?tab=Settings,/admin/?tab=Extensions').split(',');

// How much of a wide viewport the content must actually occupy. Not 100%: a settings form SHOULD have
// margins, and prose that runs 1900px wide is unreadable. But a page using less than this is a column
// stranded in a void, which is the thing being tested for.
const MIN_FILL = Number(process.env.MIN_FILL || 0.82);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (m) => console.log(`    [ ok ] ${m}`);
const bad = (m) => { fails.push(m); console.log(`    [FAIL] ${m}`); };

const browser = await puppeteer.launch({
  headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  const inputs = await page.$$('input');
  if (!inputs.length) throw new Error('no login form');
  await inputs[0].type(USER);
  await page.type('input[type=password]', PASS);
  await page.keyboard.press('Enter');
  await sleep(4500);

  /**
   * The horizontal extent of real content.
   *
   * Deliberately ignores anything `position: fixed` (the mesh gradient is `inset: -25%` on purpose and would
   * report a perfect score on every page) and anything too short to be a layout element.
   */
  const measure = () => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.querySelector('main') || document.body;
    let min = Infinity, max = -Infinity, painted = 0;
    const over = [];

    // Only elements that actually PAINT count towards the fill. A full-width transparent wrapper is not
    // content -- measuring those is how a 768px column in a 1920px window scored 97% and the metric proved
    // nothing. So: something with a visible background, a border, an image, or its own text.
    const paints = (el, cs) => {
      if (el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'CANVAS') return true;
      const bg = cs.backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return true;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      if (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0) return true;
      // direct text, not text belonging to a descendant
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
      return false;
    };

    for (const el of main.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 12 || r.width < 12) continue;

      // Overflow is measured on EVERY laid-out element, painted or not: an invisible box that is too wide
      // still drags the page sideways.
      if (r.right > vw + 0.5 || r.left < -0.5) {
        over.push(`<${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 90)}"> [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }

      if (!paints(el, cs)) continue;
      painted++;
      // Clamped to the viewport: something bled off the edge is overflow, not fill.
      const l = Math.max(0, r.left), rr = Math.min(vw, r.right);
      if (rr - l < 12) continue;
      if (l < min) min = l;
      if (rr > max) max = rr;
    }
    // Where the content edge actually is, and how wide the usable column is. `.shell` pads rather than
    // margins, so the border box is the viewport and the number that matters is inside it.
    const cs = getComputedStyle(main);
    const padStart = parseFloat(cs.paddingInlineStart) || 0;
    const padEnd = parseFloat(cs.paddingInlineEnd) || 0;
    const box = main.getBoundingClientRect();

    // A page root, hero or panel that has quietly put a cap back on. Narrow caps are legitimate (a form
    // field, a paragraph); a cap in this band on a box holding real structure is the exact bug that made
    // /profile a 768px ribbon in a 1920px window, and it is invisible until someone measures it.
    const caps = [];
    for (const el of main.querySelectorAll('*')) {
      const m = parseFloat(getComputedStyle(el).maxWidth);
      if (!Number.isFinite(m) || m < 700 || m > 1500) continue;
      if (el.childElementCount < 3) continue;
      caps.push(`<${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 70)}"> max-width:${Math.round(m)}px`);
    }

    return {
      vw,
      painted,
      scrollW: document.documentElement.scrollWidth,
      fill: max > min ? (max - min) / vw : 0,
      over: over.slice(0, 4),
      gutter: Math.round(box.left + padStart),
      content: Math.round(box.width - padStart - padEnd),
      caps: caps.slice(0, 3),
    };
  });

  // The desktop header (components/TopNav.tsx), which is outside <main> and so outside everything below: at
  // the two narrowest desktop widths, in the languages with the longest nav labels, nothing may run past the
  // window and no round button may be squeezed. v0.49.0's downloads button pushed Russian 213 px over at 1024,
  // and every round button became a 21 px oval. The language is this browser's own (localStorage), put back
  // after.
  const HEADER_LANGS = (process.env.HEADER_LANGS || 'en,de,ru').split(',');
  for (const w of [1024, 1280]) {
    await page.setViewport({ width: w, height: 800 });
    for (const lang of HEADER_LANGS) {
      await page.evaluate((c) => localStorage.setItem('uchiyomi.lang', c), lang);
      await page.goto(BASE + '/library', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(1800);
      const h = await page.evaluate(() => {
        const row = document.querySelector('header .shell');
        if (!row) return null;
        const vw = document.documentElement.clientWidth;
        const squeezed = [...row.querySelectorAll('.h-10.w-10')].map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && (r.width < 39.5 || r.height < 39.5)).map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`);
        const past = [...row.querySelectorAll('*')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.right > vw + 0.5).length;
        // The search gives way down to its icon, never to a sliver of its word: a label that shows is at least 2em
        // wide, and nothing that shows inside the button is cut by its edge (ru at 1024 and 1280 px, v0.49.0).
        const label = row.querySelector('[data-search-label]');
        const search = label?.closest('button');
        const shows = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
        let sliver = '';
        if (search && shows(label)) {
          const w = label.getBoundingClientRect().width;
          if (w < 2 * parseFloat(getComputedStyle(label).fontSize)) sliver = `label ${Math.round(w)}px`;
        }
        if (search && !sliver) {
          const box = search.getBoundingClientRect();
          const cut = [...search.children].filter(shows).map((el) => el.getBoundingClientRect()).find((r) => r.left < box.left - 0.5 || r.right > box.right + 0.5);
          if (cut) sliver = `a part cut at ${Math.round(cut.left)}-${Math.round(cut.right)} of ${Math.round(box.left)}-${Math.round(box.right)}`;
        }
        return { over: row.scrollWidth - row.clientWidth, page: document.documentElement.scrollWidth - vw, squeezed, past, sliver, lang: document.documentElement.lang };
      });
      if (!h) { bad(`header @${w} ${lang}: no header to measure`); continue; }
      if (h.lang !== lang) bad(`header @${w} ${lang}: the page is in "${h.lang}" -- the language did not switch`);
      else if (h.over > 0 || h.page > 0 || h.past) bad(`header @${w} ${lang}: runs ${Math.max(h.over, h.page)}px past the window (${h.past} element(s) beyond it)`);
      else if (h.squeezed.length) bad(`header @${w} ${lang}: round buttons squeezed to ${h.squeezed.join(', ')}`);
      else if (h.sliver) bad(`header @${w} ${lang}: the search shows a sliver (${h.sliver})`);
      else ok(`header @${w} ${lang}: fits, every round button 40 px, the search whole or its icon alone`);
    }
  }
  await page.evaluate(() => localStorage.removeItem('uchiyomi.lang'));

  for (const w of [2560, 1920, 1280, 1024, 390]) {
    const mobile = w < 700;
    console.log(`\n  ${w}px`);
    await page.setViewport({ width: w, height: mobile ? 844 : 1000, isMobile: mobile, hasTouch: mobile });
    for (const path of PAGES) {
      await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(2400);
      const m = await measure();

      // The home hero is the app's one full-bleed element, and "full bleed" is the whole point of it: it
      // bleeds out of the shell's padding, so anything that centres the shell strands it in black bars.
      // A canvas cap did exactly that and left 504px down each side of a 3440px display.
      if (path === '/' && !mobile) {
        const hero = await page.evaluate(() => {
          const el = document.querySelector('main [class*="min-h-[420px]"], main [class*="min-h-[440px]"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), vw: document.documentElement.clientWidth };
        });
        if (!hero) bad(`/ @${w}: could not find the hero to measure`);
        else if (hero.left > 1 || hero.right < hero.vw - 1)
          bad(`/ @${w}: the hero spans ${hero.left}..${hero.right} of ${hero.vw} — ${hero.left}px of black down each side`);
        else ok(`/ @${w}: the hero reaches both edges`);
      }

      if (m.scrollW > m.vw + 1) {
        bad(`${path} @${w}: ${m.scrollW - m.vw}px of horizontal overflow${m.over.length ? ` — ${m.over[0]}` : ''}`);
        for (const o of m.over.slice(1)) console.log(`             also ${o}`);
      } else ok(`${path} @${w}: no overflow`);

      if (!mobile) {
        // The shell owns the geometry now, so every page is the same width at a given viewport. It used to
        // be owned by ~98 individual elements and pages disagreed with each other by hundreds of pixels.
        // Viewport minus two 2rem gutters, at every width: the shell is deliberately uncapped, because a cap
        // centres it and the full-bleed home hero then stops reaching the edges of a large display.
        const expect = w - 64;
        Math.abs(m.content - expect) <= 1
          ? ok(`${path} @${w}: ${m.content}px of usable width`)
          : bad(`${path} @${w}: ${m.content}px of usable width, expected ${expect} — this page is not on the shell`);

        if (m.caps.length) bad(`${path} @${w}: a container has a page-level cap again — ${m.caps[0]}`);

        const pct = Math.round(m.fill * 100);
        // A page whose entire content is a search box and a hint is ALLOWED to be narrow -- stretching one
        // input across 1920px would be the worse bug. So the fill rule only applies once there is enough on
        // screen for the width to be a layout decision rather than an empty state.
        if (m.painted < 12) ok(`${path} @${w}: too little on screen to judge width (${m.painted} painted)`);
        else if (pct < MIN_FILL * 100) bad(`${path} @${w}: content spans only ${pct}% of the window — a column stranded in a void`);
        else ok(`${path} @${w}: content spans ${pct}% of the window`);

        // ⚠️ THE FILL METRIC ABOVE CANNOT SEE THIS ONE. `fill` is the span between the leftmost and
        // rightmost painted things, so putting a filter sidebar on the left and the grid on the right
        // scores just as well as a full-width grid -- and would still score 95% with the grid squeezed into
        // a third of the window. The sidebar is a fixed `lg:w-56 xl:w-64`, so what has to be watched is
        // what is LEFT for the covers.
        if (path === '/library') {
          const g = await page.evaluate(() => {
            const el = document.querySelector('[data-library-grid]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              w: Math.round(r.width),
              cols: getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
              vw: document.documentElement.clientWidth,
            };
          });
          if (!g) bad(`/library @${w}: no [data-library-grid] — the sidebar split lost its measuring hook`);
          else if (g.w / g.vw < 0.6) bad(`/library @${w}: the filter sidebar left the grid only ${Math.round(g.w / g.vw * 100)}% of the window`);
          else if (g.cols < 5) bad(`/library @${w}: the grid dropped to ${g.cols} columns beside the sidebar`);
          else ok(`/library @${w}: grid is ${g.w}px / ${g.cols} columns beside the sidebar`);
        }
      }
    }
  }
} finally {
  await browser.close();
}

console.log('\n' + '='.repeat(70));
console.log(`${fails.length} layout failure(s)`);
for (const f of fails) console.log(`  ${f}`);
process.exit(fails.length ? 1 : 0);
