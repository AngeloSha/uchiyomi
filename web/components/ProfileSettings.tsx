'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { requestPersist, storageEstimate } from '@/lib/downloads';
import { deviceId } from '@/lib/device';
import { bytes } from '@/lib/format';
import { readShownOnce } from '@/lib/shownOnce';
import { setTypeToSearchOn, typeToSearchOn } from '@/lib/typeToSearch';
import { compactChaptersOn, setCompactChaptersOn } from '@/lib/compactChapters';
import { showAllChaptersOn } from '@/lib/showAllChapters';
import { notifyOnlyNextOn } from '@/lib/notifyOnlyNext';
import { contextMenusOn, setContextMenusOn } from '@/lib/contextMenus';
import { ReaderPrefs, loadPrefs, savePrefs, syncPrefsFromServer } from '@/lib/readerPrefs';
import { Avatar, AVATAR_EMOJIS, AVATAR_COLORS, type AvatarData } from '@/components/Avatar';
import { FRAMES, badgeCaption, badgeEarned, badgeOfFrame, frameName, type AvatarFrame } from '@/lib/badges';
import type { Stats } from '@/components/ProfileYou';
import { ProgressBar } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcCheck, IcChevronRight, IcDownload, IcLock, IcMoments, IcSliders, IcSparkle } from '@/components/icons';
import { t as tr, LOCALES, keys, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/I18nProvider';
import {
  ChoiceRow, EditorSheet, MoreOptions, Row, RowBlock, RowGroup, RowSubgroup, SegmentedRow, SelectRow, SummaryRow, SwitchRow,
  useAutosave, useEditor,
} from '@/components/settings';
import type { PageView } from '@/components/ConsoleLayout';
import { ModeArt, RepeatedArt, ThemeArt, ToneArt, WideArt } from '@/components/settingsArt';
import { inDesktopWindow, isDesktop } from '@/lib/desktop';
import { usesNativeCache } from '@/lib/native';
import { useIncognito } from '@/components/IncognitoBanner';
import { INCOGNITO_TEXT } from '@/lib/incognito';
import { COMMENTS_TEXT, talkWantedOf } from '@/lib/comments';
import { TONES, toneOf, type Tone } from '@/lib/tone';
import { useReduceEffects } from '@/lib/useReduceEffects';

/**
 * The profile's settings pages: General · Appearance · Reading · This device (v0.86.0), rows of the profile's one list
 * since v0.88.0 (components/ConsoleLayout.tsx), which app/profile/page.tsx draws with its other pages.
 *
 * Before v0.39.0 these lived as eleven cards across two tabs, and every card saved its own way; v0.39.0 made every row
 * save the moment it changes and say so beside the control (`SaveState`). Until v0.86.0 they were four cards of 31 rows
 * on one screen, with seventeen paragraphs of help: the language and four behaviour switches under Appearance, the
 * weekly goal and Incognito under Reading. Now each row is where its name says, a row's help folds to two lines, and a
 * category's line in the list says what is set in it.
 */
export function useProfileSettingsViews(): { views: Record<string, PageView>; pointer: boolean } {
  // Uchiyomi Desktop (lib/desktop.ts): no This device -- no offline copies (the chapters are already on this disk;
  // copying them into the window's storage would store every one twice), no push service, and the app is installed.
  const desktop = isDesktop();
  const pointer = useHoverPointer();
  const { user } = useAuth();
  const { lang } = useT();
  const incognito = useIncognito();

  // The reader's defaults, held here for Reading's rows and the line that sums them up.
  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    let live = true;
    syncPrefsFromServer().then((p) => { if (live) setPrefs(p); });
    return () => { live = false; };
  }, []);
  /** ⚠️ The one writer: `savePrefs`, local first with the server PUT debounced (ReadingSection says why). */
  const setReader = (p: Partial<ReaderPrefs>) => { const n = { ...prefs, ...p }; setPrefs(n); savePrefs(n); };

  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  useEffect(() => { if (!desktop) storageEstimate().then(setUsage); }, [desktop]);

  const so = (user?.settings?.smartOffline ?? {}) as { enabled?: boolean };
  const views: Record<string, PageView> = {
    general: {
      icon: <IcSliders width={18} height={18} />, tint: 'bg-slate-400/15 text-slate-200',
      summary: [LOCALES.find((l) => l.code === lang)?.name ?? lang, incognito.on ? tr(INCOGNITO_TEXT[0]) : null].filter(Boolean).join(' · '),
      pane: <GeneralPane pointer={pointer} />,
    },
    appearance: {
      icon: <IcSparkle width={18} height={18} />, tint: 'bg-violet-500/15 text-violet-300',
      summary: `${tr(TONES.find((t) => t.key === toneOf(user?.settings?.tone))!.label)} · ${colorName(user?.settings?.accent || '#7c5cff')}`,
      pane: <AppearanceSection />,
    },
    reading: {
      icon: <IcMoments width={18} height={18} />, tint: 'bg-amber-500/15 text-amber-300',
      summary: `${prefs.mode === 'paged' ? tr('Paged (swipe)') : tr('Webtoon (scroll)')} · ${tr(THEME_LABEL[prefs.theme])}`,
      description: tr('These are your defaults: the reader’s own sheet still changes them for the session you are in, and a series you have adjusted keeps its own.'),
      pane: <ReadingSection prefs={prefs} set={setReader} />,
    },
    device: {
      icon: <IcDownload width={18} height={18} />, tint: 'bg-sky-500/15 text-sky-300',
      summary: [usage.usage > 0 ? bytes(usage.usage) : null, so.enabled ? tr('Keep favorites offline') : null].filter(Boolean).join(' · ') || undefined,
      pane: <DevicePane usage={usage} />,
    },
  };
  return { views, pointer };
}

/**
 * Whether this device has a pointer that can hover -- a mouse or a trackpad -- rather than only a touchscreen. The
 * compact chapter list and type-to-search do nothing on a phone or a tablet held alone, so their rows are not drawn
 * there (v0.86.0). Read on the first render where there is a window (the page renders on the client), and followed: a
 * tablet that gains a trackpad gains the rows.
 */
function useHoverPointer(): boolean {
  const query = '(any-hover: hover)';
  const [on, setOn] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(query);
    const read = () => setOn(m.matches);
    read();
    m.addEventListener?.('change', read);
    return () => m.removeEventListener?.('change', read);
  }, []);
  return on;
}

const THEME_LABEL = { amoled: 'AMOLED', paper: 'Paper', sepia: 'Sepia', gray: 'Gray' } as const;

/* ================================ General ================================ */

/** The language, how series pages list chapters, the shortcuts, and Incognito. */
function GeneralPane({ pointer }: { pointer: boolean }) {
  const { user, setSettings } = useAuth();
  const { lang, setLang } = useT();
  const incognito = useIncognito();
  // Read after mount: localStorage is not there during the static export's render.
  const [typeSearch, setTypeSearch] = useState(true);
  useEffect(() => { setTypeSearch(typeToSearchOn()); }, []);
  const [compactList, setCompactList] = useState(false);
  useEffect(() => { setCompactList(compactChaptersOn()); }, []);
  const [contextMenus, setContextMenus] = useState(true);
  useEffect(() => { setContextMenus(contextMenusOn()); }, []);
  // Show all chapters at once (lib/showAllChapters.ts): on the account like Reduce effects, so every device the
  // reader signs in on opens the whole list; optimistic, and put back when the server refuses.
  // Only tell this account about a new chapter when it is the one it would read next (bff lib/nextUp.ts). On the account
  // like the switch above; the server reads it when it sends a push or a person-aimed target's message.
  const notifyOnlyNext = notifyOnlyNextOn(user?.settings);
  const saveNotifyOnlyNext = async (next: boolean) => {
    const prev = notifyOnlyNext;
    setSettings({ notifyOnlyNext: next });
    try { await api('/api/settings', { method: 'PUT', json: { notifyOnlyNext: next } }); }
    catch (e) { setSettings({ notifyOnlyNext: prev }); throw e; }
  };
  const showAllChapters = showAllChaptersOn(user?.settings);
  const saveShowAllChapters = async (next: boolean) => {
    const prev = showAllChapters;
    setSettings({ showAllChapters: next });
    try { await api('/api/settings', { method: 'PUT', json: { showAllChapters: next } }); }
    catch (e) { setSettings({ showAllChapters: prev }); throw e; }
  };

  // ⚠️ Read at render time, not held in state. I18nProvider remounts its entire subtree on a language change,
  // so picking a language while a once-only secret is on screen -- the OPDS password, a fresh API token, the 2FA
  // recovery codes, all on other tabs -- destroys it permanently (the server keeps only a hash) and kills a
  // half-finished 2FA enrolment mid-QR-scan. Any tab switch re-renders this component, so the guard is
  // current by the time the menu can be reached. See lib/shownOnce.ts.
  const locked = !!readShownOnce('opds.link') || !!readShownOnce('apiToken.fresh') || !!readShownOnce('totp.recovery');

  return (
    <>
      {/* Written to the server so it follows you to another device, and mirrored to localStorage so the login
          screen -- which nobody is signed in to -- is already translated. The note about machine assistance
          is shown rather than buried in a commit message: someone reading their own language deserves to
          know how it got there, and it is what makes "this is wrong" an invitation instead of a complaint. */}
      <RowGroup>
        <RowBlock id="language">
          <SelectRow<Locale> label={tr('Language')} value={lang} disabled={locked}
            help={tr('Translations other than English are machine-assisted and have not been checked by a native speaker. If something reads wrong, the language files are one JSON each — corrections are welcome.')}
            options={LOCALES.map((l) => ({ value: l.code, label: l.name }))} onChange={(code) => setLang(code)} />
          {locked && (
            <p className="mt-2 max-w-prose text-[11px] text-amber-300">
              {tr('Copy what is on screen first. Changing language reloads this page, and the code is shown only once.')}
            </p>
          )}
        </RowBlock>
      </RowGroup>

      <RowGroup title={tr('Series pages')}>
        <SwitchRow id="show-all-chapters" label={tr('Show all chapters at once')}
          help={tr('A series page lists every chapter, including those not here yet, on one page instead of a hundred at a time. Saved to your account.')}
          on={showAllChapters} onChange={saveShowAllChapters} />
        {/* This device only, and only a computer's rows change: lib/compactChapters.ts. Off by default -- the default
            chapter row is the deliberate look, and taking part of it away is the reader's choice. Not drawn where there
            is no pointer to point with. */}
        {pointer && (
          <SwitchRow id="compact-chapters" device label={tr('Compact chapter list')}
            help={tr('On a computer, chapter rows without thumbnails, and their buttons appear when you point at a row. Phones and tablets are unchanged. This device only.')}
            on={compactList} onChange={(next) => { setCompactChaptersOn(next); setCompactList(next); }} />
        )}
      </RowGroup>

      <RowGroup title={tr('Notifications')}>
        <SwitchRow id="notify-only-next" label={tr('Only tell me about my next chapter')}
          help={tr('A new chapter notifies you only when it is the one the series page would open for you: you are caught up, with nothing older unread or half read. Applies to push alerts and to messages sent to you. Saved to your account.')}
          on={notifyOnlyNext} onChange={saveNotifyOnlyNext} />
      </RowGroup>

      <RowGroup title={tr('Shortcuts')}>
        {/* This device only (lib/typeToSearch.ts says why): single-key shortcuts must be possible to switch off. */}
        {pointer && (
          <SwitchRow id="type-to-search" device label={tr('Type anywhere to search')}
            help={tr('Start typing a title on any page to open search with it. This also switches the / shortcut, on this device only.')}
            on={typeSearch} onChange={(next) => { setTypeToSearchOn(next); setTypeSearch(next); }} />
        )}
        {/* This device only (lib/contextMenus.ts, #100). On by default: the menus only take the right-click where the
            browser's offers nothing worth keeping, and Shift+right-click still gets it. */}
        <SwitchRow id="context-menus" device label={tr('Right-click menus')}
          help={tr('Right-click a series or a chapter, or press and hold one on a touchscreen, for its actions. Shift+right-click still opens the browser’s own menu. This device only.')}
          on={contextMenus} onChange={(next) => { setContextMenusOn(next); setContextMenus(next); }} />
      </RowGroup>

      {/* v0.61.0: the account's, not this device's (lib/incognito.ts); the reader's sheet has the same switch. */}
      <RowGroup title={tr('Privacy')}>
        <SwitchRow id="incognito" label={tr(INCOGNITO_TEXT[0])} help={tr(INCOGNITO_TEXT[1])} on={incognito.on} onChange={incognito.set} />
      </RowGroup>
    </>
  );
}

/* ============================== Appearance ============================== */

// Rendered as `tr(name)`, so the names are declared rather than inline. See lib/i18n.ts. The first six are
// the accent palette; the avatar palette adds two more.
const ACCENT_NAMES = keys('Violet', 'Cyan', 'Emerald', 'Rose', 'Amber', 'Azure');
const ACCENTS = ['#7c5cff', '#22d3ee', '#34d399', '#fb7185', '#f59e0b', '#60a5fa']
  .map((hex, i) => ({ name: ACCENT_NAMES[i], hex }));
const EXTRA_COLOR_NAMES = keys('Purple', 'Red');
// Keyed by hex rather than by position: `AVATAR_COLORS` is Avatar.tsx's list, and an index into a parallel
// array here would silently mislabel every dot the day someone reorders it. An unknown hex reads as itself.
const COLOR_NAMES: Record<string, string> = {
  ...Object.fromEntries(ACCENTS.map((a): [string, string] => [a.hex, a.name])),
  '#a855f7': EXTRA_COLOR_NAMES[0],
  '#ef4444': EXTRA_COLOR_NAMES[1],
};
const colorName = (hex: string): string => { const n = COLOR_NAMES[hex.toLowerCase()]; return n ? tr(n) : hex; };

function AppearanceSection() {
  const { user, setAvatar, setSettings } = useAuth();
  const qc = useQueryClient();
  const avatarSave = useAutosave();
  const frameSave = useAutosave();
  const accentSave = useAutosave();
  const avatarEditor = useEditor('avatar');

  const av: AvatarData = user?.avatar ?? {};
  const saveAvatar = async (next: Partial<AvatarData>, saver = avatarSave) => {
    const merged = { ...av, ...next };
    // Optimistic: the avatar in the corner changes as you tap, and goes back to what it was (`av` is the
    // pre-tap value) when the PUT is refused -- the row says "Could not save", and a face the server never
    // accepted must not stay pressed beside that sentence. The leaderboard is refetched either way so it
    // never shows a stale face. The whole avatar is sent: the frame worn rides along with a new emoji, and a
    // frame left out (None) is taken off.
    setAvatar(merged);
    const ok = await saver.run(() => api('/api/settings', { method: 'PUT', json: { avatar: merged } }));
    if (!ok) setAvatar(av);
    qc.invalidateQueries({ queryKey: ['leaderboard'] });
  };

  // v0.89.0 (#267 part 3, CheetahDoesStuff): the frames the badges unlock (lib/badges.ts), measured on the profile's own
  // numbers -- the You tab's request, shared. A frame not earned yet is shown greyed with what it takes; the server
  // refuses it too (bff lib/badges.ts), and keeps the one already worn.
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats'), enabled: avatarEditor.open });
  const [aboutFrame, setAboutFrame] = useState<AvatarFrame | null>(null);
  const mayWear = (fr: AvatarFrame) => av.frame === fr || (!!stats && badgeEarned(badgeOfFrame(fr), stats));
  const frameCaption = (fr: AvatarFrame | null): string => {
    if (!fr) return tr('Each badge you earn unlocks a frame. Everyone in your household sees the one you wear.');
    const badge = badgeOfFrame(fr);
    return mayWear(fr)
      ? `${frameName(fr)} · ${tr('Unlocked with {badge}', { badge: tr(badge.label) })}`
      : `${frameName(fr)} · ${tr('Unlocks with {badge}', { badge: tr(badge.label) })}${stats ? ` · ${badgeCaption(badge, stats)}` : ''}`;
  };

  const [accent, setAccent] = useState<string>(user?.settings?.accent || '#7c5cff');
  const pickAccent = (hex: string) => {
    // The same optimistic-then-revert as the switches: `--accent` is applied at once through the auth
    // context, so a refused colour would otherwise stay applied and pressed until a reload.
    const prev = accent;
    setAccent(hex);
    setSettings({ accent: hex });
    void accentSave.run(() => api('/api/settings', { method: 'PUT', json: { accent: hex } }))
      .then((ok) => { if (!ok) { setAccent(prev); setSettings({ accent: prev }); } });
  };

  // The background tone (lib/tone.ts): on the account like the accent, applied the moment it is picked -- `setSettings`
  // puts it on <html> and the browser bar -- and put back if the server refuses, so the checked card is always the tone
  // the account holds.
  const tone = toneOf(user?.settings?.tone);
  const pickTone = async (next: Tone) => {
    if (next === tone) return;
    const prev = user?.settings?.tone ?? null;
    setSettings({ tone: next });
    try { await api('/api/settings', { method: 'PUT', json: { tone: next } }); }
    catch (e) { setSettings({ tone: prev }); throw e; }
  };

  // Reduce effects (#71): the performance mode. Stored on the account like the accent, so it follows the
  // person to another device, and applied the moment it is flipped -- `setSettings` sets html.reduce-effects
  // and its mirror (lib/effects.ts) -- then put back if the server refuses, so the switch never shows a
  // state the account does not hold.
  const [reduceEffects, saveReduceEffects] = useReduceEffects();

  return (
    <>
      <RowGroup>
        {/* Three curated tones, each drawn in its own colours whatever tone is on: the page, a card on it, and the accent.
            OLED black is first and the default. */}
        <ChoiceRow<Tone> id="background" label={tr('Background')}
          help={tr('True black suits OLED screens. Graphite and Midnight are softer on other displays.')}
          value={tone} onChange={pickTone} optionProps={(v) => ({ 'data-tone-choice': v })}
          options={TONES.map((t) => ({ value: t.key, label: tr(t.label), art: <ToneArt tone={t.key} /> }))} />
        <Row id="accent" stacked label={tr('Accent')} status={accentSave.status}>
          <div className="flex flex-wrap gap-3">
            {ACCENTS.map((a) => (
              <button key={a.hex} type="button" onClick={() => pickAccent(a.hex)} className="relative h-11 w-11 rounded-full"
                style={{ background: a.hex }} aria-label={tr(a.name)} aria-pressed={accent.toLowerCase() === a.hex.toLowerCase()}>
                {accent.toLowerCase() === a.hex.toLowerCase() && (
                  <span className="absolute inset-0 grid place-items-center text-black"><IcCheck width={18} height={18} /></span>
                )}
              </button>
            ))}
          </div>
        </Row>
      </RowGroup>

      <RowGroup>
        <SummaryRow id="avatar" ref={avatarEditor.row} label={tr('Avatar')} onClick={avatarEditor.show}
          value={<span className="inline-block align-middle"><Avatar avatar={av} size={30} /></span>} />
        <SwitchRow id="reduce-effects" label={tr('Reduce effects')}
          help={tr('Turns off the animated background, blur, smooth scrolling and transitions. Try it if scrolling feels slow.')}
          on={reduceEffects} onChange={saveReduceEffects} />
      </RowGroup>

      <EditorSheet title={tr('Avatar')} open={avatarEditor.open} onClose={avatarEditor.close}>
        <Row stacked label={tr('Avatar')} status={avatarSave.status}>
          <div className="flex items-center gap-4">
            <Avatar avatar={av} size={56} />
            <div className="flex flex-wrap gap-1.5">
              {/* The chosen dot is marked with a ring (a box-shadow), never with `outline`: an inline
                  `outline: none` on the seven unchosen dots removed the browser's focus ring from the first
                  eight tab stops, so keyboard focus was invisible until the emoji grid. */}
              {AVATAR_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => saveAvatar({ color: c })} aria-label={colorName(c)} aria-pressed={av.color === c}
                  className={`h-7 w-7 rounded-full ${av.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-ink-850' : ''}`}
                  style={{ background: c }} />
              ))}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {AVATAR_EMOJIS.map((e) => (
              <button key={e} type="button" onClick={() => saveAvatar({ emoji: e })} aria-label={e} aria-pressed={av.emoji === e}
                className={`grid h-10 w-10 place-items-center rounded-xl border text-xl ${av.emoji === e ? 'border-accent bg-accent-soft' : 'border-ink-700'}`}>
                {e}
              </button>
            ))}
          </div>
        </Row>
        {/* The frames, each on this face: None, then the badges' order. A locked one is a key too -- tapping it says
            what it takes, as a badge on the You tab does -- but it saves nothing. */}
        <Row id="avatar-frame" stacked label={tr('Frame')} status={frameSave.status}>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7"
            onMouseLeave={() => setAboutFrame(null)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAboutFrame(null); }}>
            <button type="button" aria-pressed={!av.frame} data-frame-choice="none" onClick={() => saveAvatar({ frame: undefined }, frameSave)}
              className={`grid justify-items-center gap-1.5 rounded-2xl border px-1 pb-2 pt-3 text-[11px] ${!av.frame ? 'border-accent bg-accent-soft text-accent' : 'border-ink-700 text-fog-300 hover:border-ink-600'}`}>
              <Avatar avatar={{ ...av, frame: undefined }} size={40} />
              <span>{tr('None')}</span>
            </button>
            {FRAMES.map((fr) => {
              const ok = mayWear(fr);
              const on = av.frame === fr;
              return (
                <button key={fr} type="button" aria-pressed={on} aria-disabled={!ok || undefined} data-frame-choice={fr}
                  title={frameCaption(fr)}
                  onMouseEnter={() => setAboutFrame(fr)} onFocus={() => setAboutFrame(fr)}
                  onClick={() => { setAboutFrame(fr); if (ok && !on) void saveAvatar({ frame: fr }, frameSave); }}
                  className={`relative grid justify-items-center gap-1.5 rounded-2xl border px-1 pb-2 pt-3 text-[11px] ${on ? 'border-accent bg-accent-soft text-accent' : ok ? 'border-ink-700 text-fog-200 hover:border-ink-600' : 'border-ink-800 text-fog-500'}`}>
                  <Avatar avatar={{ ...av, frame: fr }} size={40} frameLocked={!ok} />
                  <span className="truncate">{frameName(fr)}</span>
                  {!ok && <IcLock width={12} height={12} aria-hidden className="absolute end-1.5 top-1.5 text-fog-500" />}
                </button>
              );
            })}
          </div>
          <p data-frame-caption className="mt-2.5 text-xs text-fog-400">{frameCaption(aboutFrame)}</p>
        </Row>
      </EditorSheet>
    </>
  );
}

/* ================================ Reading ================================ */

/**
 * The reader's defaults, the same store the reader's own sheet edits (`lib/readerPrefs.ts`) -- before v0.39.0 they were
 * reachable only from inside a chapter, so "make every new series open paged" meant opening one first. ⚠️ Never write
 * `yomi_reader_prefs` or PUT `{reader}` from here: `savePrefs` (through `set`) is the one writer, local-first with the
 * server PUT debounced 1.5 s, and a second writer is how two devices start overwriting each other's row. The Saved ✓ is
 * honest because the local write IS the save the reader reads.
 *
 * Paged mode's rows are always drawn, in More options under their mode's name: until v0.86.0 they hid while the default
 * mode was Webtoon, though "Pick the mode for each series" opens manga paged whatever it is. Brightness, the page gap,
 * auto-scroll and the cover's colour at the edges are the reader's own sheet's: they are adjusted while looking at a
 * page, and the group says so.
 */
function ReadingSection({ prefs, set }: { prefs: ReaderPrefs; set: (p: Partial<ReaderPrefs>) => void }) {
  // v0.90.0: Comments and reactions (lib/comments.ts COMMENTS_TEXT), the account's like Show all chapters at once --
  // optimistic, put back when the server refuses -- and only where the household has talk (`talk` on /auth/me). The
  // talk already asked for is asked again, so a reader or a series page in another tab follows.
  const { user, setSettings } = useAuth();
  const qc = useQueryClient();
  const talkWanted = talkWantedOf(user?.settings);
  const saveTalk = async (next: boolean) => {
    setSettings({ comments: next });
    try { await api('/api/settings', { method: 'PUT', json: { comments: next } }); }
    catch (e) { setSettings({ comments: !next }); throw e; }
    // Every chapter's talk and every series' counts (lib/comments.ts talkKey, seriesTalkKey).
    void qc.invalidateQueries({ queryKey: ['comments'] });
    void qc.invalidateQueries({ queryKey: ['series-comments'] });
  };
  return (
    <>
      <RowGroup title={tr('Reader')}>
        <ChoiceRow id="reader-mode" label={tr('Mode')} value={prefs.mode} onChange={(mode) => set({ mode })}
          options={[
            { value: 'vertical', label: tr('Webtoon (scroll)'), art: <ModeArt mode="vertical" /> },
            { value: 'paged', label: tr('Paged (swipe)'), art: <ModeArt mode="paged" /> },
          ]} />
        {/* v0.61.0: the mode above is then the default only for a title the pick cannot place. */}
        <SwitchRow id="auto-mode" label={tr('Pick the mode for each series')}
          help={tr('Long strips and webtoons open in Webtoon mode, manga and right-to-left series in Paged. A series or a source you have set yourself keeps its own.')}
          on={prefs.autoMode} onChange={(autoMode) => set({ autoMode })} />
        <ChoiceRow id="reader-theme" label={tr('Theme')} value={prefs.theme} onChange={(theme) => set({ theme })}
          options={(['amoled', 'paper', 'sepia', 'gray'] as const).map((t) => ({ value: t, label: tr(THEME_LABEL[t]), art: <ThemeArt theme={t} /> }))} />
        {!isDesktop() && user?.talk && (
          <SwitchRow id="comments" label={tr(COMMENTS_TEXT[0])} help={tr(COMMENTS_TEXT[1])} on={talkWanted} onChange={saveTalk} />
        )}
      </RowGroup>

      <RowGroup title={tr('Pages')}
        description={tr('Brightness, the gap between pages, auto-scroll and the cover’s colour at the edges are set in the reader, while you look at a page.')}>
        <SegmentedRow id="fit" label={tr('Fit')} value={prefs.fitWidth ? 'width' : 'original'}
          options={[{ value: 'width', label: tr('Fit width') }, { value: 'original', label: tr('Original') }]}
          onChange={(v) => set({ fitWidth: v === 'width' })} />
        {/* v0.61.0: what a double-page spread becomes on a screen held upright. */}
        <ChoiceRow id="wide-pages" label={tr('Wide pages')} value={prefs.widePages} onChange={(widePages) => set({ widePages })}
          help={tr('On a screen held upright, a double-page spread can be split into its two pages, or turned on its side to fill the screen.')}
          options={[
            { value: 'whole', label: tr('Whole'), art: <WideArt how="whole" /> },
            { value: 'split', label: tr('Split'), art: <WideArt how="split" /> },
            { value: 'rotate', label: tr('Rotate'), art: <WideArt how="rotate" /> },
          ]} />
        {/* Set in both modes. ⚠️ It cannot LOOK the same in both: a page-by-page view has no thin slide --
            every slide is exactly one viewport wide -- so Collapse falls back to removing there, where an
            unwanted page costs one swipe rather than a scroll and there is no flow to interrupt. */}
        <ChoiceRow id="repeated-pages" label={tr('Repeated pages')} value={prefs.junkPages} onChange={(junkPages) => set({ junkPages })}
          help={tr('Credit pages and adverts repeat in every chapter. Collapse folds them down to a line you can scroll past or tap to open; hide takes them out of the chapter altogether.')}
          options={[
            { value: 'show', label: tr('Show all'), art: <RepeatedArt how="show" /> },
            { value: 'collapse', label: tr('Collapse'), art: <RepeatedArt how="collapse" /> },
            { value: 'hide', label: tr('Hide'), art: <RepeatedArt how="hide" /> },
          ]} />
        <MoreOptions id="reading-more">
          <RowSubgroup title={tr('Paged mode')}>
            <SegmentedRow id="reading-direction" label={tr('Reading direction')} value={prefs.pagedDirection}
              options={[{ value: 'series', label: tr('Series default') }, { value: 'ltr', label: tr('Left to right') }, { value: 'rtl', label: tr('Right to left') }]}
              onChange={(v) => set({ pagedDirection: v })} />
            <SegmentedRow id="pages-per-view" label={tr('Pages per view')} value={prefs.spread ? 'double' : 'single'}
              options={[{ value: 'single', label: tr('Single') }, { value: 'double', label: tr('Double spread') }]}
              onChange={(v) => set({ spread: v === 'double' })} />
            {/* #229: off until chosen; in Paged mode, whatever the default mode here, since a series can open paged anyway. */}
            <SwitchRow id="join-split" label={tr('Join split double pages')}
              help={tr('Shows two pages that a source cut from one double-page spread as that spread, in Paged mode. The server looks for them when a chapter is first opened, so they join a moment later. On a screen held upright, Wide pages applies to them.')}
              on={prefs.joinSplit} onChange={(joinSplit) => set({ joinSplit })} />
          </RowSubgroup>
          <SwitchRow id="crop-borders" label={tr('Crop page borders')}
            help={tr('Trims the blank margins around scanned pages. In Webtoon mode only the sides are trimmed, by the same amount for a whole chapter.')}
            on={prefs.cropBorders} onChange={(cropBorders) => set({ cropBorders })} />
        </MoreOptions>
      </RowGroup>
    </>
  );
}

/* ============================== This device ============================== */

const PER_SERIES = ['3', '5', '10'] as const;
type PerSeries = (typeof PER_SERIES)[number];

function DevicePane({ usage }: { usage: { usage: number; quota: number } }) {
  return (
    <>
      <DownloadsSection usage={usage} />
      <DeviceSection />
    </>
  );
}

/**
 * Everything about this device's copies of chapters, in one place: whether favourites are kept offline, and the space
 * they take, which the browser is asked to protect. The persist request used to be an unlabelled full-width button
 * that silently called `navigator.storage.persist()` and reported nothing back; it is a key with a sentence beside it,
 * and the sentence changes once the browser has said yes. "Offline downloads": this device's copies -- since v0.49.0 a
 * bare "Downloads" names the server's view.
 */
function DownloadsSection({ usage }: { usage: { usage: number; quota: number } }) {
  const { user, setSettings } = useAuth();
  const toast = useToast();
  const [persisted, setPersisted] = useState(false);
  useEffect(() => { navigator.storage?.persisted?.().then(setPersisted).catch(() => {}); }, []);

  const so = (user?.settings?.smartOffline ?? {}) as { enabled?: boolean; perSeries?: number };
  const set = async (partial: { enabled?: boolean; perSeries?: number }) => {
    const next = { enabled: !!so.enabled, perSeries: so.perSeries || 3, ...partial };
    // Optimistic, and put back on failure: SwitchRow reverts its own knob when the save throws, and the
    // auth context has to agree or the knob would spring forward again on the next render.
    setSettings({ smartOffline: next });
    try { await api('/api/settings', { method: 'PUT', json: { smartOffline: next } }); }
    catch (e) { setSettings({ smartOffline: so }); throw e; }
  };
  const ask = async () => {
    const ok = await requestPersist();
    setPersisted(ok);
    toast(ok ? tr('Protected from eviction') : tr('The browser did not grant it.'), ok ? 'success' : 'error');
  };

  return (
    <RowGroup id="downloads" title={tr('Offline downloads')}>
      <SwitchRow id="keep-offline" label={tr('Keep favorites offline')} help={tr('Auto-download the latest unread chapters of your favorites.')}
        on={!!so.enabled} onChange={(enabled) => set({ enabled })} />
      {so.enabled && (
        <SegmentedRow<PerSeries> label={tr('Per series')} value={String(so.perSeries || 3) as PerSeries}
          options={PER_SERIES.map((n) => ({ value: n, label: n }))} onChange={(n) => set({ perSeries: Number(n) })} />
      )}
      <RowBlock id="storage">
        <Row label={tr('Storage used')}
          help={persisted ? tr('Protected from eviction') : tr('Tap to ask the browser to protect your downloads from eviction.')}>
          <span className="font-display text-base font-bold tabular-nums text-fog-50">{bytes(usage.usage)}</span>
        </Row>
        <div className="mt-2"><ProgressBar value={usage.quota ? Math.min(1, usage.usage / usage.quota) : 0} /></div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!persisted && <button type="button" onClick={ask} className="btn-key">{tr('Protect downloads')}</button>}
          <Link href="/downloads/" className="btn-key gap-1">
            {tr('Offline downloads')}<IcChevronRight width={14} height={14} aria-hidden className="rtl:-scale-x-100" />
          </Link>
        </div>
      </RowBlock>
    </RowGroup>
  );
}

function urlB64ToUint8(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * What only this browser can answer: push alerts and installing.
 *
 * Both used to be cards that returned null on their own, which reflowed the board differently per install. The group
 * as a whole steps aside only when it has nothing to say -- push unconfigured on the server AND the app already
 * installed.
 */
function DeviceSection() {
  // Uchiyomi Desktop's window onto a server (its server mode -- standalone hides this whole category) has no push
  // service: Electron ships none, so the switch could only ever fail with "The browser did not grant it." There
  // the row says where new-chapter alerts come from instead (V2 review, v0.45.0).
  const [inApp] = useState(() => inDesktopWindow());
  const [native] = useState(usesNativeCache);
  const [supported] = useState(() => !inApp && !usesNativeCache() && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  const [enabledSrv, setEnabledSrv] = useState(false);
  const [key, setKey] = useState('');
  const [on, setOn] = useState(false);
  // Flips run one after another, never at once, and the switch is NOT disabled meanwhile: Chrome blurs a
  // focused control the moment it becomes disabled, so a `busy` flag on `disabled` dropped keyboard focus
  // to <body> on every toggle. A second flip while the browser still holds the first waits its turn and
  // then acts on the real subscription, which is why `flip` asks the push manager rather than `on`.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    (async () => {
      try {
        const k = await api<{ enabled: boolean; key: string }>('/api/push/key');
        setEnabledSrv(k.enabled); setKey(k.key);
        if (k.enabled && supported && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          setOn(!!(await reg.pushManager.getSubscription()));
        }
      } catch { /* no VAPID key configured; the row stays unmounted */ }
    })();
  }, []);

  /** Bring the subscription to `next`, and resolve to the state actually reached. */
  const flip = async (next: boolean): Promise<boolean> => {
    const reg = await navigator.serviceWorker.ready;
    try {
      const sub = await reg.pushManager.getSubscription();
      if (!next) {
        if (sub) { await api('/api/push/unsubscribe', { json: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
        setOn(false);
        return false;
      }
      if (!sub) {
        if ((await Notification.requestPermission()) !== 'granted') { setOn(false); return false; }
        const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) as unknown as BufferSource });
        const j = fresh.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
        if (!j.endpoint || !j.keys) { setOn(false); return false; }
        await api('/api/push/subscribe', { json: { endpoint: j.endpoint, keys: j.keys, deviceId: deviceId() } });
      }
      setOn(true);
      return true;
    } catch {
      // The subscribe or the server call failed part-way: the browser knows what is left, so ask it rather
      // than guess, and the switch shows exactly that.
      const left = !!(await reg.pushManager.getSubscription().catch(() => null));
      setOn(left);
      return left;
    }
  };

  const toggle = (next: boolean) => {
    if (!supported) return;
    const job = queue.current.then(() => flip(next)).then((reached) => {
      // A denied permission is the person's own choice, not a fault -- but the row must not read Saved ✓
      // for a state that was never reached. Throwing is what SwitchRow reads as "put the knob back". ⚠️ In
      // the shape `msgOf` parses (a body with a `message`), as ProfileAccount's `explain` does: a plain
      // `new Error(sentence)` has no `body`, and the row said "Could not save" instead of the sentence.
      if (reached !== next) throw new ApiError(0, JSON.stringify({ message: tr('The browser did not grant it.') }));
    });
    queue.current = job.catch(() => {});
    return job;
  };

  const [canInstall, setCanInstall] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    setCanInstall(!!(window as any).__yomiInstall);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));
    // Uchiyomi Desktop's window (either mode) is an installed app already: nothing to install from it.
    setStandalone(window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true || inDesktopWindow() || usesNativeCache());
  }, []);

  const install = async () => {
    const e = (window as any).__yomiInstall;
    if (!e) return;
    e.prompt();
    await e.userChoice;
    (window as any).__yomiInstall = null;
    setCanInstall(false);
  };

  // Nothing to decide here: push is not configured on the server and the app is already installed.
  if (native || (!enabledSrv && standalone)) return null;

  return (
    <RowGroup id="device" title={tr('Alerts and app')}>
      {enabledSrv && (inApp ? (
        <Row id="chapter-alerts" stacked label={tr('New-chapter alerts')}>
          <p className="max-w-prose text-sm text-fog-400">{tr('The desktop app cannot receive push notifications. Your server can still send new chapters to your phone, Home Assistant or Discord through a notification target, which an admin sets up under Admin → Settings → Notifications.')}</p>
        </Row>
      ) : (
        <SwitchRow id="chapter-alerts" device label={tr('New-chapter alerts')}
          help={supported ? tr('Get a push notification when one of your favorites gets a new chapter, or when someone comments on a chapter you commented on.') : tr('Not supported on this browser.')}
          on={on} disabled={!supported} onChange={toggle} />
      ))}
      {/* Already installed: the row is about installing, so it unmounts rather than congratulating you. */}
      {!standalone && (
        <Row id="install" stacked label={tr('Install Uchiyomi')}>
          {canInstall ? (
            <button type="button" onClick={install} className="btn-accent px-4 py-2 text-sm">
              <IcDownload width={18} height={18} />{tr('Add to home screen')}
            </button>
          ) : isIOS ? (
            <div className="max-w-prose text-sm text-fog-300">
              <p className="mb-1 font-medium text-fog-100">{tr('Add to your iPhone')}</p>
              <p>{tr('Tap Share in Safari, then Add to Home Screen.')}</p>
              <p className="mt-2 text-xs text-fog-500">{tr('On iOS, offline downloads may be cleared by the system under storage pressure.')}</p>
            </div>
          ) : (
            <p className="max-w-prose text-sm text-fog-400">{tr('Open in Chrome/Edge and use “Install app” from the menu.')}</p>
          )}
        </Row>
      )}
    </RowGroup>
  );
}
