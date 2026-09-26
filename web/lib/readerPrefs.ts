export type ReaderTheme = 'amoled' | 'sepia' | 'gray';

/**
 * What the reader does with a page that repeats across chapters -- a credit page, an advert.
 *
 * `collapse` is the default and the interesting one: the page stays exactly where it is in the scroll but
 * renders as a thin band of itself, so the chapter is never secretly shorter than it is and you can see what
 * was set aside before you decide about it. `hide` is the old behaviour, kept for anyone who wants the page
 * gone outright.
 */
export type JunkPages = 'show' | 'collapse' | 'hide';
const JUNK_MODES: readonly JunkPages[] = ['show', 'collapse', 'hide'];

/**
 * Which way paged mode lays its pages out. `rtl` is the manga way: the next page is to the LEFT (swipe right,
 * tap the left edge, ←), and a double spread puts its first page on the right. `series` follows the series'
 * own `readingDirection` -- RIGHT_TO_LEFT reads right to left, anything else left to right. Since v0.48.0
 * (#102) the built-in library knows it: from the chapter's ComicInfo, the source, AniList, or the admin
 * (bff lib/readingDirection.ts). Before that it answered WEBTOON for every series, so `series` could only
 * ever read left to right.
 */
export type PagedDirection = 'ltr' | 'rtl' | 'series';
const PAGED_DIRECTIONS: readonly PagedDirection[] = ['ltr', 'rtl', 'series'];

export interface ReaderPrefs {
  gap: number; // px between pages (0 = seamless webtoon)
  brightness: number; // 0.25 .. 1
  mode: 'vertical' | 'paged';
  autoScroll: number; // px/frame, 0 = off
  fitWidth: boolean;
  theme: ReaderTheme;
  spread: boolean; // paged mode: two pages side by side (manga double-page convention)
  /**
   * Paged mode's page order (see `PagedDirection`). `series` by default: a series that says it reads right to
   * left gets a right-to-left track, and every other series reads left to right exactly as before.
   * `ltr`/`rtl` are overrides. Stored settings without the key pick up the default through the spread in
   * `migratePrefs`.
   */
  pagedDirection: PagedDirection;
  junkPages: JunkPages; // what to do with pages that repeat across chapters
  /**
   * @deprecated Superseded by `junkPages`, and kept ONLY so that an older build does not fight this one.
   * Always derived in `normalise`, never read for behaviour. See the note there.
   */
  skipJunk: boolean;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  junkPages: 'collapse',
  skipJunk: true,
  gap: 0,
  brightness: 1,
  mode: 'vertical',
  autoScroll: 0,
  fitWidth: true,
  theme: 'amoled',
  spread: false,
  pagedDirection: 'series',
};

const KEY = 'yomi_reader_prefs';

// Reader settings follow the account, not the browser: set the reader up on a laptop and your phone should
// already agree. localStorage stays the source for first paint and for reading offline; the server is the
// source of truth once it answers. Writes are debounced because brightness/gap are sliders.
const SYNC_DELAY = 1500;
const SERIES_CAP = 300; // per-series memory is unbounded otherwise — a big library would bloat the settings row
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** How many PUTs are in flight, from the moment a debounce fires until its PUT has settled. A count, not a
 *  flag: two saves more than 1.5 s apart can have two PUTs out at once, and the first one landing must not
 *  open the window while the second is still on its way. See `syncPrefsFromServer`. */
let pushing = 0;

/**
 * Fill in what a stored object is missing, and reconcile the setting with the boolean it replaced.
 *
 * ⚠️ THE MIGRATION IS THE POINT, and plain `{ ...DEFAULT_PREFS, ...stored }` gets it wrong. Someone who
 * deliberately turned skipping OFF has `{ skipJunk: false }` and no `junkPages` at all, so the spread would
 * hand them the default and silently switch a feature back on that they had switched off. When `junkPages`
 * is absent we read the old boolean instead.
 * Reintroduce by deleting the `skipJunk === false` branch: a stored `{"skipJunk": false}` loads as
 * `'collapse'` and starts collapsing pages for someone who asked it not to.
 *
 * ⚠️ AND `skipJunk` IS STILL WRITTEN, every time. `savePrefs` PUTs the whole `reader` object and the server
 * merges it shallowly, so a second device on an older build would otherwise overwrite the settings row with
 * an object that has no `junkPages` in it -- wiping the choice on every device. Writing both keys means the
 * two builds degrade into each other instead of fighting over the row.
 *
 * Unrecognised values fall back to the default rather than being trusted, because nothing else here
 * validates what came out of storage either.
 */
export function migratePrefs(raw: unknown): ReaderPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReaderPrefs>;
  // ⚠️ Ask the RAW object, not the merged one. The defaults supply a `junkPages`, so a check against the
  // merged object can never fail and the branch below would never run.
  const chosen = JUNK_MODES.includes(r.junkPages as JunkPages);
  const p = { ...DEFAULT_PREFS, ...r };
  if (!chosen) p.junkPages = r.skipJunk === false ? 'show' : DEFAULT_PREFS.junkPages;
  if (!PAGED_DIRECTIONS.includes(p.pagedDirection)) p.pagedDirection = DEFAULT_PREFS.pagedDirection;
  p.skipJunk = p.junkPages !== 'show';
  return p;
}

export function loadPrefs(): ReaderPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    return migratePrefs(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: ReaderPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
  queueSync();
}

/** Debounced push of the local reader state into the user's server-side settings. Failures are ignored —
 *  this is a convenience, and losing a sync must never interrupt reading. */
function queueSync() {
  if (typeof window === 'undefined') return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    pushing++;
    void import('./api')
      .then(({ api }) => api('/api/settings', { method: 'PUT', json: { reader: loadPrefs(), readerSeries: allSeriesPrefs(), readerSource: allSourcePrefs() } }))
      .catch(() => {})
      .finally(() => { pushing--; });
  }, SYNC_DELAY);
}

/**
 * Pull server-side reader settings on sign-in and adopt them locally. Returns the effective prefs.
 *
 * ⚠️ A pull YIELDS to a pending push. Once `savePrefs` has written locally, the local copy is newer than
 * anything the server can answer until the debounced PUT has landed -- and the server's answer is the OLD
 * value for that whole window. Adopting it here put the old value back into localStorage, and the timer
 * then read `loadPrefs()` and PUT the old value up as if it were the new one: a theme picked on Profile →
 * Settings read "✓ Saved" and was gone from the row, the store and the server 1.5 s later whenever the
 * section remounted in between (a tab away and back, a Language chip on the same page -- I18nProvider
 * remounts everything). The same holds while the PUT is in flight (`pushing`): a GET racing it can still
 * answer the pre-PUT row. Reintroduce by deleting the guard line: readerPrefs.test.ts "a pull while a
 * push is pending keeps the local value" fails.
 */
export async function syncPrefsFromServer(): Promise<ReaderPrefs> {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  if (syncTimer || pushing) return loadPrefs();
  try {
    const { api } = await import('./api');
    const s = await api<{ reader?: Partial<ReaderPrefs>; readerSeries?: Record<string, SeriesPrefs>; readerSource?: Record<string, SourcePrefs> }>('/api/settings');
    if (s?.reader && typeof s.reader === 'object') {
      // Through the same reconciliation as a local read: a settings row written by an older build carries
      // `skipJunk` and no `junkPages`, and must not land here as a raw object.
      localStorage.setItem(KEY, JSON.stringify(migratePrefs({ ...loadPrefs(), ...s.reader })));
    }
    if (s?.readerSeries && typeof s.readerSeries === 'object') {
      for (const [id, sp] of Object.entries(s.readerSeries)) {
        if (id && sp && typeof sp === 'object') {
          localStorage.setItem(`yomi_rs_${id}`, JSON.stringify({ ...loadSeriesPrefs(id), ...sp }));
        }
      }
    }
    if (s?.readerSource && typeof s.readerSource === 'object') {
      for (const [id, sp] of Object.entries(s.readerSource)) {
        if (id && sp && typeof sp === 'object') {
          localStorage.setItem(`${SOURCE_KEY}${id}`, JSON.stringify({ ...loadSourcePrefs(id), ...sp }));
        }
      }
    }
  } catch { /* offline or signed out — keep whatever is local */ }
  return loadPrefs();
}

/** Every per-series override held locally, capped so the settings row can't grow without bound. */
function allSeriesPrefs(): Record<string, SeriesPrefs> {
  const out: Record<string, SeriesPrefs> = {};
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('yomi_rs_')) keys.push(k);
    }
    for (const k of keys.slice(-SERIES_CAP)) {
      const id = k.slice('yomi_rs_'.length);
      const v = loadSeriesPrefs(id);
      if (Object.keys(v).length) out[id] = v;
    }
  } catch {}
  return out;
}

const SOURCE_KEY = 'yomi_rp_';

// ---- per-series memory (mode/theme/zoom remembered per title) ----
export interface SeriesPrefs {
  mode?: ReaderPrefs['mode'];
  theme?: ReaderTheme;
  zoom?: number;
  spread?: boolean;
  pagedDirection?: ReaderPrefs['pagedDirection'];
  /**
   * The direction above was CHOSEN for this title in the reader, rather than copied into its memory along
   * with a change to something else. Only a series' memory carries it; see `seriesPinChange` and
   * `normaliseSeriesPrefs` for why a pin of `series` means nothing without it.
   */
  directionChosen?: true;
}

/**
 * The settings that describe how a TITLE reads -- remembered per series and per source, never taken as the
 * global default from inside the reader.
 */
export const LOOK_KEYS = ['mode', 'theme', 'spread', 'pagedDirection'] as const;

/**
 * What a change made in the reader should write to the GLOBAL default.
 *
 * Only what the change itself touched, and never a look key while a title is open: that goes to the title.
 * The reader's live prefs are the global default with the source's and the series' settings laid over it, so
 * saving them wholesale -- what the sheet did -- turned one series' or one source's look into everyone's
 * default, even on a change to brightness. The global default is set under Profile -> Settings.
 * Reintroduce by returning `p` unchanged: readerSourcePrefs.test.ts's global-default cases fail.
 */
export function globalPrefsChange(p: Partial<ReaderPrefs>, inSeries: boolean): Partial<ReaderPrefs> {
  if (!inSeries) return { ...p };
  const out: Partial<ReaderPrefs> = { ...p };
  for (const k of LOOK_KEYS) delete out[k];
  return out;
}

/**
 * A title's look laid over the reader's current settings: only the keys its memory (or its source's default)
 * actually holds, so whatever it does not hold -- the direction, for most titles now -- stays the default's.
 * The reader applies this once it knows the series and again once it knows the series' source.
 */
export function withTitleLook(cur: ReaderPrefs, sp: SeriesPrefs): ReaderPrefs {
  return {
    ...cur,
    ...(sp.mode ? { mode: sp.mode } : {}),
    ...(sp.theme ? { theme: sp.theme } : {}),
    ...(sp.spread !== undefined ? { spread: sp.spread } : {}),
    ...(sp.pagedDirection ? { pagedDirection: sp.pagedDirection } : {}),
  };
}

/**
 * What a change made in the reader, with a title open, pins to that title's memory -- or null for nothing.
 *
 * Any change to the look pins the look as it now stands (mode, theme, spread): that is how a title keeps what
 * it was set to while the defaults move. ⚠️ The DIRECTION is pinned only when the change WAS the direction.
 * v0.46.0 pinned `n.pagedDirection` on every look change, and `n.pagedDirection` is usually `series` inherited
 * from the defaults -- so switching a manga to paged, or to sepia, silently fixed its direction at whatever the
 * profile said that day, and Profile → Settings → Reading direction never reached that title again (#102):
 * the sheet showed "Series default" for it whatever the profile said. `directionChosen` marks a pin the reader
 * made on purpose, which is what lets a deliberate "Series default" for one title outlive a profile change.
 * Reintroduce by adding `pagedDirection: n.pagedDirection` to the look: readerSourcePrefs.test.ts "a change to
 * the look does not pin the direction" finds it pinned.
 */
export function seriesPinChange(p: Partial<ReaderPrefs>, n: ReaderPrefs): SeriesPrefs | null {
  if (!(p.mode || p.theme || p.spread !== undefined || p.pagedDirection)) return null;
  const out: SeriesPrefs = { mode: n.mode, theme: n.theme, spread: n.spread };
  if (p.pagedDirection) { out.pagedDirection = p.pagedDirection; out.directionChosen = true; }
  return out;
}

/**
 * A title's stored memory, with the one kind of pin that is not a pin taken out.
 *
 * v0.46.0 and v0.47.0 wrote the direction in force into a title's memory on ANY change of mode, theme or
 * spread (see `seriesPinChange`). A stored `series` from those builds is therefore almost never a choice --
 * it is the default of the day, and it is exactly the pin that kept the profile's direction away from every
 * title someone had adjusted. It carries no `directionChosen`, so it is dropped here, on every read, and the
 * title follows its source's default and the profile again. A stored `ltr` or `rtl` is kept: it may equally be
 * the default of the day, but it is also what choosing a direction for one title wrote in those builds -- the
 * very workaround #102 describes -- and a choice is not ours to throw away. A pin the reader makes now carries
 * the mark, so a deliberate "Series default" for one title is kept like any other.
 * Reading, not rewriting: the cleaned memory is what the next save writes back, locally and to the account.
 * Reintroduce by returning `raw` unchanged: readerSourcePrefs.test.ts "a stored Series default pin from before
 * v0.48 no longer hides the profile's direction" reads `series` back.
 */
export function normaliseSeriesPrefs(raw: unknown): SeriesPrefs {
  const sp: SeriesPrefs = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as SeriesPrefs) } : {};
  if (sp.pagedDirection === 'series' && sp.directionChosen !== true) delete sp.pagedDirection;
  if (!sp.pagedDirection) delete sp.directionChosen;
  return sp;
}

export function loadSeriesPrefs(seriesId: string): SeriesPrefs {
  if (typeof window === 'undefined' || !seriesId) return {};
  try {
    return normaliseSeriesPrefs(JSON.parse(localStorage.getItem(`yomi_rs_${seriesId}`) || '{}'));
  } catch {
    return {};
  }
}

export function saveSeriesPrefs(seriesId: string, partial: SeriesPrefs) {
  if (!seriesId) return;
  try {
    const cur = loadSeriesPrefs(seriesId);
    localStorage.setItem(`yomi_rs_${seriesId}`, JSON.stringify({ ...cur, ...partial }));
  } catch {}
  queueSync();
}

// ---- per-source memory (the source is the best proxy the app has for the FORMAT) ----
/**
 * Reader settings remembered per SOURCE.
 *
 * Which source a chapter came from is the most reliable signal available for what it actually is: a webtoon
 * site serves long strips, a manga site serves paged volumes. Those want opposite readers -- one continuous
 * vertical scroll, the other right-to-left paged spreads -- and until now the only options were a single global
 * default that was wrong for half the library, or correcting it on every title forever.
 *
 * Same shape as the per-series memory, and resolved between it and the global default:
 *
 *     global default  <  source default  <  this series
 *
 * so setting a source fixes everything from it at once, and a title you have adjusted by hand still wins.
 *
 * Stored under `yomi_rp_` rather than `yomi_rs_` deliberately: `allSeriesPrefs()` collects by that prefix,
 * and a key that began with it would be pushed up as a series override under a source's id.
 */
export type SourcePrefs = SeriesPrefs;

export function loadSourcePrefs(sourceId: string): SourcePrefs {
  if (typeof window === 'undefined' || !sourceId) return {};
  try {
    return JSON.parse(localStorage.getItem(`${SOURCE_KEY}${sourceId}`) || '{}');
  } catch {
    return {};
  }
}

export function saveSourcePrefs(sourceId: string, partial: SourcePrefs) {
  if (!sourceId) return;
  try {
    const cur = loadSourcePrefs(sourceId);
    localStorage.setItem(`${SOURCE_KEY}${sourceId}`, JSON.stringify({ ...cur, ...partial }));
  } catch {}
  queueSync();
}

/** Forget a source's default, so its titles fall back to the global one. */
export function clearSourcePrefs(sourceId: string) {
  if (!sourceId) return;
  try { localStorage.removeItem(`${SOURCE_KEY}${sourceId}`); } catch {}
  queueSync();
}

/**
 * The source a series reads from, remembered on this device.
 *
 * The per-source default is keyed by the SERIES' source, not by the chapter in hand: a downloaded chapter is
 * read from its offline record, which names no source, and a series can mix copies from several sources --
 * keying by the chapter applied the default to nothing downloaded and flipped the look mid-series. The reader
 * learns the series' primary source when it loads the series; this keeps it for opening one offline.
 */
const SERIES_SOURCE_KEY = 'yomi_srcof_';
export function rememberSeriesSource(seriesId: string, src: { id: string; name: string }) {
  if (!seriesId || !src.id) return;
  try { localStorage.setItem(`${SERIES_SOURCE_KEY}${seriesId}`, JSON.stringify(src)); } catch {}
}
export function seriesSourceOf(seriesId: string): { id: string; name: string } | null {
  if (typeof window === 'undefined' || !seriesId) return null;
  try {
    const v = JSON.parse(localStorage.getItem(`${SERIES_SOURCE_KEY}${seriesId}`) || 'null');
    return v && typeof v.id === 'string' && v.id ? { id: v.id, name: typeof v.name === 'string' ? v.name : '' } : null;
  } catch { return null; }
}

/** Every per-source default held locally, capped like the per-series map for the same reason. */
function allSourcePrefs(): Record<string, SourcePrefs> {
  const out: Record<string, SourcePrefs> = {};
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(SOURCE_KEY)) keys.push(k);
    }
    for (const k of keys.slice(-SERIES_CAP)) {
      const id = k.slice(SOURCE_KEY.length);
      const v = loadSourcePrefs(id);
      if (Object.keys(v).length) out[id] = v;
    }
  } catch {}
  return out;
}

export const THEME_FILTER: Record<ReaderTheme, string> = {
  amoled: 'none',
  sepia: 'sepia(0.55) saturate(1.15) brightness(0.94)',
  gray: 'grayscale(0.25) brightness(0.88) contrast(0.95)',
};
