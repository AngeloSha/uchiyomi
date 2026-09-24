// The screenshot rig's fixtures, shared by capture.mjs (the stills) and record.mjs (the tour): made-up
// extensions and sources for the screens that are ABOUT them, and neutralNames() for the screens taken on a real
// library. Nothing here is a mockup: the real components render real response shapes, fed invented names.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: made-up extensions and sources -----------------------------------------------------------------
//
// ⚠️ No screenshot may show a real extension, site or repository name (owner, v0.45.0). The extension shots used
// to photograph the live catalogue -- perfectly legible walls of third-party site names, some of them 18+ --
// which is exactly what Uchiyomi says it does not ship; and a shot of the repository row would have shown the
// live server's repository address. So every Extensions and Providers shot is taken on a page whose
// `/api/admin/extensions/*`, `/api/sources`, `/api/admin/sources*` answers come from here: the REAL components
// rendering real response shapes (the bff's routes/admin.ts and routes/sources.ts), fed invented names, neutral
// generated icons and the example.org repository the tests use. It applies on every run, against any instance,
// so a later live run cannot put the real catalogue back. Declared in docs/SCREENSHOTS.md.
export const FIXTURE_REPO = 'https://example.org/repo/index.min.json';
// What the engine lists on a LATER visit. Right after an add it lists exactly what was pasted (FIXTURE_REPO);
// only once it restarts does it list the repo.json beside a pasted index.min.json. ⚠️ The added-state shots
// (crop-repo-added, phone-repo-added) used to show this spelling right after the add, a state no real engine
// shows -- measured on Suwayomi v2.3.2243 in the v0.45.0 review. docs/extensions.md says when it changes.
export const FIXTURE_REPO_STORED = 'https://example.org/repo/repo.json';
export const FIXTURE_EXTENSIONS = [
  ['Example Manga (EN)', 'en'], ['Example Comics', 'en'], ['Sample Reader', 'en'], ['Example Manga (ES)', 'es'],
  ['Example Manga (FR)', 'fr'], ['Demo Manga', 'en'], ['Sample Webtoons', 'ko'], ['Placeholder Stories', 'en'],
  ['Fixture Manga', 'ja'], ['Lorem Manga', 'en'], ['Ipsum Manhwa', 'en'], ['Dolor Webtoon', 'pt-BR'],
  ['Mock Manga', 'en'], ['Test Pattern Manga', 'all'], ['Demo Manhua', 'zh'], ['Placeholder Library', 'de'],
  ['Fixture Webtoons', 'en'], ['Lorem Comics', 'it'], ['Ipsum Reader', 'pt-BR'], ['Dolor Manga', 'ru'],
  ['Mock Comics', 'es'], ['Test Pattern Comics', 'en'], ['Sample Manga (ID)', 'id'], ['Sample Manga (TR)', 'tr'],
  ['Demo Library', 'fr'], ['Demo Stories', 'vi'], ['Example Anthology', 'en'], ['Example Magazine', 'ja'],
  ['Placeholder Manhwa', 'ko'], ['Fixture Stories', 'en'], ['Lorem Webtoon', 'th'], ['Ipsum Library', 'ar'],
  ['Dolor Comics', 'pl'], ['Mock Reader', 'en'], ['Sample Serials', 'en'], ['Demo Serials', 'de'],
  // 36 more, so the site's three icon strips (ext-strip-*) are full: 24 tiles fill a 2400px strip.
  ...Array.from({ length: 36 }, (_, i) => [`Sample Source ${String(i + 1).padStart(2, '0')}`, ['en', 'es', 'fr', 'de', 'ja', 'pt-BR'][i % 6]]),
].map(([name, lang], i) => ({
  pkgName: `org.example.fixture.${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
  name, lang, versionName: `1.${4 + (i % 3)}.${(i * 7) % 23}`,
  iconUrl: `/img/extensions/icon/fixture-${i}.svg`,
  installed: i < 3, hasUpdate: i === 1, obsolete: false, nsfw: false,
}));

/** A neutral icon: a gradient tile and a plain shape. No letters -- a letter is the start of a logo. */
export function fixtureIcon(i) {
  const hues = [262, 292, 222, 196, 330, 170, 24, 48, 310, 240, 210, 280];
  const h = hues[i % hues.length];
  const shapes = [
    '<circle cx="48" cy="48" r="20" fill="#fff" fill-opacity=".9"/>',
    '<path d="M48 26 70 66H26z" fill="#fff" fill-opacity=".9"/>',
    '<rect x="30" y="30" width="36" height="36" rx="6" fill="#fff" fill-opacity=".9"/>',
    '<path d="M48 24 72 48 48 72 24 48z" fill="#fff" fill-opacity=".9"/>',
    '<circle cx="48" cy="48" r="19" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="9"/>',
    '<g fill="#fff" fill-opacity=".9"><rect x="28" y="30" width="40" height="8" rx="4"/><rect x="28" y="44" width="40" height="8" rx="4"/><rect x="28" y="58" width="26" height="8" rx="4"/></g>',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 70% 58%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360} 65% 38%)"/></linearGradient></defs><rect width="96" height="96" rx="22" fill="url(#g)"/>${shapes[Math.floor(i / hues.length + i) % shapes.length]}</svg>`;
}

/**
 * The extension routes, as the bff answers them. `state.repos` empty is a first visit (the row opens by itself,
 * the catalogue is empty); an add takes a moment (the row says "Checking…") and then answers what the route
 * answers for a repository that yielded extensions.
 */
export function extensionFixture(state) {
  const cat = () => (state.repos.length ? FIXTURE_EXTENSIONS : []);
  const langs = () => [...new Set(cat().map((e) => e.lang))];
  return async (url, req) => {
    const path = url.pathname;
    if (path.startsWith('/img/extensions/icon/fixture-')) {
      return { contentType: 'image/svg+xml', body: fixtureIcon(Number(path.match(/fixture-(\d+)/)?.[1] || 0)) };
    }
    if (!path.startsWith('/api/admin/extensions/')) return null;
    const on = cat().filter((e) => e.installed).length * 2;
    const route = path.slice('/api/admin/extensions/'.length);
    if (route === 'status') {
      return { json: { configured: true, reachable: true, version: 'v2.3.2243', enabled: on, known: on, registered: on, skipped: 0, cap: 25, hiddenLangs: [] } };
    }
    if (route === 'repos' && req.method() === 'POST') {
      await sleep(1800);
      state.repos = [FIXTURE_REPO]; // the running engine lists the address as it was given (see FIXTURE_REPO_STORED)
      return { json: { ok: true, url: FIXTURE_REPO, corrected: false, added: FIXTURE_EXTENSIONS.length, total: FIXTURE_EXTENSIONS.length } };
    }
    if (route === 'repos') return { json: { content: state.repos } };
    if (route === 'sources') {
      return { json: { langs: langs().map((l) => ({ lang: l, sources: cat().filter((e) => e.lang === l).length, enabled: cat().filter((e) => e.lang === l && e.installed).length, used: 0, hidden: false })) } };
    }
    if (route.startsWith('catalog')) {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const lang = url.searchParams.get('lang') || '';
      const only = url.searchParams.get('installed') === 'true';
      const content = cat().filter((e) => (!q || e.name.toLowerCase().includes(q)) && (!lang || e.lang === lang) && (!only || e.installed));
      return { json: { content, total: cat().length, matched: content.length, shown: content.length, installed: cat().filter((e) => e.installed).length, updatable: cat().filter((e) => e.hasUpdate).length, hiddenAdult: 0, langs: langs() } };
    }
    if (route === 'refresh') return { json: { count: cat().length } };
    return { status: 404, json: { error: 'not_in_fixture' } };
  };
}

/** The Providers tab's source lists: MangaDex, two sites added by URL, and one extension in three languages. */
export const FIXTURE_SOURCES = [
  { id: 'mangadex', name: 'MangaDex', lang: 'en', extension: null },
  { id: 'custom:example-manga', name: 'Example Manga', lang: 'en', extension: null },
  { id: 'custom:sample-comics', name: 'Sample Comics', lang: 'en', extension: null },
  { id: 'sw:1001', name: 'Example Manga (EN)', lang: 'en', extension: { pkgName: 'org.example.fixture.examplemanga', name: 'Example Manga' } },
  { id: 'sw:1002', name: 'Example Manga (ES)', lang: 'es', extension: { pkgName: 'org.example.fixture.examplemanga', name: 'Example Manga' } },
  { id: 'sw:1003', name: 'Example Manga (FR)', lang: 'fr', extension: { pkgName: 'org.example.fixture.examplemanga', name: 'Example Manga' } },
  { id: 'sw:1004', name: 'Example Comics', lang: 'en', extension: { pkgName: 'org.example.fixture.examplecomics', name: 'Example Comics' } },
].map((s) => ({ latest: true, popular: true, used: 0, status: 'ok', blockedUntil: null, note: null, ...s }));
export function sourcesFixture() {
  return async (url) => {
    if (url.pathname === '/api/sources') return { json: { hiddenAdult: 0, content: FIXTURE_SOURCES } };
    if (url.pathname === '/api/admin/sources') return { json: { content: [] } };
    if (url.pathname === '/api/admin/sources/custom') {
      return { json: { content: [
        { id: 'custom:example-manga', name: 'Example Manga', engine: 'madara', base: 'https://manga.example.com' },
        { id: 'custom:sample-comics', name: 'Sample Comics', engine: 'mangathemesia', base: 'https://comics.example.org' },
      ] } };
    }
    return null;
  };
}

/** Answer from the first fixture that knows the request; everything else goes to the real server. */
export async function fixturePage(ctx, profile, fixtures) {
  const p = await ctx.newPage();
  await p.setViewport(profile);
  await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await p.setRequestInterception(true);
  p.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    let url;
    try { url = new URL(req.url()); } catch { return req.continue(); }
    for (const f of fixtures) {
      const r = await f(url, req);
      if (!r) continue;
      return req.respond({
        status: r.status || 200,
        contentType: r.contentType || 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: r.body ?? JSON.stringify(r.json),
      });
    }
    return req.continue();
  });
  return p;
}

// ---- neutral names on a REAL library ----------------------------------------------------------------------------
//
// The fixtures above replace whole screens. The library shots and the tour cannot be replaced: a real library
// (covers, pages, titles) is their point. But a real library names where its chapters come from -- the series
// page's supply line read "Aqua Manga · Translated by Fuuscans, KappaBeast (+2)", legible at 1280 px in the
// README's tour, the landing page's video and series.webp, after the owner had ruled that no screenshot names a
// third-party site, group or repository (V2 review, v0.45.0). So a page shot on a real library gets
// neutralNames():
//   * every source and translation-group name the app's own API answers carry -- collected as they arrive (any
//     `sourceName`, `scanlator` or `groups`, a `name` under `sources`/`providers`/`groups`, /api/sources) -- is
//     shown as a made-up one (Example Manga, Example Scans...) in every text node and in title / aria-label /
//     alt, as React draws them (a MutationObserver), and from the first frame of every later page load;
//   * a source's or an extension's icon (a site's logo) is answered with a neutral generated tile.
// MangaDex stays: it is the built-in source every guide names. ⚠️ Silent by design, like the rest of this rig: a
// name that reaches the screen by a field not listed here is NOT rewritten. Look at the output.
export const NEUTRAL_SOURCE_NAMES = ['Example Manga', 'Sample Comics', 'Demo Reader', 'Placeholder Manga', 'Fixture Comics', 'Lorem Manga', 'Ipsum Webtoons', 'Dolor Reader'];
export const NEUTRAL_GROUP_NAMES = ['Example Scans', 'Sample Translations', 'Demo Group', 'Placeholder Team', 'Fixture Scans', 'Lorem Translations', 'Ipsum Group', 'Dolor Team'];
const KEEP = /^mangadex$/i;

/**
 * The source and group names one API answer carries, as [kind, name] pairs (pure: capture.mjs, record.mjs and a
 * test read it the same way).
 * @param {string} path the request's pathname @param {unknown} j its JSON
 * @returns {Array<['source' | 'group', string]>}
 */
export function namesIn(path, j) {
  /** @type {Array<['source' | 'group', string]>} */
  const out = [];
  const add = (kind, name, id = '') => {
    if (typeof name !== 'string' || name.trim().length < 2) return;
    if (kind === 'source' && (KEEP.test(name.trim()) || KEEP.test(String(id || '')))) return;
    out.push([kind, name.trim()]);
  };
  const sourceList = /^\/api\/(admin\/)?sources(\/custom)?$/.test(path);
  // A member's view of a series' groups is `{ content: [{ name }] }` (an admin's is `{ groups: [...] }`).
  const groupList = /^\/api\/series\/[^/]+\/groups$/.test(path);
  const walk = (v, key, depth) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string') { if (key === 'groups') add('group', x); }
        else walk(x, key, depth + 1);
      }
      return;
    }
    if (typeof v.name === 'string') {
      if (key === 'sources' || key === 'providers' || (key === 'content' && sourceList)) add('source', v.name, v.sourceId || v.id || v.source);
      else if (key === 'groups' || (key === 'content' && groupList)) add('group', v.name);
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'sourceName') add('source', x, v.sourceId || v.source);
      else if (k === 'scanlator') add('group', x);
      else if (x && typeof x === 'object') walk(x, k, depth + 1);
    }
  };
  walk(j, '', 0);
  return out;
}

/**
 * Show made-up names for every real source and group `page` meets from now on (see above). Install BEFORE the
 * page's first navigation to the screens that need it. `fixtures`: request handlers answered first, as in
 * fixturePage (record.mjs's one continuous page needs the extension fixture too).
 * @param {import('puppeteer').Page} page
 * @param {{ fixtures?: Array<(url: URL, req: any) => Promise<any>> }} [o]
 */
export async function neutralNames(page, { fixtures = [] } = {}) {
  /** @type {Map<string, string>} real -> neutral */
  const map = new Map();
  const used = { source: 0, group: 0 };
  const pick = (kind) => {
    const list = kind === 'source' ? NEUTRAL_SOURCE_NAMES : NEUTRAL_GROUP_NAMES;
    const i = used[kind]++;
    return i < list.length ? list[i] : `${list[i % list.length]} ${Math.floor(i / list.length) + 1}`;
  };
  // In the page: the replacer. Longest names first, whole words only (a group called "Scan" must not eat "Scans").
  await page.evaluateOnNewDocument(() => {
    const map = new Map();
    let re = null;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fixText = (s) => (re && s && re.test(s) ? (re.lastIndex = 0, s.replace(re, (m) => map.get(m) ?? m)) : (re && (re.lastIndex = 0), s));
    const fix = (root) => {
      if (!re || !root) return;
      if (root.nodeType === 3) { const t = fixText(root.nodeValue); if (t !== root.nodeValue) root.nodeValue = t; return; }
      if (root.nodeType !== 1 && root.nodeType !== 9) return;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = w.currentNode; n; n = w.nextNode()) {
        if (n.nodeType === 3) { const t = fixText(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; continue; }
        for (const a of ['title', 'aria-label', 'alt']) {
          const v = n.getAttribute?.(a);
          if (v) { const t = fixText(v); if (t !== v) n.setAttribute(a, t); }
        }
      }
    };
    window.__uchiNeutral = (pairs) => {
      for (const [a, b] of pairs) map.set(a, b);
      const keys = [...map.keys()].sort((x, y) => y.length - x.length).map(esc);
      re = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${keys.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
      fix(document.documentElement);
    };
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') fix(m.target);
        else if (m.type === 'attributes') fix(m.target);
        else for (const n of m.addedNodes) fix(n);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'alt'] });
  });
  // In node: collect names from every API answer, and hand the new ones to this document and every later one.
  page.on('response', async (res) => {
    let u;
    try { u = new URL(res.url()); } catch { return; }
    if (!u.pathname.startsWith('/api/') || !/json/.test(res.headers()['content-type'] || '')) return;
    const j = await res.json().catch(() => null);
    const fresh = [];
    for (const [kind, name] of namesIn(u.pathname, j)) {
      if (map.has(name) || [...map.values()].includes(name)) continue;
      const n = pick(kind);
      map.set(name, n);
      fresh.push([name, n]);
    }
    if (!fresh.length) return;
    await page.evaluateOnNewDocument((p) => window.__uchiNeutral?.(p), fresh).catch(() => {});
    await page.evaluate((p) => window.__uchiNeutral?.(p), fresh).catch(() => {});
  });
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    let url;
    try { url = new URL(req.url()); } catch { return req.continue(); }
    for (const f of fixtures) {
      const r = await f(url, req);
      if (!r) continue;
      return req.respond({ status: r.status || 200, contentType: r.contentType || 'application/json', headers: { 'cache-control': 'no-store' }, body: r.body ?? JSON.stringify(r.json) });
    }
    const icon = /^\/img\/(sources|extensions)\/icon\/(.+)$/.exec(url.pathname);
    if (icon && !KEEP.test(decodeURIComponent(icon[2]))) {
      let h = 0;
      for (const c of icon[2]) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return req.respond({ status: 200, contentType: 'image/svg+xml', headers: { 'cache-control': 'no-store' }, body: fixtureIcon(h % 60) });
    }
    return req.continue();
  });
  return { names: map };
}

/**
 * Meet every source name before the screens that show one: the Providers tab asks for all of them (/api/sources
 * and the sites added by URL), so a name that later reaches the screen inside a sentence -- a Health row, a
 * search's "via" line -- is already known to neutralNames(). ⚠️ For the tour this runs before the recording
 * starts: a name learned mid-recording is rewritten a moment AFTER it is drawn, and a frame or two may show it.
 * @param {import('puppeteer').Page} page signed in, with neutralNames() installed @param {string} base
 */
export async function meetNames(page, base) {
  await page.goto(`${base}/admin/?tab=Providers`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 20000 }).catch(() => {});
}
