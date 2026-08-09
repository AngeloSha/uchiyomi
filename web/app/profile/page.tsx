'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { requestPersist, storageEstimate } from '@/lib/downloads';
import { deviceId } from '@/lib/device';
import { bytes, relativeTime } from '@/lib/format';
import { Avatar, AVATAR_EMOJIS, AVATAR_COLORS } from '@/components/Avatar';
import { SecurityPanel } from '@/components/SecurityPanel';
import { IcDownload, IcSparkle, IcCheck, IcUser, IcChevronRight, IcRefresh } from '@/components/icons';

function urlB64ToUint8(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const ACCENTS = [
  { name: 'Violet', hex: '#7c5cff' },
  { name: 'Cyan', hex: '#22d3ee' },
  { name: 'Emerald', hex: '#34d399' },
  { name: 'Rose', hex: '#fb7185' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Azure', hex: '#60a5fa' },
];

interface Stats {
  chapters_completed: number;
  series_touched: number;
  total_events: number;
  last_read_at: string | null;
  byDay: { day: string; chapters: number }[];
  currentStreak: number;
  longestStreak: number;
  weekChapters: number;
  weeklyGoal: number;
}

const BADGES = [
  { emoji: '📖', label: 'Reader', test: (s: Stats) => s.chapters_completed >= 10 },
  { emoji: '🐛', label: 'Bookworm', test: (s: Stats) => s.chapters_completed >= 50 },
  { emoji: '🔥', label: 'On a roll', test: (s: Stats) => s.longestStreak >= 7 },
  { emoji: '💯', label: 'Centurion', test: (s: Stats) => s.chapters_completed >= 100 },
  { emoji: '🌙', label: 'Devoted', test: (s: Stats) => s.longestStreak >= 30 },
  { emoji: '👑', label: 'Legend', test: (s: Stats) => s.chapters_completed >= 500 },
];

function GoalRing({ value, goal }: { value: number; goal: number }) {
  const pct = goal > 0 ? Math.min(1, value / goal) : 0;
  const R = 26, C = 2 * Math.PI * R;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r={R} fill="none" stroke="rgb(38 38 47)" strokeWidth="6" />
      <circle cx="32" cy="32" r={R} fill="none" stroke="rgb(var(--accent))" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - pct)} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle" className="fill-fog-50 font-display text-[15px] font-bold">{value}</text>
    </svg>
  );
}

export default function ProfilePage() {
  const { user, logout, setSettings, setAvatar, isAdmin } = useAuth();
  const qc = useQueryClient();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/api/stats') });
  const { data: lb } = useQuery({ queryKey: ['leaderboard'], queryFn: () => api<{ content: any[] }>('/api/leaderboard') });

  const av = user?.avatar ?? {};
  const saveAvatar = async (next: { emoji?: string; color?: string }) => {
    const merged = { ...av, ...next };
    setAvatar(merged);
    try { await api('/api/settings', { method: 'PUT', json: { avatar: merged } }); } catch {}
    qc.invalidateQueries({ queryKey: ['leaderboard'] });
  };

  const so = (user?.settings?.smartOffline ?? {}) as { enabled?: boolean; perSeries?: number };
  const setSmart = async (partial: { enabled?: boolean; perSeries?: number }) => {
    const next = { enabled: !!so.enabled, perSeries: so.perSeries || 3, ...partial };
    setSettings({ smartOffline: next });
    try { await api('/api/settings', { method: 'PUT', json: { smartOffline: next } }); } catch {}
  };

  const [opds, setOpds] = useState<{ token: string; url: string } | null>(null);
  const [opdsBusy, setOpdsBusy] = useState(false);
  const genOpds = async () => {
    setOpdsBusy(true);
    try { setOpds(await api<{ token: string; url: string }>('/api/opds/token', { method: 'POST' })); } catch {}
    setOpdsBusy(false);
  };

  const [pushSupported] = useState(() => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  const [pushEnabledSrv, setPushEnabledSrv] = useState(false);
  const [pushKey, setPushKey] = useState('');
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const k = await api<{ enabled: boolean; key: string }>('/api/push/key');
        setPushEnabledSrv(k.enabled); setPushKey(k.key);
        if (k.enabled && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          setPushOn(!!(await reg.pushManager.getSubscription()));
        }
      } catch {}
    })();
  }, []);
  const togglePush = async () => {
    if (!pushSupported) return;
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (pushOn) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api('/api/push/unsubscribe', { json: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
        setPushOn(false);
      } else {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(pushKey) as unknown as BufferSource });
          const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
          if (j.endpoint && j.keys) { await api('/api/push/subscribe', { json: { endpoint: j.endpoint, keys: j.keys, deviceId: deviceId() } }); setPushOn(true); }
        }
      }
    } catch {}
    setPushBusy(false);
  };

  const setGoal = async (n?: number) => {
    const goal = n ?? Number(prompt('Chapters per week goal', String(stats?.weeklyGoal || 10)) || 0);
    if (!goal || goal < 1) return;
    await api('/api/settings', { method: 'PUT', json: { weeklyGoal: goal } });
    qc.invalidateQueries({ queryKey: ['stats'] });
  };
  const [accent, setAccent] = useState<string>(user?.settings?.accent || '#7c5cff');
  const [canInstall, setCanInstall] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });

  useEffect(() => {
    setCanInstall(!!(window as any).__yomiInstall);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));
    setStandalone(window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
    storageEstimate().then(setUsage);
  }, []);

  const pickAccent = async (hex: string) => {
    setAccent(hex);
    setSettings({ accent: hex });
    try {
      await api('/api/settings', { method: 'PUT', json: { accent: hex } });
    } catch {}
  };

  const install = async () => {
    const e = (window as any).__yomiInstall;
    if (e) {
      e.prompt();
      await e.userChoice;
      (window as any).__yomiInstall = null;
      setCanInstall(false);
    }
  };

  const maxDay = Math.max(1, ...(stats?.byDay?.map((d) => d.chapters) ?? [0]));

  return (
    <div className="min-h-screen-d lg:mx-auto lg:max-w-3xl">
      <header className="safe-top flex items-center gap-3 px-5 pb-2 lg:px-0">
        <Avatar avatar={av} size={48} />
        <div>
          <h1 className="font-display text-xl font-bold">{user?.displayName && user.displayName !== 'me' ? user.displayName : 'Your reading'}</h1>
          <p className="text-xs text-fog-500">{stats?.last_read_at ? `Last read ${relativeTime(stats.last_read_at)}` : 'Welcome to Koryomi'}</p>
        </div>
      </header>

      {/* stats */}
      <section className="px-5 pt-3">
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Chapters', value: stats?.chapters_completed ?? 0 },
            { label: 'Series', value: stats?.series_touched ?? 0 },
            { label: 'Sessions', value: stats?.total_events ?? 0 },
          ].map((s) => (
            <div key={s.label} className="card p-4 text-center">
              <p className="font-display text-2xl font-bold text-accent">{s.value}</p>
              <p className="text-[11px] text-fog-500">{s.label}</p>
            </div>
          ))}
        </div>
        {!!stats?.byDay?.length && (
          <div className="card mt-3 p-4">
            <p className="mb-2 text-xs font-medium text-fog-400">Last 90 days</p>
            <div className="flex h-16 items-end gap-[2px]">
              {stats.byDay.map((d) => (
                <div key={d.day} className="flex-1 rounded-t bg-accent/70" style={{ height: `${(d.chapters / maxDay) * 100}%`, minHeight: 2 }} title={`${d.day}: ${d.chapters}`} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* streak + weekly goal + badges + wrapped */}
      <section className="px-5 pt-4 lg:px-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="card flex items-center gap-3 p-4">
            <span className="text-3xl">🔥</span>
            <div>
              <p className="font-display text-2xl font-bold">
                {stats?.currentStreak ?? 0}<span className="text-sm font-normal text-fog-500"> day{(stats?.currentStreak ?? 0) === 1 ? '' : 's'}</span>
              </p>
              <p className="text-[11px] text-fog-500">streak · best {stats?.longestStreak ?? 0}</p>
            </div>
          </div>
          <div className="card flex items-center gap-3 p-4">
            <GoalRing value={stats?.weekChapters ?? 0} goal={stats?.weeklyGoal ?? 0} />
            <div className="min-w-0">
              <p className="text-xs text-fog-400">Weekly goal</p>
              {(stats?.weeklyGoal ?? 0) > 0 ? (
                <button onClick={() => setGoal()} className="text-sm text-accent">{stats?.weekChapters ?? 0}/{stats?.weeklyGoal} · edit</button>
              ) : (
                <div className="mt-1 flex gap-1">{[5, 10, 20].map((n) => <button key={n} onClick={() => setGoal(n)} className="chip text-xs">{n}</button>)}</div>
              )}
            </div>
          </div>
        </div>

        {stats && (
          <div className="card mt-3 p-4">
            <p className="mb-2 text-xs font-medium text-fog-400">Badges</p>
            <div className="flex flex-wrap gap-2">
              {BADGES.map((b) => {
                const earned = b.test(stats);
                return (
                  <span key={b.label} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${earned ? 'border-accent/40 bg-accent-soft text-fog-100' : 'border-ink-700 text-ink-500 opacity-50'}`}>
                    <span>{b.emoji}</span> {b.label}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <Link href="/history" className="card mt-3 flex items-center justify-between p-4">
          <span className="flex items-center gap-3 text-sm text-fog-200"><IcRefresh className="text-accent" width={20} height={20} /> Reading history</span>
          <IcChevronRight className="text-fog-500" width={18} height={18} />
        </Link>
        <Link href="/wrapped" className="card mt-3 flex items-center justify-between p-4">
          <span className="flex items-center gap-3 text-sm text-fog-200"><IcSparkle className="text-accent" width={20} height={20} /> Your Koryomi Wrapped</span>
          <IcChevronRight className="text-fog-500" width={18} height={18} />
        </Link>
      </section>

      {/* avatar picker */}
      <section className="px-5 pt-6 lg:px-0">
        <h2 className="mb-3 font-display text-base font-semibold">Your avatar</h2>
        <div className="card p-4">
          <div className="flex items-center gap-4">
            <Avatar avatar={av} size={56} />
            <div className="flex flex-wrap gap-1.5">
              {AVATAR_COLORS.map((c) => (
                <button key={c} onClick={() => saveAvatar({ color: c })} className="h-7 w-7 rounded-full" style={{ background: c, outline: av.color === c ? '2px solid white' : 'none', outlineOffset: 2 }} />
              ))}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {AVATAR_EMOJIS.map((e) => (
              <button key={e} onClick={() => saveAvatar({ emoji: e })}
                className={`grid h-10 w-10 place-items-center rounded-xl border text-xl ${av.emoji === e ? 'border-accent bg-accent-soft' : 'border-ink-700'}`}>
                {e}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* household leaderboard */}
      {(lb?.content?.length ?? 0) > 1 && (
        <section className="px-5 pt-6 lg:px-0">
          <h2 className="mb-3 font-display text-base font-semibold">This week in your library</h2>
          <div className="card divide-y divide-ink-800/70 overflow-hidden">
            {lb!.content.map((m: any, i: number) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <span className="w-4 text-center font-display text-sm font-bold text-fog-500">{i + 1}</span>
                <Avatar avatar={m.avatar} size={34} />
                <span className="min-w-0 flex-1 truncate text-sm text-fog-100">{m.display_name}{m.id === user?.id ? ' · you' : ''}</span>
                <span className="text-sm font-semibold text-accent">{m.week}<span className="text-xs font-normal text-fog-500"> ch</span></span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* security */}
      <section className="px-5 pt-6 lg:px-0">
        <h2 className="mb-3 font-display text-base font-semibold">Security</h2>
        <SecurityPanel />
      </section>

      {/* admin */}
      {isAdmin && (
        <section className="px-5 pt-6 lg:px-0">
          <Link href="/admin" className="card flex items-center justify-between p-4">
            <span className="flex items-center gap-3 text-sm text-fog-200"><IcUser className="text-accent" width={20} height={20} /> Admin &amp; server settings</span>
            <IcChevronRight className="text-fog-500" width={18} height={18} />
          </Link>
        </section>
      )}

      {/* accent */}
      <section className="px-5 pt-6 lg:px-0">
        <h2 className="mb-3 font-display text-base font-semibold">Accent</h2>
        <div className="flex flex-wrap gap-3">
          {ACCENTS.map((a) => (
            <button key={a.hex} onClick={() => pickAccent(a.hex)} className="relative h-11 w-11 rounded-full" style={{ background: a.hex }} aria-label={a.name}>
              {accent.toLowerCase() === a.hex.toLowerCase() && (
                <span className="absolute inset-0 grid place-items-center text-black"><IcCheck width={18} height={18} /></span>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* install */}
      <section className="px-5 pt-6">
        <h2 className="mb-3 font-display text-base font-semibold">Install Koryomi</h2>
        {standalone ? (
          <div className="card flex items-center gap-3 p-4 text-sm text-fog-300">
            <IcCheck className="text-accent" /> Installed — running as an app.
          </div>
        ) : canInstall ? (
          <button onClick={install} className="btn-accent w-full">
            <IcDownload width={18} height={18} /> Add to home screen
          </button>
        ) : isIOS ? (
          <div className="card p-4 text-sm text-fog-300">
            <p className="mb-1 font-medium text-fog-100">Add to your iPhone</p>
            Tap the <span className="text-accent">Share</span> button in Safari, then <span className="text-accent">“Add to Home Screen.”</span>
            <p className="mt-2 text-xs text-fog-500">On iOS, offline downloads may be cleared by the system under storage pressure.</p>
          </div>
        ) : (
          <div className="card p-4 text-sm text-fog-400">Open in Chrome/Edge and use “Install app” from the menu.</div>
        )}
      </section>

      {/* storage + offline */}
      <section className="px-5 pt-6">
        <Link href="/downloads" className="card flex items-center justify-between p-4">
          <span className="flex items-center gap-3 text-sm text-fog-200"><IcDownload className="text-accent" width={20} height={20} /> Offline downloads</span>
          <span className="text-xs text-fog-500">{bytes(usage.usage)}</span>
        </Link>
        <button onClick={() => requestPersist()} className="mt-2 w-full text-left text-xs text-fog-500">
          Tap to ask the browser to protect your downloads from eviction.
        </button>
      </section>

      {/* smart downloads */}
      <section className="px-5 pt-6 lg:px-0">
        <h2 className="mb-3 font-display text-base font-semibold">Smart downloads</h2>
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-fog-100">Keep favorites offline</p>
              <p className="text-xs text-fog-500">Auto-download the latest unread chapters of your favorites.</p>
            </div>
            <button onClick={() => setSmart({ enabled: !so.enabled })} className={`relative h-7 w-12 shrink-0 rounded-full transition ${so.enabled ? 'bg-accent' : 'bg-ink-600'}`}>
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${so.enabled ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
          {so.enabled && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-fog-400">Per series:</span>
              {[3, 5, 10].map((n) => (
                <button key={n} onClick={() => setSmart({ perSeries: n })} className={`chip text-xs ${(so.perSeries || 3) === n ? 'chip-active' : ''}`}>{n}</button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* new-chapter notifications */}
      {pushEnabledSrv && (
        <section className="px-5 pt-6 lg:px-0">
          <h2 className="mb-3 font-display text-base font-semibold">Notifications</h2>
          <div className="card flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="text-sm text-fog-100">New-chapter alerts</p>
              <p className="text-xs text-fog-500">{pushSupported ? 'Get a push notification when one of your favorites gets a new chapter.' : 'Not supported on this browser.'}</p>
            </div>
            <button onClick={togglePush} disabled={!pushSupported || pushBusy} className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${pushOn ? 'bg-accent' : 'bg-ink-600'}`}>
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${pushOn ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        </section>
      )}

      {/* external readers (OPDS) */}
      <section className="px-5 pt-6 lg:px-0">
        <h2 className="mb-3 font-display text-base font-semibold">External readers (OPDS)</h2>
        <div className="card p-4">
          <p className="text-sm text-fog-100">Read Koryomi in another app</p>
          <p className="mt-1 text-xs text-fog-500">Add Koryomi as an OPDS catalog in readers like Panels, Chunky, KOReader, or Moon+. Generate a personal link, then enter the URL + credentials below in your reader.</p>
          {!opds ? (
            <button onClick={genOpds} disabled={opdsBusy} className="btn-accent mt-3 w-full py-2 text-sm disabled:opacity-50">{opdsBusy ? 'Generating…' : 'Generate OPDS link'}</button>
          ) : (
            <div className="mt-3 space-y-2 text-xs">
              <div><span className="text-fog-500">Catalog URL</span><div className="mt-0.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-fog-100">{opds.url}</div></div>
              <div><span className="text-fog-500">Username</span><div className="mt-0.5 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-fog-100">{user?.username || 'me'}</div></div>
              <div><span className="text-fog-500">Password — copy now, shown once</span><div className="mt-0.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-accent">{opds.token}</div></div>
              <p className="text-[11px] text-fog-500">Generating again replaces the previous token.</p>
            </div>
          )}
        </div>
      </section>

      {/* support the project */}
      <section className="px-5 pt-6 lg:px-0">
        <a
          href="https://ko-fi.com/angeloshaheen"
          target="_blank"
          rel="noopener noreferrer"
          className="card flex items-center justify-between gap-3 p-4 transition active:scale-[0.99]"
        >
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft text-lg">☕</span>
            <span className="flex flex-col">
              <span className="font-display text-sm font-semibold text-fog-100">Support Koryomi</span>
              <span className="text-[12px] text-fog-400">Free &amp; open-source — buy me a coffee on Ko-fi</span>
            </span>
          </span>
          <IcChevronRight className="text-fog-500" width={18} height={18} />
        </a>
      </section>

      {/* logout */}
      <section className="px-5 pb-10 pt-8">
        <button onClick={logout} className="btn-ghost w-full text-red-300">Sign out</button>
        <p className="mt-4 flex items-center justify-center gap-1 text-center text-[11px] text-fog-600">
          <IcSparkle width={12} height={12} /> Koryomi · personal reader for your Komga library
        </p>
      </section>
    </div>
  );
}
