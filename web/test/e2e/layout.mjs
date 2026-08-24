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
const PAGES = (process.env.PAGES || '/,/library,/browse,/profile,/admin').split(',');

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

  for (const w of [2560, 1920, 1280, 390]) {
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
