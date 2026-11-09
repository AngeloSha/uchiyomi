// The real Sources UI against a large, deterministic API fixture. The signed-in preview supplies the shell;
// every extension write is intercepted here, so the fixture changes no server settings or installed sources.
import assert from 'node:assert/strict';

const BUNDLE = 'fixture.extension.multisite';
const NORMAL = 'fixture.extension.languages';
const languages = ['en', 'es', 'ja', 'ar', 'de', 'fr', 'pt-BR', 'ru', 'zh', 'sq', 'it', 'ko', 'nl', 'pl', 'tr', 'vi'];
const extension = (pkgName, name) => ({ pkgName, name, lang: 'all', versionName: '1.2.3', iconUrl: null,
  installed: true, hasUpdate: false, obsolete: false, nsfw: false });

export async function multiSiteExtensionWalk({ page, base, check = (label, result) => assert.ok(result, label), shot = async () => {} }) {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'fixture requires a private local preview');
  const sources = Array.from({ length: 840 }, (_, i) => ({ id: String(700000001 + i),
    name: i < 2 ? 'Moon Reader' : i === 2 ? 'Luna Archive' : `Fixture Site ${String(i + 1).padStart(3, '0')}`,
    lang: i === 0 ? 'en' : i <= 2 ? 'es' : languages[i % languages.length], enabled: false, nsfw: false, pkgName: BUNDLE, used: 0 }));
  sources.push({ id: '800000001', name: 'Ordinary (EN)', lang: 'en', enabled: false, nsfw: false, pkgName: NORMAL, used: 0 },
    { id: '800000002', name: 'Ordinary (ES)', lang: 'es', enabled: false, nsfw: false, pkgName: NORMAL, used: 0 });
  const extensions = [extension(BUNDLE, 'Many Sites Fixture'), extension(NORMAL, 'Ordinary Fixture')];
  const writes = [];
  const siteOpens = [];
  const preferences = new Map();
  const siblings = (id) => sources.filter((s) => s.pkgName === sources.find((s) => s.id === id)?.pkgName);
  const prefAnswer = (id) => ({ source: { ...sources.find((s) => s.id === id), extensionName: 'Many Sites Fixture' },
    siblings: siblings(id), usedBy: 0, renumbers: 0, preferences: [
      { key: 'domain', type: 'text', title: 'Fixture domain', value: preferences.get(id)?.domain ?? `original-${id}`,
        default: '', enabled: true, visible: true, numbering: false, summary: null },
      { key: 'compact', type: 'switch', title: 'Fixture compact view', value: preferences.get(id)?.compact ?? false,
        default: false, enabled: true, visible: true, numbering: false, summary: null },
    ] });
  const overview = () => ({ sources: sources.map((s) => ({ id: `sw:${s.id}`, name: s.name, lang: s.lang, pkgName: s.pkgName,
    kind: 'extension', standing: s.enabled ? 'usable' : 'off', offBy: s.enabled ? null : 'extension', state: s.enabled ? 'ok' : 'off',
    main: 0, followed: 0, withBackup: 0, icon: false })), attention: { replace: [], failingUnused: [], updates: 0 } });
  const catalog = () => ({ content: extensions, total: 2, matched: 2, shown: 2, installed: 2, updatable: 0,
    hiddenAdult: 0, adultTotal: 0, langs: ['all'] });
  const intercept = async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const u = new URL(req.url());
    if (u.origin !== new URL(base).origin) return req.continue();
    const path = u.pathname;
    const answer = (body, contentType = 'application/json') => req.respond({ status: 200, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (path === '/api/admin/extensions/status') return answer({ configured: true, reachable: true, version: '2.3.2243', enabled: sources.filter((s) => s.enabled).length, cap: 25 });
    if (path === '/api/admin/extensions/catalog') return answer(catalog());
    if (path === '/api/admin/extensions/sources') return answer({ content: u.searchParams.has('pkg') ? sources.filter((s) => s.pkgName === u.searchParams.get('pkg')) : sources, reachable: true, hiddenLangs: [] });
    if (path === '/api/admin/extensions/repos') return answer({ content: [] });
    if (path === '/api/admin/sources/overview') return answer(overview());
    if (path === '/api/admin/sources') return answer({ content: [], testMs: 100 });
    if (path === '/api/sources') return answer({ content: sources.filter((s) => s.enabled).map((s) => ({ id: `sw:${s.id}`, name: s.name, status: 'ok' })) });
    if (path === '/api/admin/extensions/sources/bulk') {
      const body = JSON.parse(req.postData()); writes.push({ path, body });
      for (const s of sources) if (body.ids.includes(s.id)) s.enabled = body.enabled;
      return answer({ ok: true, changed: body.ids.length });
    }
    const pref = /^\/api\/admin\/extensions\/sources\/(\d+)\/preferences$/.exec(path);
    if (pref) {
      if (req.method() !== 'GET') {
        const body = JSON.parse(req.postData()); writes.push({ path, body });
        preferences.set(pref[1], { ...(preferences.get(pref[1]) ?? {}), [body.key]: body.value });
        return answer({ ...prefAnswer(pref[1]), ok: true, changed: true, applied: true, remap: 0 });
      }
      return answer(prefAnswer(pref[1]));
    }
    const open = /^\/api\/admin\/extensions\/sources\/(\d+)\/site$/.exec(path);
    if (open) { siteOpens.push(open[1]); return answer({ session: 'fixture-session', name: sources.find((s) => s.id === open[1]).name, site: 'https://fixture.invalid/' }); }
    if (path === '/api/admin/extensions/site/fixture-session/stream') return answer('{"type":"ping"}\n', 'application/x-ndjson');
    if (path.startsWith('/api/admin/extensions/site/fixture-session')) return answer({ saved: true, test: null });
    return req.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', intercept);
  const search = async (query) => page.locator('[data-ext-langs-search]').fill(query);
  const shown = () => page.$$eval('[data-ext-lang]', (rows) => rows.map((r) => r.getAttribute('data-ext-lang')));
  const showIds = async (query, expected) => {
    await search(query);
    await page.waitForFunction((ids) => JSON.stringify([...document.querySelectorAll('[data-ext-lang]')].map((r) => r.getAttribute('data-ext-lang'))) === JSON.stringify(ids), {}, expected);
  };
  const openBundle = async () => {
    await page.goto(`${base}/admin/?tab=Sources&view=add`, { waitUntil: 'networkidle2' });
    await page.waitForSelector(`[data-ext-item="${BUNDLE}"] [data-ext-open]`, { visible: true });
    await page.click(`[data-ext-item="${BUNDLE}"] [data-ext-open]`);
    await page.waitForSelector(`[data-source-sheet="${BUNDLE}"]`, { visible: true });
    await page.waitForFunction(() => document.querySelectorAll('[data-ext-lang]').length === 840);
  };
  const previousLocale = await page.evaluate(() => localStorage.getItem('uchiyomi.lang'));
  const previousViewport = page.viewport();
  try {
    for (const [locale, width] of [['en', 1280], ['en', 390], ['ar', 390]]) {
      await page.evaluate((locale) => localStorage.setItem('uchiyomi.lang', locale), locale);
      await page.setViewport({ width, height: 900 });
      await openBundle();
      const info = await page.evaluate(() => {
        const sheet = document.querySelector('[data-source-sheet]')?.closest('[role="dialog"]');
        return { title: sheet?.querySelector('h2')?.textContent, sourceStatus: !!document.querySelector('[data-source-status]'),
          age: !!document.querySelector('[data-source-age]'), bulk: !!document.querySelector('[data-ext-turn-on]'),
          openDisabled: document.querySelector('[data-ext-open-site]')?.disabled, dir: document.documentElement.dir,
          overflow: document.documentElement.scrollWidth - innerWidth };
      });
      check(`${locale}/${width}: bundle has its package header and no borrowed site status or age rating`, info.title === 'Many Sites Fixture' && !info.sourceStatus && !info.age, JSON.stringify(info));
      check(`${locale}/${width}: bundle requires a named Open site choice and has no enable-every-site shortcut`, info.openDisabled && !info.bulk);
      check(`${locale}/${width}: no sideways page overflow and correct reading direction`, info.overflow <= 4 && info.dir === (locale === 'ar' ? 'rtl' : 'ltr'), JSON.stringify(info));
      await showIds('moon en', ['700000001']);
      check(`${locale}/${width}: search combines site name with language code`, (await shown()).length === 1);
      const row = await page.$eval('[data-ext-lang="700000001"]', (el) => ({ name: el.querySelector('bdi')?.textContent,
        isolated: el.querySelector('bdi')?.getAttribute('dir'), tagDir: el.querySelector('[aria-hidden]')?.getAttribute('dir'),
        switchName: el.querySelector('[role="switch"]')?.getAttribute('aria-label') }));
      check(`${locale}/${width}: site names and language tags stay readable and accessible`, row.name === 'Moon Reader' && row.isolated === 'auto' && row.tagDir === 'ltr' && row.switchName === 'Moon Reader · EN', JSON.stringify(row));
      if (locale === 'en' && width === 1280) {
        await showIds('moon Spanish', ['700000002']);
        const before = writes.length;
        await page.click('[data-ext-lang="700000002"] [role="switch"]');
        await page.waitForFunction(() => document.querySelector('[data-ext-lang="700000002"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
        check('switch changes only the selected source ID', writes.length === before + 1 && JSON.stringify(writes.at(-1)?.body) === JSON.stringify({ ids: ['700000002'], enabled: true }) && sources.filter((s) => s.enabled).length === 1, JSON.stringify(writes.at(-1)));
        await page.select('[data-ext-site-for]', '700000002');
        await page.click('[data-ext-open-site]');
        await page.waitForSelector('[data-site-sheet]', { visible: true });
        check('Open site sends the explicitly selected source ID', siteOpens.at(-1) === '700000002', JSON.stringify(siteOpens));
        await page.click('[data-site-done]');
        await page.waitForSelector('[data-site-sheet]', { hidden: true });
        await page.click('[data-ext-settings-toggle]');
        await page.waitForSelector('[data-ext-settings-for]');
        await page.select('[data-ext-settings-for]', '700000001');
        await page.waitForSelector('[data-ext-settings-body="700000001"] [data-pref="domain"] input');
        await page.locator('[data-pref="domain"] input').fill('unsaved-first-source');
        await page.select('[data-ext-settings-for]', '700000002');
        await page.waitForSelector('[data-ext-settings-body="700000002"] [data-pref="domain"] input');
        check('switching settings keeps each site named and discards the previous source draft',
          await page.$eval('[data-pref="domain"] input', (el) => el.value) === 'original-700000002'
          && await page.$eval('[data-ext-settings-for]', (el) => el.selectedOptions[0].textContent) === 'Moon Reader · ES');
        await page.click('[data-pref="compact"] [role="switch"]');
        await page.waitForFunction(() => document.querySelector('[data-pref="compact"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
        check('settings writes retain the selected source and preference key', writes.at(-1)?.path.endsWith('/700000002/preferences') && writes.at(-1)?.body.key === 'compact' && writes.at(-1)?.body.value === true, JSON.stringify(writes.at(-1)));
      }
      await shot(`multisite-${locale}-${width}`);
    }
    await page.evaluate(() => localStorage.setItem('uchiyomi.lang', 'en'));
    await page.goto(`${base}/admin/?tab=Sources&source=sw:700000002`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-source-sheet="sw:700000002"]');
    check('a site opened from Your sources keeps its own header and Open site target',
      await page.$eval('[data-source-sheet]', (el) => el.closest('[role="dialog"]')?.querySelector('h2')?.textContent) === 'Moon Reader'
      && await page.$eval('[data-ext-site-name]', (el) => el.textContent) === 'Moon Reader · ES'
      && !await page.$('[data-ext-site-for]'));
    await page.goto(`${base}/admin/?tab=Sources&view=add`, { waitUntil: 'networkidle2' });
    await page.waitForSelector(`[data-ext-item="${NORMAL}"] [data-ext-open]`);
    await page.click(`[data-ext-item="${NORMAL}"] [data-ext-open]`);
    await page.waitForSelector('[data-source-sheet="sw:800000001"]');
    const normal = await page.$$eval('[data-ext-lang] bdi', (rows) => rows.map((el) => el.textContent));
    check('ordinary extensions retain language rows and their existing source controls', JSON.stringify(normal) === JSON.stringify(['English', 'Spanish']) && !!await page.$('[data-source-status]') && !!await page.$('[data-ext-turn-on]') && !await page.$('[data-ext-site-for]'), JSON.stringify(normal));
  } finally {
    await page.evaluate((locale) => { if (locale === null) localStorage.removeItem('uchiyomi.lang'); else localStorage.setItem('uchiyomi.lang', locale); }, previousLocale);
    await page.goto(`${base}/library/`, { waitUntil: 'networkidle2' });
    if (previousViewport) await page.setViewport(previousViewport);
    page.off('request', intercept);
    await page.setRequestInterception(false);
  }
}
