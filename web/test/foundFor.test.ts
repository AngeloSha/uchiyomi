// Why a source Uchiyomi followed on its own is there (v0.81.0, components/SourcesSheet.tsx foundForText), in the reader's
// words: one short sentence per reason, said only for an automatic follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupText, foundForText } from '../components/SourcesSheet';

test('each reason is one plain sentence with when', () => {
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  // Reintroduce by sending every reason to the default: the scout's row reads "Added with the series".
  assert.match(foundForText('scout', at), /^Added .+: the other sources could not get its chapters$/);
  assert.match(foundForText('failed_chapter', at), /^Added .+: a chapter failed on the other sources$/);
  assert.match(foundForText('short_chapter', at), /^Added .+: a chapter was incomplete on the other sources$/);
  assert.match(foundForText('gap', at), /^Added .+: it has chapters the other sources do not$/);
  assert.match(foundForText('add', at), /^Added with the series, /);
});

test('the sentence is said only under a source the server followed', () => {
  const src = readFileSync(join(__dirname, '..', 'components', 'SourcesSheet.tsx'), 'utf8');
  // Reintroduce by dropping `s.auto &&`: a person's own follow would carry a reason nobody gave.
  assert.match(src, /\{!s\.backup && s\.auto && s\.foundFor && s\.followedAt && \(/);
});

test('a backup extension\'s source says it is one, and that it stays only until the other sources can get the chapters', () => {
  // v0.82.0 (bff lib/backupExtensions.ts). Reintroduce by giving it the automatic follow's own reason (drop the backup
  // line): the reader is never told it goes again.
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  assert.match(backupText(at), /^Added .+ as a backup, until the other sources can get its chapters$/);
  assert.equal(backupText(null), 'A backup, until the other sources can get its chapters');
  const src = readFileSync(join(__dirname, '..', 'components', 'SourcesSheet.tsx'), 'utf8');
  assert.match(src, /\{!s\.primary && s\.backup && \(\s*<span[^>]*data-backup-source>\{backupText\(s\.followedAt\)\}<\/span>/);
});
