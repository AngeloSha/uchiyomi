'use client';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { readShownOnce, writeShownOnce } from '@/lib/shownOnce';
import { t as tr } from '@/lib/i18n';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, msgOf } from '@/components/ConfirmDialog';
import { IcCloudDownload, IcPlus, IcRefresh } from '@/components/icons';
import { Row, Section, SETTINGS_GRID, SwitchRow } from '@/components/settings';

/**
 * Profile → Connections: everything that lets something OTHER than this app read or write on the account --
 * a tracker that receives finished chapters, an OPDS reader that pulls the library, a token that a script or
 * Mihon's Komga extension signs in with.
 *
 * Until v0.39.0 these three lived on two different tabs (Reading, Account), two of them collapsed behind an
 * identical `Manage` chip, and the OPDS password's state sat on the page itself. One tab, three sections,
 * nothing collapsed: a secret shown once (the OPDS password, a fresh token) is never behind a fold, because a
 * language change remounts this whole subtree (`<div key={lang}>` in lib/I18nProvider.tsx) and a collapsed
 * card would have hidden the one value the server never sends twice. See lib/shownOnce.ts.
 *
 * Every action here has a side effect somewhere else (a service, a reader, a script), so they keep their
 * toasts; only the OPDS 18+ switch is a setting, and it reports through the inline Saved tick like the rest
 * of the settings consoles.
 */
export function ProfileConnections({ focusTracking }: { focusTracking: boolean }) {
  return (
    <div className={SETTINGS_GRID}>
      <TrackerSection focus={focusTracking} />
      <OpdsSection />
      <TokensSection />
    </div>
  );
}

/**
 * Where keyboard focus goes after the button that was pressed leaves the DOM.
 *
 * Every action in the OPDS and token sections unmounts its own control: Create and Generate swap the form
 * or the header action for a reveal box, Done removes the box, Revoke removes the row. A focused element
 * that leaves the DOM drops focus to `<body>`, and from there the next Tab starts at the top of the
 * document -- about fifty stops before the token that was just minted. A handler names the next target
 * before its state change (`after(doneRef)`), and the effect, which runs after every commit, moves focus
 * there as soon as the target is in the DOM and can take it: the same commit for a button that is always
 * rendered, the next one for a box the state change is about to mount, the one after `busy` clears for
 * an action that is disabled while the request runs (a disabled button refuses focus, so the request is
 * kept until it has landed). Nothing is stolen: the target is only ever named by a press, never by a mount,
 * so returning to this tab with a token still on screen leaves focus on the pill that was tapped.
 */
function useFocusAfter() {
  const pending = useRef<RefObject<HTMLElement | null> | null>(null);
  useEffect(() => {
    const el = pending.current?.current;
    if (!el) return;
    el.focus();
    if (document.activeElement === el) pending.current = null;
  });
  return useCallback((target: RefObject<HTMLElement | null>) => { pending.current = target; }, []);
}

/* ============================== Progress tracking ============================== */

interface TrackerStatus {
  /** Sent by the server so the UI never hardcodes the provider list. */
  label?: string;
  tokenHelp?: string;
  provider: string; connected: boolean; accountName: string | null;
  expiresAt: string | null; expiringSoon: boolean; lastSyncAt: string | null; lastError: string | null;
}

/**
 * Connect one or more trackers so finished chapters push automatically.
 *
 * The provider list comes from the server rather than being written here: each one reports its own name and
 * where a token comes from, so adding a fourth service is a backend change alone.
 *
 * Token-paste rather than an OAuth round-trip, for all of them. A real OAuth flow would need every
 * self-hoster to register an application with each service and keep its secret in their compose file, which
 * is a worse trade for a household app than copying a token once.
 *
 * The section renders nothing at all when the server offers no providers. The old page put the heading
 * outside this component, so an empty list left an orphan "Progress tracking" over blank space.
 *
 * `focus` (from `?card=tracking`, the import page's "connect one under Profile" line) scrolls the section
 * into view once, after the trackers query has settled -- the section does not exist before that (it returns
 * null while the list is empty), and its height depends on the answer. `block: 'start'` with a scroll margin
 * for the sticky desktop top bar; instant under reduced motion. Only ever once per arrival: a person who
 * then scrolls away must not be pulled back by a refetch.
 */
function TrackerSection({ focus }: { focus: boolean }) {
  const { data, refetch, isPending } = useQuery({ queryKey: ['trackers'], queryFn: () => api<{ content: TrackerStatus[] }>('/api/trackers') });
  const still = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!focus || isPending || scrolled.current || !ref.current) return;
    scrolled.current = true;
    ref.current.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }, [focus, isPending, still]);
  const all = data?.content || [];
  if (!all.length) return null;
  return (
    <Section ref={ref} id="progress-tracking" className="scroll-mt-4 lg:scroll-mt-20" title={tr('Progress tracking')}
      icon={<IcRefresh width={18} height={18} />}
      description={tr('Connect a service and every chapter you finish is pushed to it.')}>
      {all.map((t) => <TrackerRow key={t.provider} t={t} refetch={refetch} />)}
    </Section>
  );
}

function TrackerRow({ t, refetch }: { t: TrackerStatus; refetch: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const formId = useId();
  // A service's own name is a proper noun: it is passed as a placeholder rather than translated.
  const label = t.label || t.provider;

  const connect = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ account: string }>(`/api/trackers/${t.provider}/connect`, { json: { token: token.trim() } });
      toast(tr('Connected to {name} as {account}', { name: label, account: r.account }), 'success');
      setToken('');
      setOpen(false);
      refetch();
      // Only AniList has a backfill endpoint today; the others start syncing from the next chapter read.
      if (t.provider === 'anilist') {
        const b = await api<{ series: number }>('/api/trackers/anilist/backfill', { json: {} });
        if (b.series) toast(tr('Syncing {n} series you have already finished…', { n: b.series }));
      }
    } catch (e: any) { toast(msgOf(e, tr('{name} did not accept that token', { name: label })), 'error'); }
    setBusy(false);
  };

  const disconnect = async () => {
    try { await api(`/api/trackers/${t.provider}`, { method: 'DELETE' }); toast(tr('Disconnected'), 'success'); refetch(); }
    catch { toast(tr('Could not disconnect'), 'error'); }
  };

  if (t.connected) {
    return (
      <Row
        label={<>{label} · <span className="text-accent">{t.accountName}</span></>}
        help={
          <>
            {tr('Finished chapters sync automatically')}
            {t.lastSyncAt && <> · {tr('last synced {when}', { when: relativeTime(t.lastSyncAt) })}</>}
            {/* Notes are spans inside the help paragraph rather than paragraphs of their own: a <p> may not
                hold a <p>, and a block-level span keeps them inside this provider's row of the divider list. */}
            {t.expiringSoon && (
              <span className="mt-2 block rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
                {tr('This {name} token expires {when}. None of these services can refresh a token silently, so reconnect before then to keep syncing.',
                  { name: label, when: t.expiresAt ? relativeTime(t.expiresAt) : tr('soon') })}
              </span>
            )}
            {t.lastError && (
              <span className="mt-2 block rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">{t.lastError}</span>
            )}
          </>
        }
      >
        <button type="button" onClick={disconnect} className="chip text-xs">{tr('Disconnect')}</button>
      </Row>
    );
  }

  return (
    <>
      {/* ⚠️ The row text keeps `Sync your reading to {name}`: scripts/shots/capture.mjs finds this card by it.
          While the form is open the row drops its divider (`border-b-0` beats the body's zero-specificity
          `:where(.divide-y > …)` rule) so the token field reads as part of this provider, not the next one. */}
      <Row
        className={open ? 'border-b-0 pb-1' : undefined}
        label={tr('Sync your reading to {name}', { name: label })}
        help={t.lastError ? <span className="text-red-300">{t.lastError}</span> : undefined}
      >
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={formId} className="chip text-xs">
          {open ? tr('Cancel') : tr('Connect')}
        </button>
      </Row>
      {open && (
        <div id={formId} className="pb-3 last:pb-0">
          {t.tokenHelp && <p className="max-w-prose text-xs text-fog-500">{t.tokenHelp}</p>}
          {/* fog-500, not fog-600: this is the one security fact on the form, and fog-600 measures 2.6:1 on
              the card -- below AA for any size of text. fog-500 (4.1:1) is the floor for helper text. */}
          <p className="mt-1 max-w-prose text-[11px] text-fog-500">
            {tr('The token carries access to your {name} account and cannot be scoped. It is stored encrypted here, and you can disconnect at any time.', { name: label })}
          </p>
          <div className="mt-3 flex gap-2">
            <input value={token} onChange={(e) => setToken(e.target.value)} type="password"
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy) connect(); }}
              placeholder={tr('{name} access token', { name: label })} aria-label={tr('{name} access token', { name: label })}
              autoCapitalize="none" autoCorrect="off" className="field min-w-0 flex-1" />
            <button type="button" onClick={connect} disabled={busy || !token.trim()} className="btn-accent shrink-0 px-4 py-2 text-sm disabled:opacity-50">
              {busy ? tr('Working…') : tr('Connect')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================== External readers (OPDS) ============================== */

interface OpdsLink { token: string; url: string; expiresInDays?: number }
/** The token that already exists, if any. The raw password is shown once, so this is the only way to see
 *  whether one is out there, when it expires, and whether a reader is still using it. */
interface OpdsStatus { exists: boolean; createdAt?: string; expiresAt?: string; lastSeen?: string | null; expired?: boolean; showAdult?: boolean }

/**
 * One personal Basic-auth link for OPDS readers (Panels, Chunky, KOReader, Moon+).
 *
 * The freshly generated password used to live on the profile page itself, two tabs away from this card,
 * because the language picker had to know a secret was on screen. The Language row now reads the same
 * `shownOnce` slot at render time (ProfileSettings), so the value can live here -- still through
 * `shownOnce`, because I18nProvider remounts this subtree on a language change and plain state would lose a
 * password the server only ever sends once.
 */
function OpdsSection() {
  const { user } = useAuth();
  const toast = useToast();
  const [link, setLinkState] = useState<OpdsLink | null>(() => readShownOnce<OpdsLink>('opds.link'));
  const setLink = (v: OpdsLink | null) => { writeShownOnce('opds.link', v); setLinkState(v); };
  const [st, setSt] = useState<OpdsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Generate replaces the header action with the reveal box, Done and Revoke remove what was pressed: each
  // names where focus goes next. See useFocusAfter.
  const after = useFocusAfter();
  const actionRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const load = () => api<OpdsStatus>('/api/opds/token').then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);

  const gen = async () => {
    setBusy(true);
    try { const r = await api<OpdsLink>('/api/opds/token', { method: 'POST' }); after(doneRef); setLink(r); await load(); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };
  const revoke = async () => {
    setBusy(true);
    try { await api('/api/opds/token', { method: 'DELETE' }); setLink(null); await load(); after(actionRef); }
    catch (e: any) { toast(msgOf(e, tr('Could not change that')), 'error'); }
    setBusy(false);
  };
  const done = () => { after(actionRef); setLink(null); };
  // On the token, not the account: the phone in a pocket and the e-reader on the shelf are different
  // audiences, and an OPDS app has no button of its own for the reveal the Library page offers. A setting,
  // so it reports through the row's Saved tick; SwitchRow reverts the knob if the PATCH fails.
  const setAdult = (on: boolean) => api<OpdsStatus>('/api/opds/token', { method: 'PATCH', json: { showAdult: on } }).then(setSt);

  return (
    <Section
      title={tr('External readers (OPDS)')}
      icon={<IcCloudDownload width={18} height={18} />}
      description={tr('Add Uchiyomi as an OPDS catalog in readers like Panels, Chunky, KOReader or Moon+. Generate a personal link, then enter the URL and credentials below in your reader.')}
      // Hidden while the fresh password is on screen: generating again would replace the one being copied.
      // A chip, like every other section action: the accent button was 172 px wide at 390 and wrapped
      // "Externe Leseprogramme (OPDS)" onto three lines beside it.
      action={!link && (
        <button ref={actionRef} type="button" onClick={gen} disabled={busy} className="chip text-xs disabled:opacity-50">
          {busy ? tr('Working…') : st?.exists ? tr('Generate a new link') : tr('Generate OPDS link')}
        </button>
      )}
    >
      {/* Shown whenever a link is held -- never behind a collapse, see the component comment. */}
      {link && (
        <div className="my-1 space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3 text-xs">
          <div>
            <span className="text-fog-500">{tr('Catalog URL')}</span>
            <div className="mt-0.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-fog-100">{link.url}</div>
          </div>
          <div>
            <span className="text-fog-500">{tr('Username')}</span>
            <div className="mt-0.5 rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-fog-100">{user?.username || 'me'}</div>
          </div>
          <div>
            <span className="text-fog-500">{tr('Password (shown once, copy it now)')}</span>
            <div className="mt-0.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-accent">{link.token}</div>
          </div>
          <p className="max-w-prose text-[11px] text-fog-500">
            {tr('Generating again replaces the previous token.')}
            {link.expiresInDays != null && <> {tr('This one stops working in {n} days. You can revoke it sooner.', { n: link.expiresInDays })}</>}
          </p>
          {/* A chip rather than a 12-px link: this is the control that dismisses a once-only secret, and a
              link-styled button was a 16-px tap target on a phone. */}
          <button ref={doneRef} type="button" onClick={done} className="chip text-xs">{tr('Done')}</button>
        </div>
      )}

      {st && (
        <Row
          label={st.exists
            ? <span className={st.expired ? 'text-rose-300' : undefined}>{st.expired ? tr('Expired') : tr('A link is active')}</span>
            : tr('No link yet.')}
          help={st.exists && (
            <>
              {st.lastSeen ? tr('last used {when}', { when: relativeTime(st.lastSeen) }) : tr('never used')}
              {st.expiresAt && <> · {st.expired
                ? tr('expired {when}', { when: relativeTime(st.expiresAt) })
                : tr('expires {when}', { when: relativeTime(st.expiresAt) })}</>}
            </>
          )}
        >
          {st.exists && (
            <button type="button" onClick={revoke} disabled={busy}
              className="chip text-xs hover:border-rose-500/50 hover:text-rose-400 disabled:opacity-50">{tr('Revoke')}</button>
          )}
        </Row>
      )}

      {st?.exists && (
        <SwitchRow
          label={tr('Include 18+ libraries in this reader')}
          help={tr('Off by default. Your age limit, if you have one, still applies whatever this says.')}
          on={!!st.showAdult}
          disabled={busy}
          onChange={setAdult}
        />
      )}
    </Section>
  );
}

/* ============================== API tokens ============================== */

interface ApiToken { id: string; name: string; scopes: string[]; createdAt: string; lastSeen: string | null; expiresAt: string | null; expired: boolean; showAdult?: boolean }

/** The one icon this file draws itself: icons.tsx has no key, and a token is a key. Same 24-grid and stroke as the rest. */
const IcKey = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4Z" />
    <circle cx="16.5" cy="7.5" r=".6" fill="currentColor" />
  </svg>
);

/**
 * Long-lived tokens for scripts and integrations. Shown once on creation, revocable at any time.
 *
 * The create form is INLINE under the header, not a Modal: the admin-scope confirmation is already a z-50
 * Modal, and two stacked modals would share one Escape key and one focus trap.
 */
function TokensSection() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  // Off by default, like the OPDS link: a token in a script or another app is a second door into the
  // library, and the age cap should not open with it unless its owner said so at mint time.
  const [adult, setAdult] = useState(false);
  // Same as the recovery codes: the server sends this token once and stores only a hash of it.
  const [fresh, setFreshState] = useState<string | null>(() => readShownOnce<string>('apiToken.fresh'));
  const setFresh = (v: string | null) => { writeShownOnce('apiToken.fresh', v); setFreshState(v); };
  const formId = useId();
  // Create closes the form under the pressed button, Done removes the reveal box, Revoke removes the row:
  // each names where focus goes next. See useFocusAfter.
  const after = useFocusAfter();
  const actionRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const { data } = useQuery({ queryKey: ['api-tokens'], queryFn: () => api<{ content: ApiToken[] }>('/api/tokens') });
  const tokens = data?.content || [];

  const create = async () => {
    const scopes = ['read', ...(write ? ['write'] : []), ...(admin ? ['admin'] : [])];
    try {
      const r = await api<{ token: string }>('/api/tokens', { json: { name: name.trim(), scopes, showAdult: adult } });
      after(doneRef); setFresh(r.token);
      setName(''); setWrite(false); setAdmin(false); setAdult(false); setOpen(false);
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (e: any) { toast(msgOf(e, tr('Could not create the token')), 'error'); }
  };
  const revoke = async (id: string) => {
    try { await api(`/api/tokens/${id}`, { method: 'DELETE' }); after(actionRef); qc.invalidateQueries({ queryKey: ['api-tokens'] }); toast(tr('Token revoked'), 'success'); }
    catch { toast(tr('Could not revoke'), 'error'); }
  };
  const done = () => { after(actionRef); setFresh(null); };
  // The scopes reset with the name: a box ticked for an abandoned token must not carry over to the next
  // one, or a later token is minted with a scope chosen for an earlier, different purpose.
  const cancel = () => { setOpen(false); setName(''); setWrite(false); setAdmin(false); setAdult(false); };

  return (
    <Section
      title={tr('API tokens')}
      icon={<IcKey />}
      description={`${tr('For scripts and integrations. A normal login expires every 15 minutes; these do not, so treat one like a password.')} ${tr('Mihon’s Komga extension and the Uchiyomi extension use these too.')}`}
      action={
        <button ref={actionRef} type="button" onClick={() => (open ? cancel() : setOpen(true))} aria-expanded={open} aria-controls={formId}
          className={`chip text-xs ${open ? 'chip-active' : ''}`}>
          <IcPlus width={14} height={14} aria-hidden />{tr('New token')}
        </button>
      }
    >
      {/* A token is shown once; it stays on screen through a remount and is never behind the form. */}
      {fresh && (
        <div className="my-1 rounded-xl border border-accent/40 bg-accent/10 p-3">
          <p className="text-xs text-fog-100">{tr('Copy this now. It will not be shown again.')}</p>
          <p className="mt-1.5 break-all rounded-lg border border-ink-700 bg-ink-900/60 px-2 py-1.5 font-mono text-xs text-accent">{fresh}</p>
          {/* A chip, like the OPDS box's Done: the control that dismisses a once-only secret was a 16-px link. */}
          <button ref={doneRef} type="button" onClick={done} className="chip mt-2 text-xs">{tr('Done')}</button>
        </div>
      )}

      {open && (
        <div id={formId} className="space-y-2 py-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('What is it for? e.g. backup script')}
            aria-label={tr('What is it for? e.g. backup script')}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) (admin ? setConfirmAdmin(true) : create()); }}
            className="field" />
          <label className="flex items-center gap-2 text-xs text-fog-300">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} className="accent-accent" />{tr('Allow changes (without this the token can only read)')}</label>
          {user?.role === 'admin' && (
            <label className="flex items-center gap-2 text-xs text-fog-300">
              <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} className="accent-accent" />{tr('Allow server administration')}</label>
          )}
          {/* Mirrors the OPDS link's switch. The Komga-compatible API (Mihon, Tachimanga) reads the library
              through a token, and without this the 18+ libraries are simply absent from it. */}
          <label className="flex items-center gap-2 text-xs text-fog-300">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="accent-accent" />{tr('Include 18+ libraries')}</label>
          <div className="flex flex-wrap gap-2 pt-1">
            {/* An admin-scoped token never expires and can do anything its owner can, so it costs one more
                deliberate step. The rest of the form is unchanged. */}
            <button type="button" onClick={() => (admin ? setConfirmAdmin(true) : create())} disabled={!name.trim()} className="btn-accent px-5 py-2 text-sm disabled:opacity-50">{tr('Create')}</button>
            <button type="button" onClick={cancel} className="chip text-xs">{tr('Cancel')}</button>
          </div>
        </div>
      )}

      {tokens.map((t) => (
        <Row
          key={t.id}
          label={
            <>
              {t.name}
              {t.expired && <span className="ms-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">{tr('Expired')}</span>}
            </>
          }
          help={
            <>
              {t.scopes.includes('admin') ? tr('admin') : t.scopes.includes('write') ? tr('read + write') : tr('read only')}
              {t.showAdult ? ` · ${tr('18+')}` : ''}
              {' · '}{t.lastSeen ? tr('last used {when}', { when: relativeTime(t.lastSeen) }) : tr('never used')}
            </>
          }
        >
          <button type="button" onClick={() => revoke(t.id)} className="chip text-xs hover:border-rose-500/50 hover:text-rose-400">{tr('Revoke')}</button>
        </Row>
      ))}
      {!tokens.length && !open && <p className="py-3 text-xs text-fog-600">{tr('No tokens yet.')}</p>}

      {confirmAdmin && (
        <ConfirmDialog
          title={tr('Allow server administration')}
          body={tr('An admin token never expires and can change server settings and other accounts. Treat it like your password.')}
          confirmLabel={tr('Create')}
          confirmText={name.trim()}
          danger
          onConfirm={() => { setConfirmAdmin(false); create(); }}
          onClose={() => setConfirmAdmin(false)}
        />
      )}
    </Section>
  );
}
