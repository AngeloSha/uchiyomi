'use client';
// Chapters here in another language than the series' (v0.62.0): one text block above the chapter list, in
// NumberingNotice's form, for the admin -- the one who can fetch them again. GET /api/series/:id/versions
// `otherLanguage` lists them (bff routes/catalog.ts): files known to be in another language -- a chapter English
// MangaDex took in another before v0.62.0, one from a source in another language -- each of which a copy in the
// series' language can replace. Fetch them again replaces each file in place, on its own row, so reading progress
// stays; the notice goes once they have landed and the versions are read again.
import { otherLanguageWords } from '@/lib/versions';
import type { OtherLanguage } from '@/lib/types';

export function LanguageNotice({ notice, busy, onFetch }: {
  notice: OtherLanguage | null | undefined;
  /** A request or a job of this page's is running: a second Fetch again would be refused as busy. */
  busy: boolean;
  onFetch: (bookIds: string[]) => void;
}) {
  if (!notice?.bookIds.length) return null;
  const w = otherLanguageWords(notice);
  return (
    <div data-language-notice className="mb-3 border-s-2 border-amber-400/70 bg-amber-500/10 py-2.5 pe-3 ps-3">
      <p className="text-[13px] font-semibold text-amber-200">{w.heading}</p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-fog-300">{w.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onFetch(notice.bookIds)} disabled={busy} className="btn-key btn-key-primary" data-language-notice-fetch>
          {w.key}
        </button>
      </div>
    </div>
  );
}
