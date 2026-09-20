'use client';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { requestPersist, storageEstimate } from '@/lib/downloads';
import { deviceId } from '@/lib/device';
import { bytes } from '@/lib/format';
import { readShownOnce } from '@/lib/shownOnce';
import { ReaderPrefs, loadPrefs, savePrefs, syncPrefsFromServer } from '@/lib/readerPrefs';
import { Avatar, AVATAR_EMOJIS, AVATAR_COLORS } from '@/components/Avatar';
import { ProgressBar } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { IcBell, IcCheck, IcDownload, IcMoments, IcSparkle } from '@/components/icons';
import { t as tr, LOCALES, keys } from '@/lib/i18n';
import { useT } from '@/lib/I18nProvider';
import { SETTINGS_GRID, Section, Row, SwitchRow, Segmented, NumberRow, RangeRow, LinkRow, useAutosave } from '@/components/settings';

/**
 * The profile's Settings tab: Appearance · Reading · Downloads · This device.
 *
 * Before v0.39.0 these lived as eleven cards across two tabs -- the reader's own defaults on none of them --
 * and every card saved its own way: some on tap, some behind a Save button, some silently. Here every row
 * saves the moment it changes and says so beside the control (`SaveState`); nothing on this tab has a Save
 * button. The DOM order pairs the taller sections at `xl` (Appearance beside Reading, Downloads beside This
 * device) so the two columns end near the same height.
 */
export function ProfileSettings({ weeklyGoal }: { weeklyGoal: number }) {
  return (
    <div className={SETTINGS_GRID}>
      <AppearanceSection />
      <ReadingSection weeklyGoal={weeklyGoal} />
      <DownloadsSection />
      <DeviceSection />
    </div>
  );
}

/**
 * One choice row: a label, an optional line of help, a Segmented control and its own Saved ✓.
 *
 * Each row owns its own `useAutosave` rather than sharing one across the section: the tick belongs beside
 * the row that changed, and one shared status would flash "Saved" next to every row at once.
 */
function Choice<T extends string>({ label, help, value, options, onChange }: {
  label: string; help?: ReactNode; value: T | null; options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => Promise<unknown> | unknown;
}) {
  const { status, run } = useAutosave();
  return (
    <Row label={label} help={help} status={status}>
      <Segmented label={label} value={value} options={options} onChange={(v) => { void run(() => onChange(v)); }} />
    </Row>
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
  const { lang, setLang } = useT();
  const avatarSave = useAutosave();
  const accentSave = useAutosave();

  const av = user?.avatar ?? {};
  const saveAvatar = async (next: { emoji?: string; color?: string }) => {
    const merged = { ...av, ...next };
    // Optimistic: the avatar in the corner changes as you tap, and goes back to what it was (`av` is the
    // pre-tap value) when the PUT is refused -- the row says "Could not save", and a face the server never
    // accepted must not stay pressed beside that sentence. The leaderboard is refetched either way so it
    // never shows a stale face.
    setAvatar(merged);
    const ok = await avatarSave.run(() => api('/api/settings', { method: 'PUT', json: { avatar: merged } }));
    if (!ok) setAvatar(av);
    qc.invalidateQueries({ queryKey: ['leaderboard'] });
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

  // ⚠️ Read at render time, not held in state. I18nProvider remounts its entire subtree on a language change,
  // so tapping a chip while a once-only secret is on screen -- the OPDS password, a fresh API token, the 2FA
  // recovery codes, all on other tabs -- destroys it permanently (the server keeps only a hash) and kills a
  // half-finished 2FA enrolment mid-QR-scan. Any tab switch re-renders this component, so the guard is
  // current by the time the chips can be reached. See lib/shownOnce.ts.
  const locked = !!readShownOnce('opds.link') || !!readShownOnce('apiToken.fresh') || !!readShownOnce('totp.recovery');

  return (
    <Section id="appearance" title={tr('Appearance')} icon={<IcSparkle width={18} height={18} />}>
      <Row stacked label={tr('Avatar')} status={avatarSave.status}>
        <div className="flex items-center gap-4">
          <Avatar avatar={av} size={56} />
          <div className="flex flex-wrap gap-1.5">
            {/* The chosen dot is marked with a ring (a box-shadow), never with `outline`: an inline
                `outline: none` on the seven unchosen dots removed the browser's focus ring from the first
                eight tab stops on this tab, so keyboard focus was invisible until the emoji grid. */}
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

      <Row stacked label={tr('Accent')} status={accentSave.status}>
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

      {/* Written to the server so it follows you to another device, and mirrored to localStorage so the login
          screen -- which nobody is signed in to -- is already translated. The note about machine assistance
          is shown rather than buried in a commit message: someone reading their own language deserves to
          know how it got there, and it is what makes "this is wrong" an invitation instead of a complaint. */}
      <Row stacked label={tr('Language')}
        help={tr('Translations other than English are machine-assisted and have not been checked by a native speaker. If something reads wrong, the language files are one JSON each — corrections are welcome.')}>
        <div className="flex flex-wrap gap-1.5">
          {LOCALES.map((l) => (
            <button key={l.code} type="button" onClick={() => setLang(l.code)} disabled={locked} aria-pressed={lang === l.code}
              className={`chip text-xs disabled:opacity-40 ${lang === l.code ? 'chip-active' : ''}`}>
              {l.name}
            </button>
          ))}
        </div>
        {locked && (
          <p className="mt-2 max-w-prose text-[11px] text-amber-300">
            {tr('Copy what is on screen first. Changing language reloads this page, and the code is shown only once.')}
          </p>
        )}
      </Row>
    </Section>
  );
}

/* ================================ Reading ================================ */

const GOALS = ['5', '10', '20'] as const;
type Goal = (typeof GOALS)[number];

/**
 * The weekly goal and the reader's defaults, side by side.
 *
 * The goal is a second door: the hero's pill and its GoalModal stay, because that is where the number is
 * looked at. The reader defaults are the SAME store the reader's own sheet edits (`lib/readerPrefs.ts`) --
 * before this they were reachable only from inside a chapter, so "make every new series open paged" meant
 * opening one first. ⚠️ Never write `yomi_reader_prefs` or PUT `{reader}` from here: `savePrefs` is the one
 * writer, local-first with the server PUT debounced 1.5 s, and a second writer is how two devices start
 * overwriting each other's row. The Saved ✓ is honest because the local write IS the save the reader reads.
 */
function ReadingSection({ weeklyGoal }: { weeklyGoal: number }) {
  const qc = useQueryClient();
  // Optimistic until the stats query catches up: the Segmented pill would otherwise sit on the old number
  // for the length of a round trip, and a failed save puts it back where the server still has it.
  const [goal, setGoal] = useState(weeklyGoal);
  const [seenGoal, setSeenGoal] = useState(weeklyGoal);
  if (weeklyGoal !== seenGoal) { setSeenGoal(weeklyGoal); setGoal(weeklyGoal); }
  const saveGoal = async (n: number) => {
    setGoal(n);
    try { await api('/api/settings', { method: 'PUT', json: { weeklyGoal: n } }); }
    catch (e) { setGoal(weeklyGoal); throw e; }
    qc.invalidateQueries({ queryKey: ['stats'] });
  };

  const [prefs, setPrefs] = useState(loadPrefs);
  useEffect(() => {
    let live = true;
    syncPrefsFromServer().then((p) => { if (live) setPrefs(p); });
    return () => { live = false; };
  }, []);
  const set = (p: Partial<ReaderPrefs>) => { const n = { ...prefs, ...p }; setPrefs(n); savePrefs(n); };

  return (
    <Section id="reading" title={tr('Reading')} icon={<IcMoments width={18} height={18} />}
      description={tr('These are your defaults: the reader’s own sheet still changes them for the session you are in, and a series you have adjusted keeps its own.')}>
      <Choice<Goal> label={tr('Weekly goal')} value={(GOALS as readonly string[]).includes(String(goal)) ? (String(goal) as Goal) : null}
        options={GOALS.map((g) => ({ value: g, label: g }))} onChange={(g) => saveGoal(Number(g))} />
      <NumberRow label={tr('Custom')} value={goal} min={1} max={999} unit={tr('chapters')} onSave={saveGoal} />

      <Choice label={tr('Mode')} value={prefs.mode}
        options={[{ value: 'vertical', label: tr('Webtoon (scroll)') }, { value: 'paged', label: tr('Paged (swipe)') }]}
        onChange={(mode) => set({ mode })} />
      <Choice label={tr('Theme')} value={prefs.theme}
        options={[{ value: 'amoled', label: tr('AMOLED') }, { value: 'sepia', label: tr('Sepia') }, { value: 'gray', label: tr('Gray') }]}
        onChange={(theme) => set({ theme })} />
      {prefs.mode === 'paged' && (
        <Choice label={tr('Pages per view')} value={prefs.spread ? 'double' : 'single'}
          options={[{ value: 'single', label: tr('Single') }, { value: 'double', label: tr('Double spread') }]}
          onChange={(v) => set({ spread: v === 'double' })} />
      )}
      {/* Set in both modes. ⚠️ It cannot LOOK the same in both: a page-by-page view has no thin slide --
          every slide is exactly one viewport wide -- so Collapse falls back to removing there, where an
          unwanted page costs one swipe rather than a scroll and there is no flow to interrupt. */}
      <Choice label={tr('Repeated pages')} value={prefs.junkPages}
        help={tr('Credit pages and adverts repeat in every chapter. Collapse folds them down to a line you can scroll past or tap to open; hide takes them out of the chapter altogether.')}
        options={[{ value: 'show', label: tr('Show all') }, { value: 'collapse', label: tr('Collapse') }, { value: 'hide', label: tr('Hide') }]}
        onChange={(junkPages) => set({ junkPages })} />
      <Choice label={tr('Fit')} value={prefs.fitWidth ? 'width' : 'original'}
        options={[{ value: 'width', label: tr('Fit width') }, { value: 'original', label: tr('Original') }]}
        onChange={(v) => set({ fitWidth: v === 'width' })} />
      {prefs.mode === 'vertical' && (
        <>
          <RangeRow label={tr('Page gap')} value={prefs.gap} min={0} max={40} step={2} format={(v) => `${v}px`} onChange={(gap) => set({ gap })} />
          <RangeRow label={tr('Auto-scroll')} value={prefs.autoScroll} min={0} max={6} step={0.5}
            format={(v) => (v === 0 ? tr('off') : v.toFixed(1))} onChange={(autoScroll) => set({ autoScroll })} />
        </>
      )}
      <RangeRow label={tr('Brightness')} value={prefs.brightness} min={0.25} max={1} step={0.05}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(brightness) => set({ brightness })} />
    </Section>
  );
}

/* =============================== Downloads =============================== */

const PER_SERIES = ['3', '5', '10'] as const;
type PerSeries = (typeof PER_SERIES)[number];

/**
 * Everything about bytes on this device, in one place.
 *
 * The persist request used to be an unlabelled full-width button that silently called
 * `navigator.storage.persist()` and reported absolutely nothing back; it is a chip with a sentence beside it
 * now, and the sentence changes once the browser has said yes.
 */
function DownloadsSection() {
  const { user, setSettings } = useAuth();
  const toast = useToast();
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [persisted, setPersisted] = useState(false);

  useEffect(() => {
    storageEstimate().then(setUsage);
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
  }, []);

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
    <Section id="downloads" title={tr('Downloads')} icon={<IcDownload width={18} height={18} />}>
      <SwitchRow label={tr('Keep favorites offline')} help={tr('Auto-download the latest unread chapters of your favorites.')}
        on={!!so.enabled} onChange={(enabled) => set({ enabled })} />
      {so.enabled && (
        <Choice<PerSeries> label={tr('Per series')} value={String(so.perSeries || 3) as PerSeries}
          options={PER_SERIES.map((n) => ({ value: n, label: n }))} onChange={(n) => set({ perSeries: Number(n) })} />
      )}
      <Row stacked label={tr('Storage used')}>
        <p className="font-display text-xl font-bold tabular-nums text-fog-50">{bytes(usage.usage)}</p>
        <div className="mt-2"><ProgressBar value={usage.quota ? Math.min(1, usage.usage / usage.quota) : 0} /></div>
      </Row>
      <Row label={tr('Protect downloads')}
        help={persisted ? tr('Protected from eviction') : tr('Tap to ask the browser to protect your downloads from eviction.')}>
        {!persisted && <button type="button" onClick={ask} className="chip text-xs">{tr('Protect downloads')}</button>}
      </Row>
      <LinkRow href="/downloads/" label={tr('Offline downloads')} />
    </Section>
  );
}

/* ============================== This device ============================== */

function urlB64ToUint8(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * What only this browser can answer: push alerts and installing.
 *
 * Both used to be cards that returned null on their own, which reflowed the board differently per install.
 * The section as a whole steps aside only when it has nothing to say -- push unconfigured on the server AND
 * the app already installed -- so the grid is the same shape on every device that has a decision left.
 */
function DeviceSection() {
  const [supported] = useState(() => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
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
        if (k.enabled && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
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
    setStandalone(window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
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
  if (!enabledSrv && standalone) return null;

  return (
    <Section id="device" title={tr('This device')} icon={<IcBell width={18} height={18} />}>
      {enabledSrv && (
        <SwitchRow label={tr('New-chapter alerts')}
          help={supported ? tr('Get a push notification when one of your favorites gets a new chapter.') : tr('Not supported on this browser.')}
          on={on} disabled={!supported} onChange={toggle} />
      )}
      {/* Already installed: the row is about installing, so it unmounts rather than congratulating you. */}
      {!standalone && (
        <Row stacked label={tr('Install Uchiyomi')}>
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
    </Section>
  );
}
