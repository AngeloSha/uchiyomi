'use client';
// Admin -> Settings -> Downloads: the slow archive's knobs (#117). Its own file, mounted by AdminSettings.tsx
// after the Scanlators section, so the four sections settingsConsole.test.ts pins keep their order.
//
// These are the whole server's politeness towards every site, so they are an admin's: the server-wide pause,
// how many chapters an hour one source is asked for, the hours it may run in, and the free space it leaves
// alone. PATCH /api/admin/settings takes each (bff lib/archive.ts ARCHIVE_SETTINGS_SHAPE), and the running
// scheduler reads them again at once -- no restart.
import { Disclosure, NumberRow, Section, SwitchRow } from '@/components/settings';
import { IcHourglass } from '@/components/icons';
import { t as tr } from '@/lib/i18n';
import { isDesktop } from '@/lib/desktop';
import { ARCHIVE_PACE, archivePaceHelp } from '@/lib/archive';

type Save = (body: Record<string, unknown>) => Promise<unknown>;

/** The window an admin starts from when switching "Only during set hours" on: the small hours. */
const WINDOW_DEFAULT = { from: 1, to: 7 };

export function DownloadsSection({ data, save }: { data: any; save: Save }) {
  const perHour: number = data.archive_per_hour ?? ARCHIVE_PACE.perHour;
  const from: number | null = data.archive_window_from ?? null;
  const to: number | null = data.archive_window_to ?? null;
  const windowOn = from != null && to != null;
  const freeGb: number | null = typeof data.archive_free_gb === 'number' ? data.archive_free_gb : null;
  const desktop = isDesktop();
  return (
    <Section id="downloads" title={tr('Downloads')} icon={<IcHourglass width={18} height={18} />}
      description={tr('The slow archive fetches whole series a chapter at a time, over nights or days, so a site never sees a burst. Queue a series from the add dialog, its page, or a Library selection.')}>
      {/* On is "not paused": the column is archive_paused, and the switch says what an admin wants to know. */}
      <SwitchRow label={tr('Slow archive')}
        help={desktop
          ? `${tr('Off pauses every archive; nothing queued is lost.')} ${tr('Runs only while Uchiyomi is running, even when it is only in the tray. If the PC sleeps at night, a night-time window will rarely get anything done.')}`
          : tr('Off pauses every archive; nothing queued is lost.')}
        on={data.archive_paused !== true} onChange={(next) => save({ archivePaused: !next })} />
      <NumberRow label={tr('Chapters an hour, per source')} min={ARCHIVE_PACE.perHourRange[0]} max={ARCHIVE_PACE.perHourRange[1]} value={perHour}
        help={archivePaceHelp(perHour)} onSave={(n) => save({ archivePerHour: n })} />
      {/* The window's two ends travel together: the server refuses one without the other. */}
      <SwitchRow label={tr('Only during set hours')}
        help={tr("Hours in the server's local time. 22 until 6 runs overnight.")}
        on={windowOn}
        onChange={(next) => save(next
          ? { archiveWindowFrom: WINDOW_DEFAULT.from, archiveWindowTo: WINDOW_DEFAULT.to }
          : { archiveWindowFrom: null, archiveWindowTo: null })} />
      {windowOn && (
        <>
          <NumberRow label={tr('From (hour, 0–23)')} min={0} max={23} value={from}
            onSave={(n) => save({ archiveWindowFrom: n, archiveWindowTo: to })} />
          <NumberRow label={tr('Until (hour, 0–23)')} min={0} max={23} value={to}
            help={from === to ? tr('The same hour at both ends means any time.') : undefined}
            onSave={(n) => save({ archiveWindowFrom: from, archiveWindowTo: n })} />
        </>
      )}
      <NumberRow label={tr('Stop when free space is below (GB)')} min={1} max={2000} value={data.archive_min_free_gb ?? 20}
        help={freeGb === null
          ? tr('Chapters you fetch yourself are not held to this.')
          : `${tr('Free now: {n} GB.', { n: freeGb.toLocaleString() })} ${tr('Chapters you fetch yourself are not held to this.')}`}
        onSave={(n) => save({ archiveMinFreeGb: n })} />
      <div className="py-3 last:pb-0">
        <Disclosure label={tr('How the slow archive works')}>
          <ul className="max-w-prose list-disc space-y-1 ps-4 text-[11px] leading-relaxed text-fog-500">
            <li>{tr('One chapter at a time per source, with a random pause between pages and a random break between chapters, now and then a long one. Several sites are archived side by side.')}</li>
            <li>{tr('It stands aside for the scheduled check, the library repair, the source check and anyone else downloading from the same site.')}</li>
            <li>{tr('A site that refuses is left alone for an hour, then three, then twelve, then a day at a time. The series stays queued.')}</li>
            <li>{tr('After a restart it carries on where it left off, and no break is cut short. It only fetches from the sources a series already follows; it never searches other sites.')}</li>
            <li>{tr('Chapters it brings in do not count as new chapters under Updates, and trigger no notifications.')}</li>
          </ul>
        </Disclosure>
      </div>
    </Section>
  );
}
