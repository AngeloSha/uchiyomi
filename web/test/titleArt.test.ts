import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeroTitle } from '../components/HeroTitle';
import { titleArtStyle, titleArtAccent, titleLogoUrl, titleLogoNeedsCaption, titleNeedsNaturalScript, titleArtPending, titleArtPollAllowed } from '../lib/titleArt';
import type { SeriesTitleArt } from '../lib/types';

(globalThis as any).React = React;
const art = (extra: Partial<SeriesTitleArt> = {}): SeriesTitleArt => ({ mode: 'automatic', style: 'auto', status: 'ready', version: 4,
  logoUrl: '/img/series/s_1/logo?v=4', language: 'en', showReadableTitle: false, attribution: null, ...extra });
const series = (titleArt?: SeriesTitleArt) => ({ id: 's_1', name: 'The Hero', metadata: { title: 'The Hero', genres: ['Action'] }, titleArt, color: '#201030' });

test('mixed genres choose the same title treatment regardless of metadata order, and a manual choice wins', () => {
  assert.equal(titleArtStyle(['Action', 'Fantasy']), 'fantasy');
  assert.equal(titleArtStyle(['Fantasy', 'Action']), 'fantasy');
  assert.equal(titleArtStyle(['Action', 'Romance', 'Mystery']), 'noir');
  assert.equal(titleArtStyle(['Sci-Fi', 'Romance']), 'soft');
  assert.equal(titleArtStyle(['Mecha']), 'scifi');
  assert.equal(titleArtStyle(['Cooking']), 'plain');
  assert.equal(titleArtStyle(['Horror'], 'action'), 'action');
  assert.equal(titleArtStyle(['Action'], 'plain'), 'plain');
});

test('comedy is a secondary mood and cannot erase action, fantasy or science-fiction lettering', () => {
  for (const [genres, expected] of [
    [['Action', 'Comedy'], 'action'],
    [['Fantasy', 'Action', 'Comedy'], 'fantasy'],
    [['Comedy', 'Science Fiction', 'Mecha'], 'scifi'],
    [['Sports', 'Comedy'], 'action'],
    [['Comedy'], 'soft'],
    [['Romance', 'Fantasy', 'Comedy'], 'soft'],
    [['Slice of Life', 'Action', 'Comedy'], 'soft'],
  ] as const) {
    assert.equal(titleArtStyle(genres), expected, genres.join(', '));
    assert.equal(titleArtStyle([...genres].reverse()), expected, 'source genre order must not change the treatment');
    assert.equal(titleArtStyle(genres, 'plain'), 'plain', 'an explicit choice still wins');
  }
});

test('title palette lifts dark covers and cannot interpolate arbitrary CSS', () => {
  assert.equal(titleArtAccent('#000000'), '163 163 163');
  assert.equal(titleArtAccent('#ffffff'), '255 255 255');
  assert.equal(titleArtAccent('url(https://outside.test)'), '193 176 255');
  assert.equal(titleArtAccent('#123'), '193 176 255');
});

test('unknown, old and text-only metadata ask for no image; cached logos remain usable during retries', () => {
  assert.equal(titleLogoUrl('s_1'), null);
  assert.equal(titleLogoUrl('s_1', art({ mode: 'text' })), null);
  assert.equal(titleLogoUrl('s_1', art({ logoUrl: null })), null);
  for (const status of ['ready', 'pending', 'error', 'missing', 'disabled'] as const) {
    assert.equal(titleLogoUrl('s_1', art({ status })), '/img/series/s_1/logo?v=4');
  }
  for (const logoUrl of ['https://outside.test/logo.png', '//outside.test/a', '/img/series/other/logo?v=4', '/img/series/s_1/logo/../file']) {
    assert.equal(titleLogoUrl('s_1', art({ logoUrl })), null, logoUrl);
  }
});

test('non-Latin names keep natural shaping instead of decorative Latin spacing', () => {
  for (const title of ['العنوان', 'המנגה שלי', '鬼滅の刃', '나 혼자만 레벨업', 'Пример']) assert.equal(titleNeedsNaturalScript(title), true, title);
  assert.equal(titleNeedsNaturalScript('L’étrange héros 2!'), false);
  const html = renderToStaticMarkup(React.createElement(HeroTitle, { series: series(), title: 'العنوان' }));
  assert.match(html, /data-title-script="natural"/);
  assert.match(html, />العنوان<\/span>/);
});

test('a downloading logo never blanks the accessible title, and only readable English artwork may omit the caption', () => {
  const english = renderToStaticMarkup(React.createElement(HeroTitle, { series: series(art()) }));
  assert.match(english, /<h1[^>]*dir="auto"/);
  assert.match(english, /<img[^>]*alt=""[^>]*aria-hidden="true"/);
  assert.match(english, /class="hero-title-text">The Hero<\/span>/, 'the readable fallback stays while the image downloads');
  assert.match(english, /hero-title-loading/, 'the not-yet-loaded picture must not shift the controls');
  assert.equal(titleLogoNeedsCaption(art()), false);
  for (const language of ['original', null] as const) {
    assert.equal(titleLogoNeedsCaption(art({ language })), true);
  }
  assert.equal(titleLogoNeedsCaption(art({ language: 'en', showReadableTitle: true })), true);
  const fallback = renderToStaticMarkup(React.createElement(HeroTitle, { series: series() }));
  assert.doesNotMatch(fallback, /<img/);
  assert.match(fallback, /class="hero-title-text">The Hero<\/span>/);
});

test('a title-art preview does not insert a second page heading', () => {
  const html = renderToStaticMarkup(React.createElement(HeroTitle, { series: series(art()), as: 'div' }));
  assert.match(html, /<div[^>]*data-hero-title/);
  assert.doesNotMatch(html, /<h1/);
});

test('an admin preview may use an in-memory image without accepting external artwork URLs', () => {
  const local = renderToStaticMarkup(React.createElement(HeroTitle, { series: series(), as: 'div', previewUrl: 'blob:private-preview' }));
  assert.match(local, /src="blob:private-preview"/);
  assert.match(local, />The Hero<\/span>/, 'the canonical name remains readable while the cutout loads');
  const external = renderToStaticMarkup(React.createElement(HeroTitle, { series: series(), as: 'div', previewUrl: 'https://outside.test/image.png' }));
  assert.doesNotMatch(external, /<img/);
});

test('only pending jobs are polled and a run ends after a minute even if the provider remains slow', () => {
  assert.equal(titleArtPending([series(art({ status: 'pending' }))]), true);
  assert.equal(titleArtPending([series(), series(art({ status: 'ready' })), series(art({ status: 'error' }))]), false);
  assert.equal(titleArtPollAllowed(1000, 1000), true);
  assert.equal(titleArtPollAllowed(1000, 60_999), true);
  assert.equal(titleArtPollAllowed(1000, 61_000), false);
  assert.equal(titleArtPollAllowed(1000, 999), false);
});
