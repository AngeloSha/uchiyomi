// The facts under Admin → Overview's heading: "204 series · 48,445 chapters · 1 member · …".
//
// v0.61.2 (#204): the chapters joined the series there, from the stats' new booksTotal, so the one number a dashboard
// can now read is on the admin's own screen too. Both counts are grouped as the reader's language groups digits
// (numberText): the chapters run to tens of thousands. A server older than the field sends none, and the fact is left
// out rather than saying "0 chapters".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
/** The file with its comments removed -- comments here quote the code they describe. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the Overview line counts the chapters beside the series, grouped (#204)', () => {
  const src = code(readFileSync(join(ROOT, 'app/admin/page.tsx'), 'utf8'));
  const facts = src.slice(src.indexOf('const facts = ['), src.indexOf('].filter(Boolean) as string[];'));
  assert.ok(facts.length > 0, 'the facts list is not where this test looks');
  assert.match(facts, /tr\('\{n\} series', \{ n: numberText\(stats\.seriesTotal\) \}\)/, 'the series count is not grouped');
  // Reintroduce by dropping the chapters fact: neither match below holds.
  assert.match(facts, /typeof stats\?\.booksTotal === 'number'/, 'the chapters are shown without checking the server sent them');
  assert.match(facts, /tr\('\{n\} chapters', \{ n: numberText\(stats\.booksTotal\) \}\)/, 'the chapters are not counted, or not grouped');
  // Right after the series: the two counts read together.
  assert.ok(facts.indexOf('booksTotal') > facts.indexOf('seriesTotal') && facts.indexOf('booksTotal') < facts.indexOf('members'),
    'the chapters do not sit beside the series');
});
