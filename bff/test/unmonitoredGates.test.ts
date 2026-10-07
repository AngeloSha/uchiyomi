// Unmonitor means no new chapter is searched for or downloaded by anything unattended. The sweep always honoured
// `lib_series.auto_update`; these are the other automatic jobs that fetched for a paused series, each held to its gate.
// Reintroduce any one by dropping its `auto_update` test or its `unattended: true`: the matching assertion fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8');

test('every unattended job that downloads leaves an unmonitored series alone', () => {
  const updater = src('lib/updater.ts');
  assert.match(updater, /if \(opts\.unattended && s\.auto_update === false\) return nothing\(s\.title, 'paused'\)/, 'visitSeries no longer answers paused');
  assert.match(updater, /WHERE b\.missing_pages IS NOT NULL[\s\S]{0,200}AND s\.auto_update/, 'the sweep\'s partial-chapter pass fetches for a paused series');

  const repair = src('lib/repair.ts');
  assert.match(repair, /updateSeries\(id, 10, \{ hunt: wide \? false : budget, cancelled, unattended: true, folderHeld: true \}\)/, 'Retry now / Fix all re-checks a paused series');
  assert.match(repair, /updateSeries\(s\.id, AUTOFIX_RECHECK_CHAPTERS, \{ hunt: false, cancelled, unattended: true/, 'Fix everything\'s failures step re-checks a paused series');
  assert.match(repair, /\$\{opts\.bookId \? 'AND b\.id = \$3' : 'AND s\.auto_update'\}/, 'the short-chapter step replaces chapters of a paused series');
  assert.match(repair, /unattended: !opts\.seriesId/, 'the nightly gap fetch fetches for a paused series');

  assert.match(src('lib/autofix.ts'), /updateSeries\(t\.id, 100, \{ hunt: false, cancelled: \(\) => halted\(a\), unattended: true \}\)/,
    'Fix everything after a source is replaced fetches for a paused series');
  assert.match(src('lib/archive.ts'), /WHERE a\.state = 'queued' AND \$\{visibleToAll\('s'\)\}[\s\S]{0,300}AND s\.auto_update/, 'the slow archive fetches for a paused series');
});
