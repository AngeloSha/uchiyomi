// The MangaDex languages' decisions (v0.52.0, #123; lib/mangadexLangs.ts): what one tap on a language sends, when
// turning one off asks first, and that quick taps are saved one at a time in tap order. The chips themselves
// (components/MangadexCard.tsx, in Admin → Sources since v0.54.0) only wire these up; the server half is
// bff/test/mangadexLangs.int.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MANGADEX_LANGUAGES_HREF, offCost, opensMangadexLanguages, serial, toggleLang } from '../lib/mangadexLangs';
import { initialView } from '../lib/sourcesPanel';

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
  // MangaDex's sources as the sources overview lists them (v0.54.0): main and followed series, both stop updating.
  // Count only one of them (`main`): "2 series would stop updating unasked" fails.
  const md = (id: string, name: string, main: number, followed: number) => ({ id, name, main, followed });
  const sources = [md('mangadex', 'MangaDex', 40, 2), md('mangadex-es-419', 'MangaDex (ES-419)', 1, 2), md('mangadex-fr', 'MangaDex (FR)', 0, 0), md('mangadex-pt', 'MangaDex (PT)', 0, 2)];
  assert.deepEqual(offCost(sources, 'es-419'), { name: 'MangaDex (ES-419)', used: 3 }, '3 series would stop updating unasked');
  assert.deepEqual(offCost(sources, 'pt'), { name: 'MangaDex (PT)', used: 2 }, '2 series would stop updating unasked');
  assert.equal(offCost(sources, 'fr'), null, 'a language with no series asks anyway');
  assert.equal(offCost(sources, 'pt-BR'), null, 'a language not registered yet has nothing to lose');
  // An older answer's one count.
  assert.deepEqual(offCost([{ id: 'mangadex-fr', name: 'MangaDex (FR)', used: 4 }], 'fr'), { name: 'MangaDex (FR)', used: 4 });
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

test("the add dialog's link opens Sources at the MangaDex languages, unfolded (v0.52.0)", () => {
  // An edition with no source in another language says "Turn on more MangaDex languages in Admin → Sources", and
  // the link lands on the language chips, not at the top of a long tab. Reintroduce the bare `/admin/?tab=Sources`:
  // "the link does not name the card" fails; start the languages folded: "the card does not unfold" fails.
  const at = new URL(MANGADEX_LANGUAGES_HREF, 'http://x');
  assert.equal(at.pathname, '/admin/');
  assert.equal(at.searchParams.get('tab'), 'Sources', 'the link names the tab by its old name');
  assert.equal(opensMangadexLanguages(at.searchParams), true);
  assert.equal(opensMangadexLanguages(new URLSearchParams('tab=Sources')), false, 'every visit to Sources unfolds it');
  // The languages are in Add sources: the address opens that view (lib/sourcesPanel.ts initialView).
  assert.equal(initialView(at.searchParams), 'add', 'the link lands on Your sources, where the languages are not');
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const dialog = src('components/AddSeriesDialog.tsx');
  assert.equal(dialog.match(/<Link href=\{MANGADEX_LANGUAGES_HREF\}/g)?.length, 2, 'the link does not name the card (none found, or one under the list)');
  assert.doesNotMatch(dialog, /href="\/admin\/\?tab=(Providers|Sources)"/, 'the link does not name the card');
  const card = src('components/MangadexCard.tsx');
  assert.match(card, /const \[arrived\] = useState\(\(\) => !always && opensMangadexLanguages\(params\)\);\s*const \[unfolded, setUnfolded\] = useState\(arrived\);/, 'the card does not unfold');
  assert.match(card, /if \(arrived\) cardRef\.current\?\.scrollIntoView\(/, 'the card is not brought on screen');
});
