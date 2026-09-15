'use client';
// What a source, an extension, a site by URL, a translation group and "Fetch vs Save offline" are, in five
// short lines a first-time reader can take in.
//
// The series page and Discover used these words for months without ever saying what they meant, and the
// owner -- who runs the server -- said he was getting confused. The definitions are the docs' own, cut to
// one sentence or two each; the (i) that opens this sits wherever the words are used: the "Sources &
// translations" sheet, Discover's source list, and beside "Add a site" in the admin console.
import { Sheet } from '@/components/ui';
import { IcCloudDownload, IcDownload } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

export function SourcesExplainer({ onClose }: { onClose: () => void }) {
  const rows: { term: string; text: string }[] = [
    { term: tr('Source'), text: tr('A website Uchiyomi reads manga from: MangaDex, or a site an admin added.') },
    { term: tr('Extension'), text: tr('A plug-in from the Mihon catalogue that teaches Uchiyomi one site; one extension can add several sources, one per language.') },
    { term: tr('Site by URL'), text: tr('A site added by pasting its address. Uchiyomi reads it with its built-in reader, so it cannot say which group translated a chapter.') },
    { term: tr('Translated by'), text: tr('The fan group that translated a chapter. A chapter often has several versions; the server keeps one, taking a preferred group first, never a blocked one, and waiting for a preferred group for the patience you set.') },
  ];
  return (
    <Sheet title={tr('Sources, extensions and translations')} onClose={onClose} overBottomNav>
      <dl className="space-y-3 text-sm">
        {rows.map((r) => (
          <div key={r.term}>
            <dt className="font-semibold text-fog-100">{r.term}</dt>
            <dd className="mt-0.5 text-fog-400">{r.text}</dd>
          </div>
        ))}
        <div>
          <dt className="font-semibold text-fog-100">{tr('Fetch vs Save offline')}</dt>
          {/* One flowing paragraph with the icons INLINE. Each icon+sentence was an `inline-flex` span, and
              at 390px a span that does not fit the line wraps as one block: the cloud floated centred beside
              two lines of text with "everyone." orphaned under an indent. An inline-block icon sits in the
              line like a letter and the sentence wraps like a sentence. */}
          <dd className="mt-0.5 text-fog-400">
            <IcCloudDownload width={14} height={14} className="me-1 inline-block align-text-bottom text-fog-300" />
            {tr('Fetch brings a chapter onto the server for everyone.')}
            {' '}
            <IcDownload width={14} height={14} className="me-1 inline-block align-text-bottom text-fog-300" />
            {tr('Save offline copies it to this device.')}
          </dd>
        </div>
      </dl>
    </Sheet>
  );
}
