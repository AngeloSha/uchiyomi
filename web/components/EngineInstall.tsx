'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bridge, type EngineStatus } from '@/lib/desktop';
import { bytes } from '@/lib/format';
import { ProgressBar } from '@/components/ui';
import { t as tr } from '@/lib/i18n';

/**
 * Admin → Extensions on Uchiyomi Desktop, until the extension engine is running.
 *
 * The engine (Suwayomi: a Java runtime and its jar, about 200 MB) is never in the installer -- most people
 * who only read MangaDex or a Madara site never need it -- so the Docker card's "bring it back with docker
 * compose" has no meaning here. Instead: one button that asks the shell to fetch it (contract 3,
 * `engine.install()`), live progress from `engine.onStatus`, then "Starting…" while the shell starts it and
 * restarts the server once to connect to it (contract 5). The ordinary Extensions panel takes over by
 * itself the moment the server reports the engine reachable, which is why this polls `ext-status` while
 * it waits: the card never has to decide it is done.
 *
 * Rendered only on desktop (the Extensions card gates it through lib/desktop); on the server build the
 * Docker card is exactly what it was.
 */
export function EngineInstall({ span = '' }: { span?: string }) {
  const qc = useQueryClient();
  const b = bridge();
  const [st, setSt] = useState<EngineStatus | null>(null);
  // Between the press and the shell's first status event, so the button cannot be pressed twice.
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!b?.engine) return;
    let live = true;
    b.engine.status?.().then((s) => { if (live) setSt(s); }).catch(() => {});
    const off = b.engine.onStatus?.((s) => { if (live) setSt(s); });
    return () => { live = false; if (typeof off === 'function') off(); };
  }, [b]);

  // Starting, or running while the server has not seen it yet (it restarts to pick it up): ask the server
  // again every two seconds. A request that lands mid-restart just fails and the next one answers.
  const waiting = st?.state === 'starting' || st?.state === 'running';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ['ext-status'] });
      void qc.invalidateQueries({ queryKey: ['sources'] });
    }, 2000);
    return () => clearInterval(t);
  }, [waiting, qc]);

  const install = async () => {
    if (!b?.engine?.install || asked) return;
    setAsked(true);
    try {
      await b.engine.install();
    } catch (e: any) {
      // The shell reports a failure through onStatus as well; this covers a rejection that arrives alone.
      setSt((cur) => (cur?.state === 'failed' ? cur : { state: 'failed', error: String(e?.message || e || '') }));
    } finally {
      setAsked(false);
    }
  };

  const state: EngineStatus['state'] | 'asking' = asked && (!st || st.state === 'absent' || st.state === 'failed') ? 'asking' : st?.state ?? 'absent';
  const pct = st?.total ? (st.bytes ?? 0) / st.total : st?.progress ?? 0;

  return (
    <div className={`card grad-border p-4 ${span}`}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fog-500">{tr('Extensions')}</p>

      {!b ? (
        // The server says desktop but this window has no bridge: nothing here can fetch the engine.
        <p className="text-[11px] leading-relaxed text-fog-500">{tr('The extension engine isn’t running')}</p>
      ) : !st && !asked ? (
        <p className="text-[11px] text-fog-500">{tr('Loading…')}</p>
      ) : state === 'absent' || state === 'failed' ? (
        <>
          <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">
            {tr('Extensions run in the extension engine, a separate download of about 200 MB. It is fetched once and runs only on this computer.')}
          </p>
          {state === 'failed' && (
            <p role="alert" className="mt-2 max-w-prose text-[11px] leading-relaxed text-red-300">
              {tr('The extension engine could not be installed.')}
              {st?.error ? <span className="block break-words font-mono text-[10px] text-red-300/80">{st.error}</span> : null}
            </p>
          )}
          <button type="button" onClick={install} className="btn-accent mt-3 px-4 py-2 text-sm">
            {state === 'failed' ? tr('Try again') : tr('Download the extension engine (about 200 MB)')}
          </button>
        </>
      ) : (
        <div role="status" aria-live="polite">
          <p className="text-sm text-fog-200">
            {state === 'asking' || state === 'downloading' ? tr('Downloading the extension engine…')
              : state === 'installing' ? tr('Installing the extension engine…')
              : tr('Starting the extension engine…')}
          </p>
          {(state === 'asking' || state === 'downloading') && (
            <>
              <div className="mt-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
                <ProgressBar value={Math.min(1, Math.max(0, pct))} />
              </div>
              <p className="mt-1 text-[11px] tabular-nums text-fog-500">
                {st?.total ? tr('{done} of {total}', { done: bytes(st.bytes ?? 0), total: bytes(st.total) }) : `${Math.round(pct * 100)}%`}
              </p>
            </>
          )}
          {(state === 'starting' || state === 'running') && (
            <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-fog-500">
              {tr('Uchiyomi reconnects to it by itself; the extension list appears here in a few seconds.')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
