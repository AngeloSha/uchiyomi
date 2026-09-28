'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { FORMAT_KEYS, GenreFacet, sameGenre } from '@/lib/genres';
import { LibraryRow } from '@/components/AdultToggle';
import { Img } from '@/components/ui';
import { keys, t as tr } from '@/lib/i18n';

/**
 * Every way to narrow the library, in one place, as labelled sections.
 *
 * ⚠️ THIS IS ONE DEFINITION WITH TWO PLACEMENTS, and that is the point of it existing at all. The library
 * used to spread its controls across three horizontally-scrolling chip rails in the page header -- four
 * sorts, a Filters button, an 18+ toggle and a Select toggle in a single row of seven, with the library tabs
 * above them and a hand-rolled copy of the Sheet primitive holding the rest. Nothing said which chips were
 * sorts and which were filters, and the genre list inside the sheet was a flat wall of NINETY-THREE
 * unsearchable, uncounted words on the library this was written against.
 *
 * So the page renders this in a sticky sidebar from `lg:` up, and inside the real `Sheet` below it. Adding a
 * filter means adding a section here and it appears correctly in both.
 *
 * State stays in the URL, written through the page's single `setParam`. There is no draft and no Apply: a
 * tap is a navigation, exactly as it was before, so the back button still walks your filters backwards.
 */

const SORT_LABELS = keys('Updated', 'Newest', 'A–Z', 'Most unread');
export const SORTS = [
  { key: 'updated', label: SORT_LABELS[0], sort: 'lastModified,desc' },
  { key: 'new', label: SORT_LABELS[1], sort: 'createdDate,desc' },
  { key: 'az', label: SORT_LABELS[2], sort: 'metadata.titleSort,asc' },
  // per-user unread is now expressible server-side, so the label can say what it does
  { key: 'unread', label: SORT_LABELS[3], sort: 'unread,desc' },
];
// ⚠️ NO "RANDOM" SORT, EVEN THOUGH THE SERVER HAS ONE. `sortSql()` maps it to `ORDER BY random()`
// (ownedCatalog.ts), and the grid pages through `LIMIT/OFFSET` with `useInfiniteQuery` APPENDING each page.
// A fresh shuffle per page means page 2 re-draws series already scrolled past and silently omits others,
// and it looks like it works -- you would have to count to notice. Randomness that belongs to a whole shelf
// cannot be served one window at a time. "Surprise me" in the header is the honest version: one series,
// one request, no pagination. See library.test.ts, which fails if this comes back.

const READ_LABELS = keys('Not started', 'Reading', 'Finished');
export const READ_STATES = [
  { key: 'UNREAD', label: READ_LABELS[0] },
  { key: 'IN_PROGRESS', label: READ_LABELS[1] },
  { key: 'READ', label: READ_LABELS[2] },
];

// ⚠️ These used to be rendered as `v.charAt(0) + v.slice(1).toLowerCase()`, which is not a translation --
// every locale got "Ongoing". A `keys()` array is the same fix the sorts and read states already had.
const STATUS_LABELS = keys('Ongoing', 'Completed', 'Hiatus', 'Cancelled');
export const STATUSES = [
  { key: 'ONGOING', label: STATUS_LABELS[0] },
  { key: 'COMPLETED', label: STATUS_LABELS[1] },
  { key: 'HIATUS', label: STATUS_LABELS[2] },
  { key: 'CANCELLED', label: STATUS_LABELS[3] },
];

/** How many genres are listed before the rest go behind "Show all". */
const GENRE_HEAD = 20;
/** Below this many, the search box is noise. */
const GENRE_SEARCHABLE = 16;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fog-500">{children}</p>;
}

function Chips({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

/**
 * A genre, as a row rather than a tile.
 *
 * The browse page drew these as a wall of 16:9 tiles, which is right for a page whose whole job is the
 * genres and wrong for a filter list: ninety-three of them would be a second library. What survives is the
 * part that made the wall worth looking at -- the count, and a piece of the shelf it actually describes,
 * built from covers the overview payload already returned. Same request, a fraction of the pixels.
 */
function GenreRow({ facet, on, onToggle }: { facet: GenreFacet; on: boolean; onToggle: () => void }) {
  const ids = facet.covers.slice(0, 4);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-start text-sm transition ${
        on ? 'bg-accent-soft font-medium text-accent' : 'text-fog-300 hover:bg-ink-800/60 hover:text-fog-100'
      }`}
    >
      <span aria-hidden className={`grid h-7 w-7 shrink-0 overflow-hidden rounded-md border border-ink-700/70
                                    ${ids.length > 1 ? 'grid-cols-2 grid-rows-2' : ''}`}>
        {/* ⚠️ The same URL `SeriesTile` asks for, with no `w=` of its own. A different width is a different
            cache entry, so asking for a smaller one here would DOUBLE the requests rather than save any:
            these are covers of series that are, by definition, in the grid beside this list. */}
        {ids.map((id) => (
          <Img key={id} src={img.seriesThumb(id)} alt="" className="h-full w-full" imgClassName="object-top" />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{facet.label}</span>
      {/* Omitted rather than faked when the backend cannot count -- Komga exposes no per-genre aggregate. */}
      {facet.series != null && <span className="shrink-0 text-xs tabular-nums text-fog-600">{facet.series}</span>}
    </button>
  );
}

export function LibraryFilters({ sort, read, status, genres, lib, libs, onSet }: {
  sort: string;
  read: string;
  status: string;
  genres: string[];
  lib: string;
  libs: LibraryRow[];
  onSet: (k: string, v: string) => void;
}) {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);

  // The counted list the browse page used, not the bare `/api/genres` the old sheet called. It is the same
  // one request either way, and it is what carries the counts and the cover ids.
  const { data } = useQuery({
    queryKey: ['genres-overview'],
    queryFn: () => api<{ content: GenreFacet[] }>('/api/genres/overview?covers=4').then((r) => r.content ?? []),
    staleTime: 10 * 60 * 1000,
  });

  /**
   * Is this genre selected?
   *
   * ⚠️ Case-folded, because the two sides disagree and the SERVER already folds. The filter matches
   * `lower(g) = lower($n)`, so a url carrying `genres=Martial arts` really is filtering by Martial Arts --
   * but the facet is labelled with the spelling the library mostly uses, and an exact comparison would draw
   * that row unselected while the grid beside it was filtered by it. Shared links and bookmarks from before
   * this change are exactly where that bites.
   */
  const isOn = (label: string) => genres.some((g) => sameGenre(g, label));

  const toggleGenre = (label: string) =>
    onSet('genres', (isOn(label)
      ? genres.filter((x) => !sameGenre(x, label))
      : [...genres, label]).join(','));

  const { formats, listed, hidden } = useMemo(() => {
    const all = data ?? [];
    // Formats are not moods. "Manhwa" carries 161 of 2,132 series here, so under a count ranking it sits
    // above every actual genre while telling you nothing about what a book is like. Browse quarantined
    // these into their own row and that judgement travels with them. See lib/genres.ts.
    const formats = all.filter((g) => FORMAT_KEYS.has(g.key));
    const real = all.filter((g) => !FORMAT_KEYS.has(g.key));
    const needle = q.trim().toLowerCase();
    const matched = needle ? real.filter((g) => g.label.toLowerCase().includes(needle)) : real;
    if (needle || showAll) return { formats, listed: matched, hidden: 0 };
    // ⚠️ A selected genre is ALWAYS listed, even when it falls outside the head. Otherwise picking a small
    // genre and then reloading leaves it filtering the grid with no control on screen to switch it off.
    const head = matched.slice(0, GENRE_HEAD);
    const inHead = new Set(head.map((g) => g.key));
    const picked = matched.filter((g) => !inHead.has(g.key) && isOn(g.label));
    return { formats, listed: [...head, ...picked], hidden: matched.length - head.length - picked.length };
  }, [data, q, showAll, genres]);

  return (
    <div className="space-y-5">
      <section>
        <Eyebrow>{tr('Sort by')}</Eyebrow>
        <Chips>
          {SORTS.map((s) => (
            <button key={s.key} type="button" onClick={() => onSet('sort', s.key)} aria-pressed={sort === s.key}
              className={`chip text-xs ${sort === s.key ? 'chip-active' : ''}`}>{tr(s.label)}</button>
          ))}
        </Chips>
      </section>

      {/* Only when there is a choice to make. This lists what the viewer may actually open -- the endpoint
          filters by their grants -- so it doubles as an honest answer to "what do I have access to". */}
      {libs.length > 1 && (
        <section>
          <Eyebrow>{tr('Library')}</Eyebrow>
          <Chips>
            <button type="button" onClick={() => onSet('lib', '')} aria-pressed={!lib}
              className={`chip text-xs ${lib ? '' : 'chip-active'}`}>{tr('All')}</button>
            {libs.map((l) => (
              <button key={l.id} type="button" onClick={() => onSet('lib', lib === l.id ? '' : l.id)} aria-pressed={lib === l.id}
                className={`chip text-xs ${lib === l.id ? 'chip-active' : ''}`}>{l.name}</button>
            ))}
          </Chips>
        </section>
      )}

      <section>
        <Eyebrow>{tr('Read state')}</Eyebrow>
        <Chips>
          {READ_STATES.map((r) => (
            <button key={r.key} type="button" onClick={() => onSet('read', read === r.key ? '' : r.key)} aria-pressed={read === r.key}
              className={`chip text-xs ${read === r.key ? 'chip-active' : ''}`}>{tr(r.label)}</button>
          ))}
        </Chips>
      </section>

      <section>
        <Eyebrow>{tr('Status')}</Eyebrow>
        <Chips>
          {STATUSES.map((s) => (
            <button key={s.key} type="button" onClick={() => onSet('status', status === s.key ? '' : s.key)} aria-pressed={status === s.key}
              className={`chip text-xs ${status === s.key ? 'chip-active' : ''}`}>{tr(s.label)}</button>
          ))}
        </Chips>
      </section>

      {formats.length > 0 && (
        <section>
          <Eyebrow>{tr('Format')}</Eyebrow>
          <Chips>
            {formats.map((g) => (
              <button key={g.key} type="button" onClick={() => toggleGenre(g.label)} aria-pressed={isOn(g.label)}
                className={`chip text-xs ${isOn(g.label) ? 'chip-active' : ''}`}>
                {g.label}{g.series != null && <span className="ms-1 tabular-nums text-fog-600">{g.series}</span>}
              </button>
            ))}
          </Chips>
        </section>
      )}

      <section>
        <Eyebrow>
          {tr('Genres')}
          {genres.length > 1 && <span className="ms-1 normal-case tracking-normal">{tr('(all of them)')}</span>}
        </Eyebrow>
        {(data ?? []).length > GENRE_SEARCHABLE && (
          <input value={q} onChange={(e) => setQ(e.target.value)} type="search"
            placeholder={tr('Find a genre')} aria-label={tr('Find a genre')}
            className="field mb-2 w-full py-1.5 text-xs" />
        )}
        <div className="space-y-0.5">
          {listed.map((g) => (
            <GenreRow key={g.key} facet={g} on={isOn(g.label)} onToggle={() => toggleGenre(g.label)} />
          ))}
        </div>
        {!data && <p className="text-xs text-fog-500">{tr('Loading…')}</p>}
        {/* Two different nothings. "No match" is an answer to a search; a library whose series carry no
            genres at all has not been searched, and telling it that nothing matched is a small lie. */}
        {data && !listed.length && (
          <p className="text-xs text-fog-500">
            {q.trim() ? tr('No genre matches that.') : tr('Once your series carry genres, this is where they gather.')}
          </p>
        )}
        {hidden > 0 && (
          <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-xs text-accent">
            {tr('Show all')} ({hidden})
          </button>
        )}
      </section>
    </div>
  );
}
