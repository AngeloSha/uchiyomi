// A backup extension's source (v0.82.0, bff lib/backupExtensions.ts) is never offered to browse or pick: Discover, Add
// more sources and the server-wide source order leave it out. GET /api/sources lists it -- flagged -- only so the reader,
// the series page and the downloads can name a chapter's source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSources } from '../lib/sourceGroups';

const code = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('Discover and every source picker leave a backup out', () => {
  // Reintroduce by returning the list as it came (discoverSources = (list) => [...list]): the backup is offered.
  assert.deepEqual(discoverSources([{ id: 'mine' }, { id: 'spare', backup: true }, { id: 'other', backup: false }]).map((s) => s.id), ['mine', 'other']);
  // Each picker through it. Reintroduce by reading the raw list in any of them: its assertion fails.
  assert.match(code('app/discover/page.tsx'), /const sources = useMemo\(\(\) => discoverSources\(sourcesData\?\.content \?\? \[\]\), \[sourcesData\]\);/,
    'Discover');
  assert.match(code('components/MigrateSourceSheet.tsx'), /\(\) => discoverSources\(srcs\.data\?\.content \?\? \[\]\)\.sort\(/, 'Add more sources');
  assert.match(code('components/AdminSettings.tsx'), /const rest = addable\(order, discoverSources\(all\)\);/, 'the source order');
});
