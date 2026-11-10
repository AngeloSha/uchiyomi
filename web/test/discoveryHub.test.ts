import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscoveryPreview, DiscoveryTabLoading } from '../components/DiscoveryHub';
import { catalogItem, discoveryView, discoveryFiltersFrom, discoveryKey, filterDiscovery, isHiddenPick, mixCatalog, NO_DISCOVERY_FILTERS, openingDiscoveryTab, recommendationItems, surprisePick, writeDiscoveryFilters, type DiscoveryItem } from '../lib/discoveryHub';
import type { Pick } from '../lib/forYou';
import { setActiveLocale } from '../lib/format';
import { setActiveDict } from '../lib/i18n';
(globalThis as { React?: unknown }).React = React;
setActiveLocale('en'); setActiveDict({});
const item = (id: number, extra: Partial<DiscoveryItem> = {}): DiscoveryItem => ({ key: `al:${id}`, id, title: `Title ${id}`, cover: null,
  description: 'A known story.', genres: ['Fantasy'], score: 80, chapters: 20, status: 'FINISHED', ...extra });

test('a mixed hero gives every origin space, without showing duplicate works under another title', () => {
  const kr = [item(1, { country: 'KR' }), item(2, { country: 'KR' }), item(3, { country: 'KR' })];
  const jp = [item(4, { country: 'JP' }), item(1, { title: 'Another title', country: 'JP' })];
  const cn = [item(5, { country: 'CN' }), item(6, { country: 'CN' })];
  const mixed = mixCatalog([kr, jp, cn]);
  assert.deepEqual(mixed.map((i) => i.id), [1, 4, 5, 2, 6, 3]);
  assert.equal(mixCatalog([kr, [item(9, { title: 'Ｔｉｔｌｅ １' })]]).filter((i) => i.title.normalize('NFKC') === 'Title 1').length, 1);
  assert.deepEqual(mixCatalog([]), []);
});

test('genre, origin and completed filters reject unknown data rather than inventing metadata', () => {
  const known = item(1, { country: 'JP' });
  const unknown = item(2, { genres: [], country: null, status: null });
  const ongoing = item(3, { country: 'JP', status: 'RELEASING' });
  const all = [known, unknown, ongoing];
  assert.equal(filterDiscovery(all, NO_DISCOVERY_FILTERS).length, 3);
  assert.deepEqual(filterDiscovery(all, { country: 'JP', genre: 'fantasy', completed: true }), [known]);
  assert.deepEqual(filterDiscovery(all, { ...NO_DISCOVERY_FILTERS, genre: 'Mystery' }), []);
  assert.deepEqual(filterDiscovery(all, { ...NO_DISCOVERY_FILTERS, completed: true }), [known]);
  // FINISHED describes the work, not whether a particular translation/source has every chapter.
  assert.equal(known.status, 'FINISHED');
});

test('Not interested suppresses canonical IDs and Unicode title aliases in every recommendation pool', () => {
  const hidden = new Set(['al:1', 't:나혼자만레벨업']);
  assert.ok(isHiddenPick(item(1, { title: 'Different name' }), hidden));
  assert.ok(isHiddenPick({ title: '나 혼자만 레벨업!' }, hidden));
  assert.equal(filterDiscovery([item(1), item(2)], NO_DISCOVERY_FILTERS, hidden).length, 1);
  assert.equal(discoveryKey(item(1, { key: 't:recordedidentity' })), 't:recordedidentity', 'a saved identity must not silently change after enrichment');
});

test('recommendations inherit only catalog metadata that matches their work and retain their own reason', () => {
  const pick: Pick = { id: 5, title: 'Reader title', cover: null, score: null, from: { kind: 'tracker', badge: 'MAL', because: 'A', tip: 'A' } };
  const known = item(5, { title: 'Catalog title', country: 'JP', cover: 'https://example.com/cover.jpg' });
  const [out] = recommendationItems([pick], [known], () => 'Because you read A');
  assert.equal(out.key, 'al:5'); assert.equal(out.title, 'Reader title'); assert.equal(out.country, 'JP');
  assert.equal(out.cover, known.cover); assert.equal(out.reason, 'Because you read A');
  const [unknown] = recommendationItems([{ ...pick, id: null, title: 'Unrelated' }], [known], () => 'Your tracker');
  assert.deepEqual(unknown.genres, []); assert.equal(unknown.description, ''); assert.equal(unknown.status, null);
  assert.equal(unknown.country, undefined);
});

test('a title-only recommendation adopts a confirmed matching catalog identity without confusing similar titles', () => {
  const pick: Pick = { id: null, title: 'Ｔｉｔｌｅ ５!', cover: null, score: null, from: { kind: 'tracker', badge: 'MAL', because: null, tip: '' } };
  const [out] = recommendationItems([pick], [item(5)], () => 'Your tracker');
  assert.equal(out.key, 'al:5'); assert.equal(out.id, 5);
  assert.equal(recommendationItems([{ ...pick, title: 'Title 50' }], [item(5)], () => '')[0].id, null);
});

test('Surprise me uses only the supplied filtered pool and avoids repeating the last pick when possible', () => {
  const allowed = filterDiscovery([item(1), item(2), item(3)], NO_DISCOVERY_FILTERS, new Set(['al:2']));
  assert.equal(surprisePick(allowed, 'al:1', 0)?.id, 3);
  assert.equal(surprisePick(allowed, 'al:3', 0.99999)?.id, 1);
  assert.equal(surprisePick([], null, 0), null);
  assert.equal(surprisePick([item(1)], 'al:1', 0)?.id, 1);
});

test('direct search URLs open Sources and explicit tabs win over remembered defaults', () => {
  assert.equal(openingDiscoveryTab(null, 'Solo leveling'), 'sources');
  assert.equal(openingDiscoveryTab('for-you', 'Solo leveling'), 'sources');
  assert.equal(openingDiscoveryTab('sources', ''), 'sources');
  assert.equal(openingDiscoveryTab('for-you', ''), 'for-you');
  assert.equal(openingDiscoveryTab('unexpected', ''), null);
});

test('filter URLs restore valid selections and preserve unrelated search parameters', () => {
  const original = new URLSearchParams('tab=for-you&country=JP&genre=Mystery&completed=1&q=hello');
  const filters = discoveryFiltersFrom(original);
  assert.deepEqual(filters, { country: 'JP', genre: 'Mystery', completed: true });
  const cleared = writeDiscoveryFilters(original, NO_DISCOVERY_FILTERS);
  assert.equal(cleared.get('tab'), 'for-you'); assert.equal(cleared.get('q'), 'hello');
  assert.equal(cleared.has('genre'), false); assert.equal(original.get('genre'), 'Mystery', 'writing a URL must not mutate the source');
  assert.deepEqual(discoveryFiltersFrom(new URLSearchParams('country=XX&genre=Invented&completed=yes')), NO_DISCOVERY_FILTERS);
});

test('the title preview escapes descriptions and offers source selection before any download action', () => {
  const html = renderToStaticMarkup(createElement(DiscoveryPreview, { item: item(1, { description: '<script>bad()</script>', reason: 'Because you read A', country: 'JP' }),
    saved: false, busy: false, canChange: true, onClose() {}, onFind() {}, onSave() {}, onHide() {} }));
  assert.match(html, /role="dialog"/); assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /Because you read A/);
  assert.match(html, />Find a source</); assert.match(html, />Save for later</); assert.match(html, />Not interested</);
  assert.doesNotMatch(html, />Download|all chapters available/i);
});

test('an unavailable personal state disables feedback while source preview remains usable', () => {
  const html = renderToStaticMarkup(createElement(DiscoveryPreview, { item: item(1, { description: '' }), saved: true, busy: false, canChange: false,
    onClose() {}, onFind() {}, onSave() {}, onHide() {} }));
  assert.match(html, /aria-pressed="true" disabled=""/); assert.match(html, />Saved</);
  assert.match(html, /No synopsis is available/);
  const find = html.slice(html.indexOf('>Find a source<') - 300, html.indexOf('>Find a source<'));
  assert.doesNotMatch(find, /disabled=""/);
});


test('a remembered Sources tab never paints the default hub while its preference is still loading', () => {
  assert.deepEqual(discoveryView(null, undefined, true), { tab: 'for-you', ready: false });
  assert.deepEqual(discoveryView(null, 'sources', false), { tab: 'sources', ready: true });
  const html = renderToStaticMarkup(createElement(DiscoveryTabLoading));
  assert.match(html, /role="status" aria-busy="true"/);
  assert.match(html, /Loading…/);
  assert.doesNotMatch(html, /data-discover-hero|data-discovery-hub|SourceLatest|Not interested/);
});

test('an explicit URL or click opens immediately, and a failed preference request falls back to For you', () => {
  assert.deepEqual(discoveryView('sources', undefined, true), { tab: 'sources', ready: true });
  assert.deepEqual(discoveryView('for-you', 'sources', true), { tab: 'for-you', ready: true });
  assert.deepEqual(discoveryView(null, undefined, false), { tab: 'for-you', ready: true });
  assert.deepEqual(discoveryView('sources', 'for-you', false), { tab: 'sources', ready: true });
});
