// A real-browser regression for #418. Only the disposable page's extension API is intercepted; no repository is added.
import assert from 'node:assert/strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function errorDetailsWalk({ page, base, ok = () => {}, bad = message => { throw new Error(message); }, shot = async () => {} }) {
  const viewport = page.viewport();
  const trace = `java.lang.IllegalStateException: fixture install failed\n${Array.from({ length: 180 }, (_, i) => `\tat FixtureExtension.install(FixtureExtension.kt:${i})`).join('\n')}\nCaused by: fixture-signature-mismatch`;
  const payload = { error: 'engine_refused', message: trace, reason: 'Authorization: Bearer fixture-private-token\nhttps://fixture.invalid/install?token=fixture-url-secret&file=fixture.apk', password: 'fixture-unrelated-password' };
  const status = { configured: true, reachable: true, version: 'fixture', enabled: 0, known: 0, cap: 1000, skipped: 0 };
  const catalogue = { content: [], total: 0, matched: 0, shown: 0, installed: 0, updatable: 0, hiddenAdult: 0, langs: [] };
  const intercept = request => {
    if (request.isInterceptResolutionHandled()) return;
    const url = new URL(request.url());
    let body;
    if (url.origin === new URL(base).origin) {
      if (url.pathname === '/api/admin/extensions/status') body = status;
      if (url.pathname === '/api/admin/extensions/catalog') body = catalogue;
      if (url.pathname === '/api/admin/extensions/sources') body = { content: [], reachable: true, hiddenLangs: [] };
      if (url.pathname === '/api/admin/extensions/repos') body = { content: ['https://fixture.invalid/index.min.json'] };
      if (url.pathname === '/api/admin/extensions/repos' && request.method() === 'POST') {
        void request.respond({ status: 400, contentType: 'application/json', body: JSON.stringify(payload) });
        return;
      }
    }
    if (body) void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    else void request.continue();
  };
  try {
    await page.setRequestInterception(true);
    page.on('request', intercept);
    for (const rtl of [false, true]) {
      await page.setViewport({ width: 390, height: 740, isMobile: true, hasTouch: true });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: rtl ? 'reduce' : 'no-preference' }]);
      await page.goto(`${base}/admin/?tab=Sources&view=add`, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.evaluate(direction => { document.documentElement.dir = direction; }, rtl ? 'rtl' : 'ltr');
      await page.waitForSelector('[data-ext-repos]', { visible: true });
      await page.click('[data-ext-repos]');
      await page.waitForSelector('[data-repos-sheet] input', { visible: true });
      await page.type('[data-repos-sheet] input', 'https://fixture.invalid/test/index.min.json');
      await page.$eval('[data-repo-form]', form => [...form.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add').click());
      await page.waitForSelector('[data-notice-details]', { visible: true });
      const notice = await page.$eval('[data-notice="error"]', el => el.textContent);
      assert.doesNotMatch(notice, /IllegalStateException|FixtureExtension\.kt|fixture-private/);
      ok(`error notice has a short summary (${rtl ? 'RTL/reduced motion' : 'mobile'})`);
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-notice-details]');
        if (!button || Number(getComputedStyle(button.closest('[data-notice]')).opacity) < 0.99) return false;
        const rect = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      });
      await page.tap('[data-notice-details]');
      await page.waitForSelector('[data-error-details-text]', { visible: true });
      const diagnostic = await page.$eval('[data-error-details-text]', el => el.value);
      assert.ok(diagnostic.includes(trace));
      assert.doesNotMatch(diagnostic, /fixture-private-token|fixture-url-secret|fixture-unrelated-password/);
      ok('Details preserves every stack frame and removes credential fields');
      const point = await page.$eval('[data-error-details-text]', el => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height - 24), top: rect.y + 24 };
      });
      const cdp = await page.createCDPSession();
      try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        for (let step = 1; step <= 10; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: Math.round(point.y + (point.top - point.y) * step / 10), id: 1 }] });
          await sleep(30);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally { await cdp.detach(); }
      await page.waitForFunction(() => document.querySelector('[data-error-details-text]')?.scrollTop > 0);
      assert.ok(await page.$('[data-error-details]'));
      assert.ok(await page.$('[data-repos-sheet]'));
      ok('a real mobile swipe scrolls the trace without dismissing either dialog');
      // A permission failure, including browsers with no Clipboard API, selects the complete text instead.
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('fixture denied', 'NotAllowedError'); } } }));
      await page.click('[data-error-copy]');
      await page.waitForFunction(() => document.querySelector('[data-error-copy-status]')?.textContent.includes('Could not copy automatically'));
      const selected = await page.$eval('[data-error-details-text]', el => ({ start: el.selectionStart, end: el.selectionEnd, length: el.value.length, active: document.activeElement === el }));
      assert.deepEqual(selected, { start: 0, end: diagnostic.length, length: diagnostic.length, active: true });
      ok('a refused clipboard write offers the complete selected text for manual copying');
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__errorFixtureCopy = text; } } }));
      await page.click('[data-error-copy]');
      await page.waitForFunction(() => document.querySelector('[data-error-copy-status]')?.textContent === 'Copied');
      assert.equal(await page.evaluate(() => window.__errorFixtureCopy), diagnostic);
      ok('Copy error writes exactly the complete displayed diagnostic');
      await page.waitForFunction(() => !document.querySelector('[data-notice-details]'), { timeout: 15000 });
      assert.equal(await page.$eval('[data-error-details-text]', el => el.value), diagnostic);
      ok('the original toast expires while the full error dialog remains usable');
      // Tab and Shift+Tab stay in the top dialog, above the still-open source sheet.
      await page.$eval('[data-error-select]', el => el.focus());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-error-select')), true);
      ok('keyboard focus stays in error details in both directions');
      await shot(`error-details-${rtl ? 'rtl' : 'mobile'}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-error-details]'));
      assert.ok(await page.$('[data-repos-sheet]'));
      ok('Escape closes only the error details and retains the repository sheet');
    }
  } catch (error) {
    await shot('error-details-failure').catch(() => {});
    bad(`error details regression: ${error.stack || error.message}`);
  }
  finally {
    page.off('request', intercept);
    await page.setRequestInterception(false);
    await page.emulateMediaFeatures([]);
    if (viewport) await page.setViewport(viewport);
  }
}
