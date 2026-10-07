// Edit details, redone (v0.53.0): components/SeriesEditor.tsx and the rules in lib/seriesMeta.ts it saves by.
//
// The owner called the old dialog what it was -- one long column, three ways of saving, a "Save details" key in the
// middle of the scroll, and the art at the bottom with no picture of it. These hold what replaced it: every field
// saves itself and saves the WHOLE object (the route writes every column), one save at a time; the fields seed from
// the overrides exactly as before; the tabs, with Art a tab on a phone only; the art previews and their keys; Mark
// caught up and the folder paths; and one save state for the dialog. The dialog is rendered to markup with
// react-dom/server (as actionList.test.ts does), the save queue driven with plain values. Every guard names the edit
// that makes it fail again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { metaBody, metaSaver, seedMeta, type MetaBody } from '../lib/seriesMeta';
import type { Series } from '../lib/types';
import { SeriesEditor, coverChoices, FIRST_PAGE_COVER, type EditTab } from '../components/SeriesEditor';
import { scopeTakes } from '../components/settings';

// Under tsx the components compile to the classic `React.createElement`, which they look up as a global.
(globalThis as any).React = React;

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const EDITOR = 'components/SeriesEditor.tsx';

const series = (over: Partial<Series> = {}): Series => ({
  id: 's_1', libraryId: 'lib', name: 'Walk Tale', booksCount: 4, booksReadCount: 0, booksUnreadCount: 4, booksInProgressCount: 0,
  metadata: { title: 'Walk Tale', summary: 'A tale.', author: 'Scanned Author', status: 'Ongoing', genres: ['Action'], ageRating: null },
  artVersion: 7,
  autoHero: { seed: 3 },
  paths: ['/library/fake-a/Walk Tale', '/more/fake-a/Walk Tale'],
  sources: [{ sourceId: 'fake-a', name: 'fake-a', sourceSeriesId: 'walk-tale', primary: true, checkedAt: null, chapters: 12, registered: true }],
  detectedDirection: { direction: 'RIGHT_TO_LEFT', from: 'comicinfo' },
  lang: 'en', langAuto: 'en', langStated: false,
  ...over,
});
const OVERRIDES = { title: null, summary: null, cover: null, banner: null, author: null, status: null, genres: null, ageRating: null };

/** The dialog as markup, on `tab`, for `s`. */
const render = (tab: EditTab, s: Series = series(), extra: Record<string, unknown> = {}) => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(SeriesEditor, { id: s.id, series: s, tab, onClose: () => {}, onSaved: () => {}, onOpenSources: () => {}, ...extra })));

/** One element's opening tag, found by an attribute. */
const tagWith = (html: string, attr: string): string => html.match(new RegExp(`<[a-z]+ [^>]*${attr}[^>]*>`))?.[0] ?? '';
/** The markup of one element found by an attribute, to its matching close (same-name nesting counted). */
function elementWith(html: string, attr: string): string {
  const open = new RegExp(`<([a-z]+) [^>]*${attr}[^>]*>`).exec(html);
  if (!open) return '';
  const name = open[1];
  let depth = 0;
  const re = new RegExp(`<${name}[\\s>]|</${name}>`, 'g');
  re.lastIndex = open.index;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(open.index, m.index + m[0].length);
  }
  return html.slice(open.index);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('there is no Save details key: every field saves on its own', () => {
  // The key sat in the middle of the scroll and an edit left above it was lost on close. Reintroduce it (a
  // `<button>{tr('Save details')}</button>` in any tab): "the dialog has a Save details key again" fails.
  for (const tab of ['details', 'art', 'reading', 'updates', 'files'] as const) {
    assert.doesNotMatch(render(tab), /Save details/, `the dialog has a Save details key again (opened on ${tab})`);
  }
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
  for (const f of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /tr\('Save details'\)/, `${f.slice(ROOT.length + 1)} renders a Save details key`);
  }
});

test('a field commits by saving the whole object, one save at a time, and a refused one is put back', async () => {
  // The route writes every column on every call, so a save that sent only the field it changed would clear the
  // rest. Reintroduce `put(patch)` for `put(metaBody(now))` in lib/seriesMeta.ts: "a save sends only the field it
  // changed" fails. Send each save at once instead of after the one before (`queue.catch…` dropped): "the second
  // save went out before the first answered" fails -- and the later body would carry the old status back.
  const sent: MetaBody[] = [];
  const answers: Array<() => void> = [];
  const shown: string[] = [];
  const saver = metaSaver(seedMeta(series()), (body) => { sent.push(body); return new Promise<void>((r) => { answers.push(r); }); }, (m) => shown.push(m.status));
  const first = saver.save({ status: 'COMPLETED' });
  const second = saver.save({ title: 'Renamed' });
  await tick();
  assert.equal(sent.length, 1, 'the second save went out before the first answered');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['adultExempt', 'ageRating', 'author', 'genres', 'readingDirection', 'seriesType', 'status', 'summary', 'title'],
    'a save sends only the field it changed');
  assert.deepEqual(sent[0], {
    title: 'Renamed', summary: 'A tale.', author: 'Scanned Author', status: 'COMPLETED', genres: ['Action'],
    ageRating: null, adultExempt: false, readingDirection: null, seriesType: null,
  }, 'the first save is not the whole object as it stands when it is sent');
  answers.shift()!();
  await first;
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].status, 'COMPLETED', 'the later save put the old status back');
  assert.equal(sent[1].title, 'Renamed');
  answers.shift()!();
  await second;
  assert.equal(shown.at(-1), 'COMPLETED', 'the fields do not show what was saved');

  // Refused: the field goes back to what is saved, the error reaches the row (and so the header), the rest stays.
  const failing = metaSaver(seedMeta(series()), () => Promise.reject(new Error('400')), () => {});
  await assert.rejects(failing.save({ status: 'HIATUS', author: 'Someone' }), /400/, 'a refused save resolves as if it had saved');
  assert.equal(failing.current().status, 'Ongoing', 'a refused status stays on screen');
  assert.equal(failing.current().author, 'Scanned Author');

  // And every field of the dialog commits through that saver, never a PUT of its own.
  const src = read(EDITOR);
  assert.match(src, /metaSaver\(seedMeta\(series\), \(body\) => api\(`\/api\/admin\/series\/\$\{id\}\/meta`, \{ method: 'PUT', json: body \}\), setMeta\)/,
    'the dialog does not save through the whole-object saver');
  for (const f of ['title', 'summary', 'author', 'status', 'genres', 'readingDirection', 'ageRating', 'adultExempt', 'seriesType']) {
    assert.match(src, new RegExp(`\\(${f}\\) => save\\(\\{ ${f} \\}\\)`), `${f} does not commit through save()`);
  }
  assert.equal((src.match(/\/meta`/g) ?? []).length, 1, 'something in the dialog PUTs the meta route itself');
});

test('the fields seed from the override where one exists, exactly as the dialog always has', () => {
  // Seeding author, status, the rating or the genres from the scan alone showed the scanned value over an active
  // override, and the next save wrote it back over the override. "Always show" and the reading direction come from
  // the override ONLY. Reintroduce `author: m?.author ?? ''` in lib/seriesMeta.ts: "an author override is not what
  // the field shows" fails.
  const plain = seedMeta(series());
  assert.deepEqual(plain, {
    title: 'Walk Tale', summary: 'A tale.', author: 'Scanned Author', status: 'Ongoing', ageRating: '', genres: ['Action'],
    adultExempt: false, readingDirection: '', seriesType: '',
  });
  const over = seedMeta(series({
    metadata: { title: 'Walk Tale', summary: 'A tale.', author: 'Scanned Author', status: 'Ongoing', genres: ['Action'], ageRating: 15, readingDirection: 'RIGHT_TO_LEFT' },
    overrides: { ...OVERRIDES, author: 'Hand Author', genres: [], ageRating: 13, adultExempt: true, readingDirection: null },
  }));
  assert.equal(over.author, 'Hand Author', 'an author override is not what the field shows');
  assert.equal(over.status, 'Ongoing', 'no status override falls back to the scanned status');
  assert.deepEqual(over.genres, [], 'genres cleared on purpose come back as the scanned ones');
  assert.equal(over.ageRating, '13', 'a rating override is not what the field shows');
  assert.equal(over.adultExempt, true, '"Always show" is not seeded from the override');
  assert.equal(over.readingDirection, '', 'the detected direction is seeded as if an admin had chosen it');
  assert.equal(seedMeta(series({ metadata: { title: 'Walk Tale', ageRating: 15 } })).ageRating, '15', 'a scanned rating with no override is not shown');
  // A retitle sends the seeded object: the override author kept, the detected direction NOT made an override.
  assert.deepEqual(metaBody({ ...over, title: 'Renamed' }), {
    title: 'Renamed', summary: 'A tale.', author: 'Hand Author', status: 'Ongoing', genres: [], ageRating: 13, adultExempt: true, readingDirection: null, seriesType: null,
  });
  // And the fields show it.
  const html = render('details', series({ overrides: { ...OVERRIDES, author: 'Hand Author' } }));
  assert.match(tagWith(html, 'id="edit-author"'), /value="Hand Author"/, 'the Author field does not show the override');
  assert.match(tagWith(html, 'id="edit-title"'), /value="Walk Tale"/);
  assert.match(tagWith(html, 'id="edit-title"'), /dir="auto"/, 'a title in another script takes the interface\'s direction');
});

test('the tabs: Details, Reading, Updates and Files, with Art a tab of its own on a phone only', () => {
  // From md up the art is the column at the start of every tab; below it there is no room for a column, so Art is
  // a tab. Reintroduce the art tab without `md:hidden`: "Art is a tab on a desktop too" fails; drop 'art' from TABS:
  // "a phone has no Art tab" fails.
  const html = render('details');
  const list = elementWith(html, 'role="tablist"');
  const tabs = [...list.matchAll(/<button [^>]*data-edit-tab="(\w+)"[^>]*>/g)];
  assert.deepEqual(tabs.map((m) => m[1]), ['details', 'art', 'reading', 'updates', 'files'], 'a phone has no Art tab, or the order changed');
  const art = tabs.find((m) => m[1] === 'art')![0];
  assert.match(art, /class="[^"]*\bmd:hidden\b/, 'Art is a tab on a desktop too, beside its own column');
  for (const m of tabs.filter((t) => t[1] !== 'art')) assert.doesNotMatch(m[0], /\bmd:hidden\b/, `${m[1]} is hidden on a desktop`);
  assert.match(tabs[0][0], /aria-selected="true"/);
  assert.match(list, /data-lenis-prevent/, 'the tab row scrolls the page behind it');
  assert.match(list, /class="[^"]*\boverflow-x-auto\b/, 'a tab row too long for a phone pushes the page sideways');
  // Every tab's pane is there, only the open one shown; the art column is shown from md up whatever is open.
  for (const t of ['details', 'reading', 'updates', 'files']) {
    const pane = tagWith(html, `data-edit-pane="${t}"`);
    assert.ok(pane, `no ${t} pane`);
    assert.equal(/\shidden=""/.test(pane), t !== 'details', `the ${t} pane is ${t === 'details' ? 'hidden while open' : 'shown while closed'}`);
  }
  assert.match(tagWith(html, 'data-edit-pane="art"'), /class="hidden min-w-0 md:block"/, 'the art column is not the start column from md up');
  // Opened on Art (a phone): the art is the panel, the fields wait.
  const onArt = render('art');
  assert.match(tagWith(onArt, 'data-edit-pane="art"'), /role="tabpanel"/);
  assert.match(tagWith(onArt, 'data-edit-pane="art"'), /class=" min-w-0 md:block"/, 'the Art tab does not show the art');
});

test('the art: each preview as the series page shows it, with its keys', () => {
  // The cover at 2:3 by the art version, the background through the page's own <Backdrop banner> -- the automatic
  // banner first, as on the page. Reintroduce the preview's Backdrop without `banner`: "the background preview is not
  // the page's sharp banner" fails; drop the autoHero guard on New banner: "New banner is offered for a real banner".
  const html = render('details');
  const cover = elementWith(html, 'data-art-preview="cover"');
  assert.match(cover, /<img src="\/img\/series\/s_1\/thumb\?v=2&amp;av=7&amp;w=800"/, 'the cover preview is not the poster at its art version');
  const banner = elementWith(html, 'data-art-preview="banner"');
  assert.match(banner, /<img src="\/img\/series\/s_1\/hero\?v=3"/, 'the background preview does not show the automatic banner first');
  const real = elementWith(render('details', series({ autoHero: null })), 'data-art-preview="banner"');
  assert.match(real, /<img src="\/img\/series\/s_1\/backdrop\?av=7&amp;style=banner"/, 'the background preview is not the page\'s sharp banner');
  for (const key of ['data-art-upload="cover"', 'data-art-link="cover"', 'data-art-upload="banner"', 'data-art-more="banner"']) {
    assert.match(tagWith(html, key), /class="btn-key[ "]/, `${key} is not a key`);
  }
  assert.match(tagWith(html, 'data-art-more="banner"'), /aria-haspopup="menu"/);
  // The cover's ⋯ holds Use the first page and Reset to automatic (v0.55.7), one of them always to press, so it is
  // always there (coverChoices, below): an automatic cover, an upload and the first page alike.
  for (const cover of [null, 'upload', FIRST_PAGE_COVER]) {
    assert.match(tagWith(render('details', series({ overrides: { ...OVERRIDES, cover } })), 'data-art-more="cover"'), /aria-haspopup="menu"/,
      `a ${cover ?? 'automatic'} cover has no ⋯`);
  }
  // New banner: only while the background is an automatic one, and only where the page hands its shuffle in.
  const shuffle = async () => {};
  assert.ok(tagWith(render('details', series(), { onNewBanner: shuffle }), 'data-art-new-banner'), 'no New banner for an automatic banner');
  assert.equal(tagWith(render('details', series({ autoHero: null }), { onNewBanner: shuffle }), 'data-art-new-banner'), '', 'New banner is offered for a real banner');
  assert.equal(tagWith(html, 'data-art-new-banner'), '', 'New banner without the page\'s shuffle');
  // Upload is a file input for images; the limit is said in words.
  assert.match(html, /<input type="file" accept="image\/\*" hidden=""/, 'no image file input');
  assert.match(html, /Images up to 11 MB\. You can also drop one onto a preview\./, 'the 11 MB limit is not said');
  for (const p of ['cover', 'banner']) assert.match(tagWith(html, `data-art-preview="${p}"`), /data-busy="false"/, `the ${p} preview has no busy state`);
});

test('Use the first page: offered unless it already is, Reset only over a choice, and the cover says which it is', () => {
  // v0.55.7 (#168). A menu of nothing but greyed items takes no focus, and the Escape meant to close it closed the dialog
  // under it: every state leaves one of the two. Reintroduce Use the first page as always on (`firstPage: true`): "a
  // cover that is the first page offers it again" fails; Reset as always on: "an automatic cover offers Reset".
  assert.deepEqual(coverChoices(null), { firstPage: true, reset: false }, 'an automatic cover offers Reset');
  assert.deepEqual(coverChoices('upload'), { firstPage: true, reset: true });
  assert.deepEqual(coverChoices('https://example.org/c.jpg'), { firstPage: true, reset: true });
  assert.deepEqual(coverChoices(FIRST_PAGE_COVER), { firstPage: false, reset: true }, 'a cover that is the first page offers it again');
  for (const c of [null, undefined, 'upload', FIRST_PAGE_COVER]) {
    const can = coverChoices(c);
    assert.ok(can.firstPage || can.reset, `the ⋯ of a ${c ?? 'automatic'} cover holds nothing to press`);
  }
  // The menu is built from them, with the first page's own hook for the browser walk.
  const src = read(EDITOR);
  assert.match(src, /label: tr\('Use the first page'\), onSelect: \(\) => void firstPage\(\), disabled: !can\.firstPage, hook: 'cover-first-page'/);
  assert.match(src, /label: tr\('Reset to automatic'\), onSelect: \(\) => void reset\('cover'\), disabled: !can\.reset/);
  assert.match(src, /mode: 'first_page'/, 'the choice is not the route\'s first_page');
  // Under the cover: what automatic means -- what Reset to automatic gives back -- or the choice; an upload needs no words.
  const note = (cover: string | null) => elementWith(render('details', series({ overrides: { ...OVERRIDES, cover } })), 'data-art-cover-note');
  assert.match(note(null), /Automatic: the source’s cover, or AniList’s when its entry has the same name, else the first page\./);
  assert.match(note(FIRST_PAGE_COVER), /The first page, by your choice: nothing found online replaces it\./);
  assert.equal(note('upload'), '', 'an uploaded cover is explained in words');
  assert.match(elementWith(render('details'), 'data-art-cover-note'), /Automatic:/, 'a series with no overrides at all says nothing');
});

test('Mark caught up and the folder paths are still there, in Updates and Files', () => {
  // Reintroduce the paths without `dir="ltr"`: "a path reads right to left in Arabic" fails; drop `data-series-paths`
  // or `data-caught-up`: the hooks the walks use are gone and these fail by name.
  const updates = render('updates');
  const caught = elementWith(updates, 'data-caught-up="idle"');
  assert.ok(caught, 'Mark caught up is gone for a series with a source');
  assert.match(caught, /<button type="button" class="btn-key">Mark caught up<\/button>/);
  assert.doesNotMatch(render('updates', series({ sources: [] })), /data-caught-up/, 'Mark caught up offered for a series with nothing to fetch from');
  assert.match(updates, /Check for new chapters now/);
  assert.match(updates, /<button type="button" class="group flex w-full[^"]*">.*Sources &amp; translations/, 'Updates has no way to Sources & translations');
  assert.match(render('updates', series(), { onOpenSources: undefined }), /Translation groups are ranked in Sources &amp; translations/,
    'without the sheet there is no word of where the groups went');
  const paths = elementWith(render('files'), 'data-series-paths');
  assert.ok(paths, 'the folder on the server is gone');
  const codes = [...paths.matchAll(/<code dir="(\w+)"[^>]*>([^<]*)<\/code>/g)];
  assert.deepEqual(codes.map((m) => m[2]), ['/library/fake-a/Walk Tale', '/more/fake-a/Walk Tale']);
  assert.ok(codes.every((m) => m[1] === 'ltr'), 'a path reads right to left in Arabic');
  assert.equal((paths.match(/>Copy<\/button>/g) ?? []).length, 2, 'not every path has its Copy');
});

test('one save state for the whole dialog: the rows under its scope draw none, and it shows the latest save', () => {
  // A tick at every row and one in the header is "Saved" twice. Reintroduce the row's own SaveState under a scope
  // (drop `!scoped &&` in settings.tsx Row): "the rows draw save states of their own" fails.
  for (const tab of ['details', 'reading', 'updates', 'files'] as const) {
    const html = render(tab);
    assert.equal((html.match(/role="status"/g) ?? []).length, 1, `the rows draw save states of their own (on ${tab})`);
    assert.match(html, /<div data-edit-save="idle"[^>]*><span role="status" aria-live="polite"/, 'the header has no save state');
  }
  // The label is the latest save's; an older save finishing does not take it back, an error always does.
  // Reintroduce `|| from === owner` alone (no error rule): "an older save's error is hidden" fails.
  assert.equal(scopeTakes('a', 'b', { kind: 'saving' }), true, 'a new save does not take the label');
  assert.equal(scopeTakes('b', 'a', { kind: 'saved' }), false, 'an older save\'s tick replaced the newer one\'s Saving…');
  assert.equal(scopeTakes('b', 'b', { kind: 'saved' }), true);
  assert.equal(scopeTakes('b', 'a', { kind: 'error', message: 'No' }), true, 'an older save\'s error is hidden');
});

test('what moves stands still under Reduce effects as under reduced motion, and Escape is not taken twice', () => {
  // The tab underline and the segments' mark slide; the art's busy ring is ProgressRing, which already stands still.
  // Reintroduce the underline's transition without `plain ||`: it springs under Reduce effects and this fails.
  const src = read(EDITOR);
  assert.match(src, /layoutId=\{`\$\{uid\}-underline`\}[\s\S]{0,200}transition=\{plain \|\| still \? \{ duration: 0 \}/, 'the tab underline slides under Reduce effects');
  assert.match(src, /<ProgressRing progress="spin" size="cover" onCover/, 'the art\'s busy state is not the still-able ring');
  const kit = read('components/settings.tsx');
  assert.match(kit, /transition=\{still \|\| plain \? \{ duration: 0 \}/, 'the segments\' mark slides under Reduce effects');
  // An Escape a field used to put an edit back (TextRow, the description, a link field) is not also a close: the
  // dialog skips a handled one. Reintroduce the close without the check: "the dialog closes on an Escape a field used".
  assert.match(src, /if \(e\.defaultPrevented\) return;\s*if \(e\.key === 'Escape'\) closeRef\.current\(\);/, 'the dialog closes on an Escape a field used');
  assert.match(kit, /if \(draft !== last\.current\) e\.preventDefault\(\);\s*setDraft\(last\.current\);/, 'TextRow does not mark the Escape that puts an edit back');
});

test('the picture over the page is called a banner everywhere, and its words are translated', () => {
  // The panel said "Background" over a key reading "New banner": every language has two words for those (Hintergrund /
  // Banner, Фон / баннер), so it read as two pictures. Reintroduce tr('Background') or a "background" notice: this fails.
  const editor = read('components/SeriesEditor.tsx');
  assert.doesNotMatch(editor, /tr\('[^']*[Bb]ackground[^']*'\)/, 'the banner is called a background in Edit details again');
  for (const k of ['Banner', 'Banner updated', 'Banner reset to automatic', 'Could not change the banner', 'More banner options']) {
    assert.ok(editor.includes(`tr('${k}')`), `Edit details does not say "${k}"`);
  }
  // The genres help named a Browse page that the Library replaced (v0.27.0); translators took it for the extension catalogue.
  assert.doesNotMatch(editor, /Genres drive Browse/, 'the genres help points at a page that is gone');
  // Content → Art's notices and the home page's "Because you read" were English in every language.
  const admin = read('app/admin/page.tsx');
  assert.doesNotMatch(admin, /toast\(`\$\{kind === 'banner' \? 'Banner' : 'Cover'\} updated`/, 'Content → Art says "updated" in English');
  assert.doesNotMatch(admin, /toast\('Failed to apply'/, 'Content → Art fails in English');
  assert.doesNotMatch(read('app/page.tsx'), /<SectionTitle>Because you read \{/, 'the home page says "Because you read" in English');
  // Arabic letters are joined: letter-spacing pulls them apart (the Source health group head already says so).
  // Admin → Sources' heads (v0.54.0; Extensions' group heads before): every letter-spaced one is plain in Arabic.
  const heads = [...read('components/SourcesPanel.tsx').matchAll(/className="([^"]*\btracking-(?:wider|widest|\[[^\]]+\])[^"]*)"/g)].map((m) => m[1]);
  assert.ok(heads.length >= 2, 'the Sources heads are not where this test looks');
  for (const c of heads) assert.match(c, /\brtl:tracking-normal\b/, `a Sources head spaces Arabic letters apart: ${c}`);
});
