// Finding the pages that are not the story.
//
// A scanlation group's credit page is the same image in every chapter, so a page whose perceptual hash
// recurs across chapters of one series is furniture. That is the whole idea, and these tests pin the two
// decisions that keep it from hiding something real: how much evidence is enough, and whose evidence counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pageHash, junkHashes, carriesIdentity, MIN_CHAPTERS, MIN_BITS } from '../src/lib/pageHash';

/**
 * A deterministic test page: a soft gradient with a few solid blocks on it.
 *
 * ⚠️ Deliberately NOT random noise. A first attempt used an XOR pattern, and the re-encode test failed --
 * correctly. Noise is the pathological case for JPEG: lossy compression exists to throw away exactly that
 * high-frequency detail, so the downsample lands somewhere else and the hash moves. Real pages are the
 * opposite -- large flat areas, panel borders, blocks of text -- and a credit page most of all. This
 * fixture is shaped like the thing the feature actually runs on, which is what makes the robustness claim
 * below mean anything. The honest limit: this hash survives re-encoding of PAGES, not of noise.
 */
async function png(seed: number, w = 400, h = 600): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // a smooth background...
      let v = Math.round(40 + (x / w) * 120 + (y / h) * 60);
      // ...with solid blocks whose position depends on the seed, like panels or a text box
      const bx = Math.floor((x / w) * 4);
      const by = Math.floor((y / h) * 6);
      if ((bx + by * 4 + seed) % 5 === 0) v = 235;
      else if ((bx * 3 + by + seed) % 7 === 0) v = 15;
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('the same picture hashes the same, a different one does not', async () => {
  const a = await pageHash(await png(1));
  const b = await pageHash(await png(1));
  const c = await pageHash(await png(2));
  assert.ok(a, 'a readable page should hash');
  assert.equal(a, b, 'the same image must give the same hash, or nothing ever matches');
  assert.notEqual(a, c, 'different images must not collide, or story pages get flagged');
  assert.match(a!, /^[0-9a-f]{16}$/, '64 bits as hex');
});

test('different pages are far apart, which is what makes equality safe', async () => {
  // ⚠️ This test exists because the first design was wrong. The plan was to match "within N bits", the way
  // dHash is normally used. Measuring killed it: on page-shaped images the same page re-encoded lands 0-5
  // bits away, and DIFFERENT pages were observed as close as 4. The ranges overlap, so any threshold loose
  // enough to catch a re-encode can also hide a story page.
  //
  // So matching is exact equality, and what this pins is the property that makes that safe: genuinely
  // different pages are nowhere near each other, so an equal hash means the same picture.
  const bits = (h: string) => BigInt('0x' + h).toString(2).padStart(64, '0');
  const dist = (a: string, b: string) => {
    const x = bits(a), y = bits(b);
    let d = 0;
    for (let i = 0; i < 64; i++) if (x[i] !== y[i]) d++;
    return d;
  };
  const hs: string[] = [];
  for (let s = 1; s <= 8; s++) hs.push((await pageHash(await png(s)))!);
  for (let i = 0; i < hs.length; i++) {
    for (let j = i + 1; j < hs.length; j++) {
      assert.notEqual(hs[i], hs[j], 'two different pages produced the same hash — that is a false positive');
      assert.ok(dist(hs[i], hs[j]) >= 3, `pages ${i} and ${j} are only ${dist(hs[i], hs[j])} bits apart`);
    }
  }
});

test('the same file re-encoded often still matches, but nothing depends on it', async () => {
  // Recorded rather than relied upon: a lossless re-encode of the same page usually lands on the same hash,
  // which is a bonus. A page re-compressed differently in every chapter simply never reaches the threshold
  // and is never skipped — fewer skips, which is the safe direction.
  const original = await png(5, 800, 1200);
  const same = await pageHash(await sharp(original).png().toBuffer());
  assert.equal(same, await pageHash(original), 'a lossless round-trip must not move the hash');
});

test('an unreadable page is not a junk page', async () => {
  // Returning null leaves it unhashed and therefore never flagged. The failure mode must be "we skip
  // nothing", never "we hide a page we could not read".
  assert.equal(await pageHash(Buffer.from('this is not an image')), null);
});

test('a page must appear in three chapters before it counts', () => {
  const credit = 'aaaaaaaaaaaaaaaa';
  const two = junkHashes([
    { bookId: 'c1', page: 1, hash: credit },
    { bookId: 'c2', page: 1, hash: credit },
  ]);
  // Reintroduce by lowering MIN_CHAPTERS to 2: a two-chapter series that shares a title card has it skipped
  // on the strength of a single coincidence, and two chapters is the commonest part-downloaded state.
  assert.equal(two.size, 0, 'two chapters is a coincidence, not evidence');

  const three = junkHashes([
    { bookId: 'c1', page: 1, hash: credit },
    { bookId: 'c2', page: 1, hash: credit },
    { bookId: 'c3', page: 1, hash: credit },
  ]);
  assert.deepEqual([...three], [credit], 'three chapters is the threshold');
  assert.equal(MIN_CHAPTERS, 3);
});

test('the same page twice in ONE chapter is not evidence', () => {
  // Counting rows rather than chapters would let a single chapter with a repeated page flag itself.
  const h = 'bbbbbbbbbbbbbbbb';
  const out = junkHashes([
    { bookId: 'c1', page: 1, hash: h },
    { bookId: 'c1', page: 9, hash: h },
    { bookId: 'c1', page: 17, hash: h },
  ]);
  assert.equal(out.size, 0, 'evidence is distinct chapters, not occurrences');
});

test('a story page is never flagged', () => {
  const pages = [
    { bookId: 'c1', page: 1, hash: 'c0dec0de5a5a3c3c' },
    { bookId: 'c1', page: 2, hash: 'a1b2c3d4e5f60789' },
    { bookId: 'c2', page: 1, hash: 'c0dec0de5a5a3c3c' },
    { bookId: 'c2', page: 2, hash: 'b2c3d4e5f6a71234' },
    { bookId: 'c3', page: 1, hash: 'c0dec0de5a5a3c3c' },
    { bookId: 'c3', page: 2, hash: 'c3d4e5f6a7b85678' },
  ];
  const junk = junkHashes(pages);
  assert.deepEqual([...junk], ['c0dec0de5a5a3c3c']);
  for (const p of pages.filter((x) => x.hash.startsWith('story'))) {
    assert.ok(!junk.has(p.hash), `${p.hash} is a story page and must never be flagged`);
  }
});

test('evidence from one series cannot flag a page in another', () => {
  // ⚠️ The caller passes ONE series' pages. This test states the contract that makes that safe: the
  // function counts chapters, so mixing two series in would let a page be flagged on evidence from a book
  // the reader never opened, where nobody ever compared them.
  // Reintroduce by hashing across the whole library instead of per series.
  const shared = 'cccccccccccccccc';
  const seriesA = [
    { bookId: 'a1', page: 1, hash: shared },
    { bookId: 'a2', page: 1, hash: shared },
  ];
  const seriesB = [{ bookId: 'b1', page: 1, hash: shared }];
  assert.equal(junkHashes(seriesA).size, 0, 'two chapters in this series is not enough on its own');
  assert.equal(junkHashes([...seriesA, ...seriesB]).size, 1,
    'and this is exactly what a global scan would do: three "chapters" spanning two series');
});

test('pages that never hashed are ignored rather than grouped', () => {
  const out = junkHashes([
    { bookId: 'c1', page: 1, hash: '' },
    { bookId: 'c2', page: 1, hash: '' },
    { bookId: 'c3', page: 1, hash: '' },
  ] as any);
  assert.equal(out.size, 0, 'empty hashes must not all group together into one huge false match');
  // ⚠️ The fixtures in this file are REAL 16-hex-char values on purpose. An earlier version used readable
  // stand-ins like 'credit0000000000', which are not hex at all -- so once the hash had to be parsed to be
  // judged, those tests were exercising a value the app could never produce.
});

test('a blank page is not hashed at all', async () => {
  // ⚠️ Found while writing the browser-test fixture, which generated solid-colour pages. A flat page has
  // every neighbouring pixel equal, so all 64 comparisons are false and the hash is all zeros -- and EVERY
  // flat page produces that identical hash whatever its colour. Left unguarded, three blank pages of three
  // different colours look like the same page repeated three times, which is exactly the pattern that
  // flags furniture. Refusing to hash them means they are never skipped.
  const flat = async (v: number) =>
    sharp(Buffer.alloc(400 * 600 * 3, v), { raw: { width: 400, height: 600, channels: 3 } }).png().toBuffer();
  assert.equal(await pageHash(await flat(255)), null, 'a white page must not hash');
  assert.equal(await pageHash(await flat(0)), null, 'nor a black one');
  assert.equal(await pageHash(await flat(128)), null, 'nor a grey one');
  // and the real thing still does
  assert.ok(await pageHash(await png(1)), 'a page with content must still hash');
});


/**
 * A long-strip slice that fades top to bottom and is uniform left to right.
 *
 * ⚠️ This is the real shape that defeated the first guard, not an invented edge case: 800x1280 webtoon slices
 * whose GLOBAL brightness range is the maximum possible 255, and whose every horizontal neighbour is identical.
 */
async function verticalFade(from: number, to: number, w = 200, h = 400): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = Math.round(from + ((to - from) * y) / (h - 1));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('a page with no LEFT-TO-RIGHT variation is not hashed, however bright top to bottom', async () => {
  // ⚠️ The bug this pins shipped in v0.25.0 and was skipping 100 pages of a real library. The old guard asked
  // for the global min/max range of the thumbnail, which these pages pass at the maximum possible value of
  // 255 -- while every comparison the hash actually makes is a tie, so both hash to all zeros and collide.
  // Reintroduce by measuring the global range instead of the per-row range in pageHash.
  const a = await verticalFade(0, 255);
  const b = await verticalFade(255, 0);   // a DIFFERENT image: the same fade upside down
  assert.equal(await pageHash(a), null, 'a vertical-only fade must not hash');
  assert.equal(await pageHash(b), null, 'nor its opposite');
  // and a page with real horizontal structure still does
  assert.ok(await pageHash(await png(3)), 'a page with content must still hash');
});

test('a hash carries identity only when enough comparisons found a difference', () => {
  assert.equal(carriesIdentity('0000000000000000'), false, 'no bits set says nothing about a page');
  assert.equal(carriesIdentity('ffffffffffffffff'), false, 'nor does the same failure in negative');
  assert.equal(carriesIdentity('0100000000000000'), false, 'one bit is not identity');
  assert.equal(carriesIdentity(null), false);
  assert.equal(carriesIdentity(''), false);
  assert.equal(carriesIdentity('d8c5a0a265a69d6d'), true, 'a real page hash is evidence');
  assert.equal(MIN_BITS, 8);
});

test('pages sharing an information-free hash are not treated as the same page', () => {
  // ⚠️ The half of the fix that works without re-reading anything. Hashes already stored were written by the
  // old guard and the backfill never revisits a chapter it has seen, so the gate has to be applied where the
  // matching happens too. On the real library the all-zero hash alone was flagging 100 pages this way.
  // Reintroduce by dropping the carriesIdentity filter in junkHashes.
  const flat = '0000000000000000';
  assert.equal(junkHashes([
    { bookId: 'c1', page: 1, hash: flat },
    { bookId: 'c2', page: 1, hash: flat },
    { bookId: 'c3', page: 1, hash: flat },
  ]).size, 0, 'three different blank slices are not one repeated page');

  // and a real credit page in the same series is still found
  const credit = 'd8c5a0a265a69d6d';
  assert.deepEqual([...junkHashes([
    { bookId: 'c1', page: 1, hash: credit }, { bookId: 'c1', page: 2, hash: flat },
    { bookId: 'c2', page: 1, hash: credit }, { bookId: 'c2', page: 2, hash: flat },
    { bookId: 'c3', page: 1, hash: credit }, { bookId: 'c3', page: 2, hash: flat },
  ])], [credit], 'the gate must not cost us the page we are actually after');
});

test('the junk skipper never flags a placeholder: a partial chapter\'s flat page hashes null', async () => {
  // A chapter saved with pages missing (lib/partial.ts) carries a flat placeholder image at every missing
  // index, and the same placeholder appears in every partial chapter of the library. If it hashed, three
  // partial chapters would make it a "repeated credit page" and the reader would skip the very slot the
  // caption lives on. It does not: a flat image has no horizontal variation, so the identity gate above
  // returns null and nothing in junkPages.ts had to learn what a placeholder is.
  //
  // Reintroduce by drawing anything on the placeholder in placeholderPng() -- a line of text, a border --
  // or by lowering the `widest < 8` gate in pageHash(): the hash comes back as a string and the assertion
  // fails.
  process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  const { placeholderPng } = await import('../src/lib/partial');
  assert.equal(await pageHash(await placeholderPng(800, 1200)), null, 'the placeholder carries no identity');
  assert.equal(await pageHash(await placeholderPng(640, 300)), null, 'at any size');
  assert.equal(await pageHash(await sharp(await placeholderPng(800, 1200)).jpeg().toBuffer()), null, 'and re-encoded');
});
