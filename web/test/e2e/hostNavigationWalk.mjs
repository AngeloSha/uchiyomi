import { openSeriesMore } from './seriesMore.mjs';

// The real app/router, with a transport stand-in. UIKit geometry has hosted XCTest coverage.
export async function hostNavigationWalk({ page, BASE, ok, bad, shot, ensureSignedIn }) {
  const viewport = page.viewport();
  let injection;
  const install = async mode => {
    if (injection) await page.removeScriptToEvaluateOnNewDocument(injection);
    ({ identifier: injection } = await page.evaluateOnNewDocument(mode => {
      // Layout-only extraction fixture; generation is covered by titleExtractionWalk.
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url ?? input, location.href);
        if (url.pathname === '/api/admin/title-extraction/capabilities') return Promise.resolve(new Response(JSON.stringify({
          available: true, reason: null, automaticAvailable: false, automaticApplyAvailable: false, maxExclusions: 8, timeoutSeconds: 30,
        }), { headers: { 'Content-Type': 'application/json' } }));
        if (/^\/api\/admin\/series\/[^/]+\/title-extraction$/.test(url.pathname) && (!init?.method || init.method === 'GET'))
          return Promise.resolve(new Response(JSON.stringify({ job: null }), { headers: { 'Content-Type': 'application/json' } }));
        return fetch(input, init);
      };
      const listeners = new Set();
      const fixture = { current: null, result: null, mode };
      fixture.reset = current => {
        for (const receive of listeners) receive({ kind: 'reset', version: 1, session: current.session });
      };
      fixture.action = (action, overrides = {}) => {
        const current = fixture.current;
        if (!current) throw new Error('Host has no committed navigation state');
        for (const receive of listeners) receive({ kind: 'action', version: 1, session: current.session,
          revision: current.revision, request: crypto.randomUUID(), action, ...overrides });
      };
      window.__hostNavigationFixture = fixture;
      Object.defineProperty(window, 'uchiyomiNative', { value: Object.freeze({
        platform: 'ios', protocolVersion: 2, serverOrigin: location.origin,
        navigation: {
          version: 1,
          send(message) {
            if (message.kind === 'hello' && mode !== 'silent') queueMicrotask(() => {
              for (const receive of listeners) receive({ kind: 'ready', version: mode === 'unsupported' ? 99 : 1, session: message.session });
            });
            if (message.kind === 'state') fixture.current = message;
            if (message.kind === 'result') fixture.result = message;
            if (message.kind === 'stop' && fixture.current?.session === message.session) fixture.current = null;
          },
          subscribe(receive) { listeners.add(receive); return () => listeners.delete(receive); },
        },
      }) });
    }, mode));
  };
  const route = async (action, path) => {
    await page.evaluate(action => window.__hostNavigationFixture.action(action), action);
    await page.waitForFunction(path => location.pathname.replace(/\/$/, '') === path.replace(/\/$/, ''), { timeout: 10000 }, path);
    await page.waitForFunction(() => window.__hostNavigationFixture.result?.accepted === true);
  };
  const reachable = async selector => {
    await page.evaluate(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), selector);
    await new Promise(resolve => setTimeout(resolve, 150));
    return page.evaluate(selector => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && !!hit && (hit === el || el.contains(hit));
    }, selector);
  };
  const assert = (value, message) => { if (!value) throw new Error(message); ok(message); };
  try {
    console.log('\n  host navigation');
    await install('normal');
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${BASE}/library/`, { waitUntil: 'networkidle2' });
    if (!await ensureSignedIn(page, 'host navigation')) throw new Error('Host navigation fixture is signed out');
    await page.waitForFunction(() => window.__hostNavigationFixture?.current?.state.auth === 'authed');
    assert(await page.evaluate(() => document.documentElement.hasAttribute('data-host-navigation') &&
      !document.querySelector('nav.fixed.bottom-0') && !document.querySelector('[data-sidebar]')), 'negotiated navigation removes duplicate web chrome');
    const length = await page.evaluate(() => history.length);
    await route('library', '/library/');
    assert(await page.evaluate(() => history.length) === length, 'reselecting the current root does not add history');
    for (const [action, path] of [['home', '/'], ['search', '/search/'], ['discover', '/discover/'], ['offline', '/downloads/'], ['profile', '/profile/']]) {
      await route(action, path);
    }
    for (const [action, path] of [['lists', '/collections/'], ['history', '/history/'], ['moments', '/moments/'], ['updates', '/updates/'], ['admin', '/admin/']]) {
      await route(action, path);
    }
    ok('primary and secondary native actions use the existing routes');
    await route('library', '/library/');
    const before = page.url();
    await page.evaluate(() => window.__hostNavigationFixture.action('https://example.invalid/'));
    assert(page.url() === before && await page.evaluate(() => window.__hostNavigationFixture.result?.accepted === false), 'unsupported navigation action is rejected');
    await page.evaluate(() => window.__hostNavigationFixture.action('profile', { revision: 0 }));
    assert(page.url() === before && await page.evaluate(() => window.__hostNavigationFixture.result?.accepted === false), 'stale navigation action is rejected');
    await page.evaluate(() => window.__hostNavigationFixture.action('quick-settings'));
    await page.waitForSelector('[role=dialog][aria-label="Quick settings"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role=dialog][aria-label="Quick settings"]', { hidden: true });
    ok('native quick settings opens and closes the existing sheet');

    await page.waitForSelector('a[href*="/series?"] , a[href*="/series/?"]');
    const series = await page.$eval('a[href*="/series?"] , a[href*="/series/?"]', a => a.href);
    await page.goto(series, { waitUntil: 'networkidle2' });
    await route('library', '/library/');
    await page.goBack({ waitUntil: 'networkidle2' });
    await page.waitForFunction(series => location.href === series, { timeout: 10000 }, series);
    assert(page.url() === series, 'tab from a child opens its root and Back returns to the child');
    await page.goForward({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => location.pathname.replace(/\/$/, '') === '/library' &&
      window.__hostNavigationFixture?.current?.state.selected === 'library', { timeout: 10000 });
    assert(new URL(page.url()).pathname.replace(/\/$/, '') === '/library', 'Forward restores the committed root');
    for (const width of [390, 768, 1023, 1024]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(series, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => window.__hostNavigationFixture?.current?.state.selected === 'library');
      const kind = await openSeriesMore(page);
      assert(!!kind, `series More opens at ${width}px with native navigation`);
      const remove = '[data-menu-item="remove-series"]';
      assert(await reachable(remove), `series More's final action is tappable at ${width}px`);
      await page.click(remove);
      await page.waitForSelector('[role=dialog]');
      const cancel = await page.evaluate(() => {
        const button = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Cancel');
        button?.setAttribute('data-host-test-cancel', ''); return !!button;
      });
      assert(cancel && await reachable('[data-host-test-cancel]'), `confirmation actions are tappable at ${width}px`);
      await page.click('[data-host-test-cancel]');
      await page.waitForSelector('[role=dialog]', { hidden: true });
      await openSeriesMore(page);
      await page.click('[data-menu-item="edit-details"]');
      await page.waitForSelector('[data-series-editor]');
      assert(await reachable('[data-series-editor] button[aria-label=Close]'), `editor header is tappable at ${width}px`);
      if (width < 768) await page.click('[data-edit-tab=art]');
      await page.waitForFunction(() => !document.querySelector('[data-art-extract-cover]')?.disabled);
      await page.$eval('[data-art-extract-cover]', el => el.scrollIntoView({ block: 'center' }));
      await page.click('[data-art-extract-cover]');
      await page.waitForSelector('[data-title-extraction-dialog]');
      assert(await reachable('[data-extract-close]'), `title-extraction dialog controls are tappable at ${width}px`);
      await page.click('[data-extract-close]');
      await page.click('[data-series-editor] button[aria-label=Close]');
      await page.waitForSelector('[data-series-editor]', { hidden: true });
      if (width < 1024) {
        // Short fixtures can keep their main CTA visible even at the bottom. A
        // shorter viewport exercises the actual observer, without altering DOM.
        await page.setViewport({ width, height: 500 });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForSelector('[data-continue-bar] [data-continue]');
        assert(await reachable('[data-continue-bar] [data-continue]'), `Continue bar is tappable at ${width}px`);
        await page.setViewport({ width, height: 900 });
      }
      await openSeriesMore(page);
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Copy link').click());
      await page.waitForSelector('[data-notice]');
      await page.evaluate(() => [...document.querySelectorAll('[data-chapter-toolbar] button')].find(b => b.textContent.trim() === 'Select').click());
      await page.waitForSelector('[data-select-all-chapters]');
      assert(await reachable('[data-notice] button[aria-label=Dismiss]'), `notice remains visible and dismissible above fixed actions at ${width}px`);
      await page.click('[data-notice] button[aria-label=Dismiss]');
      assert(await reachable('[data-select-all-chapters]'), `chapter selection bar is tappable at ${width}px`);
      const bottom = await page.$eval('[data-select-all-chapters]', el => el.closest('.fixed').getBoundingClientRect().bottom);
      assert(Math.abs(bottom - 900) < 2, `chapter selection bar has no obsolete web-nav gap at ${width}px`);
      await page.evaluate(() => [...document.querySelectorAll('[data-chapter-toolbar] button')].find(b => b.textContent.trim() === 'Done').click());
      await page.keyboard.press('Escape');
      await route('library', '/library/');
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Filters'));
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Filters').click());
      await page.waitForSelector('[role=dialog][aria-label=Filters]');
      const done = await page.evaluate(() => {
        const button = [...document.querySelectorAll('[role=dialog][aria-label=Filters] button')].find(b => b.textContent.trim() === 'Done');
        if (!button) return false;
        button.setAttribute('data-host-test-done', ''); return true;
      });
      assert(done && await reachable('[data-host-test-done]'), `Filters footer is tappable at ${width}px`);
      await shot(`native-web-filters-${width}`);
      await page.click('[data-host-test-done]');
      await page.waitForSelector('[role=dialog][aria-label=Filters]', { hidden: true });
      assert(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rail-w').trim() === '0px'), `native viewport has no reserved web rail at ${width}px`);
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Select').click());
      // Committing the Library route does not wait for its search response. The
      // toolbar is already usable over skeletons, but Select all picks only loaded
      // series. Wait for real tiles so a slow response cannot select an empty list.
      await page.waitForSelector('[data-library-grid]:not([aria-busy=true]) button[aria-pressed=false]');
      await page.evaluate(() => [...document.querySelectorAll('[data-library-toolbar] button')].find(b => b.textContent.trim() === 'Select all').click());
      await page.waitForFunction(() => {
        const tiles = [...document.querySelectorAll('[data-library-grid] button[aria-pressed]')];
        return tiles.length > 0 && tiles.every(tile => tile.getAttribute('aria-pressed') === 'true');
      });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Cancel' && b.closest('.fixed')));
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel' && b.closest('.fixed')).setAttribute('data-host-library-cancel', ''));
      assert(await reachable('[data-host-library-cancel]'), `library selection bar is tappable at ${width}px`);
      await page.click('[data-host-library-cancel]');
    }

    await page.evaluate(() => {
      // Reset exercises ownership loss in an already rendered document.
      const current = window.__hostNavigationFixture.current;
      window.__hostNavigationFixture.reset(current);
    });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-host-navigation') && !!document.querySelector('nav.fixed.bottom-0'));
    ok('losing host ownership restores web navigation in the current document');

    for (const mode of ['silent', 'unsupported']) {
      await install(mode);
      await page.goto(`${BASE}/library/`, { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 3200));
      assert(await page.evaluate(() => !document.documentElement.hasAttribute('data-host-navigation') && !!document.querySelector('nav.fixed.bottom-0')), `${mode} handshake retains web navigation`);
    }
  } catch (error) {
    console.log('Host navigation failure geometry', await page.evaluate(() => ({
      scrollY, height: innerHeight, body: document.body.scrollHeight,
      buttons: [...document.querySelectorAll('[data-continue]')].map(el => ({ rect: el.getBoundingClientRect().toJSON(), text: el.textContent })),
      bodyStyle: document.body.style.cssText, htmlStyle: document.documentElement.style.cssText,
    })));
    await shot('native-web-failure');
    bad(`host navigation: ${error.message}`);
  }
  finally {
    if (injection) await page.removeScriptToEvaluateOnNewDocument(injection);
    await page.setViewport(viewport);
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await ensureSignedIn(page, 'after host navigation');
  }
}
