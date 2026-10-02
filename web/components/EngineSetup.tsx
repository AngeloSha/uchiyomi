'use client';
// The top of Admin → Extensions: the extension engine's state (#72, v0.53.0).
//
// Not working -- off, not set up or not answering -- it is the whole tab: the state, the retry, Check again, and the
// steps for the platform Uchiyomi runs on. It replaces one sentence that fitted nobody: "If you turned it off by
// emptying SUWAYOMI_URL, put that line back" for a Compose admin who had just set EXTENSION_ENGINE=0, the same for
// Unraid and CasaOS where no engine ever ran, and "Can't reach the extension engine" with nothing to do about it.
// The steps are per platform (the words and commands live in lib/engineSetup.ts, where they are tested), and the
// card turns into the extensions by itself the moment the server can reach the engine.
//
// Working, it is the header (EngineReady): the engine and its Cloudflare helper side by side, each with its state,
// a line on what it means and the one thing to do about it, and the steps to turn the engine off folded under them.
// They were a small mark in the corner and a foot under a 1,400-row list, the first thing an admin comes to ask.
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { untilText, wallClock } from '@/lib/format';
import { msgOf } from '@/components/ConfirmDialog';
import { ProgressRing } from '@/components/ProgressRing';
import { StatusEdge, StatusMark } from '@/components/StatusMark';
import { OnBody, Sheet } from '@/components/ui';
import {
  PLATFORM_CHIPS, dataPlace, dataWarning, defaultPlatform, headline, headlineText, lastTryLine, offSteps, onSteps, platformLabel,
  stillLine, type EngineReport, type Platform, type Step,
} from '@/lib/engineSetup';
import { engineLine, extensionsInstalledText, helperLine, overLimitText, sourcesOnText, type ExtStatus } from '@/lib/extensions';
import { sentenceGap } from '@/lib/jobs';

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
 * The card for an engine that is off, not set up or not answering: the whole of Admin → Extensions until it works.
 */
export function EngineSetup({ status }: { status: EngineReport }) {
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

  return (
    <div data-engine-setup={h} data-engine-state={h} className="card grad-border relative overflow-hidden p-4 lg:p-5">
      <StatusEdge tone={waiting ? 'problem' : 'info'} />
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Extension engine')}</p>
      {body}
    </div>
  );
}

/**
 * The header of a working Admin → Extensions (v0.53.0): one card, the engine and its Cloudflare helper side by side
 * (stacked on a phone), each its state as a mark, a line on what it means and its one action -- Connect, for a helper
 * that is off or pointed at localhost, where nothing answers. The steps to turn the engine off are a sheet behind a
 * small key. Connect answers in place, and the line stays: the status refetch after it shows the helper connected.
 * On desktop there is no turning it off.
 */
export function EngineReady({ status, installed, desktop }: { status: ExtStatus; installed: number | null; desktop: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [showOff, setShowOff] = useState(false);
  const engine = engineLine(status);
  const helper = helperLine(status.solver);
  const over = overLimitText(status.skipped, status.cap);

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

  const counts = [installed === null ? null : extensionsInstalledText(installed), sourcesOnText(status.enabled ?? 0, status.cap ?? 0)]
    .filter(Boolean).join(' · ');
  const helperTone = said ? (said.ok ? 'ok' : 'problem') : helper?.tone ?? 'off';
  // The card's edge says the worse of the two: a quiet card when both work.
  const edge = helperTone === 'problem' ? 'problem' : over || helperTone === 'warn' ? 'warn' : 'ok';
  return (
    <section data-engine-state="ready" aria-label={tr('Extension engine')} className="card grad-border relative overflow-hidden">
      <StatusEdge tone={edge} />
      <div className="grid grid-cols-1 divide-y divide-ink-800/70 md:grid-cols-2 md:divide-x md:divide-y-0 md:rtl:divide-x-reverse">
        <div data-engine-tile="engine" className="min-w-0 px-4 py-3.5 lg:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Extension engine')}</p>
          <div className="mt-1.5"><StatusMark tone={engine.tone} label={engine.label} size="md" /></div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-fog-400" data-engine-counts>{counts}</p>
          {/* The source limit, where the count it limits is: SUWAYOMI_MAX_SOURCES is the Docker install's variable, and
              desktop has no .env to raise it in. The name is copied into the sentence, never translated. */}
          {over && (
            <p className="mt-1 text-[12px] leading-relaxed text-amber-300" data-engine-over>
              {over}{sentenceGap(over)}
              <span className="text-amber-200/70">{desktop
                ? tr('Hide languages you don’t read.')
                : tr('Hide languages you don’t read, or raise {name}.', { name: 'SUWAYOMI_MAX_SOURCES' })}</span>
            </p>
          )}
          {!desktop && (
            <button type="button" onClick={() => setShowOff(true)} className="mt-1.5 text-[12px] text-fog-500 hover:text-fog-200 hover:underline" data-engine-off>
              {tr('Turning it off')}&nbsp;›
            </button>
          )}
        </div>
        <div data-engine-tile="helper" data-engine-solver={status.solver?.wiring ?? ''} className="min-w-0 px-4 py-3.5 lg:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-fog-500">{tr('Cloudflare helper')}</p>
              <div className="mt-1.5">
                <StatusMark tone={helperTone} label={said?.ok ? tr('Connected') : helper?.label ?? tr('Not available')} size="md" />
              </div>
            </div>
            {!said?.ok && helper?.action === 'connect' && (
              <button type="button" onClick={connect} disabled={busy} className="btn-key btn-key-primary mt-1" data-engine-connect>
                {busy ? tr('Connecting…') : tr('Connect')}
              </button>
            )}
          </div>
          <p role="status" className={`mt-1.5 text-[12px] leading-relaxed ${said ? (said.ok ? 'text-emerald-300' : 'text-red-300') : 'text-fog-400'}`}>
            {said ? said.text : helper?.detail ?? tr('This engine has no Cloudflare helper setting.')}
          </p>
          {!said && helper?.action === 'set_url' && (
            <p className="mt-1 text-[12px] leading-relaxed text-fog-500">{withCode(tr('Set {name} on Uchiyomi first, then connect it here.'), { name: 'FLARESOLVERR_URL' })}</p>
          )}
        </div>
      </div>
      {showOff && <OnBody><EngineOffSheet status={status} onClose={() => setShowOff(false)} /></OnBody>}
    </section>
  );
}

/** How to turn the engine off on each platform, and the never-delete-its-data warning. */
function EngineOffSheet({ status, onClose }: { status: EngineReport; onClose: () => void }) {
  const [platform, setPlatform] = useState<Platform>(() => defaultPlatform(status));
  return (
    <Sheet title={tr('Turning it off')} onClose={onClose} overBottomNav>
      <div className="pb-3" data-engine-off-sheet>
        <p className="max-w-prose text-[12px] leading-relaxed text-fog-400">
          {tr('Turning it off keeps its data; turning it back on picks up where it left off.')}
        </p>
        <PlatformChips value={platform} onChange={setPlatform} />
        <Steps steps={offSteps(platform)} />
        <DataWarning platform={platform} linked={status.linkedSeries ?? 0} />
      </div>
    </Sheet>
  );
}
