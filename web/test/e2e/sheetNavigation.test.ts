// Render the real sheet and navigation with the app's CSS: a class-name assertion cannot detect one
// breakpoint hiding the last action behind another component. No server or signed-in account is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import puppeteer from 'puppeteer';
import { AuthProvider } from '../../lib/auth';
import { seriesActionGroups } from '../../lib/seriesActions';
import { BottomNav } from '../../components/BottomNav';
import { SeriesMoreSheet } from '../../components/SeriesKeys';
import { Sheet } from '../../components/ui';

(globalThis as { React?: unknown }).React = React;
const root = resolve(import.meta.dirname, '../..');
const shots = resolve(root, 'test/e2e/shots/sheet-navigation');
const groups = seriesActionGroups({ isAdmin: true, mayDownload: true, booksCount: 40,
  mayArchive: true, autoHero: true, hasFolder: true });

function fixture(footer: boolean) {
  const sheet = footer
    ? h(Sheet, { title: 'Library filters', onClose() {}, overBottomNav: true,
      footer: h('button', { 'data-final-action': '', className: 'w-full rounded-xl bg-accent px-4 py-3' }, 'Apply filters'),
      children: Array.from({ length: 20 }, (_, i) => h('p', { key: i, className: 'py-3' }, `Filter ${i + 1}`)) })
    : h(SeriesMoreSheet, { title: 'Sample series', groups, notesHref: '/moments/?series=sample', onPick() {}, onClose() {} });
  return renderToStaticMarkup(h(QueryClientProvider, { client: new QueryClient() },
    h(AuthProvider, null, h(PathnameContext.Provider, { value: '/series/' },
      h('main', { className: 'shell relative z-[1] pb-28 lg:pb-12' }, sheet), h(BottomNav)))));
}

test('sheet actions stay above the floating navigation at every mobile breakpoint', async (t) => {
  const css = (await postcss([tailwind({ base: root })]).process(
    await readFile(resolve(root, 'app/globals.css'), 'utf8'), { from: resolve(root, 'app/globals.css') })).css;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
  t.after(() => browser.close());
  await mkdir(shots, { recursive: true });
  const page = await browser.newPage();
  for (const footer of [false, true]) {
    for (const [width, height, inset] of [[390, 667, 0], [430, 932, 34], [639, 800, 0], [640, 800, 0],
      [768, 1024, 34], [844, 390, 21], [1023, 768, 0], [1024, 768, 0]]) {
      const name = `${footer ? 'footer' : 'more'}-${width}x${height}-inset${inset}`;
      await t.test(name, async () => {
        await page.setViewport({ width, height });
        // Desktop Chrome has no home-indicator inset. Substitute only that environment value to also
        // exercise the exact padding calculations a phone uses in portrait and landscape.
        await page.setContent(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
          <style>${css.replaceAll('env(safe-area-inset-bottom)', `${inset}px`)}</style></head>
          <body>${fixture(footer)}</body></html>`);
        const target = footer ? '[data-final-action]' : '[data-menu-item="remove-series"]';
        const result = await page.evaluate((selector) => {
          const scroller = document.querySelector<HTMLElement>('[data-lenis-prevent]')!;
          scroller.scrollTop = scroller.scrollHeight;
          const action = document.querySelector<HTMLElement>(selector)!;
          const box = action.getBoundingClientRect();
          const nav = document.querySelector('nav')!;
          const navBox = nav.getBoundingClientRect();
          const visibleNav = getComputedStyle(nav).display !== 'none';
          const clear = [box.top + 2, box.top + box.height / 2, box.bottom - 2].every((y) =>
            action.contains(document.elementFromPoint(box.left + box.width / 2, y)));
          return { clear, bottom: box.bottom, navTop: navBox.top, visibleNav, viewport: innerHeight };
        }, target);
        await page.screenshot({ path: resolve(shots, `${name}.png`) });
        assert.ok(result.clear, `${name}: another element intercepts the final action: ${JSON.stringify(result)}`);
        assert.ok(result.bottom <= result.viewport, `${name}: action falls outside the viewport`);
        if (result.visibleNav) assert.ok(result.bottom <= result.navTop,
          `${name}: action overlaps the navigation: ${JSON.stringify(result)}`);
      });
    }
  }
});
