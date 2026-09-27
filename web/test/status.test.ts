// Status as a mark and a word (v0.49.0, "no more pills"): the vocabulary in lib/status.ts and the marks
// components/StatusMark.tsx draws from it, rendered to markup with react-dom/server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HEALTH_LABELS, SOURCE_LABELS, SOURCE_STATUSES, engineMark, healthMark, sourceMark, TONE_TEXT, type Tone } from '../lib/status';
import { StatusEdge, StatusGlyph, StatusMark } from '../components/StatusMark';

// Under tsx the components compile to the classic `React.createElement` (tsconfig's `jsx: preserve` is for
// Next), which they look up as a global when they render.
(globalThis as any).React = React;

const ROOT = join(__dirname, '..');
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const TONES: Tone[] = ['ok', 'warn', 'problem', 'info', 'off', 'accent'];

test('every source status the server can send has a mark, read from the Src type itself', () => {
  // The union in lib/sourceGroups.ts is the list the server's statuses are typed by. A status added there
  // and not here would render as "Healthy". TypeScript refuses a missing Record entry; this holds the list
  // at run time too. Reintroduce by deleting `quiet` from SOURCE_MARK: "quiet has no mark" fails.
  const src = readFileSync(join(ROOT, 'lib/sourceGroups.ts'), 'utf8');
  const union = src.match(/\n\s*status\?: ((?:'[a-z_]+'\s*\|?\s*)+);/);
  assert.ok(union, 'the Src status union moved');
  // Plus `failing`, the one status only the admin card shows (#115, lib/providerGroups.ts providerStatus).
  const statuses = [...[...union![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), 'failing'].sort();
  assert.deepEqual([...SOURCE_STATUSES].sort(), statuses, `${statuses.filter((s) => !SOURCE_STATUSES.includes(s as any)).join(', ') || 'a status'} has no mark`);
});

test('the source marks: a quiet source is not red, and the words are specific', () => {
  // Answers without error and returns nothing: maybe a redesign, maybe a failure -- nobody knows until it
  // is tested, which is why the Providers card never made it red. Reintroduce by mapping quiet to
  // 'problem': this fails.
  assert.notEqual(sourceMark('quiet').tone, 'problem', 'a quiet source reads as broken');
  assert.deepEqual(sourceMark('ok'), { tone: 'ok', label: 'Healthy' });
  assert.deepEqual(sourceMark('blocked'), { tone: 'problem', label: 'Blocked by the site' });
  assert.deepEqual(sourceMark('rate_limited'), { tone: 'warn', label: 'Rate-limited' });
  assert.deepEqual(sourceMark('down'), { tone: 'problem', label: 'Not answering' });
  assert.deepEqual(sourceMark('disabled'), { tone: 'off', label: 'Turned off' });
  assert.deepEqual(sourceMark(undefined), { tone: 'ok', label: 'Healthy' }, 'a source without a status is not healthy, as the card reads it');
  assert.deepEqual(sourceMark('new_thing' as any), { tone: 'ok', label: 'Healthy' });
});

test('a source card\'s words agree with the noun "source" in the languages that inflect for it', () => {
  // The bare 'Blocked' key belongs to a scanlation group's Block toggle and agrees with THAT noun, so on a
  // source card es read "Bloqueado" beside "Desactivada", and ru "Отключена" beside the masculine
  // "Источники". Reintroduce 'Blocked' in SOURCE_LABELS (or the old ru "Отключена"): the language that
  // disagrees fails by name.
  const blockedKey = SOURCE_LABELS[1];
  const offKey = SOURCE_LABELS[5];
  const agree: Record<string, RegExp> = { es: /a$/, 'pt-BR': /a$/, fr: /ée$/, ru: /н$/ };
  for (const [lang, ending] of Object.entries(agree)) {
    const dict = JSON.parse(readFileSync(join(ROOT, 'public/locales', `${lang}.json`), 'utf8')) as Record<string, string>;
    const blocked = dict[blockedKey].split(' ')[0];
    const off = dict[offKey].split(' ')[0];
    assert.match(blocked, ending, `${lang}: "${blocked}" does not agree with the source noun (or with "${off}")`);
    assert.match(off, ending, `${lang}: "${off}" does not agree with the source noun (or with "${blocked}")`);
  }
  assert.notEqual(blockedKey, 'Blocked', 'a source shares the scanlation group\'s "Blocked" key');
});

test('the Health and engine marks', () => {
  assert.deepEqual(healthMark('problem'), { tone: 'problem', label: 'Needs attention' });
  assert.deepEqual(healthMark('warn'), { tone: 'warn', label: 'Worth a look' });
  assert.deepEqual(healthMark('ok'), { tone: 'ok', label: 'All good' });
  assert.deepEqual([...HEALTH_LABELS], ['Needs attention', 'Worth a look', 'All good']);
  assert.deepEqual(engineMark(true, 'v2.3.2243'), { tone: 'ok', label: 'Engine ready · v2.3.2243' });
  assert.deepEqual(engineMark(true), { tone: 'ok', label: 'Engine ready' });
  assert.deepEqual(engineMark(false, 'v2'), { tone: 'problem', label: 'Engine unreachable' });
});

test('a mark is a glyph and coloured words: no fill, no border, no rounding', () => {
  // The whole point of the owner's decision. Reintroduce the capsule (`rounded-full border px-2 …` on the
  // outer span): "the mark is a capsule" fails.
  for (const tone of TONES) {
    const out = html(createElement(StatusMark, { tone, label: 'Word' }));
    const outer = out.match(/^<span data-status="[a-z]+"[^>]*class="([^"]*)"/);
    assert.ok(outer, `${tone}: no mark`);
    assert.doesNotMatch(outer![1], /\b(bg-|border|rounded)/, `${tone}: the mark is a capsule (${outer![1]})`);
    assert.ok(outer![1].includes(TONE_TEXT[tone]), `${tone}: the words are not in the tone's colour`);
    assert.match(out, /<span>Word<\/span>/);
  }
  // Without words it is an image with a name, not an unlabelled glyph.
  assert.match(html(createElement(StatusMark, { tone: 'problem', title: 'Needs attention' })), /role="img" aria-label="Needs attention"/);
});

test('the shapes differ, so the status reads without its colour', () => {
  // A colour-blind admin read the old capsules as three identical badges. Reintroduce by drawing warn with
  // the ok check: "warn and ok share a shape" fails.
  const shape = (tone: Tone) => html(createElement(StatusGlyph, { tone })).replace(/class="[^"]*"/g, '');
  const seen = new Map<string, Tone>();
  for (const tone of TONES) {
    const s = shape(tone);
    assert.ok(!seen.has(s), `${tone} and ${seen.get(s)} share a shape`);
    seen.set(s, tone);
  }
});

test('accent is finished, not working: only `working` turns the ring', () => {
  // lib/status.ts calls accent "working or has finished", and a success notice is accent. Reintroduce the
  // ring for the accent tone (`case 'accent': return <ProgressRing … progress="spin" />`): "a finished
  // accent mark spins" fails -- every success notice would carry a turning ring.
  assert.doesNotMatch(html(createElement(StatusGlyph, { tone: 'accent' })), /data-ring=/, 'a finished accent mark spins');
  assert.doesNotMatch(html(createElement(StatusMark, { tone: 'accent', label: 'Saved' })), /data-ring=/, 'a finished accent mark spins');
  assert.match(html(createElement(StatusGlyph, { tone: 'accent', working: true })), /data-ring=/, 'working is not a small ring');
  assert.match(html(createElement(StatusMark, { tone: 'accent', label: 'Working…', working: true })), /data-ring=/, 'StatusMark drops `working`');
  // The ring keeps the tone's colour on its wrapper, so a working mark is still read in its own tone.
  assert.match(html(createElement(StatusGlyph, { tone: 'accent', working: true })), /^<span class="shrink-0 text-accent">/);
});

test('the start-edge bar: at the logical start, and absent from a healthy or switched-off card', () => {
  // Reintroduce `left-0` for `start-0`: the bar stays on the left in Arabic, where the card starts on the
  // right, and "not at the start edge" fails.
  assert.equal(html(createElement(StatusEdge, { tone: 'ok' })), '', 'a healthy card wears an edge');
  assert.equal(html(createElement(StatusEdge, { tone: 'off' })), '');
  const edge = html(createElement(StatusEdge, { tone: 'problem' }));
  assert.match(edge, /class="pointer-events-none absolute start-0 inset-y-4 w-\[3px\] rounded-e-\[3px\] bg-red-400"/, 'not at the start edge');
  assert.match(edge, /aria-hidden="true"/);
  assert.match(html(createElement(StatusEdge, { tone: 'warn', inset: 'inset-y-0' })), /inset-y-0/);
});

test('Overview\'s Needs attention tiles: the tint from this vocabulary, the start edge, and a shape with a name', () => {
  // The tiles told a problem from a warning by tint alone (the Health capsules' HEALTH_TONE). Now the tint
  // is TONE_SURFACE's, the tile wears the same edge a Health card does, and a glyph says the verdict by
  // shape and to a screen reader. Reintroduce the old tile (`rounded-2xl border px-3 py-2.5
  // ${HEALTH_TONE[c.status]}` with no edge and no mark): "the tile's tint is not the status vocabulary's"
  // fails; by dropping `relative`: the edge is placed against the whole card and "the tile is not
  // positioned" fails.
  const src = readFileSync(join(ROOT, 'app/admin/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const a = src.indexOf('function NeedsAttention(');
  const b = src.indexOf('function TabTile(', a);
  assert.ok(a >= 0 && b > a, 'function NeedsAttention moved');
  const tiles = src.slice(a, b);
  assert.match(tiles, /const m = healthMark\(c\.status\);/, 'the tile does not read the check through healthMark');
  const tile = tiles.match(/<div key=\{c\.id\} className=\{`([^`]*)`\}>/);
  assert.ok(tile, 'the tile moved');
  assert.match(tile![1], /\$\{TONE_SURFACE\[m\.tone\]\}/, 'the tile\'s tint is not the status vocabulary\'s');
  assert.match(tile![1], /(^|\s)relative(\s|$)/, 'the tile is not positioned, so its edge would sit against the card');
  assert.doesNotMatch(tiles, /HEALTH_TONE/, 'the tile still reads the Health capsules\' tints');
  assert.match(tiles, /<StatusEdge tone=\{m\.tone\} inset="inset-y-3" \/>/, 'the tile has no start edge');
  assert.match(tiles, /<StatusMark tone=\{m\.tone\} title=\{m\.label\} \/>\{c\.title\}/, 'the verdict has no shape or name beside the title');
});
