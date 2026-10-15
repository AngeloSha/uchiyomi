// "18+ titles are showing", above every page while the reveal is on (#255, @Squeaks72's idea, rebuilt as
// components/AdultToggle.tsx AdultBanner).
//
// The Show 18+ chips live on Library, Home and Discover, and the reveal is a session cookie: turned on there, it stayed on
// across a series page, search and history with no sign of it and no way off until the browser closed. The PR pinned a
// capsule over the bottom of every page (over the series page's Continue bar and the select toolbars) and made the chips
// one-way. This is Incognito reading's line instead: in its slot, in its look, with a squared Hide 18+ key, and only
// while the reveal reveals something to this account. The chips stay two-way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';
import { AdultBannerShown, type LibraryRow } from '../components/AdultToggle';

(globalThis as { React?: unknown }).React = React;
setActiveLocale('en');
setActiveDict({});

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string): string => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/** The banner with the reveal on, for an account holding `libs` and meeting the 18+ filter or not. */
const banner = (libs: LibraryRow[] | undefined, configured: boolean) => {
  const qc = new QueryClient();
  if (libs) qc.setQueryData(['libraries'], libs);
  qc.setQueryData(['adult-filter'], { configured });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(AdultBannerShown)));
};

test('it shows only while the reveal reveals something to this account', () => {
  // A reveal left on after the admin took the 18+ library away, or on an account capped below 18 (whose libraries and
  // filter answer nothing adult), reveals nothing. Reintroduce the PR's rule (on is enough): the two empty cases render.
  assert.match(banner([{ id: 'l1', name: 'Adult', adult: true }], false), /data-adult-banner/, 'an 18+ library it holds');
  assert.match(banner([{ id: 'l1', name: 'Main' }], true), /data-adult-banner/, "the admin's 18+ genres or sources");
  assert.equal(banner([{ id: 'l1', name: 'Main' }], false), '', 'nothing to reveal');
  assert.equal(banner(undefined, false), '', 'libraries not known yet');
});

test("a squared key in Incognito reading's look, never a capsule", () => {
  const html = banner([{ id: 'l1', name: 'Adult', adult: true }], false);
  assert.match(html, /18\+ titles are showing\./);
  assert.match(html, /<button type="button" class="btn-key h-6 shrink-0 px-2 text-\[11px\]" data-adult-off="true">Hide 18\+<\/button>/);
  assert.doesNotMatch(html, /rounded-full|\bchip\b/, 'the PR\'s pill: rounded-full and a chip for an action');
  // The same line as Incognito's, so two on at once read as one set.
  const incognito = code(read('components/IncognitoBanner.tsx'));
  const line = 'flex items-center justify-center gap-2 bg-ink-800 px-4 py-1.5 text-[11px] text-fog-300 lg:ps-[calc(var(--rail-w)+1rem)]';
  assert.ok(incognito.includes(line) && html.includes(line), "Incognito reading's line and this one have parted");
});

test("the shell puts it in Incognito reading's slot, on every page but the reader's", () => {
  // In flow above the top bar, not pinned over the page: the PR's `fixed bottom-[5.5rem] z-40` covered the series page's
  // Continue bar and the select toolbars on a phone. The reader returns before this markup, as it does for Incognito's.
  const shell = code(read('components/AppShell.tsx'));
  assert.match(shell, /\{status === 'authed' && <IncognitoBanner \/>\}\s*\{status === 'authed' && <AdultBanner \/>\}/);
  assert.ok(shell.indexOf("if (immersive) return <>{children}</>;") < shell.indexOf('<AdultBanner />'));
  // With the reveal off it is null before asking for libraries or the filter: no request from every page.
  assert.match(code(read('components/AdultToggle.tsx')), /return useAdultShown\(\) \? <AdultBannerShown \/> : null;/);
});

test('the Show 18+ chips stay two-way', () => {
  // The PR made them the way in only (nothing rendered while on). Reintroduce that: this finds `setAdultShown(true)`.
  const toggle = code(read('components/AdultToggle.tsx'));
  const chip = toggle.slice(toggle.indexOf('export function AdultToggle('), toggle.indexOf('export function AdultBanner('));
  assert.match(chip, /aria-pressed=\{on\}/);
  assert.match(chip, /setAdultShown\(!on\);/);
  assert.match(chip, /if \(!alsoWhen && !\(libs \?\? \[\]\)\.some\(\(l\) => l\.adult\)\) return null;/);
});

test('its line is translated in all eight languages, not English copies', () => {
  for (const lang of ['ar', 'de', 'es', 'fr', 'ja', 'pt-BR', 'ru', 'zh']) {
    const d = JSON.parse(read(`public/locales/${lang}.json`)) as Record<string, string>;
    const v = d['18+ titles are showing.'];
    assert.ok(v && v !== '18+ titles are showing.', `${lang}: ${v}`);
  }
});
