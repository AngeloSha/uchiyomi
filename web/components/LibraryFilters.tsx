'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, img } from '@/lib/api';
import { FORMAT_KEYS, GenreFacet, sameGenre } from '@/lib/genres';
import { LibraryRow } from '@/components/AdultToggle';
import { Img } from '@/components/ui';
import { IcCheck, IcChevronRight } from '@/components/icons';
import { SourceIcon } from '@/components/SourcePicker';
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
 * Filters only, since v0.60.0: the order moved to the toolbar's Sort menu (components/LibraryToolbar.tsx,
 * lib/librarySort.ts), where nine sort chips at the top of this panel were the loudest thing on the shelf.
 *
 * State stays in the URL, written through the page's single `setParam`. There is no draft and no Apply: a
 * tap is a navigation, exactly as it was before, so the back button still walks your filters backwards.
 *
 * Rows, not chips, since v0.60.0 (the owner: "it's so full of pills"). Every choice is one row -- a glyph, a source's
 * icon or a cover mosaic, its name, its count where the server counts it, and a tick when it is on -- in a section that
 * folds; a folded section still names what it is filtering by, so a filter is never on out of sight. The genre rows
 * were already this; every other section now matches them.
 */

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

/**
 * A source the viewer's library comes from (GET /api/library/sources): how many series were added from it
 * (`main`) and how many read from it at all, as their main source or a followed one (`any`).
 */
export interface LibrarySource { id: string; name: string; main: number; any: number; installed: boolean }

/**
 * Main source's "No source" (#149) in the `src` URL param: the series with no main source -- folders added by hand, and
 * anything never matched to a site. A value no source id can be (a site added by address is named by letters and
 * digits, an extension's source is `sw:` and digits, MangaDex `mangadex…`), in the same param as the sources, so the
 * choice stays single like the section's: picking a source replaces it, picking it replaces the source.
 */
export const NO_SOURCE = '-';

/**
 * The sources, one query for the panel and the page's active-filter chips (react-query shares it), and `none`: how many
 * of the viewer's series have no main source (#149), 0 from a server too old to say, or on Komga.
 *
 * ⚠️ Keyed UNDER ['library'], because that is the key everything that changes the shelf invalidates: the select
 * bar's settle() after a bulk action, pull to refresh, the header's refresh, an add, a series edit. Keyed
 * ['library-sources'], the counts sat out a Remove from library for their five-minute staleTime, still counting
 * the series that had just gone. Nothing writes into the prefix with setQueriesData, which would hand this list a
 * page of the grid (library.test.ts).
 */
export function useLibrarySources() {
  return useQuery({
    queryKey: ['library', 'sources'],
    queryFn: () => api<{ content: LibrarySource[]; none?: number }>('/api/library/sources')
      .then((r) => ({ sources: r.content ?? [], none: r.none ?? 0 })),
    staleTime: 5 * 60 * 1000,
  });
}

/** How many sources a source section lists before the rest go behind "Show all". Rows are taller than chips were. */
const SOURCE_HEAD = 6;

/**
 * Which sections are folded, on this device (v0.60.0): `uchiyomi.libraryFilterFold`, a list of section ids. Any source
 * starts folded -- the rarer question of the two source sections. Read after mount, as every device preference here
 * is: the static export renders without storage, and the first client render must match it.
 */
const FOLD_KEY = 'uchiyomi.libraryFilterFold';
const FOLD_DEFAULT = ['anysrc'];
export interface Fold { folded: (id: string) => boolean; toggle: (id: string) => void }
export function useFilterFold(): Fold {
  const [ids, setIds] = useState<string[]>(FOLD_DEFAULT);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FOLD_KEY) ?? 'null');
      if (Array.isArray(saved) && saved.every((x) => typeof x === 'string')) setIds(saved);
    } catch { /* no storage, or not ours: the default */ }
  }, []);
  return {
    folded: (id) => ids.includes(id),
    toggle: (id) => setIds((now) => {
      const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* the choice lasts this visit */ }
      return next;
    }),
  };
}

/**
 * One section: its name as the key that folds it, and while folded, what it is filtering by beside the name (`picked`),
 * so a filter that is on never hides. `data-filter-section` is the walks' handle.
 */
function FilterSection({ id, title, help, picked, fold, children }: {
  id: string; title: ReactNode; help?: string; picked?: string; fold: Fold; children: ReactNode;
}) {
  const open = !fold.folded(id);
  return (
    <section data-filter-section={id}>
      <button type="button" onClick={() => fold.toggle(id)} aria-expanded={open}
        className="group flex w-full items-center gap-2 rounded-md py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-fog-500 transition group-hover:text-fog-300">{title}</span>
        {!open && picked && <span className="min-w-0 truncate text-xs font-medium text-accent">{picked}</span>}
        <IcChevronRight width={14} height={14} aria-hidden
          className={`ms-auto shrink-0 text-fog-600 transition-transform duration-200 ${open ? 'rotate-90' : 'rtl:rotate-180'}`} />
      </button>
      {open && (
        <div className="mt-1.5">
          {help && <p className="mb-1.5 text-[11px] leading-snug text-fog-600">{help}</p>}
          <div className="space-y-0.5">{children}</div>
        </div>
      )}
    </section>
  );
}

/**
 * One choice, as a row: `lead` (a glyph, a source's icon or a cover mosaic), the name, the count where there is one, and
 * a tick when it is on. A chosen row is drawn chosen whatever else is true of it -- a source that is not loaded is
 * `muted` only while it is not the one chosen (library.test.ts evaluates this template). Still a `button` with
 * `aria-pressed`: what the walks click, and what a screen reader says.
 */
function FilterOption({ on, onPick, lead, label, count, muted = false, title, attrs }: {
  on: boolean; onPick: () => void; lead: ReactNode; label: ReactNode; count?: number | null; muted?: boolean; title?: string;
  attrs?: Record<string, string>;
}) {
  return (
    <button type="button" onClick={onPick} aria-pressed={on} title={title} {...attrs}
      className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-2 text-start text-sm transition lg:py-1.5 ${on ? 'bg-accent-soft font-medium text-accent' : muted ? 'text-fog-500 hover:bg-ink-800/60' : 'text-fog-300 hover:bg-ink-800/60 hover:text-fog-100'}`}>
      <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center">{lead}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className={`shrink-0 text-xs tabular-nums ${on ? 'text-accent' : 'text-fog-600'}`}>{count}</span>}
      {on && <IcCheck width={14} height={14} aria-hidden className="shrink-0" />}
    </button>
  );
}

/**
 * The read states and the publication statuses, each drawn as a mark on one small ring (16 px, the text's colour): a ring
 * filling up for how far YOU are (empty, half, full), and a sign inside it for where the SERIES is (playing on, done,
 * paused, stopped). One family, so the two sections read as a pair rather than as two walls of words.
 */
function Glyph({ k }: { k: string }) {
  const ring = <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />;
  const inner: Record<string, ReactNode> = {
    UNREAD: null,
    IN_PROGRESS: <path d="M8 2a6 6 0 0 1 0 12Z" fill="currentColor" />,
    READ: <circle cx="8" cy="8" r="6" fill="currentColor" />,
    ONGOING: <path d="M6.6 5.4v5.2L10.8 8Z" fill="currentColor" />,
    COMPLETED: <path d="m5.4 8.2 1.8 1.8 3.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
    HIATUS: <path d="M6.6 5.6v4.8M9.4 5.6v4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
    CANCELLED: <path d="m6 6 4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
    NONE: null,
    LIBRARY: <path d="M5.2 5.5h5.6M5.2 8h5.6M5.2 10.5h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  };
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden className="shrink-0">
      {k === 'NONE' ? <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2.2" /> : ring}
      {inner[k]}
    </svg>
  );
}

/**
 * One source filter: every source with its count, single choice, a tap on the chosen one clears it. The
 * chosen source is always listed, even past the head, so a reload never leaves it filtering with no control.
 * Main source ends on "No source" (#149) while series have none, or while it is chosen: after the sources and never
 * behind "Show all", the one choice that is not a source.
 */
function SourceSection({ id, fold, title, help, rows, none, count, value, onPick }: {
  /** The section's id for folding (`src`, `anysrc`). */
  id: string; fold: Fold;
  title: string; help: string; rows: LibrarySource[];
  /** How many series have no main source: Main source's alone. */
  none?: number;
  count: (s: LibrarySource) => number; value: string; onPick: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const listed = rows.filter((s) => count(s) > 0).sort((a, b) => count(b) - count(a) || a.name.localeCompare(b.name));
  const head = all ? listed : listed.slice(0, SOURCE_HEAD);
  const shown = head.some((s) => s.id === value) || !value ? head : [...head, ...listed.filter((s) => s.id === value)];
  const hidden = listed.length - shown.length;
  const noneShown = none !== undefined && (none > 0 || value === NO_SOURCE);
  if (!listed.length && !noneShown) return null;
  const picked = value === NO_SOURCE ? tr('No source') : rows.find((s) => s.id === value)?.name;
  return (
    <FilterSection id={id} fold={fold} title={title} help={help} picked={picked}>
      {shown.map((s) => (
        <FilterOption key={s.id} on={value === s.id} onPick={() => onPick(value === s.id ? '' : s.id)} muted={!s.installed}
          title={s.installed ? undefined : tr('not installed')}
          lead={<SourceIcon id={s.id} name={s.name} size={20} registered={s.installed} />} label={s.name} count={count(s)} />
      ))}
      {noneShown && (
        <FilterOption on={value === NO_SOURCE} onPick={() => onPick(value === NO_SOURCE ? '' : NO_SOURCE)}
          lead={<Glyph k="NONE" />} label={tr('No source')} count={none} attrs={{ 'data-source-none': '' }} />
      )}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 px-1.5 text-xs text-accent">{tr('Show all')} ({hidden})</button>
      )}
    </FilterSection>
  );
}

/** How many genres are listed before the rest go behind "Show all". */
const GENRE_HEAD = 20;
/** Below this many, the search box is noise. */
const GENRE_SEARCHABLE = 16;


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
  const mosaic = (
    <span className={`grid h-7 w-7 overflow-hidden rounded-md border border-ink-700/70 ${ids.length > 1 ? 'grid-cols-2 grid-rows-2' : ''}`}>
      {/* ⚠️ The same URL `SeriesTile` asks for, with no `w=` of its own. A different width is a different
          cache entry, so asking for a smaller one here would DOUBLE the requests rather than save any:
          these are covers of series that are, by definition, in the grid beside this list. */}
      {ids.map((id) => (
        <Img key={id} src={img.seriesThumb(id)} alt="" className="h-full w-full" imgClassName="object-top" />
      ))}
    </span>
  );
  // The count is omitted rather than faked when the backend cannot count -- Komga exposes no per-genre aggregate.
  return <FilterOption on={on} onPick={onToggle} lead={mosaic} label={facet.label} count={facet.series ?? null} />;
}

export function LibraryFilters({ read, status, genres, lib, libs, mainSrc, anySrc, onSet }: {
  read: string;
  status: string;
  genres: string[];
  lib: string;
  libs: LibraryRow[];
  /** The `src` URL param: only series ADDED from this source, or NO_SOURCE: the series with no main source. */
  mainSrc: string;
  /** The `anysrc` URL param: series that read from this source at all, main or followed. */
  anySrc: string;
  onSet: (k: string, v: string) => void;
}) {
  const { data: counted } = useLibrarySources();
  const sources = counted?.sources ?? [];
  const none = counted?.none ?? 0;
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const fold = useFilterFold();

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

  const pickedRead = READ_STATES.find((r) => r.key === read);
  const pickedStatus = STATUSES.find((x) => x.key === status);
  const pickedFormats = formats.filter((g) => isOn(g.label)).map((g) => g.label);
  const pickedGenres = genres.filter((g) => !formats.some((f) => sameGenre(f.label, g)));

  return (
    <div className="space-y-4">
      {/* Only when there is a choice to make. This lists what the viewer may actually open -- the endpoint
          filters by their grants -- so it doubles as an honest answer to "what do I have access to". */}
      {libs.length > 1 && (
        <FilterSection id="lib" fold={fold} title={tr('Library')} picked={libs.find((l) => l.id === lib)?.name}>
          <FilterOption on={!lib} onPick={() => onSet('lib', '')} lead={<Glyph k="LIBRARY" />} label={tr('All')} />
          {libs.map((l) => (
            <FilterOption key={l.id} on={lib === l.id} onPick={() => onSet('lib', lib === l.id ? '' : l.id)} lead={<Glyph k="LIBRARY" />} label={l.name} />
          ))}
        </FilterSection>
      )}

      <FilterSection id="read" fold={fold} title={tr('Read state')} picked={pickedRead ? tr(pickedRead.label) : undefined}>
        {READ_STATES.map((r) => (
          <FilterOption key={r.key} on={read === r.key} onPick={() => onSet('read', read === r.key ? '' : r.key)}
            lead={<Glyph k={r.key} />} label={tr(r.label)} />
        ))}
      </FilterSection>

      <FilterSection id="status" fold={fold} title={tr('Status')} picked={pickedStatus ? tr(pickedStatus.label) : undefined}>
        {STATUSES.map((x) => (
          <FilterOption key={x.key} on={status === x.key} onPick={() => onSet('status', status === x.key ? '' : x.key)}
            lead={<Glyph k={x.key} />} label={tr(x.label)} />
        ))}
      </FilterSection>

      {/* Only with a choice to make: two sources, or for Main source one source and series with none (#149), whose
          "No source" makes two -- a library with no source at all has nothing to narrow. Empty on a Komga backend (no
          sources there, and `none` is 0), so neither section renders and no condition a Komga server would refuse is
          ever sent. */}
      {(sources.length > 1 || (sources.length > 0 && (none > 0 || mainSrc === NO_SOURCE))) && (
        <SourceSection title={tr('Main source')} help={tr('Series added from this source.')} id="src" fold={fold}
          rows={sources} none={none} count={(s) => s.main} value={mainSrc} onPick={(id) => onSet('src', id)} />
      )}
      {sources.length > 1 && (
        <SourceSection title={tr('Any source')} help={tr('Series that read from this source, as their main source or a followed one.')} id="anysrc" fold={fold}
          rows={sources} count={(s) => s.any} value={anySrc} onPick={(id) => onSet('anysrc', id)} />
      )}

      {formats.length > 0 && (
        <FilterSection id="format" fold={fold} title={tr('Format')} picked={pickedFormats.join(', ') || undefined}>
          {formats.map((g) => (
            <GenreRow key={g.key} facet={g} on={isOn(g.label)} onToggle={() => toggleGenre(g.label)} />
          ))}
        </FilterSection>
      )}

      <FilterSection id="genres" fold={fold}
        title={<>{tr('Genres')}{genres.length > 1 && <span className="ms-1 normal-case tracking-normal">{tr('(all of them)')}</span>}</>}
        picked={pickedGenres.join(', ') || undefined}>
        {(data ?? []).length > GENRE_SEARCHABLE && (
          <input value={q} onChange={(e) => setQ(e.target.value)} type="search"
            placeholder={tr('Find a genre')} aria-label={tr('Find a genre')}
            className="field mb-2 w-full py-1.5 text-xs" />
        )}
        {listed.map((g) => (
          <GenreRow key={g.key} facet={g} on={isOn(g.label)} onToggle={() => toggleGenre(g.label)} />
        ))}
        {!data && <p className="text-xs text-fog-500">{tr('Loading…')}</p>}
        {/* Two different nothings. "No match" is an answer to a search; a library whose series carry no
            genres at all has not been searched, and telling it that nothing matched is a small lie. */}
        {data && !listed.length && (
          <p className="text-xs text-fog-500">
            {q.trim() ? tr('No genre matches that.') : tr('Once your series carry genres, this is where they gather.')}
          </p>
        )}
        {hidden > 0 && (
          <button type="button" onClick={() => setShowAll(true)} className="mt-1 px-1.5 text-xs text-accent">
            {tr('Show all')} ({hidden})
          </button>
        )}
      </FilterSection>
    </div>
  );
}
