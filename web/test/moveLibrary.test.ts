// Move library, from the series page's More and a card's menu: one dialog (components/MoveToLibrary.tsx), shared with the
// Library's Select mode, over the admin routes that already existed (POST /api/admin/series/:id/library).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { seriesActionGroups, type SeriesActionsInput } from '../lib/seriesActions';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const BASE: SeriesActionsInput = {
  isAdmin: false, mayDownload: false, booksCount: 10, mayArchive: false, autoHero: false, hasFolder: false, offline: false,
  notes: { notes: 0, bookmarks: 0 }, hiddenChapters: 0,
} as unknown as SeriesActionsInput;
const ids = (x: SeriesActionsInput) => seriesActionGroups(x).flatMap((g) => g.items.map((i) => i.id));

test('Move library is an admin item in More, greyed while offline, and nobody else sees it', () => {
  assert.ok(!ids(BASE).includes('move'), 'a member is offered Move library');
  assert.ok(ids({ ...BASE, isAdmin: true }).includes('move'));
  const item = seriesActionGroups({ ...BASE, isAdmin: true, offline: true }).flatMap((g) => g.items).find((i) => i.id === 'move')!;
  assert.equal(item.disabled, true);
  assert.equal(item.label, 'Move library');
});

test('the series page and the card menu file the series through the single-series route', () => {
  for (const f of ['app/series/page.tsx', 'components/SeriesMenu.tsx']) {
    assert.match(read(f), /api\(`\/api\/admin\/series\/\$\{encodeURIComponent\((id|series\.id)\)\}\/library`, \{ json: \{ libraryId \} \}\)/, `${f} does not post the library`);
    assert.match(read(f), /<MoveToLibrary n=\{1\}/, `${f} does not open the picker`);
  }
  assert.match(read('components/SeriesMenu.tsx'), /isAdmin \? \[\{ label: tr\('Move library'\)/, "a member's card menu offers Move library");
  assert.match(read('app/series/page.tsx'), /case 'move': setMoving\(true\); break;/);
});

test('one picker serves the Library and the series: Automatic hands the series back to the folder rule', () => {
  const picker = read('components/MoveToLibrary.tsx');
  assert.match(picker, /onPick\(null\)/);
  assert.match(picker, /No files move\./);
  assert.doesNotMatch(read('app/library/page.tsx'), /function MoveToLibrary\(/, 'the Library keeps its own copy');
  assert.match(read('app/library/page.tsx'), /import \{ MoveToLibrary \} from '@\/components\/MoveToLibrary'/);
});
