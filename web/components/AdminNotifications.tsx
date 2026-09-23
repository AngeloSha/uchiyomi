'use client';
// Admin → Settings → Notifications (v0.43.0, #70): where new chapters and server problems are announced
// besides this browser's own notifications -- a webhook, Home Assistant, ntfy or Discord.
//
// ⚠️ AN ADDRESS OR A TOKEN GOES IN AND NEVER COMES BACK. The server answers a masked display form alone
// (`target`: scheme and host) and `hasToken`; there is no endpoint that reveals either, and this panel never
// pre-fills a credential field from anything the server sent. Editing a target leaves those fields blank,
// and blank means "keep what is stored" -- typing one replaces it. A screenshot of this panel pasted into a
// GitHub issue must not leak a Discord webhook, which is a credential in URL form.
//
// ⚠️ TEST SENDS THE TARGET'S ID, NEVER AN ADDRESS. The server tests only what is saved (an address in the
// body would make it a port scanner behind an admin login), so a new target is saved first and tested from
// its row. Five Tests a minute per admin; the answer is a reason from a closed list, never the target's body.
//
// Kind names (Home Assistant, ntfy, Discord, and "Webhook", the name of the thing on every service that
// offers one) are proper nouns and are not translated.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { t as tr } from '@/lib/i18n';
import { DEFAULT_TEMPLATE, renderDigest } from '@/lib/notifyDigest';
import { useToast } from '@/components/Toast';
import { ConfirmDialog, Modal, msgOf } from '@/components/ConfirmDialog';
import { Switch } from '@/components/Switch';
import { IcBell, IcPlus } from '@/components/icons';
import { SaveState, Section, Segmented, useAutosave } from '@/components/settings';

type Kind = 'webhook' | 'home_assistant' | 'ntfy' | 'discord';
type NotifyEvent = 'new_chapters' | 'health';

/** What GET /api/admin/notify-targets answers per target. Nothing in it can be used to post to the target. */
interface NotifyTarget {
  id: string;
  kind: Kind;
  name: string;
  target: string;
  service: string | null;
  hasToken: boolean;
  userId: string | null;
  userName: string | null;
  events: NotifyEvent[];
  template: string | null;
  enabled: boolean;
  includeAdult: boolean;
  consecutiveFailures: number;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastResult: 'ok' | 'error' | null;
}

const KIND_LABEL: Record<Kind, string> = { webhook: 'Webhook', home_assistant: 'Home Assistant', ntfy: 'ntfy', discord: 'Discord' };
const KINDS: Kind[] = ['webhook', 'home_assistant', 'ntfy', 'discord'];
/** The server switches a target off after this many failed deliveries in a row (lib/notify AUTO_DISABLE_AFTER). */
const AUTO_OFF = 10;
const HA_SERVICE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
/** What the live preview renders: three series, so {series} reads "3 series" and {list} shows its shape. */
const SAMPLE = [
  { title: 'Solo Leveling', added: 3 },
  { title: 'Omniscient Reader', added: 1 },
  { title: 'Tower of God', added: 2 },
];

/**
 * The server's reason code as a sentence in the reader's language. The codes are a closed set
 * (lib/notify/send.ts REASONS); an unknown one falls back to the generic sentence rather than showing a code.
 */
function reasonText(code: string | null | undefined): string {
  switch (code) {
    case 'ok': return tr('Delivered');
    case 'timeout': return tr('No answer within 10 seconds');
    case 'refused': return tr('The connection was refused — is the service running on that port?');
    case 'dns': return tr('That host name could not be resolved');
    case 'tls': return tr('The HTTPS certificate was not accepted');
    case 'unauthorized': return tr('The target refused the token (401/403)');
    case 'not_found': return tr('Nothing answers at that address (404)');
    case 'rate_limited': return tr('The target asked us to slow down (429)');
    case 'server_error': return tr('The target failed with a server error (5xx)');
    case 'bad_response': return tr('The target refused the request');
    case 'redirect': return tr('The target answered with a redirect, which is never followed');
    case 'blocked': return tr('That address is refused (cloud metadata, or this server itself)');
    case 'secret_unreadable': return tr('The stored address and token could not be read — enter them again');
    default: return tr('The address could not be reached');
  }
}

export function NotificationsSection() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin-notify-targets'],
    queryFn: () => api<{ targets: NotifyTarget[] }>('/api/admin/notify-targets'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-notify-targets'] });
  // `null` closed, `'new'` the add dialog, a target the edit dialog for it.
  const [editing, setEditing] = useState<NotifyTarget | 'new' | null>(null);
  const [deleting, setDeleting] = useState<NotifyTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const targets = data?.targets ?? [];

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/admin/notify-targets/${deleting.id}`, { method: 'DELETE' });
      toast(tr('Deleted {name}', { name: deleting.name }), 'success');
      setDeleting(null);
      void refresh();
    } catch (e) { toast(msgOf(e, tr('Could not delete it')), 'error'); }
    setBusy(false);
  };

  return (
    <>
      <Section title={tr('Notifications')} icon={<IcBell width={18} height={18} />}
        description={tr('Send new chapters and server problems somewhere besides this browser: a webhook, Home Assistant, ntfy or Discord. One message per library update, not one per chapter.')}
        action={(
          <button type="button" onClick={() => setEditing('new')} className="chip inline-flex items-center gap-1 text-xs">
            <IcPlus width={14} height={14} />{tr('Add')}
          </button>
        )}>
        {!data ? (
          <p className="py-3 text-sm text-fog-500">{tr('Loading…')}</p>
        ) : targets.length ? (
          targets.map((t) => <TargetRow key={t.id} t={t} onEdit={() => setEditing(t)} onDelete={() => setDeleting(t)} refresh={refresh} />)
        ) : (
          <p className="max-w-prose py-3 text-[11px] leading-relaxed text-fog-500">
            {tr('Nothing is set up yet. Add a target to hear about new chapters on your phone, in Home Assistant or in a Discord channel.')}
          </p>
        )}
      </Section>
      {editing && (
        <TargetDialog target={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void refresh(); }} />
      )}
      {deleting && (
        <ConfirmDialog
          title={tr('Delete {name}?', { name: deleting.name })}
          body={<p>{tr('Notifications stop going there, and its stored address and token are deleted with it.')}</p>}
          confirmLabel={tr('Delete')}
          danger
          busy={busy}
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

/**
 * One target: what it is and where it points (masked), the switch, the last result, and Test / Edit / Delete.
 *
 * The switch is optimistic the way `SwitchRow` is and reports through the row's own Saved tick. It is not a
 * `Row`: the actions sit on a line of their own under the text, so at 390 px three buttons and a switch do
 * not squeeze the name to one word per line.
 */
function TargetRow({ t, onEdit, onDelete, refresh }: {
  t: NotifyTarget; onEdit: () => void; onDelete: () => void; refresh: () => Promise<unknown>;
}) {
  const toast = useToast();
  const { status, run } = useAutosave();
  const [local, setLocal] = useState(t.enabled);
  const [seen, setSeen] = useState(t.enabled);
  if (t.enabled !== seen) { setSeen(t.enabled); setLocal(t.enabled); }
  const [testing, setTesting] = useState(false);

  const flip = async (next: boolean) => {
    setLocal(next);
    const ok = await run(async () => {
      await api(`/api/admin/notify-targets/${t.id}`, { method: 'PATCH', json: { enabled: next } });
      await refresh();
    });
    if (!ok) setLocal(t.enabled);
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; status: number | null; reason: string }>(`/api/admin/notify-targets/${t.id}/test`, { method: 'POST' });
      toast(r.ok ? tr('Test sent to {name}', { name: t.name }) : reasonText(r.reason), r.ok ? 'success' : 'error');
    } catch (e) {
      toast(e instanceof ApiError && e.status === 429 ? tr('Five tests a minute at most — try again shortly') : msgOf(e, tr('Could not send the test')), 'error');
    }
    setTesting(false);
    void refresh();
  };

  const autoOff = !t.enabled && t.consecutiveFailures >= AUTO_OFF;
  const last = autoOff
    ? <span className="text-amber-300">{tr('Switched off after {n} failed deliveries in a row. Fix it, then switch it back on.', { n: t.consecutiveFailures })}</span>
    : t.lastResult === 'ok'
      ? <span className="text-emerald-400">{tr('Delivered {when}', { when: relativeTime(t.lastOkAt) })}</span>
      : t.lastResult === 'error'
        ? <span className="text-rose-300">{reasonText(t.lastError)} · {relativeTime(t.lastErrorAt)}</span>
        : <span>{tr('Not used yet')}</span>;
  const what = [
    t.events.includes('new_chapters') ? tr('New chapters') : null,
    t.events.includes('health') ? tr('Server problems') : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="py-3 first:pt-1 last:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-sm text-fog-100">{t.name}</p>
          <p className="truncate text-[11px] text-fog-500">
            <span className="text-fog-300">{KIND_LABEL[t.kind]}</span> · <bdi dir="ltr">{t.target}</bdi>
          </p>
          <p className="text-[11px] leading-relaxed text-fog-500">
            {what}{t.userName ? <> · {tr('Only {name}’s favourites', { name: t.userName })}</> : null}
          </p>
          <p className="text-[11px] leading-relaxed text-fog-500">{last}</p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          <Switch on={local} onChange={(next) => { void flip(next); }} label={tr('Send to {name}', { name: t.name })} />
          <SaveState status={status} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" onClick={test} disabled={testing} className="chip text-xs disabled:opacity-50">
          {testing ? tr('Sending…') : tr('Send a test')}
        </button>
        <button type="button" onClick={onEdit} className="chip text-xs">{tr('Edit')}</button>
        <button type="button" onClick={onDelete} className="chip text-xs hover:text-rose-300">{tr('Delete')}</button>
      </div>
    </div>
  );
}

/**
 * Add (target null) or edit one target.
 *
 * Exactly the fields the kind needs. Credentials start EMPTY on edit -- never from the server's answer,
 * which does not carry them anyway -- and an empty one is not sent, which the server reads as "keep". The
 * one exception is the Home Assistant service name: it is not a secret, the server returns it, and it is
 * shown so it can be corrected.
 */
function TargetDialog({ target, onClose, onSaved }: { target: NotifyTarget | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = !!target;
  const [kind, setKind] = useState<Kind>(target?.kind ?? 'webhook');
  const [name, setName] = useState(target?.name ?? '');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [topic, setTopic] = useState('');
  const [service, setService] = useState(target?.service ?? '');
  const [events, setEvents] = useState<NotifyEvent[]>(target?.events ?? ['new_chapters', 'health']);
  const [template, setTemplate] = useState(target?.template ?? '');
  const [userId, setUserId] = useState(target?.userId ?? '');
  const [includeAdult, setIncludeAdult] = useState(target?.includeAdult ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Only for the "who is it for" list; an admin can see every account anyway.
  const { data: users } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ content: Array<{ id: string; username: string; display_name?: string | null }> }>('/api/admin/users'),
  });

  const toggle = (e: NotifyEvent, on: boolean) => setEvents((cur) => (on ? [...new Set([...cur, e])] : cur.filter((x) => x !== e)));
  const serviceBad = kind === 'home_assistant' && !!service.trim() && !HA_SERVICE.test(service.trim());
  const topicBad = kind === 'ntfy' && !!topic.trim() && !NTFY_TOPIC.test(topic.trim());
  // ⚠️ A STORED TOKEN NEVER FOLLOWS THE ADDRESS TO ANOTHER HOST. The server refuses that PATCH outright
  // (reenter_token / reenter_topic in routes/notify.ts) rather than hand a new host the Home Assistant
  // long-lived token, the webhook bearer or the ntfy topic at the next test or digest; this asks for it
  // before the round trip instead of after the refusal. Only ANOTHER origin counts -- correcting a webhook's
  // path keeps its token here exactly as it does on the server -- and an address that does not parse is left
  // to the server's own bad_url, which never hints at what is stored.
  const typedOrigin = (() => {
    const raw = url.trim() || (kind === 'ntfy' ? 'https://ntfy.sh' : '');
    if (!raw) return null;
    try { return new URL(raw).origin; } catch { return null; }
  })();
  // What the server sends back is the masked form: scheme and host, then "/…" when a path was kept.
  const storedOrigin = target?.target ? target.target.replace(/\/….*$/, '') : null;
  const moved = editing && !!url.trim() && !!typedOrigin && !!storedOrigin && typedOrigin !== storedOrigin;
  // What a NEW target cannot be saved without; an edit may leave every credential blank (kept as stored) --
  // unless the address moved to another host, which needs its token, and an ntfy topic, typed again.
  const missing = !name.trim() || !events.length || serviceBad || topicBad
    || (moved && !!target?.hasToken && !token.trim() && !removeToken)
    || (moved && kind === 'ntfy' && !topic.trim())
    || (!editing && (
      (kind !== 'ntfy' && !url.trim())
      || (kind === 'home_assistant' && (!token.trim() || !service.trim()))
      || (kind === 'ntfy' && !topic.trim())
    ));

  const save = async () => {
    setBusy(true);
    setError('');
    const creds: Record<string, unknown> = {};
    if (url.trim()) creds.url = url.trim();
    if (token.trim()) creds.token = token.trim();
    else if (removeToken) creds.token = null;
    if (topic.trim()) creds.topic = topic.trim();
    if (kind === 'home_assistant' && service.trim() && service.trim() !== (target?.service ?? '')) creds.service = service.trim();
    const common = { name: name.trim(), events, template: template.trim() || null, userId: userId || null, includeAdult };
    try {
      if (target) await api(`/api/admin/notify-targets/${target.id}`, { method: 'PATCH', json: { ...common, ...creds } });
      else await api('/api/admin/notify-targets', { json: { kind, ...common, ...creds } });
      toast(editing ? tr('Saved') : tr('Added {name} — send it a test from its row', { name: name.trim() }), 'success');
      onSaved();
    } catch (e) {
      // The server's own sentence: every refusal there is a fixed one that never repeats what was typed.
      setError(msgOf(e, tr('Could not save')));
    }
    setBusy(false);
  };

  const keepHint = editing ? tr('Leave blank to keep the stored one') : undefined;
  return (
    <Modal title={editing ? tr('Edit {name}', { name: target!.name }) : tr('Add a notification target')} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        {!editing && (
          <Segmented label={tr('Kind')} value={kind} onChange={(k) => { setKind(k); setError(''); }}
            options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        )}
        <Field label={tr('Name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off"
            placeholder={tr('e.g. Kitchen tablet')} className="field" />
        </Field>

        {kind === 'webhook' && (
          <>
            <Field label={tr('Address')} help={keepHint ?? tr('Receives a JSON POST: event, title, message, count and the series.')}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" autoComplete="off" autoCapitalize="none"
                placeholder="http://n8n.lan:5678/webhook/…" className="field" dir="ltr" />
            </Field>
            <TokenField label={tr('Token (optional)')} help={tr('Sent as “Authorization: Bearer …”.')} value={token} onChange={setToken}
              editing={editing} hasToken={!!target?.hasToken} retype={moved} removable removeToken={removeToken} setRemoveToken={setRemoveToken} />
          </>
        )}
        {kind === 'home_assistant' && (
          <>
            <Field label={tr('Home Assistant address')} help={keepHint ?? tr('Only the address is used; the path is built from the service.')}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" autoComplete="off" autoCapitalize="none"
                placeholder="http://homeassistant.local:8123" className="field" dir="ltr" />
            </Field>
            <TokenField label={tr('Long-lived access token')} help={tr('Your Home Assistant profile → Security → Long-lived access tokens.')} value={token} onChange={setToken}
              editing={editing} hasToken={!!target?.hasToken} retype={moved} />
            <Field label={tr('Service')} help={serviceBad
              ? <span className="text-rose-300">{tr('Lower-case letters, digits and _, as domain.service')}</span>
              : tr('The notify service to call, e.g. notify.mobile_app_your_phone')}>
              <input value={service} onChange={(e) => setService(e.target.value)} autoComplete="off" autoCapitalize="none"
                placeholder="notify.mobile_app_pixel" className="field" dir="ltr" />
            </Field>
          </>
        )}
        {kind === 'ntfy' && (
          <>
            <Field label={tr('Server')} help={keepHint ?? tr('Leave blank for ntfy.sh.')}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" autoComplete="off" autoCapitalize="none"
                placeholder="https://ntfy.sh" className="field" dir="ltr" />
            </Field>
            <Field label={tr('Topic')} help={topicBad
              ? <span className="text-rose-300">{tr('1 to 64 letters, digits, - or _')}</span>
              : moved ? tr('A new server needs the topic typed again')
              : keepHint ?? tr('On a public server the topic works like a password: pick one nobody would guess.')}>
              <input value={topic} onChange={(e) => setTopic(e.target.value)} type="password" autoComplete="off" autoCapitalize="none"
                className="field" dir="ltr" />
            </Field>
            <TokenField label={tr('Token (optional)')} help={tr('For a server that requires one.')} value={token} onChange={setToken}
              editing={editing} hasToken={!!target?.hasToken} removable removeToken={removeToken} setRemoveToken={setRemoveToken} />
          </>
        )}
        {kind === 'discord' && (
          <Field label={tr('Discord webhook address')} help={keepHint ?? tr('Server Settings → Integrations → Webhooks → Copy Webhook URL. The address is the password, so it is never shown again.')}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} type="password" autoComplete="off" autoCapitalize="none"
              placeholder="https://discord.com/api/webhooks/…" className="field" dir="ltr" />
          </Field>
        )}

        <fieldset>
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Send')}</legend>
          {/* items-start: these labels run to two lines at 390 px, and a centred box would float between them. */}
          <label className="flex items-start gap-2 text-xs text-fog-300">
            <input type="checkbox" checked={events.includes('new_chapters')} onChange={(e) => toggle('new_chapters', e.target.checked)} className="mt-0.5 shrink-0 accent-accent" />
            {tr('New chapters — one message after each library update')}
          </label>
          <label className="mt-1 flex items-start gap-2 text-xs text-fog-300">
            <input type="checkbox" checked={events.includes('health')} onChange={(e) => toggle('health', e.target.checked)} className="mt-0.5 shrink-0 accent-accent" />
            {tr('Server problems — a source refusing this server, the Cloudflare solver, extensions')}
          </label>
          {!events.length && <p className="mt-1 text-[11px] text-rose-300">{tr('Pick at least one.')}</p>}
        </fieldset>

        <Field label={tr('Who it is for')} help={tr('A person’s target hears only about their own favourites. Server problems reach it only if they are an admin.')}>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className="field">
            <option value="">{tr('The whole server')}</option>
            {(users?.content ?? []).map((u) => (
              <option key={u.id} value={u.id}>{tr('Only {name}’s favourites', { name: u.display_name || u.username })}</option>
            ))}
          </select>
        </Field>

        {/* The 18+ opt-in, off by default, like an OPDS link's and an API token's: the web app's Show 18+ is a
            per-browser session cookie the server never sees, so a target carries its own choice. It only ever
            WIDENS what may be named; a person's own libraries and age cap are permissions and always apply. */}
        <label className="flex items-start gap-2 text-xs text-fog-300">
          <input type="checkbox" checked={includeAdult} onChange={(e) => setIncludeAdult(e.target.checked)} className="mt-0.5 shrink-0 accent-accent" />
          <span>
            {tr('Include 18+ series')}
            <span className="mt-0.5 block max-w-prose text-[11px] leading-relaxed text-fog-500">
              {tr('Titles from libraries rated 18+ are left out unless this is on. A person’s target never names a series outside their own libraries or above their age limit.')}
            </span>
          </span>
        </label>

        {events.includes('new_chapters') && (
          <Field label={tr('Message')}
            help={<>{tr('{count} chapters added · {series} the series’ title, or “3 series” · {list} up to ten titles')}</>}>
            <input value={template} onChange={(e) => setTemplate(e.target.value)} maxLength={500} autoComplete="off"
              placeholder={DEFAULT_TEMPLATE} className="field" dir="auto" />
            {/* A span, not a <p>: this sits inside the field's <label>, which may hold phrasing content only. */}
            <span className="mt-1.5 block rounded-lg border border-ink-700 bg-ink-950/60 px-2.5 py-1.5 text-xs text-fog-300">
              <span className="text-fog-500">{tr('Preview')}: </span><bdi dir="auto">{renderDigest(template, SAMPLE)}</bdi>
            </span>
          </Field>
        )}

        <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">
          {tr('Addresses and tokens are stored encrypted and never shown again; to change one, type it again, and a new address needs its token typed again too. Addresses on your own network work. Redirects are never followed.')}
        </p>
        {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">{tr('Cancel')}</button>
          <button type="button" onClick={save} disabled={busy || missing} className="btn-accent flex-1 py-2 text-sm font-semibold disabled:opacity-40">
            {busy ? tr('Working…') : editing ? tr('Save') : tr('Add')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, help, children }: { label: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-fog-500">{label}</span>
      {children}
      {help && <span className="mt-1 block max-w-prose text-[11px] leading-relaxed text-fog-500">{help}</span>}
    </label>
  );
}

/**
 * A write-only token box. On edit it says whether one is stored -- never what it is -- and, when the address
 * being saved points at another host (`retype`), that the stored one will not go there: the server refuses
 * that save, because a token following an address to a new host is a reveal by another name.
 */
function TokenField({ label, help, value, onChange, editing, hasToken, retype, removable, removeToken, setRemoveToken }: {
  label: string; help: string; value: string; onChange: (v: string) => void; editing: boolean; hasToken: boolean;
  retype?: boolean; removable?: boolean; removeToken?: boolean; setRemoveToken?: (v: boolean) => void;
}) {
  return (
    <div>
      <Field label={label} help={editing
        ? retype && hasToken ? tr('A new address needs the token typed again')
        : hasToken ? tr('A token is stored. Leave blank to keep it.') : tr('No token is stored.')
        : help}>
        <input value={value} onChange={(e) => onChange(e.target.value)} type="password" autoComplete="new-password" autoCapitalize="none"
          disabled={!!removeToken} className="field disabled:opacity-40" dir="ltr" />
      </Field>
      {editing && removable && hasToken && setRemoveToken && (
        <label className="mt-1 flex items-center gap-2 text-xs text-fog-300">
          <input type="checkbox" checked={!!removeToken} onChange={(e) => setRemoveToken(e.target.checked)} className="accent-accent" />
          {tr('Remove the stored token')}
        </label>
      )}
    </div>
  );
}
