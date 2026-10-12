// Browser acceptance walk for v0.61.0, lane D -- related works, the reader's Next in the story, Discover's Because you
// read, its trending manga and manhua rails, and `/discover/?q=`.
//
// Repeated Pages gets a checked AniList link (990301) and the related row the background job would store for it,
// written directly so the walk does not wait for the six-hour tick: its sequels are Mixed Formats (held, linked 990302)
// and "Repeated Pages Two", its prequel "Repeated Pages Zero"; AniList's readers recommend Mixed Formats and four works
// the library does not hold. The fake AniList (E2E_ANILIST=1) answers each country's trending with titles of its own.
//   1. the series page shows Related above More like this, in the server's order: Mixed Formats as its own card saying
//      Sequel, the two others as AniList's covers leading to Discover; More like this leads with Mixed Formats;
//   2. tapping "Repeated Pages Two" opens Discover on its search -- the field holds it, the address keeps ?q=, no hero --
//      and Newest takes ?q= off the address;
//   3. with a chapter of Repeated Pages finished, Discover shows "Because you read Repeated Pages" above the wall with
//      the four works the library does not hold, and the trending manhwa, manga and manhua rails under it;
//   4. at the end of Repeated Pages' last chapter the reader shows "Next in the story" -- Mixed Formats and "Repeated
//      Pages Two" -- above Because you finished this;
//   5. a member who may not add series is shown the outside works as plain cards saying "Not in your library";
//   6. no console errors along the way.
//
// ⚠️ On a FRESH instance: the server keeps each country's trending answer six hours, so a Discover opened before this
// walk sets the fake's titles (another walk, the main run) leaves the rails empty until then.
//
//   KEEP=1 E2E_NET=uchiyomi-e2e-610 E2E_PORT=18610 E2E_SUBNET=10.222.61.0/24 E2E_ANILIST=1 E2E_NO_WALK=1 bash web/test/e2e/up.sh
//   cd web && E2E_NET=uchiyomi-e2e-610 BASE=http://127.0.0.1:18610 node test/e2e/v610Walk.mjs
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:18610';
const NET = process.env.E2E_NET || 'uchiyomi-e2e-610';
const USER = process.env.E2E_USER || 'e2e';
const PASS = process.env.E2E_PASS || 'e2e-passw0rd-123';
const OUT = process.env.OUT || 'shots610d';
// Where up.sh publishes the fake AniList (its E2E_ANILIST_PORT default), as v557Walk.mjs reaches it.
const ANILIST = process.env.ANILIST || `http://127.0.0.1:${28_000 + (Number(new URL(BASE).port) % 1000)}`;
const NODL = { username: 'e2e-nodl610', password: 'e2e-nodl610-passw0rd-1' };
mkdirSync(OUT, { recursive: true });

const failures = [];
const ok = (message) => console.log(`    [ ok ] ${message}`);
const bad = (message) => { failures.push(message); console.log(`    [FAIL] ${message}`); };
const check = (yes, pass, fail = pass) => (yes ? ok(pass) : bad(fail));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, ms = 10_000, step = 250) => {
  const started = Date.now();
  let value;
  while (Date.now() - started < ms) { value = await fn(); if (value) return value; await sleep(step); }
  return value;
};
const sql = (text) => execFileSync('docker', ['exec', `${NET}-db`, 'psql', '-U', 'postgres', '-d', 'yomi', '-tAqc', text], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Text as a reader sees it: the bidi isolates around a title (U+2066-2069) dropped, spaces folded. */
const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

let token = '';
async function api(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const raw = await r.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  return { status: r.status, body };
}

/** A related work as anilist_related keeps it (bff lib/anilist.ts RelatedItem). No cover: the tile shows its placeholder. */
const item = (id, title, extra = {}) => ({
  id, title, titles: [title], synonyms: [], cover: null, format: 'MANGA', status: 'RELEASING', adult: false, genres: ['Action'],
  country: 'KR', score: 75, ...extra,
});
const RELATIONS = [
  item(990302, 'Mixed Formats', { rel: 'SEQUEL' }),
  item(990350, 'Repeated Pages Two', { rel: 'SEQUEL' }),
  item(990351, 'Repeated Pages Zero', { rel: 'PREQUEL' }),
];
const RECS = [
  item(990302, 'Mixed Formats', { rating: 50 }),
  ...['One', 'Two', 'Three', 'Four'].map((n, i) => item(990360 + i, `Walk Rec ${n}`, { rating: 40 - i * 10 })),
];
/** Eleven manhwa: the hero takes ten and the rail the last; one manga, one manhua. */
const TRENDS = {
  KR: Array.from({ length: 11 }, (_, i) => ({ id: 990410 + i, title: `Walk Trend Manhwa ${i + 1}` })),
  JP: [{ id: 990430, title: 'Walk Trend Manga' }],
  CN: [{ id: 990440, title: 'Walk Trend Manhua' }],
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
let phase = 'start';
const consoleErrors = [];
const watch = (p, who = '') => {
  p.on('console', (m) => { if (m.type() === 'error' && !/401|404|409|429/.test(m.text())) consoleErrors.push(`${who}[${phase}] ${m.text().slice(0, 180)}`); });
  p.on('pageerror', (e) => consoleErrors.push(`${who}[${phase}] ${String(e).slice(0, 180)}`));
  return p;
};
const signIn = async (p, user, pass) => {
  await p.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await p.waitForSelector('input[type=password]', { timeout: 30_000 });
  await sleep(2500); // the form renders again once /auth/config answers; typing before that is lost
  await (await p.$$('input'))[0].type(user);
  await p.type('input[type=password]', pass);
  await p.keyboard.press('Enter');
  await waitFor(async () => !(await p.$('input[type=password]')), 20_000);
  return !(await p.$('input[type=password]'));
};
/** The Related section's cards, in page order: [title, note, kind] -- `series` opens the series, `outside` is AniList's. */
const relatedCards = (p, root = 'section[data-related]') => p.evaluate((root) => {
  const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll(`${root} a[href*="/series/"], ${root} [data-outside]`)].map((el) => [
    plain(el.querySelector('p')?.textContent), plain(el.querySelector('[data-card-note]')?.textContent),
    el.hasAttribute('data-outside') ? `outside:${el.tagName.toLowerCase()}` : 'series', el.getAttribute('href') ?? '',
  ]);
}, root);
/** Whether `a` comes before `b` in the page. */
const before = (p, a, b) => p.evaluate((a, b) => {
  const x = typeof a === 'string' ? document.querySelector(a) : null;
  const y = [...document.querySelectorAll('h2')].find((h) => (h.textContent || '').trim() === b);
  return !!x && !!y && !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
}, a, b);

try {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) throw new Error(`API login ${login.status}`);
  token = (await login.json()).accessToken;
  for (const id of ['fake-a', 'fake-b']) {
    await api(`/api/admin/sources/${id}/enable`, { method: 'POST' });
    await api(`/api/admin/sources/${id}/unblock`, { method: 'POST' });
  }

  // ---- setup ----
  phase = 'setup';
  const idOf = (title) => sql(`SELECT id FROM lib_series WHERE title = ${lit(title)} AND deleted_at IS NULL AND merged_into IS NULL LIMIT 1`);
  const rp = await waitFor(() => idOf('Repeated Pages'), 30_000, 500);
  const mf = await waitFor(() => idOf('Mixed Formats'), 30_000, 500);
  check(!!rp && !!mf, 'Repeated Pages and Mixed Formats are in the library', JSON.stringify({ rp, mf }));
  for (const [id, al] of [[rp, '990301'], [mf, '990302']]) {
    sql(`INSERT INTO series_trackers (series_id, provider, external_id, checked_at) VALUES (${lit(id)}, 'anilist', ${lit(al)}, now())
         ON CONFLICT (series_id, provider) DO UPDATE SET external_id = EXCLUDED.external_id, checked_at = now()`);
  }
  sql(`INSERT INTO anilist_related (anilist_id, relations, recs, fetched_at)
       VALUES ('990301', ${lit(JSON.stringify(RELATIONS))}::jsonb, ${lit(JSON.stringify(RECS))}::jsonb, now())
       ON CONFLICT (anilist_id) DO UPDATE SET relations = EXCLUDED.relations, recs = EXCLUDED.recs, fetched_at = now()`);
  const set = await fetch(`${ANILIST}/__trending`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(TRENDS) });
  check(set.ok, 'the fake AniList answers each country its own trending titles', `__trending answered ${set.status}`);
  const books = ((await api(`/api/series/${encodeURIComponent(rp)}/books?size=50`)).body?.content ?? []).slice().sort((a, b) => a.number - b.number);
  check(books.length >= 2, 'Repeated Pages has its chapters', `${books.length} chapters`);
  const done = await api(`/api/books/${encodeURIComponent(books[0].id)}/progress`, { method: 'PUT', json: { page: 3, completed: true, seriesId: rp } });
  check(done.status < 300, 'a chapter of Repeated Pages finished', `progress answered ${done.status}`);

  const page = watch(await browser.newPage());
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setBypassServiceWorker(true);
  let shotNo = 0;
  const shot = (name, p = page) => p.screenshot({ path: `${OUT}/${String(++shotNo).padStart(2, '0')}-${name}.png` });
  phase = 'login';
  check(await signIn(page, USER, PASS), 'signed in');

  // ---- 1. the series page ----
  phase = 'series';
  await page.goto(`${BASE}/series/?id=${encodeURIComponent(rp)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const cards = await waitFor(async () => { const c = await relatedCards(page); return c.length >= 3 ? c : null; }, 20_000, 500);
  check(JSON.stringify(cards?.map(([t, n, k]) => [t, n, k])) === JSON.stringify([
    ['Mixed Formats', 'Sequel', 'series'], ['Repeated Pages Two', 'Sequel', 'outside:a'], ['Repeated Pages Zero', 'Prequel', 'outside:a'],
  ]), 'Related: the held sequel as its own card, the rest as AniList\'s, each saying how it is related', JSON.stringify(cards));
  check(/\/discover\/?\?q=Repeated%20Pages%20Two$/.test(cards?.[1]?.[3] ?? ''), 'an outside card leads to Discover searching for it', cards?.[1]?.[3]);
  check(await before(page, 'section[data-related]', 'More like this'), 'Related sits above More like this');
  const similar = await page.evaluate(() => [...document.querySelectorAll('section')].find((s) => (s.querySelector('h2')?.textContent || '').trim() === 'More like this')
    ?.querySelector('a[href*="/series/"] p')?.textContent?.trim() ?? null);
  check(similar === 'Mixed Formats', 'More like this leads with what AniList\'s readers recommend and the library holds', `first: ${similar}`);
  await page.$eval('section[data-related]', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await shot('series-related');

  // ---- 2. an outside card opens Discover on its search ----
  phase = 'discover-q';
  await page.click('section[data-related] [data-outside="990350"]');
  const arrived = await waitFor(() => page.evaluate(() => location.pathname.startsWith('/discover') && location.search), 20_000, 250);
  check(/q=Repeated(%20|\+)Pages(%20|\+)Two/.test(arrived || ''), 'Discover opens with the title in its address', `address: ${arrived}`);
  const field = await waitFor(() => page.evaluate(() => document.querySelector('input[aria-label="Search all sources…"]')?.value || null), 10_000);
  check(field === 'Repeated Pages Two', 'its search field holds the title', `field: ${field}`);
  const searching = await waitFor(() => page.evaluate(() => [...document.querySelectorAll('h2')].some((h) => (h.textContent || '').trim() === 'Results across your sources')), 10_000);
  check(!!searching, 'and it is searching the sources for it');
  check(!(await page.evaluate(() => (document.body.innerText || '').includes('Trending now'))), 'no hero over a search');
  await shot('discover-q');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Newest' && b.className.includes('chip'))?.click());
  const left = await waitFor(() => page.evaluate(() => (location.search.includes('q=') ? null : location.pathname)), 10_000);
  check(!!left, 'Newest takes ?q= off the address', 'the address still carries ?q=');

  // ---- 3. Because you read, and the trending rails ----
  phase = 'discover-rails';
  const rail = (kind) => page.evaluate((kind) => {
    const plain = (t) => String(t ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
    const s = document.querySelector(`[data-anilist-rail="${kind}"]`);
    return s ? { title: plain(s.querySelector('h2')?.textContent), cards: [...s.querySelectorAll('button p')].map((p) => plain(p.textContent)) } : null;
  }, kind);
  const because = await waitFor(() => rail('because'), 20_000, 500);
  check(because?.title === 'Because you read Repeated Pages', 'Because you read names the series read', JSON.stringify(because));
  check(JSON.stringify(because?.cards) === JSON.stringify(['Walk Rec One', 'Walk Rec Two', 'Walk Rec Three', 'Walk Rec Four']),
    'with the four recommendations the library does not hold -- Mixed Formats left out', JSON.stringify(because?.cards));
  check(await before(page, '[data-anilist-rail="because"]', 'Newest from your sources'), 'above the wall');
  const trends = {};
  for (const c of ['KR', 'JP', 'CN']) trends[c] = await waitFor(() => rail(c), 20_000, 500);
  check(trends.KR?.title === 'Trending manhwa' && trends.KR.cards.join() === 'Walk Trend Manhwa 11', 'the manhwa rail: what the hero did not take', JSON.stringify(trends.KR));
  check(trends.JP?.title === 'Trending manga' && trends.JP.cards.join() === 'Walk Trend Manga', 'a trending manga rail', JSON.stringify(trends.JP));
  check(trends.CN?.title === 'Trending manhua' && trends.CN.cards.join() === 'Walk Trend Manhua', 'a trending manhua rail', JSON.stringify(trends.CN));
  check(!(await before(page, '[data-anilist-rail="JP"]', 'Newest from your sources')), 'the trending rails sit under the wall');
  const askedJP = (await (await fetch(`${ANILIST}/__log`)).json()).filter((r) => r.kind === 'trending').map((r) => r.country);
  check(['KR', 'JP', 'CN'].every((c) => askedJP.includes(c)), 'each country was asked for by name', JSON.stringify(askedJP));
  await page.$eval('[data-anilist-rail="because"]', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await shot('discover-because');
  await page.$eval('[data-anilist-rail="CN"]', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await shot('discover-trending');

  // ---- 4. the reader's end card ----
  phase = 'reader';
  const last = books[books.length - 1];
  await page.goto(`${BASE}/reader/?book=${encodeURIComponent(last.id)}&page=last`, { waitUntil: 'networkidle2', timeout: 60_000 });
  let next = await waitFor(() => page.$('[data-next-in-story]'), 20_000, 500);
  if (!next) {
    // A strip that has not reached its last pages yet: to the end of it, as a reader would.
    await page.evaluate(() => { const s = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 50 && getComputedStyle(d).overflowY !== 'visible'); s?.scrollTo(0, s.scrollHeight); });
    next = await waitFor(() => page.$('[data-next-in-story]'), 20_000, 500);
  }
  const nextCards = next ? await relatedCards(page, '[data-next-in-story]') : null;
  check(JSON.stringify(nextCards?.map(([t, , k]) => [t, k])) === JSON.stringify([['Mixed Formats', 'series'], ['Repeated Pages Two', 'outside:a']]),
    'the end of the series shows Next in the story: the sequels alone', JSON.stringify(nextCards));
  const order = await page.evaluate(() => {
    const t = (document.body.innerText || '');
    return [t.indexOf('Next in the story'), t.indexOf('Because you finished this')];
  });
  check(order[0] >= 0 && (order[1] < 0 || order[0] < order[1]), 'above Because you finished this', JSON.stringify(order));
  await next?.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(400);
  await shot('reader-next');

  // ---- 5. a member who may not add series ----
  phase = 'member';
  const made = await api('/api/admin/users', { json: { ...NODL, role: 'user', perms: { canDownload: false } } });
  check([200, 201, 409].includes(made.status), 'a member who may not add series', `${made.status}`);
  const ctx = await browser.createBrowserContext();
  try {
    const m = watch(await ctx.newPage(), 'member: ');
    await m.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await m.setBypassServiceWorker(true);
    check(await signIn(m, NODL.username, NODL.password), 'signed in as the member');
    await m.goto(`${BASE}/series/?id=${encodeURIComponent(rp)}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    const theirs = await waitFor(async () => { const c = await relatedCards(m); return c.length >= 3 ? c : null; }, 20_000, 500);
    check(JSON.stringify(theirs?.map(([t, , k]) => [t, k])) === JSON.stringify([['Mixed Formats', 'series'], ['Repeated Pages Two', 'outside:div'], ['Repeated Pages Zero', 'outside:div']]),
      'the outside works are plain cards for them, not links to a Discover that refuses them', JSON.stringify(theirs));
    const says = await m.evaluate(() => [...document.querySelectorAll('section[data-related] [data-outside]')].map((e) => e.querySelector('[data-not-held]')?.textContent?.trim()));
    check(says.length === 2 && says.every((s) => s === 'Not in your library'), 'each says it is not in the library', JSON.stringify(says));
    await m.$eval('section[data-related]', (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(400);
    await shot('member-related', m);
  } finally {
    await ctx.close();
  }

  check(consoleErrors.length === 0, 'no console errors along the way', `console: ${consoleErrors.join(' | ')}`);
} catch (e) {
  bad(`[${phase}] ${e?.stack || e}`);
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall ok');
process.exit(failures.length ? 1 : 0);
