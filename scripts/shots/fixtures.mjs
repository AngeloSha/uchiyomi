// The screenshot rig's fixtures, shared by capture.mjs (the stills) and record.mjs (the tour): made-up
// extensions and sources for the screens that are ABOUT them, and neutralNames() for the screens taken on a real
// library. Nothing here is a mockup: the real components render real response shapes, fed invented names.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: made-up extensions and sources -----------------------------------------------------------------
//
// ⚠️ No screenshot may show a real extension, site or repository name (owner, v0.45.0). The extension shots used
// to photograph the live catalogue -- perfectly legible walls of third-party site names, some of them 18+ --
// which is exactly what Uchiyomi says it does not ship; and a shot of the repository row would have shown the
// live server's repository address. So every shot of Admin → Sources (Extensions and Providers until v0.54.0) is
// taken on a page whose `/api/admin/extensions/*`, `/api/sources`, `/api/admin/sources*` answers come from here --
// the sources overview too, which names every source: the REAL components
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
  // The installed extensions' sources, one per language, all on (v0.53.0's Installed rows and sheets read them).
  const sources = () => cat().filter((e) => e.installed).flatMap((e, i) => (e.lang === 'all' ? ['en', 'es', 'fr'] : [e.lang]).map((l, j) => ({
    id: String(9100 + i * 10 + j), name: `${e.name} (${l.toUpperCase()})`, lang: l, nsfw: false, enabled: true, supportsLatest: true, pkgName: e.pkgName, used: 0,
  })));
  return async (url, req) => {
    const path = url.pathname;
    if (path.startsWith('/img/extensions/icon/fixture-')) {
      return { contentType: 'image/svg+xml', body: fixtureIcon(Number(path.match(/fixture-(\d+)/)?.[1] || 0)) };
    }
    if (!path.startsWith('/api/admin/extensions/')) return null;
    const route = path.slice('/api/admin/extensions/'.length);
    if (route === 'status') {
      return { json: {
        configured: true, reachable: true, version: 'v2.3.2243', enabled: sources().length, known: sources().length, registered: sources().length,
        skipped: 0, cap: 25, hiddenLangs: [], solver: { supported: true, enabled: true, wiring: 'ok', connectable: true },
      } };
    }
    if (route === 'repos' && req.method() === 'POST') {
      await sleep(1800);
      state.repos = [FIXTURE_REPO]; // the running engine lists the address as it was given (see FIXTURE_REPO_STORED)
      return { json: { ok: true, url: FIXTURE_REPO, corrected: false, added: FIXTURE_EXTENSIONS.length, total: FIXTURE_EXTENSIONS.length } };
    }
    if (route === 'repos') return { json: { content: state.repos } };
    if (route === 'sources') {
      const pkg = url.searchParams.get('pkg');
      const ls = [...new Set(sources().map((s) => s.lang))];
      return { json: {
        content: sources().filter((s) => !pkg || s.pkgName === pkg), reachable: true, total: sources().length, hiddenLangs: [],
        langs: ls.map((l) => ({ lang: l, sources: sources().filter((s) => s.lang === l).length, enabled: sources().filter((s) => s.lang === l).length, used: 0, hidden: false })),
      } };
    }
    if (route.startsWith('catalog')) {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const lang = url.searchParams.get('lang') || '';
      const only = url.searchParams.get('installed') === 'true';
      const updates = url.searchParams.get('updates') === 'true';
      const matched = cat().filter((e) => (!q || e.name.toLowerCase().includes(q)) && (!lang || e.lang === lang) && (!only || e.installed) && (!updates || e.hasUpdate))
        .sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.hasUpdate) - Number(a.hasUpdate) || a.name.localeCompare(b.name));
      // A page at a time, as the route answers since v0.53.0.
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Math.min(400, Number(url.searchParams.get('limit')) || 400);
      const content = matched.slice(offset, offset + limit);
      return { json: { content, total: cat().length, matched: matched.length, shown: content.length, offset, limit, installed: cat().filter((e) => e.installed).length, updatable: cat().filter((e) => e.hasUpdate).length, hiddenAdult: 0, langs: langs() } };
    }
    if (route === 'refresh') return { json: { count: cat().length } };
    return { status: 404, json: { error: 'not_in_fixture' } };
  };
}

/** The source lists: MangaDex, two sites added by URL, and one extension in three languages (the Providers tab's). */
export const FIXTURE_SOURCES = [
  { id: 'mangadex', name: 'MangaDex', lang: 'en', extension: null },
  { id: 'custom:example-manga', name: 'Example Manga', lang: 'en', extension: null },
  { id: 'custom:sample-comics', name: 'Sample Comics', lang: 'en', extension: null },
  { id: 'sw:1001', name: 'Example Manga (EN)', lang: 'en', extension: { pkgName: 'org.example.fixture.examplemanga', name: 'Example Manga' } },
  { id: 'sw:1002', name: 'Example Manga (ES)', lang: 'es', extension: { pkgName: 'org.example.fixture.examplemanga', name: 'Example Manga' } },
  { id: 'sw:1003', name: 'Example Manga (FR)', lang: 'fr', extension: { pkgName: 'org.example.fixture.examplemanga', name: 'Example Manga' } },
  { id: 'sw:1004', name: 'Example Comics', lang: 'en', extension: { pkgName: 'org.example.fixture.examplecomics', name: 'Example Comics' } },
].map((s) => ({ latest: true, popular: true, used: 0, status: 'ok', blockedUntil: null, note: null, ...s }));
/**
 * The sources overview (GET /api/admin/sources/overview, v0.54.0) for `state` (extensionFixture's): MangaDex, the two
 * sites added by URL, and the installed fixture extensions' sources -- every one working, used by made-up numbers of
 * series, with one extension update waiting once a repository is there.
 */
export function overviewFixture(state) {
  const installed = state.repos.length ? FIXTURE_EXTENSIONS.filter((e) => e.installed) : [];
  const row = (o) => ({ lang: 'en', pkgName: null, standing: 'usable', offBy: null, state: 'ok', stage: null, cooldown: null, offline: false,
    main: 0, followed: 0, withBackup: 0, lastTestedAt: null, icon: false, address: null, ...o });
  const sources = [
    row({ id: 'custom:example-manga', name: 'Example Manga', kind: 'site', main: 42, followed: 3, address: 'https://manga.example.com' }),
    row({ id: 'mangadex', name: 'MangaDex', kind: 'mangadex', main: 18, followed: 9 }),
    ...installed.flatMap((e, i) => (e.lang === 'all' ? ['en', 'es', 'fr'] : [e.lang]).map((l, j) => row({
      // A source is its extension's name and its language, as the engine names it: "Example Manga (EN)", never "(EN) (EN)".
      id: `sw:${9100 + i * 10 + j}`, name: `${e.name.replace(/\s*\([^)]*\)$/, '')} (${l.toUpperCase()})`, kind: 'extension', lang: l, pkgName: e.pkgName, icon: true,
      main: [11, 6, 2][i] ?? 0, followed: [4, 1, 0][i] ?? 0,
    }))),
    row({ id: 'custom:sample-comics', name: 'Sample Comics', kind: 'site', followed: 2, address: 'https://comics.example.org' }),
  ];
  return { sources, attention: { replace: [], failingUnused: [], updates: installed.filter((e) => e.hasUpdate).length } };
}

export function sourcesFixture(state = { repos: [] }) {
  return async (url) => {
    if (url.pathname === '/api/sources') return { json: { hiddenAdult: 0, content: FIXTURE_SOURCES } };
    if (url.pathname === '/api/admin/sources/overview') return { json: overviewFixture(state) };
    if (url.pathname === '/api/admin/sources') return { json: { content: [] } };
    if (url.pathname === '/api/admin/sources/custom') {
      return { json: { content: [
        { id: 'custom:example-manga', name: 'Example Manga', engine: 'madara', base: 'https://manga.example.com' },
        { id: 'custom:sample-comics', name: 'Sample Comics', engine: 'mangathemesia', base: 'https://comics.example.org' },
      ] } };
    }
    // Test all, as a server with no sweep running answers it.
    if (url.pathname === '/api/admin/sources/check') return { json: { running: false, total: 0, done: 0, current: null, result: null } };
    return null;
  };
}

/**
 * ⚠️ The app's service worker answers /api/admin/* and the images with fetches of its own (web/public/sw.js), which a
 * page's request interception never sees -- so wherever one can register (https, or a localhost base) the fixtures
 * below and neutralNames() were silently skipped, and the real server's sources, names and icons reached the shot.
 * Every page here bypasses it.
 */
const noServiceWorker = (p) => p.setBypassServiceWorker(true);

/** Answer from the first fixture that knows the request; everything else goes to the real server. */
export async function fixturePage(ctx, profile, fixtures) {
  const p = await ctx.newPage();
  await noServiceWorker(p);
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
 * The people on a real server are not ours to publish (v0.60.1). Admin → Members, the profile's household board and
 * the sessions list showed the household's real names and usernames until then -- in the public repo and on the
 * marketing site. Every answer that lists people is fetched for real and handed back with sample names (the same
 * person, the same sample name, on every screen) and no avatar; roles, states and counts are kept, so the screen is the
 * real one. The capture account itself (`meId`) keeps its own. Not done as a text swap (neutralNames): real display
 * names are words like "me", which a page-wide swap would rewrite in every sentence.
 * ⚠️ Silent like the rest of the rig: a NEW route that lists people is not covered until it is added here. Look at the
 * output.
 */
/**
 * Sign in through the API as the capture account: its id (so peopleFixture leaves it its own name) and a token for the
 * calls the rig makes itself (capture.mjs seedReading). One login more than the page's; the limit is ten in five minutes.
 * @param {string} base @param {string} user @param {string} pass
 * @returns {Promise<{ accessToken: string, user: { id: string } }>}
 */
export async function apiLogin(base, user, pass) {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }),
  });
  if (!r.ok) throw new Error(`API sign-in answered ${r.status}`);
  const j = await r.json();
  if (!j?.accessToken || !j?.user?.id) throw new Error('API sign-in answered without a token or an id');
  return j;
}

/**
 * A reading life for the capture account. Without one every per-reader screen photographed a stranger (v0.60.1): no
 * progress bars on the covers, "Start reading" on every series, empty stars, no favourites, no Keep reading.
 *
 * capture.mjs and record.mjs call it only when run.sh asks (SHOT_SEED=1), which it does for the throwaway account it creates and deletes, never for
 * `--login`, which may be somebody's account. Written through the app's own API, as a reader's "Mark read" is
 * (`silent`: no reading events, so nobody's weekly board or Top 10 moves while the rig runs), and every row is the
 * account's own: run.sh's DELETE of the account removes them all (each foreign key to users is ON DELETE CASCADE).
 * The covers it reads are the Library's first screen in its default order (lib/librarySort.ts SORTS[0], no filter,
 * 18+ hidden, as the page asks), and the series the series shot shows, to different depths so the bars differ.
 */
export async function seedReading(base, token, seriesId = '') {
  const call = async (method, path, json) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    if (!r.ok) throw new Error(`seed: ${method} ${path} answered ${r.status}`);
    return r.json().catch(() => null);
  };
  const shelf = await call('POST', '/api/series/search', { page: 0, size: 18, sort: 'lastModified,desc', collapseEditions: true });
  const ids = [...new Set([seriesId, ...(shelf?.content ?? []).map((x) => x.id)].filter(Boolean))];
  const DEPTHS = [0.55, 0.3, 0.8, 0.15, 0.65, 0.4, 0.9, 0.25, 0.5, 0.7, 0.35, 0.6];
  const at = (b) => Number(b.metadata?.numberSort ?? b.number ?? 0);
  let marked = 0;
  for (const [i, id] of ids.entries()) {
    const books = ((await call('GET', `/api/series/${encodeURIComponent(id)}/books?size=2000`))?.content ?? []).sort((a, b) => at(a) - at(b));
    if (books.length < 3) continue;
    const done = Math.max(1, Math.floor(books.length * DEPTHS[i % DEPTHS.length]));
    for (const b of books.slice(0, done)) {
      await call('PUT', `/api/books/${encodeURIComponent(b.id)}/progress`, { page: Math.max(0, (b.media?.pagesCount ?? 1) - 1), completed: true, seriesId: id, silent: true });
      marked++;
    }
    // Part-way into the next one on the series shot and every third cover: "Continue · Ch. N" rather than "Next".
    if (i % 3 === 0 && books[done]) {
      await call('PUT', `/api/books/${encodeURIComponent(books[done].id)}/progress`, { page: 3, completed: false, seriesId: id, silent: true });
    }
  }
  if (seriesId) {
    await call('PUT', `/api/ratings/${encodeURIComponent(seriesId)}`, { stars: 4 });
    await call('POST', '/api/favorites', { seriesId });
  }
  console.log(`  · seeded: ${marked} chapters read across ${ids.length} series${seriesId ? ', the shot series rated and favourited' : ''}`);
}

export const SAMPLE_PEOPLE = ['Alex', 'Sam', 'Jordan', 'Robin', 'Kai', 'Riley', 'Casey', 'Taylor'];
const PEOPLE_ROUTES = new Set(['/api/admin/users', '/api/leaderboard', '/api/admin/sessions']);
/** @param {string} meId the capture account's id @returns {(url: URL, req: any) => Promise<any>} a fixture */
export function peopleFixture(meId) {
  /** @type {Map<string, string>} person id -> sample name */
  const named = new Map();
  const nameFor = (key) => {
    if (!named.has(key)) {
      const i = named.size;
      named.set(key, i < SAMPLE_PEOPLE.length ? SAMPLE_PEOPLE[i] : `${SAMPLE_PEOPLE[i % SAMPLE_PEOPLE.length]} ${Math.floor(i / SAMPLE_PEOPLE.length) + 1}`);
    }
    return named.get(key);
  };
  return async (url, req) => {
    if (!PEOPLE_ROUTES.has(url.pathname) || req.method() !== 'GET') return null;
    // Only what the app itself sends: the bearer token. Cookies and the browser's own headers stay with the browser.
    const auth = req.headers().authorization;
    const r = await fetch(url, { headers: { accept: 'application/json', ...(auth ? { authorization: auth } : {}) } });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return { status: r.status, contentType: r.headers.get('content-type') || 'text/plain', body: text }; }
    for (const row of Array.isArray(j?.content) ? j.content : []) {
      const who = String(row.user_id ?? row.userId ?? row.id ?? '');
      if (!who || who === meId) continue;
      const name = nameFor(who);
      for (const k of ['display_name', 'displayName']) if (k in row) row[k] = name;
      for (const k of ['username', 'userName']) if (k in row) row[k] = name.toLowerCase().replace(/\s+/g, '');
      if ('avatar' in row) row.avatar = null;
    }
    return { status: r.status, json: j };
  };
}

/**
 * Admin → Library on a real server: its libraries' names and folders, who may open each, and the top-level folders it
 * suggests splitting out -- which a downloader names after the sites it fetched from, and an 18+ library after one
 * (v0.60.1). The answer is fetched for real and handed back with the default library as it is, every other one named
 * from SAMPLE_LIBRARIES with a folder to match, the members as sample people, and the suggested folders as made-up
 * source names; counts, age ratings and switches are kept.
 */
export const SAMPLE_LIBRARIES = ['Family', 'Grown-ups', 'Comics', 'Webtoons', 'Classics', 'Shared'];
/** @param {string} meName the capture account's display name, kept @returns {(url: URL, req: any) => Promise<any>} */
export function librariesFixture(meName = 'Admin') {
  const people = new Map();
  const person = (n) => {
    if (n === meName) return n;
    if (!people.has(n)) people.set(n, SAMPLE_PEOPLE[people.size % SAMPLE_PEOPLE.length]);
    return people.get(n);
  };
  return async (url, req) => {
    if (url.pathname !== '/api/admin/libraries' || req.method() !== 'GET') return null;
    const auth = req.headers().authorization;
    const r = await fetch(url, { headers: { accept: 'application/json', ...(auth ? { authorization: auth } : {}) } });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return { status: r.status, contentType: r.headers.get('content-type') || 'text/plain', body: text }; }
    let named = 0;
    for (const lib of Array.isArray(j?.content) ? j.content : []) {
      if (Array.isArray(lib.members)) lib.members = lib.members.map((m) => (typeof m === 'string' ? person(m) : m));
      if (lib.id === 'lib' || !lib.path) continue; // the default library: "Library", over every root, no folder of its own
      const name = SAMPLE_LIBRARIES[named++ % SAMPLE_LIBRARIES.length];
      lib.name = name;
      lib.path = name;
      if (Array.isArray(lib.paths)) lib.paths = lib.paths.map((_, i) => (i ? `${name} ${i + 1}` : name));
    }
    if (Array.isArray(j?.candidates)) {
      j.candidates = j.candidates.map((c, i) => ({ ...c, path: NEUTRAL_SOURCE_NAMES[i % NEUTRAL_SOURCE_NAMES.length] + (i >= NEUTRAL_SOURCE_NAMES.length ? ` ${Math.floor(i / NEUTRAL_SOURCE_NAMES.length) + 1}` : '') }));
    }
    return { status: r.status, json: j };
  };
}

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
  await noServiceWorker(page);
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
 * Meet every source name before the screens that show one: Admin → Sources asks for all of them (the sources
 * overview, v0.54.0; Providers asked /api/sources and the sites added by URL), so a name that later reaches the
 * screen inside a sentence -- a Health row, a search's "via" line -- is already known to neutralNames(). ⚠️ For the
 * tour this runs before the recording starts: a name learned mid-recording is rewritten a moment AFTER it is drawn,
 * and a frame or two may show it.
 * @param {import('puppeteer').Page} page signed in, with neutralNames() installed @param {string} base
 */
export async function meetNames(page, base) {
  await page.goto(`${base}/admin/?tab=Sources`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 20000 }).catch(() => {});
}
