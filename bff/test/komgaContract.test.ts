// The Komga client contract, pinned.
//
// Both clients of the Komga-compatible API decode with kotlinx.serialization and no `coerceInputValues`, so a
// missing non-nullable field, or a JSON null in one, throws -- and fails the decode of the whole list the row
// sits in. Nothing on our side would notice: the phone shows an empty source and a toast. This file is the
// hand-copied list of every field the Kotlin classes declare WITHOUT a default, with the JSON type each must
// carry, checked against what lib/komgaDto emits for the thinnest DTO ownedCatalog can produce (nulls and
// blanks everywhere). Copied from:
//
//   keiyoushi/extensions-source @9137b65d  src/all/komga/src/eu/kanade/tachiyomi/extension/all/komga/dto/Dto.kt
//     LibraryDto L11-15, SeriesDto L17-28, SeriesMetadataDto L50-72, BookMetadataAggregationDto L74-84,
//     BookDto L86-100, MediaDto L135-142, PageDto L144-149, BookMetadataDto L151-167, AuthorDto L169-173
//   keiyoushi ... dto/PageWrapperDto.kt L8-19
//   mihonapp/mihon @424bbc53  app/src/main/java/eu/kanade/tachiyomi/data/track/komga/KomgaModels.kt
//     SeriesDto L5-19 (adds the three read counts), SeriesMetadataDto L21-42, BookMetadataAggregationDto L44-53,
//     ReadProgressV2Dto L99-107
//
// A field with `= default` (MediaDto.mediaProfile, BookMetadataAggregationDto.authors/tags, totalBookCount) is
// listed as optional so its absence is tolerated but its type still checked when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  springPage, komgaDate, komgaDateOrNull, komgaDay, komgaSeries, komgaBook, komgaPage, komgaStatus,
  komgaReadingDirection, parseSeriesQuery, parseBooksQuery, listParam, komgaSort, PAGE_SIZE_MAX, humanSize,
} from '../src/lib/komgaDto';

// ---- the schema language ----------------------------------------------------------------------------------

type Kind = 'string' | 'string?' | 'int' | 'float' | 'double' | 'long' | 'bool' | 'strings' | 'authors' | 'int?';
/** `[kind]` = required; `[kind, 'opt']` = has a Kotlin default (may be absent, must type-check when present). */
type Field = [Kind] | [Kind, 'opt'];
type Schema = Record<string, Field | { object: Schema }>;

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** Throws on the first violation, naming the path -- the same loudness kotlinx would have on the phone. */
function check(obj: any, schema: Schema, path = '$'): void {
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), `${path} must be an object`);
  for (const [name, spec] of Object.entries(schema)) {
    const at = `${path}.${name}`;
    if ('object' in spec) {
      assert.ok(name in obj, `${at} is required`);
      check(obj[name], spec.object, at);
      continue;
    }
    const [kind, opt] = spec;
    if (!(name in obj) || obj[name] === undefined) {
      assert.ok(opt, `${at} is required (non-null in Kotlin, no default)`);
      continue;
    }
    const v = obj[name];
    switch (kind) {
      case 'string': assert.equal(typeof v, 'string', `${at} must be a String, got ${JSON.stringify(v)}`); break;
      case 'string?': assert.ok(v === null || typeof v === 'string', `${at} must be a String or null`); break;
      case 'int': case 'long': assert.ok(isInt(v), `${at} must be an integer, got ${JSON.stringify(v)}`); break;
      case 'int?': assert.ok(v === null || isInt(v), `${at} must be an integer or null`); break;
      case 'float': case 'double': assert.ok(isNum(v), `${at} must be a finite number, got ${JSON.stringify(v)}`); break;
      case 'bool': assert.equal(typeof v, 'boolean', `${at} must be a Boolean`); break;
      case 'strings':
        assert.ok(Array.isArray(v) && v.every((s: unknown) => typeof s === 'string'), `${at} must be a list of Strings`);
        break;
      case 'authors':
        assert.ok(Array.isArray(v), `${at} must be a list`);
        for (const a of v) check(a, AUTHOR, `${at}[]`);
        break;
    }
  }
}

// ---- the copied lists -------------------------------------------------------------------------------------

const AUTHOR: Schema = { name: ['string'], role: ['string'] }; // Dto.kt L169-173

const PAGE_WRAPPER: Schema = { // PageWrapperDto.kt L8-19: all nine required
  empty: ['bool'], first: ['bool'], last: ['bool'], number: ['long'], numberOfElements: ['long'],
  size: ['long'], totalElements: ['long'], totalPages: ['long'],
};

const SERIES_METADATA: Schema = { // Dto.kt L50-72 ∪ KomgaModels.kt L21-42 (identical minus totalBookCount)
  status: ['string'], created: ['string?'], lastModified: ['string?'], title: ['string'], titleSort: ['string'],
  summary: ['string'], summaryLock: ['bool'], readingDirection: ['string'], readingDirectionLock: ['bool'],
  publisher: ['string'], publisherLock: ['bool'], ageRating: ['int?'], ageRatingLock: ['bool'],
  language: ['string'], languageLock: ['bool'], genres: ['strings'], genresLock: ['bool'], tags: ['strings'],
  tagsLock: ['bool'], totalBookCount: ['int?', 'opt'],
};

const BOOKS_METADATA_AGG: Schema = { // Dto.kt L74-84 ∪ KomgaModels.kt L44-53
  authors: ['authors', 'opt'], tags: ['strings', 'opt'], releaseDate: ['string?'], summary: ['string'],
  summaryNumber: ['string'], created: ['string'], lastModified: ['string'],
};

const SERIES: Schema = { // Dto.kt L17-28 ∪ KomgaModels.kt L5-19
  id: ['string'], libraryId: ['string'], name: ['string'], created: ['string?'], lastModified: ['string?'],
  fileLastModified: ['string'], booksCount: ['int'],
  booksReadCount: ['int'], booksUnreadCount: ['int'], booksInProgressCount: ['int'], // Mihon only
  metadata: { object: SERIES_METADATA }, booksMetadata: { object: BOOKS_METADATA_AGG },
};

const MEDIA: Schema = { // Dto.kt L135-142
  status: ['string'], mediaType: ['string'], pagesCount: ['int'], mediaProfile: ['string', 'opt'],
  epubDivinaCompatible: ['bool', 'opt'],
};

const BOOK_METADATA: Schema = { // Dto.kt L151-167
  title: ['string'], titleLock: ['bool'], summary: ['string'], summaryLock: ['bool'], number: ['string'],
  numberLock: ['bool'], numberSort: ['float'], numberSortLock: ['bool'], releaseDate: ['string?'],
  releaseDateLock: ['bool'], authors: ['authors'], authorsLock: ['bool'], tags: ['strings'], tagsLock: ['bool'],
};

const BOOK: Schema = { // Dto.kt L86-100
  id: ['string'], seriesId: ['string'], seriesTitle: ['string'], name: ['string'], number: ['float'],
  created: ['string?'], lastModified: ['string?'], fileLastModified: ['string'], sizeBytes: ['long'],
  size: ['string'], media: { object: MEDIA }, metadata: { object: BOOK_METADATA },
};

const PAGE: Schema = { number: ['int'], fileName: ['string'], mediaType: ['string'] }; // Dto.kt L144-149

const READ_PROGRESS_V2: Schema = { // KomgaModels.kt L99-107
  booksCount: ['int'], booksReadCount: ['int'], booksUnreadCount: ['int'], booksInProgressCount: ['int'],
  lastReadContinuousNumberSort: ['double'], maxNumberSort: ['float'],
};

/** KomgaUtils.kt L13-14: `yyyy-MM-dd` and `yyyy-MM-dd'T'HH:mm:ss`, parsed strictly -- no Z, no millis, nothing after. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every date-typed field in a padded DTO, wherever it is, matches the strict pattern (nulls allowed where nullable). */
function checkDates(series: any, book: any) {
  for (const [at, v] of [
    ['series.created', series.created], ['series.lastModified', series.lastModified],
    ['series.fileLastModified', series.fileLastModified],
    ['series.metadata.created', series.metadata.created], ['series.metadata.lastModified', series.metadata.lastModified],
    ['series.booksMetadata.created', series.booksMetadata.created],
    ['series.booksMetadata.lastModified', series.booksMetadata.lastModified],
    ['book.created', book.created], ['book.lastModified', book.lastModified], ['book.fileLastModified', book.fileLastModified],
  ] as Array<[string, unknown]>) {
    if (v !== null) assert.match(String(v), DATE_TIME, `${at} must be yyyy-MM-ddTHH:mm:ss (no Z, no millis)`);
  }
  for (const [at, v] of [['series.booksMetadata.releaseDate', series.booksMetadata.releaseDate], ['book.metadata.releaseDate', book.metadata.releaseDate]] as Array<[string, unknown]>) {
    if (v !== null) assert.match(String(v), DAY, `${at} must be yyyy-MM-dd`);
  }
}

// ---- the thinnest inputs ownedCatalog can produce -----------------------------------------------------------

/** lib/ownedCatalog seriesDto for a row with nothing filled in: no created_at, no author, empty status. */
const bareSeries = () => ({
  id: 's_x', libraryId: 'lib', libraryPinned: false, name: 'T', created: null, booksCount: 0,
  booksReadCount: 0, booksUnreadCount: 0, booksInProgressCount: 0,
  metadata: { title: 'T', status: '', summary: '', readingDirection: 'WEBTOON', author: '', publisher: '', genres: [], tags: [], ageRating: null, language: 'en' },
  booksMetadata: { summary: '', genres: [], tags: [] }, autoUpdate: true, source: null,
});

/** lib/ownedCatalog bookDto for a chapter with a NULL title, no date, no scanlator. */
const bareBook = () => ({
  id: 'b_x', seriesId: 's_x', seriesTitle: '', name: null, number: 0,
  media: { pagesCount: 0, mediaType: 'application/vnd.comicbook+zip', status: 'READY' },
  metadata: { title: null, number: '0', numberSort: 0, summary: '', releaseDate: null },
  scanlator: null, sourceId: null, pruned: false, owned: false,
});

// ---- tests ------------------------------------------------------------------------------------------------

test('a series with nothing filled in still carries every field both Kotlin SeriesDto classes require', () => {
  // Reintroduce by deleting any one `*Lock: false` (or `summaryNumber`, `fileLastModified`) from komgaSeries:
  // the "is required" assertion names it.
  const s = komgaSeries(bareSeries());
  check(s, SERIES);
  checkDates(s, komgaBook(bareBook()));
  assert.equal(s.fileLastModified, '1970-01-01T00:00:00', 'a required date with nothing known is the epoch, not null');
  assert.equal(s.created, null, 'a nullable date with nothing known stays null (the extension treats it as absent)');
});

test('the three read counts are integers and default to "all unread"', () => {
  // Reintroduce by returning `counts?.read` without `int()`: undefined is not an Int.
  const s = komgaSeries({ ...bareSeries(), booksCount: 7 });
  assert.deepEqual([s.booksCount, s.booksReadCount, s.booksUnreadCount, s.booksInProgressCount], [7, 0, 7, 0]);
  const t = komgaSeries({ ...bareSeries(), booksCount: 7 }, { read: 2, unread: 4, inProgress: 1 });
  assert.deepEqual([t.booksReadCount, t.booksUnreadCount, t.booksInProgressCount], [2, 4, 1]);
});

test('a chapter with a NULL title and no date still carries every field BookDto requires, and name is ""', () => {
  // Reintroduce by emitting `name: dto.name` instead of the coalesced title: null is not a String.
  const b = komgaBook(bareBook());
  check(b, BOOK);
  assert.equal(b.name, '');
  assert.equal(b.metadata.title, '');
  assert.equal(b.metadata.releaseDate, null, 'no date is null, never an epoch day the extension would show as 1970');
  assert.equal(b.fileLastModified, '1970-01-01T00:00:00');
  assert.equal(b.media.mediaProfile, 'DIVINA', 'anything else than DIVINA/EPUB-compatible is dropped from the chapter list (Komga.kt L278-280)');
  assert.equal(b.media.epubDivinaCompatible, false);
});

test('number, metadata.numberSort and metadata.number are the one override-aware number, unrounded', () => {
  // Reintroduce by `Math.round`-ing numberSort or by reading `dto.metadata.numberSort` for one and `dto.number`
  // for the other: the three disagree.
  const b = komgaBook({ ...bareBook(), number: 12.5, metadata: { ...bareBook().metadata, number: '12.5', numberSort: 12.5 } });
  assert.equal(b.number, 12.5);
  assert.equal(b.metadata.numberSort, 12.5);
  assert.equal(b.metadata.number, '12.5');
});

test('the scanlator is an author with role translator, which is what the extension turns back into scanlator', () => {
  // Reintroduce by using role 'writer': the extension's `.filter { it.role == "translator" }` (Komga.kt L286-288) finds nothing.
  const b = komgaBook({ ...bareBook(), scanlator: 'Asura' });
  assert.deepEqual(b.metadata.authors, [{ name: 'Asura', role: 'translator' }]);
  assert.deepEqual(komgaBook(bareBook()).metadata.authors, []);
});

test('the series author is booksMetadata.authors with role writer (Dto.kt L43-46)', () => {
  const s = komgaSeries({ ...bareSeries(), metadata: { ...bareSeries().metadata, author: 'Oda' } });
  assert.deepEqual(s.booksMetadata.authors, [{ name: 'Oda', role: 'writer' }]);
});

test('a pruned tombstone is not READY, so media_status=READY means what it says', () => {
  // Reintroduce by hard-coding status 'READY': the phone lists a chapter whose pages are [] and every image 404s.
  assert.equal(komgaBook({ ...bareBook(), pruned: true }).media.status, 'ERROR');
  assert.equal(komgaBook(bareBook()).media.status, 'READY');
});

test('dates are yyyy-MM-ddTHH:mm:ss in UTC with no Z and no millis; release dates are yyyy-MM-dd', () => {
  // Reintroduce by returning `toISOString()` whole: the strict LocalDateTime.parse rejects the `.000Z` tail and
  // every chapter is "uploaded" at the epoch.
  assert.equal(komgaDate('2026-09-20T12:34:56.789Z'), '2026-09-20T12:34:56');
  assert.equal(komgaDate(new Date(Date.UTC(2020, 0, 2, 3, 4, 5, 6))), '2020-01-02T03:04:05');
  assert.equal(komgaDate(1_600_000_000_000), '2020-09-13T12:26:40');
  assert.equal(komgaDate(null), '1970-01-01T00:00:00');
  assert.equal(komgaDate('garbage'), '1970-01-01T00:00:00');
  assert.equal(komgaDate(0), '1970-01-01T00:00:00', 'an unstamped mtime of 0 is "unknown", which is the epoch here');
  assert.equal(komgaDateOrNull(0), null, 'and null where the field may be null');
  assert.equal(komgaDay('2026-09-20T23:59:59.000Z'), '2026-09-20');
  assert.equal(komgaDay(null), null);
  const b = komgaBook({ ...bareBook(), metadata: { ...bareBook().metadata, releaseDate: '2026-09-20T23:59:59.000Z' } });
  assert.equal(b.metadata.releaseDate, '2026-09-20');
  assert.equal(b.created, '2026-09-20T23:59:59');
  assert.equal(b.fileLastModified, '2026-09-20T23:59:59');
  checkDates(komgaSeries({ ...bareSeries(), created: '2026-01-01T00:00:00.000Z' }, null, { lastModified: 1_600_000_000_000 }), b);
});

test('the Spring page envelope has all nine keys, is 0-based, and never emits NaN', () => {
  // Reintroduce by removing `empty` or `numberOfElements`, or by `Math.ceil(total / size)` without the size
  // clamp: the zero-book unpaged case yields null for a required Long.
  const p = springPage([1, 2, 3], 3, 0, 0);
  check(p, PAGE_WRAPPER);
  assert.equal(p.number, 0, '0-based: the extension sends page-1 on the wire (Komga.kt L161)');
  assert.ok(p.last && p.first && !p.empty);
  assert.equal(p.numberOfElements, 3);
  assert.equal(p.size, 20, 'size 0 is not a page size; the default is Spring\'s 20');

  const empty = springPage([], 0, 0, 0);
  check(empty, PAGE_WRAPPER);
  assert.ok(empty.empty && empty.last && empty.first, 'an empty page is the last page, or the client pages forever');
  assert.equal(empty.totalPages, 0);
  for (const v of Object.values(empty)) assert.notEqual(v, null);
  assert.equal(JSON.stringify(empty).includes('null'), false, 'no key may serialise as null');

  const mid = springPage(new Array(20).fill(0), 45, 1, 20);
  assert.deepEqual([mid.first, mid.last, mid.totalPages], [false, false, 3]);
  const last = springPage(new Array(5).fill(0), 45, 2, 20);
  assert.deepEqual([last.first, last.last, last.numberOfElements], [false, true, 5]);

  assert.equal(springPage([], 0, -3, 20).number, 0, 'a negative page is page 0, not a negative OFFSET (500)');
  assert.equal(springPage([], 0, 0, 999_999).size, PAGE_SIZE_MAX, 'a huge size is capped, not a full table scan');
  assert.equal(springPage([], 0, 'x' as any, 'y' as any).totalPages, 0, 'junk is not NaN');
});

test('an unpaged answer of 600 rows says size 600 and last=true, whatever the page-size cap is', () => {
  // Reintroduce by dropping the `{ unpaged }` option from the springPage call (or ignoring it inside): the
  // size is clamped to PAGE_SIZE_MAX and a 600-chapter series answers `size 500, last false, totalPages 2`
  // with all 600 rows in content -- a shape Spring never emits, and a last-driven client asks for page 1
  // and gets the same 600 rows again. 8 live series are above 500 chapters.
  const rows = new Array(600).fill(0);
  const p = springPage(rows, 600, 0, 600, { unpaged: true });
  check(p, PAGE_WRAPPER);
  assert.equal(p.size, 600, 'unpaged: size is the row count, not the cap');
  assert.equal(p.last, true, 'unpaged: one page, and it is the last');
  assert.deepEqual([p.first, p.number, p.numberOfElements, p.totalElements, p.totalPages], [true, 0, 600, 600, 1]);
  assert.ok(rows.length > PAGE_SIZE_MAX, 'the case only means something above the cap');

  // The zero-book series stays the sane page K1 pinned: size at least 1, zero pages, last.
  const empty = springPage([], 0, 0, 1, { unpaged: true });
  check(empty, PAGE_WRAPPER);
  assert.deepEqual([empty.size, empty.totalPages, empty.last, empty.first, empty.empty], [1, 0, true, true, true]);
  assert.equal(JSON.stringify(empty).includes('null'), false, 'no key may serialise as null');

  // And the option is inert when false: a paged call is unchanged.
  assert.equal(springPage(new Array(20).fill(0), 45, 1, 20, { unpaged: false }).last, false);
});

test('page numbers are 1-based', () => {
  // Reintroduce by `number: index`: the extension requests `/pages/${number}` verbatim (Komga.kt L308-315).
  const p = komgaPage({ fileName: '001.jpg', mediaType: 'image/jpeg' }, 0);
  check(p, PAGE);
  assert.equal(p.number, 1);
  assert.equal(komgaPage({ fileName: '', mediaType: '' }, 9).mediaType, 'image/jpeg', 'a blank type is not a null String');
});

test('readingDirection is one of the four Komga values whatever we are given', () => {
  for (const v of [undefined, null, '', 'sideways', 'WEBTOON', 'rtl', 'ltr', 'vertical', 'long strip']) {
    assert.ok(['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT', 'VERTICAL', 'WEBTOON'].includes(komgaReadingDirection(v)), String(v));
  }
  assert.equal(komgaReadingDirection('rtl'), 'RIGHT_TO_LEFT');
});

test('status: synonyms map to Komga\'s four, anything else is passed through upper-cased for the client to call UNKNOWN', () => {
  // Reintroduce by returning 'ONGOING' for the unknown case: a status we never had becomes "still running".
  assert.equal(komgaStatus('Completed'), 'ENDED');
  assert.equal(komgaStatus('Ongoing'), 'ONGOING');
  assert.equal(komgaStatus('On Hiatus'), 'HIATUS');
  assert.equal(komgaStatus('Cancelled'), 'ABANDONED');
  assert.equal(komgaStatus('Something Odd'), 'SOMETHING_ODD');
  assert.equal(komgaStatus(''), '');
  assert.equal(komgaStatus(null), '');
});

test('ReadProgressV2 shape: six required numbers (KomgaModels.kt L99-107)', () => {
  check({ booksCount: 3, booksReadCount: 1, booksUnreadCount: 2, booksInProgressCount: 0, lastReadContinuousNumberSort: 1, maxNumberSort: 3 }, READ_PROGRESS_V2);
  assert.throws(() => check({ booksCount: 3 }, READ_PROGRESS_V2), /booksReadCount is required/);
});

test('the checker itself fails loudly on a missing required field and on a null in a non-null String', () => {
  // A checker that passes everything proves nothing; this is the vacuity guard.
  assert.throws(() => check({ ...komgaSeries(bareSeries()), fileLastModified: undefined }, SERIES), /fileLastModified is required/);
  const s: any = komgaSeries(bareSeries());
  s.metadata.summaryLock = undefined;
  assert.throws(() => check(s, SERIES), /summaryLock is required/);
  const b: any = komgaBook(bareBook());
  b.name = null;
  assert.throws(() => check(b, BOOK), /name must be a String/);
});

// ---- query parameters -------------------------------------------------------------------------------------

test('list params: comma-joined single values AND repeated keys both flatten (KomgaFilters.kt L87-93 vs L37-38)', () => {
  // Reintroduce by `String(q.x).split(',')` alone: a repeated key arrives as an array and becomes "a,b" of
  // the array's toString -- which happens to work -- but `[].concat` is what makes `read_status=UNREAD&
  // read_status=IN_PROGRESS` two values rather than one. The deepEqual below pins both forms.
  assert.deepEqual(listParam('a,b'), ['a', 'b']);
  assert.deepEqual(listParam(['a', 'b,c']), ['a', 'b', 'c']);
  assert.deepEqual(listParam(undefined), []);
  assert.deepEqual(listParam(' a , ,b '), ['a', 'b']);
});

test('parseSeriesQuery builds the condition tree condSql speaks, in both param forms', () => {
  const q1 = parseSeriesQuery({ search: '', page: '0', deleted: 'false', sort: 'metadata.titleSort,asc', library_id: 'lib,lib_a' });
  assert.equal(q1.fullTextSearch, null, 'an empty search is no filter (Komga.kt L160 always sends it)');
  assert.deepEqual(q1.condition, { anyOf: [{ libraryId: { operator: 'is', value: 'lib' } }, { libraryId: { operator: 'is', value: 'lib_a' } }] });
  assert.equal(q1.sort, 'title,asc');
  assert.equal(q1.page, 0);
  assert.equal(q1.size, 20);
  assert.equal(q1.needsUser, false);

  const q2 = parseSeriesQuery({ search: 'one', page: '2', read_status: ['UNREAD', 'IN_PROGRESS'], author: ['Oda,writer', 'A, B,penciller'], genre: 'Action,Drama', tag: 'x', status: 'ENDED', sort: 'lastModifiedDate,desc' });
  assert.equal(q2.fullTextSearch, 'one');
  assert.equal(q2.page, 2);
  assert.equal(q2.sort, 'updated,desc');
  assert.equal(q2.needsUser, true, 'read_status is per user; condSql refuses it without one');
  const parts = (q2.condition as any).allOf as any[];
  assert.ok(parts.some((c) => JSON.stringify(c).includes('"COMPLETED"')), 'ENDED also finds a series stored as Completed');
  assert.ok(parts.some((c) => JSON.stringify(c) === JSON.stringify({ anyOf: [{ genre: { operator: 'is', value: 'Action' } }, { genre: { operator: 'is', value: 'Drama' } }, { genre: { operator: 'is', value: 'x' } }] })), 'genre and tag are one column here');
  assert.ok(parts.some((c) => JSON.stringify(c) === JSON.stringify({ anyOf: [{ author: { operator: 'is', value: 'Oda' } }, { author: { operator: 'is', value: 'A, B' } }] })), 'author=name,role keeps the name up to the LAST comma');
  assert.ok(parts.some((c) => JSON.stringify(c) === JSON.stringify({ anyOf: [{ readStatus: { operator: 'is', value: 'UNREAD' } }, { readStatus: { operator: 'is', value: 'IN_PROGRESS' } }] })));

  assert.equal(parseSeriesQuery({ page: '-1', size: '99999' }).page, 0);
  assert.equal(parseSeriesQuery({ page: '-1', size: '99999' }).size, PAGE_SIZE_MAX);
  assert.equal(parseSeriesQuery(undefined).condition, null);
});

test('the sort map is a whitelist: Komga\'s five, nothing per-user, junk falls to title', () => {
  // Reintroduce by passing the raw string through: `sort=unread,desc` joins the per-user CTEs a Komga client
  // never asked for, and `sort=favourites` too.
  assert.equal(komgaSort('metadata.titleSort,asc'), 'title,asc');
  assert.equal(komgaSort('name,desc'), 'title,desc');
  assert.equal(komgaSort('createdDate,desc'), 'added,desc');
  assert.equal(komgaSort('lastModifiedDate,desc'), 'updated,desc');
  assert.equal(komgaSort('relevance,asc'), 'title,asc');
  assert.equal(komgaSort('random,asc'), 'random');
  assert.equal(komgaSort('unread,desc'), 'title,asc');
  assert.equal(komgaSort(undefined), 'title,asc');
});

test('parseBooksQuery: unpaged, media_status=READY, direction', () => {
  const b = parseBooksQuery({ unpaged: 'true', media_status: 'READY', deleted: 'false' });
  assert.deepEqual([b.unpaged, b.readyOnly, b.sort, b.page], [true, true, 'metadata.numberSort,asc', 0]);
  const c = parseBooksQuery({ search: 'x', page: '1', sort: 'name,desc', library_id: 'lib' });
  assert.deepEqual([c.unpaged, c.readyOnly, c.sort, c.page, c.fullTextSearch, c.libraryIds], [false, false, 'metadata.numberSort,desc', 1, 'x', ['lib']]);
  assert.equal(parseBooksQuery({ media_status: 'READY,ERROR' }).readyOnly, false, 'asking for errors too is not "ready only"');
});

test('humanSize mirrors Komga\'s BinaryByteUnit', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(1536), '1.5 KiB');
  assert.equal(humanSize(3 * 1024 * 1024), '3.0 MiB');
});

test('a chapter whose DTO carries sizeBytes 1536 answers size "1.5 KiB", so the default chapter name is not "(0 B)"', () => {
  // Reintroduce by reading only `opts?.sizeBytes` in komgaBook (ignoring `dto.sizeBytes`): the route passes
  // no opts, sizeBytes is 0 and every chapter on the phone reads `1 - Chapter 1 (0 B)` (Komga.kt L619).
  const b = komgaBook({ ...bareBook(), sizeBytes: 1536 });
  assert.equal(b.sizeBytes, 1536);
  assert.equal(b.size, '1.5 KiB');
  const unknown = komgaBook({ ...bareBook(), sizeBytes: null });
  assert.deepEqual([unknown.sizeBytes, unknown.size], [0, '0 B'], 'a never-stamped size is 0, never null (sizeBytes is a required Long)');
  assert.equal(komgaBook({ ...bareBook(), sizeBytes: 100 }, { sizeBytes: 2048 }).size, '2.0 KiB', 'an explicit opts.sizeBytes still wins');
});
