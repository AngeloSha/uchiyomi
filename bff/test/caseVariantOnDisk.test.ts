// The spelling the disk uses for a series folder stored in another case (renamed by hand: `Manga/X` stored, `manga/X` on disk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { caseVariantOnDisk } from '../src/lib/caseVariant';

test('finds the on-disk spelling of a folder stored with another case, and nothing otherwise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cv-'));
  try {
    mkdirSync(join(root, 'manga', 'One Piece'), { recursive: true });
    assert.equal(await caseVariantOnDisk([root], 'Manga/One Piece'), 'manga/One Piece');
    assert.equal(await caseVariantOnDisk([root], 'manga/one piece'), 'manga/One Piece');
    assert.equal(await caseVariantOnDisk([root], 'manga/One Piece'), null, 'the exact spelling is not a variant');
    assert.equal(await caseVariantOnDisk([root], 'Manga/Other'), null, 'nothing on disk under any case');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('looks in every root, and answers only for a folder that exists in full', async () => {
  const a = mkdtempSync(join(tmpdir(), 'cv-a-'));
  const b = mkdtempSync(join(tmpdir(), 'cv-b-'));
  try {
    mkdirSync(join(a, 'manga'), { recursive: true });
    mkdirSync(join(b, 'Manga', 'x'), { recursive: true });
    assert.equal(await caseVariantOnDisk([a, b], 'manga/X'), 'Manga/x', 'the first root has only part of the path');
    assert.equal(await caseVariantOnDisk([a], 'manga/X'), null, 'a path present only up to its parent is not a variant');
    assert.equal(await caseVariantOnDisk([join(a, 'absent')], 'manga/X'), null, 'a root that is not there answers null');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});
