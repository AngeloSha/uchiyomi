// The MangaDex card's decisions (v0.52.0, #123; lib/mangadexLangs.ts): what one tap on a language sends, when
// turning one off asks first, and that quick taps are saved one at a time in tap order. The card itself
// (components/MangadexCard.tsx) only wires these to its chips; the server half is bff/test/mangadexLangs.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { offCost, serial, toggleLang } from '../lib/mangadexLangs';
import { groupProviders, type ProviderSrc } from '../lib/providerGroups';

const AVAILABLE = ['en', 'es-419', 'es', 'pt-BR', 'pt', 'fr', 'zh-Hans', 'zh-Hant'];

test("one tap turns a language on or off, and the list keeps the picker's order, never English", () => {
  // Reintroduce by appending the tapped code (`[...on, code]`) without the reorder: "in the picker's order" fails,
  // and the PATCH would say ['fr', 'es-419'] for what the server keeps as ['es-419', 'fr'].
  assert.deepEqual(toggleLang(AVAILABLE, ['fr'], 'es-419'), ['es-419', 'fr'], "in the picker's order");
  assert.deepEqual(toggleLang(AVAILABLE, ['es-419', 'fr'], 'es-419'), ['fr'], 'a second tap turns it off');
  assert.deepEqual(toggleLang(AVAILABLE, ['fr'], 'en'), ['fr'], 'English is always on and never sent');
  assert.deepEqual(toggleLang(AVAILABLE, [], 'zh-Hant'), ['zh-Hant']);
});

test('turning off a language that series came from asks first, with its name and how many; an unused one does not', () => {
  // Reintroduce by asking for every language (or none): "a language with no series asks anyway" or "3 series would
  // stop updating unasked" fails.
  const md = (id: string, name: string, used: number): ProviderSrc =>
    ({ id, name, lang: null, used, status: 'ok', extension: { pkgName: 'mangadex', name: 'MangaDex' } });
  const [g] = groupProviders([md('mangadex', 'MangaDex', 40), md('mangadex-es-419', 'MangaDex (ES-419)', 3), md('mangadex-fr', 'MangaDex (FR)', 0)]);
  assert.deepEqual(offCost(g, 'es-419'), { name: 'MangaDex (ES-419)', used: 3 }, '3 series would stop updating unasked');
  assert.equal(offCost(g, 'fr'), null, 'a language with no series asks anyway');
  assert.equal(offCost(g, 'pt-BR'), null, 'a language not registered yet has nothing to lose');
});

test('quick taps are saved one at a time, in tap order, and a refused save does not stop the next', async () => {
  // Three taps, where the first save is the slowest. Reintroduce by sending each at once (serial() returning the job
  // unchained): the second and third start while the first is still out -- "started before the one before it
  // settled" -- and the server could keep the first tap's list last.
  const run = serial();
  const log: string[] = [];
  let active = 0;
  const job = (name: string, ms: number, fail = false) => () => new Promise<string>((resolve, reject) => {
    log.push(`start ${name}`);
    assert.equal(active, 0, `${name} started before the one before it settled`);
    active++;
    setTimeout(() => { active--; log.push(`end ${name}`); if (fail) reject(new Error(name)); else resolve(name); }, ms);
  });
  const a = run(job('a', 30, true));
  const b = run(job('b', 5));
  const c = run(job('c', 1));
  await assert.rejects(a, /a/);
  assert.equal(await b, 'b');
  assert.equal(await c, 'c');
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});
