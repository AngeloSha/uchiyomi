'use client';
// One source's sheet, for every kind (v0.54.0): Admin → Sources' rows open it, and so does an installed extension in
// Add sources.
//
// Everything about one source in one place, where Providers gave a source a card of two to five keys and Extensions
// another sheet with its languages and a link back to Providers to test them:
// - its face, name, kind and language, and what it is to the library ("main source of 195 series");
// - its state in one line, and Details -- the stage lines and the fix (components/SourceEvidence.tsx) -- behind a
//   disclosure, open by itself after a Test, whose answer it is;
// - its keys: Replace (the one filled key) while it cannot serve the series it is main to, Test with its clock, Clear
//   block in a cooldown, Turn off / Turn on -- asking first when series use it -- and, for a site added by address,
//   Remove; a source the engine's limit left out (v0.55.1) has no Replace, and one line on how to make room instead;
// - "Used by 195 series ›", the Library filtered to them;
// - what its kind has: an extension's languages, settings, Update and Remove extension (components/ExtensionSheet.tsx);
//   MangaDex's languages (components/MangadexCard.tsx); a site's address, with Update address.
//
// Every question is asked INSIDE the sheet: a ConfirmDialog is z-50 under a Sheet's z-60. Replace and the Languages
// sheet are sheets of their own, so this one closes before either opens (one sheet at a time).
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { isDesktop } from '@/lib/desktop';
import { diagnosisReason } from '@/lib/said';
import { useTicker } from '@/lib/ticker';
import { testClock, type TestAnswer } from '@/lib/sourceEvidence';
import {
  failingSince, libraryHref, limitLine, sheetFacts, sheetKeys, sourceSays, turnOffQuestion, turnOffRequest, turnOnRequest,
  usedBy, usedByLink, type OverviewSource, type SheetKey, type SourceEvidenceRow, type SourcesOverview,
} from '@/lib/sourcesPanel';
import { extSourceIdOf } from '@/lib/sourcePrefs';
import { extLanguagesText, type ExtStatus, type InstalledExt } from '@/lib/extensions';
import { Sheet } from '@/components/ui';
import { msgOf } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { StatusMark } from '@/components/StatusMark';
import { SourceEvidence } from '@/components/SourceEvidence';
import { SourceTile } from '@/components/SourceTile';
import { Disclosure } from '@/components/settings';
import { Busy, ExtIcon, ExtTags, Facts, busyKey } from '@/components/ExtensionBits';
import { ExtensionRemove, ExtensionSection, ExtensionUpdateKey } from '@/components/ExtensionSheet';
import { MangadexLanguages } from '@/components/MangadexCard';
import { IcChevronRight } from '@/components/icons';
import type { ExtActions } from '@/components/ExtensionsPanel';

/** What a sheet is opened on: a source, or an installed extension (Add sources' catalogue), whose first source it shows. */
export type SheetTarget = { id: string; settings?: boolean } | { pkg: string };

/** The source and the extension a target names, from what the panel has read. */
export function resolveTarget(target: SheetTarget, sources: readonly OverviewSource[], installed: readonly InstalledExt[]):
  { source: OverviewSource | null; ext: InstalledExt | null } {
  if ('pkg' in target) {
    const ext = installed.find((e) => e.pkgName === target.pkg) ?? null;
    // Its first source switched on, else its first: the one a person most likely reads.
    const first = ext ? (ext.sources.find((s) => s.enabled) ?? ext.sources[0]) : null;
    return { source: first ? sources.find((s) => s.id === `sw:${first.id}`) ?? null : null, ext };
  }
  const source = sources.find((s) => s.id === target.id) ?? null;
  const raw = extSourceIdOf(target.id);
  const ext = installed.find((e) => (source?.pkgName && e.pkgName === source.pkgName) || (!!raw && e.sources.some((x) => x.id === raw))) ?? null;
  return { source, ext };
}

export function SourceSheet({ target, overview, evidence, testMs, status, actions, installed, hiddenLangs, onClose, onReplace, onLanguages, onChanged }: {
  target: SheetTarget;
  overview: SourcesOverview | undefined;
  /** GET /api/admin/sources, by source id: the stored evidence behind Details. */
  evidence: ReadonlyMap<string, SourceEvidenceRow>;
  /** How long one Test may take, for its clock (GET /api/admin/sources `testMs`). */
  testMs?: number;
  /** The extension engine's report; an extension's part needs it, and is left out while the engine is down. */
  status?: ExtStatus;
  actions: ExtActions;
  installed: readonly InstalledExt[];
  hiddenLangs: string[];
  onClose: () => void;
  /** Replace this source: the panel closes this sheet and opens the Replace dialog. */
  onReplace: (s: OverviewSource) => void;
  /** The languages hidden in every extension: the panel closes this sheet and opens that one. */
  onLanguages: () => void;
  /** After anything here changed: the lists and Health are asked again. */
  onChanged: () => Promise<unknown> | void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { source: s, ext } = resolveTarget(target, overview?.sources ?? [], installed);
  const [busy, setBusy] = useState<SheetKey | 'address' | null>(null);
  const [asking, setAsking] = useState<'turn-off' | 'remove' | 'address' | null>(null);
  // Said where it was asked: under the keys, or under the address form for Update address.
  const [refusal, setRefusal] = useState<{ key: SheetKey | 'address'; text: string } | null>(null);
  const [answer, setAnswer] = useState<(TestAnswer & { probe?: { finalUrl?: string } }) | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [testFrom, setTestFrom] = useState(0);
  const now = useTicker(busy === 'test');
  const [address, setAddress] = useState('');

  const engineReady = !!status?.configured && !!status?.reachable;
  const name = s?.name ?? ext?.name ?? '';
  const row = s ? evidence.get(s.id) : undefined;
  const says = s ? sourceSays(s, failingSince(row)) : null;
  const keys = s ? sheetKeys(s, overview?.attention) : [];
  // Not loaded because the engine's source limit is full (v0.55.1): why, and the way to room, where Replace was.
  const limit = s ? limitLine(s, isDesktop()) : null;
  const offByAdmin = new Set((overview?.sources ?? []).filter((x) => x.kind === 'extension' && x.offBy === 'admin')
    .map((x) => extSourceIdOf(x.id)).filter((x): x is string => !!x));

  /**
   * One request, then the lists again; a refusal is said on the sheet, in the server's words by its code (`messageSaid`)
   * in the reader's language. Remove's 409 `in_use` is `retire.inUse` ("It is the main source of n series. Replace it
   * first."): one wording, the server's, never a second one of the web's own.
   */
  const run = async (key: SheetKey | 'address', go: () => Promise<string | null>) => {
    setBusy(key);
    setRefusal(null);
    try {
      const done = await go();
      if (done) toast(done, 'success');
    } catch (e) {
      setRefusal({ key, text: msgOf(e, tr('Could not save that')) });
    }
    await onChanged();
    setBusy(null);
  };

  const test = () => {
    if (!s) return;
    setTestFrom(Date.now());
    void run('test', async () => {
      const r = await api<TestAnswer & { probe?: { finalUrl?: string } }>(`/api/admin/sources/${encodeURIComponent(s.id)}/test`, { method: 'POST' });
      setAnswer(r);
      // The answer is what Details is for: open it, so the stage that failed is in front of whoever asked.
      setDetailsOpen(true);
      void qc.invalidateQueries({ queryKey: ['admin-sources'] });
      if (!r.ok) toast(diagnosisReason(r.diagnosis) || tr('That source is still failing'), 'error');
      return r.ok ? tr('That source is working') : null;
    });
  };
  const unblock = () => s && run('unblock', async () => {
    await api(`/api/admin/sources/${encodeURIComponent(s.id)}/unblock`, { method: 'POST' });
    return tr('Block cleared');
  });
  const turnOff = () => s && run('turn-off', async () => {
    setAsking(null);
    const r = turnOffRequest(s);
    await api(r.path, r.json ? { json: r.json } : { method: 'POST' });
    return tr('That source is switched off');
  });
  const turnOn = () => s && run('turn-on', async () => {
    const r = turnOnRequest(s);
    await api(r.path, r.json ? { json: r.json } : { method: 'POST' });
    return tr('Enabled');
  });
  const remove = () => s && run('remove', async () => {
    setAsking(null);
    await api(`/api/admin/sources/${encodeURIComponent(s.id)}/retire`, { json: { how: 'remove' } });
    onClose();
    // Its own words: "Removed {name}" is an extension's, and several languages say so in it.
    return tr('Removed {name} from your sources', { name: `\u2068${s.name}\u2069` });
  });
  /** A site's new address: the one a Test found it moved to, or the one typed -- its origin, as Add a site takes one. */
  const moveTo = (to: string) => {
    if (!s) return;
    const origin = (() => { try { const u = new URL(to); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } })();
    // Said under the keys, in words: the request is never sent for an address that is not one.
    if (!origin) { setRefusal({ key: 'address', text: tr('That doesn’t look like a web address. It starts with https://') }); return; }
    void run('address', async () => {
      const r = await api<{ smoke?: { ok?: boolean } }>(`/api/admin/sources/custom/${encodeURIComponent(s.id)}`, { method: 'PATCH', json: { base: origin } });
      setAsking(null);
      setAnswer(null);
      return r.smoke?.ok ? tr('Moved to {address}, and it works', { address: origin }) : tr('Moved to {address}', { address: origin });
    });
  };

  const key = (k: SheetKey, label: ReactNode, onClick: () => void, cls = 'btn-key', hook: Record<string, string> = {}) => (
    <button key={k} type="button" onClick={onClick} disabled={!!busy} data-source-key={k} {...hook}
      className={`${cls} tabular-nums ${busyKey(busy === k)}`}>
      {label}
    </button>
  );
  const used = s ? usedBy(s) : 0;
  const usedLink = s ? usedByLink(s) : null;

  const footer = (s?.kind === 'site' || ext) ? (
    <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
      {ext && <ExtensionRemove ext={ext} actions={actions} onRemoved={onClose} />}
      {s?.kind === 'site' && asking !== 'remove' && (
        <button type="button" onClick={() => setAsking('remove')} disabled={!!busy} className="btn-key btn-key-danger text-rose-300" data-source-key="remove">
          {tr('Remove')}
        </button>
      )}
      {s?.kind === 'site' && asking === 'remove' && (
        <div role="alertdialog" aria-label={tr('Remove {name}?', { name: `⁨${s.name}⁩` })} className="w-full border-s-2 border-red-400 bg-ink-850/80 py-2.5 pe-2 ps-3" data-source-remove-confirm>
          <p className="text-sm text-fog-100">{tr('Remove {name}?', { name: `⁨${s.name}⁩` })}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-fog-400">{tr('It goes from your sources. Series that follow it stop following it, and their chapters stay.')}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" onClick={remove} disabled={!!busy} className="btn-key border-red-500/50 bg-red-500/20 text-red-100 hover:border-red-400 hover:text-red-50" data-source-remove-yes>
              {busy === 'remove' ? <Busy tone="red">{tr('Removing…')}</Busy> : tr('Remove')}
            </button>
            <button type="button" onClick={() => setAsking(null)} disabled={!!busy} className="btn-key">{tr('Cancel')}</button>
          </div>
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <Sheet title={name} onClose={onClose} overBottomNav
      lead={s ? <SourceTile id={s.id} name={s.name} icon={s.icon} tone={says!.tone === 'ok' ? 'info' : says!.tone} dim={says!.tone === 'off'} size={52} />
        : ext ? <ExtIcon url={ext.iconUrl} name={ext.name} size={52} /> : undefined}
      subtitle={s ? <><span><Facts items={sheetFacts(s)} /></span>{ext && <ExtTags e={ext} />}</>
        : ext ? <><span><Facts items={[ext.versionName ? `v${ext.versionName}` : null, extLanguagesText(ext)]} /></span><ExtTags e={ext} /></> : undefined}
      action={ext ? <ExtensionUpdateKey ext={ext} actions={actions} /> : undefined}
      footer={footer}>
      <div className="space-y-4 pb-3" data-source-card={s?.id ?? ''} data-source-sheet={s?.id ?? ext?.pkgName ?? ''}>
        {s && says && (
          <section aria-label={tr('Status')}>
            {/* The one line: the state in a word, and why, as the row in the list says it. */}
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" data-source-status={s.state}>
              <StatusMark tone={says.tone} label={says.word} size="md" />
              {says.reason && <span className="text-fog-400">— {says.reason}</span>}
            </p>
            {limit && <p className="mt-1.5 text-[12px] leading-relaxed text-fog-400" data-source-limit>{limit}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2" data-source-keys>
              {keys.includes('replace') && key('replace', tr('Replace'), () => onReplace(s), 'btn-key btn-key-primary')}
              {keys.includes('test') && key('test', busy === 'test' ? testClock(now - testFrom, testMs) : tr('Test'), test, 'btn-key', { 'data-source-test': s.id })}
              {keys.includes('unblock') && key('unblock', tr('Clear block'), () => void unblock())}
              {keys.includes('turn-on') && key('turn-on', busy === 'turn-on' ? <Busy tone="muted">{tr('Turning on…')}</Busy> : tr('Turn on'), () => void turnOn(), 'btn-key btn-key-accent')}
              {keys.includes('turn-off') && asking !== 'turn-off' && key('turn-off', tr('Turn off'), () => (used > 0 ? setAsking('turn-off') : void turnOff()), 'btn-key btn-key-danger')}
            </div>
            {asking === 'turn-off' && (
              <div role="alertdialog" aria-label={tr('Turn off {name}?', { name: `⁨${s.name}⁩` })} className="mt-3 border-s-2 border-amber-400 bg-ink-850/80 py-2.5 pe-2 ps-3" data-source-off-confirm>
                <p className="text-sm text-fog-100">{tr('Turn off {name}?', { name: `⁨${s.name}⁩` })}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-fog-400">{turnOffQuestion(s)}</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {/* Cancel takes the focus: a second Enter on Turn off must not switch it off. */}
                  <button type="button" autoFocus onClick={() => setAsking(null)} className="btn-key">{tr('Cancel')}</button>
                  <button type="button" onClick={() => void turnOff()} disabled={!!busy} className="btn-key btn-key-danger" data-source-off-yes>{tr('Turn off')}</button>
                </div>
              </div>
            )}
            {refusal && refusal.key !== 'address' && <p role="alert" dir="auto" className="mt-2 text-[12px] leading-relaxed text-amber-300" data-source-refusal>{refusal.text}</p>}
          </section>
        )}

        {s && usedLink && (
          <Link href={libraryHref(s)} onClick={onClose} data-source-used
            className="group flex w-full items-center gap-3 border-t border-ink-800/70 pt-3 text-start text-sm text-fog-200 hover:text-fog-50">
            <span className="min-w-0 flex-1">{usedLink}</span>
            <IcChevronRight aria-hidden width={16} height={16} className="shrink-0 text-fog-500 group-hover:text-fog-200 rtl:-scale-x-100" />
          </Link>
        )}

        {s && (answer || row?.live || row?.evidence?.some((l) => l.state !== 'unknown')) && (
          <div className="border-t border-ink-800/70 pt-1" data-source-details>
            <Disclosure label={tr('Details')} open={detailsOpen} onOpenChange={setDetailsOpen}>
              {answer
                ? <SourceEvidence answer={answer} onMove={s.kind === 'site' && answer.probe?.finalUrl ? () => moveTo(answer.probe!.finalUrl!) : undefined} />
                : <SourceEvidence lines={row?.evidence} tested={row?.live} failing={!!row?.failing?.length} />}
            </Disclosure>
          </div>
        )}

        {s?.kind === 'site' && (
          <section aria-label={tr('Address')} className="border-t border-ink-800/70 pt-3" data-source-address>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-fog-500 rtl:tracking-normal">{tr('Address')}</p>
            {asking !== 'address' ? (
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <bdi dir="ltr" className="min-w-0 break-all text-[13px] text-fog-200">{s.address ?? '—'}</bdi>
                <button type="button" onClick={() => { setAddress(s.address ?? ''); setAsking('address'); }} disabled={!!busy} className="btn-key" data-source-key="address">
                  {tr('Update address')}
                </button>
              </div>
            ) : (
              <form className="mt-1.5 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); moveTo(address.trim()); }}>
                <input value={address} onChange={(e) => setAddress(e.target.value)} dir="ltr" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  placeholder="https://site.com" aria-label={tr('Address')} className="field min-w-0 flex-1 basis-48" />
                <button type="submit" disabled={!!busy || !address.trim()} className="btn-key">{busy === 'address' ? <Busy tone="muted">{tr('Saving…')}</Busy> : tr('Save')}</button>
                <button type="button" onClick={() => { setAsking(null); setRefusal(null); }} className="btn-key">{tr('Cancel')}</button>
              </form>
            )}
            {refusal?.key === 'address' && <p role="alert" dir="auto" className="mt-2 text-[12px] leading-relaxed text-amber-300" data-source-refusal>{refusal.text}</p>}
          </section>
        )}

        {s?.kind === 'mangadex' && (
          <div className="border-t border-ink-800/70 pt-3">
            <MangadexLanguages open sources={(overview?.sources ?? []).filter((x) => x.kind === 'mangadex')} onSaved={() => void onChanged()} />
          </div>
        )}

        {(s?.kind === 'extension' || (!s && ext)) && (
          <div className="border-t border-ink-800/70 pt-3">
            {ext && status && engineReady ? (
              <ExtensionSection ext={ext} status={status} hiddenLangs={hiddenLangs} actions={actions} onLanguages={onLanguages}
                offByAdmin={offByAdmin} settingsFor={extSourceIdOf(s?.id)} settingsOpen={'id' in target && !!target.settings} />
            ) : (
              <p className="text-[12px] text-fog-500">{engineReady ? tr('This extension is no longer installed.') : tr('The extension engine isn’t answering')}</p>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
