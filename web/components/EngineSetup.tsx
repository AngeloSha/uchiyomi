'use client';
// Admin → Extensions when the extension engine is off, not set up or not answering (#72), and the two lines the
// panel gains once it is ready: the engine's Cloudflare helper, and how to turn it off safely.
//
// It replaces one sentence that fitted nobody: "If you turned it off by emptying SUWAYOMI_URL, put that line back"
// for a Compose admin who had just set EXTENSION_ENGINE=0, the same for Unraid and CasaOS where no engine ever
// ran, and "Can't reach the extension engine" with nothing to do about it. The steps are per platform (the words
// and commands live in lib/engineSetup.ts, where they are tested), "Check again" asks at once, and the card turns
// into the extension catalogue by itself the moment the server can reach the engine.
//
// A separate component on purpose: the Extensions panel (app/admin/page.tsx) is edited by other v0.49.0 work too,
// and its tests cut it into slices by string markers.
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { untilText, wallClock } from '@/lib/format';
import { msgOf } from '@/components/ConfirmDialog';
import { ProgressRing } from '@/components/ProgressRing';
import {
  PLATFORM_CHIPS, dataPlace, dataWarning, defaultPlatform, headline, headlineText, lastTryLine, offSteps, onSteps, platformLabel,
  stillLine, type EngineReport, type Platform, type Step,
} from '@/lib/engineSetup';

/** How often the card asks the server again while it waits: an engine being started answers within minutes. */
const POLL_CONFIGURED_MS = 15_000;
/** Off or not set up: nothing changes until someone edits a setting and Uchiyomi restarts. */
const POLL_OFF_MS = 30_000;

/**
 * A translated sentence with its `{placeholders}` as code: names, variables and paths are copied, never
 * translated, and a translation may put them in any order.
 */
function withCode(text: string, vars: Record<string, string> = {}): ReactNode[] {
  return text.split(/(\{[a-z]+\})/).map((part, i) => {
    const name = /^\{([a-z]+)\}$/.exec(part)?.[1];
    return name && name in vars
      // dir="ltr" isolates it: in Arabic, `SUWAYOMI_URL=` would otherwise print its `=` on the wrong side.
      ? <code key={i} dir="ltr" className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[10.5px] text-fog-200">{vars[name]}</code>
      : part;
  });
}

/**
 * A command to copy, in a block that scrolls sideways at 390 px rather than wrapping a path in half. Copy only
 * where the browser allows it -- `navigator.clipboard` is missing over plain http on a LAN, which is how most
 * people reach this page -- and decided after mount, so the static HTML and the first render agree
 * (ConfirmDialog's Copy title, for the same reasons).
 */
function Command({ command }: { command: string }) {
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCanCopy(typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'); }, []);
  useEffect(() => {
    if (!copied) return;
    const h = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(h);
  }, [copied]);
  return (
    <div className="mt-1.5 flex items-stretch gap-1.5">
      <pre dir="ltr" className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-ink-700/70 bg-ink-900/70 px-2.5 py-2 text-start">
        <code className="select-all whitespace-pre font-mono text-[11px] text-fog-100">{command}</code>
      </pre>
      {canCopy && (
        <button type="button" className="btn-key self-center"
          onClick={() => navigator.clipboard.writeText(command).then(() => setCopied(true), () => setCopied(false))}>
          {copied ? tr('Copied') : tr('Copy')}
        </button>
      )}
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-3 space-y-3">
      {steps.map((s, i) => (
        <li key={`${s.text}-${i}`} className="flex gap-2.5">
          {steps.length > 1 && (
            <span aria-hidden className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ink-600 text-[10px] font-semibold tabular-nums text-fog-400">
              {i + 1}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] leading-relaxed text-fog-300">{withCode(tr(s.text), s.vars)}</p>
            {s.command && <Command command={s.command} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The platform switch: filter chips (the one chip shape the owner kept), scrolling sideways on a phone. */
function PlatformChips({ value, onChange }: { value: Platform; onChange: (p: Platform) => void }) {
  return (
    <div role="radiogroup" aria-label={tr('Where Uchiyomi runs')} className="hide-scrollbar -mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
      {PLATFORM_CHIPS.map((p) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} onClick={() => onChange(p)}
          className={`chip shrink-0 whitespace-nowrap px-2.5 py-1 text-xs ${value === p ? 'chip-active' : ''}`}>
          {platformLabel(p)}
        </button>
      ))}
    </div>
  );
}

/** The data warning with its place as code: the volume, or the folder the template and the add-on mount. */
function DataWarning({ platform, linked }: { platform: Platform; linked: number }) {
  const place = dataPlace(platform);
  if (!place) return null;
  return (
    <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-amber-200/90">
      {withCode(dataWarning(linked), { place })}
    </p>
  );
}

/**
 * The engine's mark: a thin ring around an extension glyph. The ring turns while Uchiyomi is waiting for an engine
 * that is set up (the retry is running), and is still otherwise; ProgressRing stops the turn by itself under
 * Reduce effects or the system's reduced motion, drawing a still dashed arc instead.
 */
function EngineMark({ waiting, tone }: { waiting: boolean; tone: 'amber' | 'muted' }) {
  return (
    <span aria-hidden className="relative grid h-10 w-10 shrink-0 place-items-center">
      <ProgressRing size="bar" progress={waiting ? 'spin' : 'idle'} tone={tone} className="absolute inset-0" />
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
        className={tone === 'amber' ? 'text-amber-300' : 'text-fog-400'}>
        <path d="M6.2 3.2a1.3 1.3 0 1 1 2.6 0V4.2H12a.8.8 0 0 1 .8.8v3h-1a1.3 1.3 0 1 0 0 2.6h1v2.6a.8.8 0 0 1-.8.8H9.1v-1a1.3 1.3 0 1 0-2.6 0v1H4a.8.8 0 0 1-.8-.8V10.4h1a1.3 1.3 0 1 0 0-2.6h-1V5a.8.8 0 0 1 .8-.8h2.2Z" />
      </svg>
    </span>
  );
}

/**
 * The card. `bare` renders it inside the ready panel's own card and header (the engine was reached once and is not
 * answering now); otherwise it is the whole Extensions card.
 */
export function EngineSetup({ status, span = '', bare = false }: { status: EngineReport; span?: string; bare?: boolean }) {
  const qc = useQueryClient();
  const h = headline(status);
  const [platform, setPlatform] = useState<Platform>(() => defaultPlatform(status));
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState<string | null>(null);

  // Ask again while the page is looked at, so an engine that has just been started shows up without a press.
  useEffect(() => {
    const every = status.configured ? POLL_CONFIGURED_MS : POLL_OFF_MS;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['ext-status'] });
    }, every);
    return () => clearInterval(t);
  }, [status.configured, qc]);
  // This card goes away when the engine answers: Discover and the source lists may have gained its sources.
  useEffect(() => () => { void qc.invalidateQueries({ queryKey: ['sources'] }); }, [qc]);

  // Check again is a plain refetch: the status route itself registers the engine's sources when it answers again
  // (bff lib/extensionEngine.ts), and the panel turns into the catalogue from that answer.
  const checkAgain = async () => {
    if (checking) return;
    setChecking(true);
    setStill(null);
    try {
      await qc.refetchQueries({ queryKey: ['ext-status'] });
      const now = qc.getQueryData<EngineReport>(['ext-status']) ?? status;
      if (!(now.configured && now.reachable)) setStill(stillLine(now));
    } catch (e) {
      const why = msgOf(e, '');
      setStill(why ? tr('Still no answer: {reason}', { reason: why }) : tr('Still no answer'));
    } finally {
      setChecking(false);
    }
  };

  const waiting = h === 'unreachable';
  const retry = status.retry;
  const retryLine = retry
    // One try has no "since": it was AT that time.
    ? (retry.attempts === 1
      ? tr('Tried once, at {time} · next try {when}', { time: wallClock(retry.since), when: untilText(Date.parse(retry.nextAt) - Date.now()) })
      : tr('Tried {n} times since {time} · next try {when}', { n: retry.attempts, time: wallClock(retry.since), when: untilText(Date.parse(retry.nextAt) - Date.now()) }))
    // No retry: the last attempt and how it went, which after Check again is that very press.
    : waiting ? lastTryLine(status) || null : null;

  const body = (
    <>
      <div className="flex items-start gap-3">
        <EngineMark waiting={waiting} tone={waiting ? 'amber' : 'muted'} />
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className={`text-sm font-medium leading-snug ${waiting ? 'text-amber-300' : 'text-fog-100'}`}>{headlineText(h)}</p>
          {retryLine && <p className="mt-0.5 text-[11px] tabular-nums text-fog-500">{retryLine}</p>}
          {waiting && status.error && (
            <p className="mt-0.5 break-words font-mono text-[10.5px] text-fog-600">{status.error}</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button type="button" onClick={checkAgain} disabled={checking} className="btn-key" data-engine-check>
          {checking ? tr('Checking…') : tr('Check again')}
        </button>
        {still && <p role="status" className="min-w-0 flex-1 text-[11px] leading-snug text-fog-400">{still}</p>}
      </div>

      <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
        {tr('The extension engine runs Mihon and Tachiyomi extensions for Uchiyomi. It is an optional extra that uses about 750 MB of memory; MangaDex and sites you add by address work without it.')}
      </p>

      <PlatformChips value={platform} onChange={setPlatform} />
      <Steps steps={onSteps(platform, h)} />

      {platform !== 'umbrel' && (
        <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-fog-500">
          {tr('It takes a minute or two to start the first time. This card turns into your extensions by itself.')}
        </p>
      )}
      {(h === 'switched_off' || h === 'unset') && (status.linkedSeries ?? 0) > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-fog-300">{tr('Your extension data is kept while it is off.')}</p>
      )}
      <DataWarning platform={platform} linked={status.linkedSeries ?? 0} />
    </>
  );

  if (bare) return <div data-engine-setup={h} className="mt-1">{body}</div>;
  return (
    <div data-engine-setup={h} className={`card grad-border p-4 ${span}`}>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Extensions')}</p>
      {body}
    </div>
  );
}

/**
 * The foot of the ready panel: the engine's own Cloudflare helper when it is off (or pointed at localhost on a
 * server, where nothing answers), with Connect; and a closed "Turning it off" with the same per-platform steps and
 * the never-delete-its-data warning. Connect answers inline, and the line stays: the status refetch after it is
 * what shows the helper connected.
 */
export function EngineReadyFoot({ status, desktop }: { status: EngineReport; desktop: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [platform, setPlatform] = useState<Platform>(() => defaultPlatform(status));
  const s = status.solver;
  const miswired = !!s && (s.wiring === 'off' || s.wiring === 'localhost');

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    try {
      await api('/api/admin/extensions/solver', { json: {} });
      setSaid({ ok: true, text: tr('Connected: the extension engine now uses Uchiyomi’s Cloudflare helper.') });
      await qc.invalidateQueries({ queryKey: ['ext-status'] });
      void qc.invalidateQueries({ queryKey: ['admin-health'] });
    } catch (e) {
      setSaid({ ok: false, text: tr('Could not change the engine’s setting: {reason}', { reason: msgOf(e, tr('no reply')) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2 border-t border-ink-700/60 pt-3">
      {(miswired || said) && (
        <div data-engine-solver={s?.wiring ?? ''} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-fog-300">
            <span className="font-semibold text-fog-200">{tr('Cloudflare helper')}</span>{' · '}
            {said ? <span className={said.ok ? 'text-emerald-300' : 'text-red-300'}>{said.text}</span>
              : s?.wiring === 'localhost'
                ? tr('The engine’s Cloudflare helper points at localhost, where no helper runs, so extensions on Cloudflare-protected sites fail.')
                : tr('The engine’s own Cloudflare helper is off, so extensions on Cloudflare-protected sites fail.')}
            {!said && s && !s.connectable && (
              <span className="block text-fog-500">{withCode(tr('Set {name} on Uchiyomi first, then connect it here.'), { name: 'FLARESOLVERR_URL' })}</span>
            )}
          </p>
          {!said?.ok && s?.connectable && (
            <button type="button" onClick={connect} disabled={busy} className="btn-key btn-key-primary" data-engine-connect>
              {busy ? tr('Connecting…') : tr('Connect')}
            </button>
          )}
        </div>
      )}
      {!desktop && (
        <details className="group text-[11px] text-fog-400">
          <summary className="cursor-pointer select-none text-fog-300 marker:text-fog-500">{tr('Turning it off')}</summary>
          <p className="mt-2 max-w-prose leading-relaxed text-fog-500">
            {tr('Turning it off keeps its data; turning it back on picks up where it left off.')}
          </p>
          <PlatformChips value={platform} onChange={setPlatform} />
          <Steps steps={offSteps(platform)} />
          <DataWarning platform={platform} linked={status.linkedSeries ?? 0} />
        </details>
      )}
    </div>
  );
}
